/**
 * Credential chain, first match wins:
 *
 * 1. MOODLE_TOKEN or MOODLE_TOKEN_FILE (+ MOODLE_URL): cloud, CI, containers.
 * 2. MOODLE_USERNAME + MOODLE_PASSWORD (+ MOODLE_URL): accounts with a Moodle
 *    password (manual/LDAP); the token is fetched from login/token.php and
 *    fetched again when it expires.
 * 3. The sign-in saved by the `login` tool or CLI command.
 */

import { readFile } from "node:fs/promises";
import { env, normalizeSiteUrl } from "../config.js";
import { MOBILE_SERVICE } from "./launch.js";
import { loadCredential, type Session } from "./store.js";

export type CredentialSource = "environment token" | "environment password" | "saved sign-in";

export interface ActiveCredential {
  siteUrl: string;
  token: string;
  source: CredentialSource;
  session?: Session;
  /** Folder holding the saved sign-in, for the "saved sign-in" source. */
  savedIn?: string;
}

export const NOT_SIGNED_IN_HINT =
  "Call the `login` tool to sign in: it opens a browser window where the user signs in to Moodle " +
  "(or explains how to configure this environment when it has no screen). " +
  "Never ask the user to type their Moodle password or token into the chat.";

export class NotSignedInError extends Error {
  /** The message without the hint for the assistant. */
  readonly reason: string;

  constructor(reason = "Not signed in to Moodle.") {
    super(`${reason} ${NOT_SIGNED_IN_HINT}`);
    this.name = "NotSignedInError";
    this.reason = reason;
  }
}

/** Compare two site addresses ignoring scheme, case and trailing slashes. */
export function sameSite(a: string, b: string): boolean {
  const key = (url: string) => normalizeSiteUrl(url).replace(/^https?:\/\//i, "").toLowerCase();
  return key(a) === key(b);
}

/** Exchange a username/password for a token (only for accounts that have a Moodle password). */
export async function passwordToken(
  siteUrl: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  // POST keeps the password out of server access logs.
  const response = await fetchImpl(`${siteUrl}/login/token.php`, {
    method: "POST",
    body: new URLSearchParams({ username, password, service: MOBILE_SERVICE }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, string>;
  if (data.token) return data.token;
  throw new Error(
    `Moodle rejected the username/password (${data.errorcode ?? `HTTP ${response.status}`}). ` +
      "Accounts that sign in through SSO (Microsoft, Google, SAML, CAS) have no Moodle password; use the login tool instead.",
  );
}

export async function resolveCredential(fetchImpl: typeof fetch = globalThis.fetch): Promise<ActiveCredential | null> {
  const siteEnv = env("MOODLE_URL");
  const tokenFile = env("MOODLE_TOKEN_FILE");
  const token = env("MOODLE_TOKEN") ?? (tokenFile ? (await readFile(tokenFile, "utf8")).trim() || undefined : undefined);
  if (token) {
    if (!siteEnv) throw new Error("MOODLE_TOKEN is set but MOODLE_URL is not. Set MOODLE_URL to your Moodle address.");
    return { siteUrl: normalizeSiteUrl(siteEnv), token, source: "environment token" };
  }

  const username = env("MOODLE_USERNAME");
  const password = env("MOODLE_PASSWORD");
  if (username && password) {
    if (!siteEnv) throw new Error("MOODLE_USERNAME is set but MOODLE_URL is not. Set MOODLE_URL to your Moodle address.");
    const siteUrl = normalizeSiteUrl(siteEnv);
    return { siteUrl, token: await passwordToken(siteUrl, username, password, fetchImpl), source: "environment password" };
  }

  const saved = await loadCredential();
  if (!saved) return null;
  if (siteEnv && !sameSite(saved.session.siteUrl, siteEnv)) return null;
  if (saved.token === null) throw new NotSignedInError(`${saved.problem} Sign in again to replace it.`);
  return {
    siteUrl: saved.session.siteUrl,
    token: saved.token,
    source: "saved sign-in",
    session: saved.session,
    savedIn: saved.dir,
  };
}
