/**
 * The server's live connection to Moodle: resolves credentials lazily, keeps
 * one client, and turns a rejected token into a clear "sign in again".
 */

import { downloadDir, env } from "../config.js";
import { isInvalidTokenError, MoodleClient } from "../moodle/client.js";
import { validTimeZone } from "../moodle/format.js";
import type { MoodleContext } from "../moodle/tools.js";
import { NotSignedInError, resolveCredential, type ActiveCredential } from "./credentials.js";
import { clearCredential } from "./store.js";

export class MoodleSession {
  #credential: ActiveCredential | null = null;
  #context: MoodleContext | null = null;

  /** Forget the current client, e.g. after login or logout. */
  reset(): void {
    this.#credential = null;
    this.#context = null;
  }

  get credential(): ActiveCredential | null {
    return this.#credential;
  }

  async context(): Promise<MoodleContext> {
    if (this.#context) return this.#context;
    const credential = await resolveCredential();
    if (!credential) throw new NotSignedInError();
    const client = new MoodleClient(credential.siteUrl, credential.token);
    this.#credential = credential;
    this.#context = { client, timeZone: await this.#timeZone(client), downloadDir: downloadDir() };
    return this.#context;
  }

  /** Run `fn` with a client; a rejected token is refreshed (password source) or reported. */
  async run<T>(fn: (ctx: MoodleContext) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.context());
    } catch (error) {
      if (!isInvalidTokenError(error)) throw error;
      const source = this.#credential?.source;
      this.reset();
      if (source === "environment password") return fn(await this.context());
      if (source === "saved sign-in") await clearCredential();
      throw new NotSignedInError(
        source === "environment token"
          ? "Moodle rejected MOODLE_TOKEN (expired or revoked); replace it, or remove it and sign in instead."
          : "The saved Moodle sign-in has expired or was revoked.",
      );
    }
  }

  /** MOODLE_TIMEZONE, else the user's Moodle profile zone, else the system zone. */
  async #timeZone(client: MoodleClient): Promise<string | undefined> {
    const configured = validTimeZone(env("MOODLE_TIMEZONE"));
    if (configured) return configured;
    try {
      const [user] = await client.call<{ timezone?: string }[]>("core_user_get_users_by_field", {
        field: "id",
        values: [await client.userId()],
      });
      return validTimeZone(user?.timezone);
    } catch (error) {
      if (isInvalidTokenError(error)) throw error;
      return undefined;
    }
  }
}
