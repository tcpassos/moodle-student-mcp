/**
 * Minimal client for the Moodle Web Services REST API, authenticated with a
 * token for the official mobile-app service (`moodle_mobile_app`), so it acts
 * with the student's own permissions.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** Error reported by Moodle itself (the `exception` / `errorcode` fields). */
export class MoodleError extends Error {
  constructor(
    readonly errorcode: string,
    message: string,
  ) {
    super(`[${errorcode}] ${message}`);
    this.name = "MoodleError";
  }
}

/** True when Moodle no longer accepts the token (expired, revoked, password changed). */
export function isInvalidTokenError(error: unknown): boolean {
  return error instanceof MoodleError && error.errorcode === "invalidtoken";
}

/** Encode nested params the way Moodle expects: `a[0][b]=c`. */
export function flattenParams(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (val: unknown, key: string) => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((item, index) => visit(item, `${key}[${index}]`));
    } else if (typeof val === "object") {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) visit(v, key ? `${key}[${k}]` : k);
    } else if (typeof val === "boolean") {
      out[key] = val ? "1" : "0";
    } else {
      out[key] = String(val);
    }
  };
  visit(value, prefix);
  return out;
}

function moodleErrorFrom(data: unknown): MoodleError | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.exception || record.errorcode) {
      return new MoodleError(String(record.errorcode ?? "unknown"), String(record.message ?? record.error ?? "unknown error"));
    }
  }
  return null;
}

export interface MoodleClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class MoodleClient {
  readonly siteUrl: string;
  readonly endpoint: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  #userId: number | undefined;

  constructor(siteUrl: string, token: string, options: MoodleClientOptions = {}) {
    this.siteUrl = siteUrl.replace(/\/+$/, "");
    this.endpoint = `${this.siteUrl}/webservice/rest/server.php`;
    this.#token = token;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Replace any occurrence of the token in `text`, so errors never leak it. */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join("***") : text;
  }

  /** Call a web service function and return its JSON result. */
  async call<T = any>(wsfunction: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = new URLSearchParams({
      wstoken: this.#token,
      wsfunction,
      moodlewsrestformat: "json",
      ...flattenParams(params),
    });
    let response: Response;
    try {
      response = await this.#fetch(this.endpoint, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(
        this.redact(
          `Could not reach Moodle at ${this.siteUrl}: ${(error as Error).message}. If this runs in a sandbox with ` +
            `restricted network access (e.g. Claude Code on the web), allow ${new URL(this.siteUrl).host} in the ` +
            "environment's network settings.",
        ),
      );
    }
    if (!response.ok) {
      throw new Error(
        `Moodle answered HTTP ${response.status} for ${wsfunction}.` +
          (response.status === 403 ? " A sandbox network allowlist may be blocking the site." : ""),
      );
    }
    const data = await response.json();
    const moodleError = moodleErrorFrom(data);
    if (moodleError) throw moodleError;
    return data as T;
  }

  /**
   * Download a pluginfile URL to `dest` and return the number of bytes.
   *
   * The token goes in the POST body rather than the query string, so it does
   * not end up in URLs, logs or error messages. Falls back to the query string
   * for servers that reject POST.
   */
  async download(fileUrl: string, dest: string): Promise<number> {
    let response = await this.#fetchFile(fileUrl, "POST");
    if (response.status === 405 || response.status === 411 || (await this.#isMissingParam(response))) {
      response = await this.#fetchFile(fileUrl, "GET");
    }
    if (!response.ok) throw new Error(this.redact(`HTTP ${response.status} downloading ${fileUrl}`));
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      const moodleError = moodleErrorFrom(await response.json());
      throw moodleError ?? new Error("Moodle returned JSON instead of the file");
    }
    if (!response.body) throw new Error("Empty response body");

    await mkdir(dirname(dest), { recursive: true });
    const partial = `${dest}.part`;
    let total = 0;
    try {
      const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
      source.on("data", (chunk: Buffer) => {
        total += chunk.length;
      });
      await pipeline(source, createWriteStream(partial));
      await rename(partial, dest);
    } catch (error) {
      await rm(partial, { force: true });
      throw new Error(this.redact((error as Error).message));
    }
    return total;
  }

  async #fetchFile(fileUrl: string, method: "POST" | "GET"): Promise<Response> {
    const timeout = AbortSignal.timeout(Math.max(this.#timeoutMs, 300_000));
    try {
      if (method === "POST") {
        return await this.#fetch(fileUrl, {
          method,
          body: new URLSearchParams({ token: this.#token }),
          signal: timeout,
        });
      }
      const url = new URL(fileUrl);
      url.searchParams.set("token", this.#token);
      return await this.#fetch(url, { signal: timeout });
    } catch (error) {
      throw new Error(this.redact(`Could not download ${fileUrl}: ${(error as Error).message}`));
    }
  }

  async #isMissingParam(response: Response): Promise<boolean> {
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return false;
    try {
      const data = await response.clone().json();
      return (data as Record<string, unknown>)?.errorcode === "missingparam";
    } catch {
      return false;
    }
  }

  /** The student's user id (from core_webservice_get_site_info, cached). */
  async userId(): Promise<number> {
    if (this.#userId === undefined) {
      const info = await this.call<{ userid: number }>("core_webservice_get_site_info");
      this.#userId = info.userid;
    }
    return this.#userId;
  }
}
