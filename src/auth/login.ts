/**
 * Sign-in orchestration shared by the `login` MCP tool and the CLI.
 *
 * - With a browser that the user can see: open it, let them sign in, capture
 *   the token. Zero copy-paste.
 * - Without one (SSH, containers, cloud sandboxes, or no Chromium browser):
 *   hand out a link to the helper page; the user signs in on any device and
 *   pastes back an encrypted code that only this server can open.
 *
 * In both cases the token never passes through the model.
 */

import { env } from "../config.js";
import { MoodleClient } from "../moodle/client.js";
import { browserLogin, canShowBrowserWindow, findBrowser } from "./browser.js";
import { launchUrl, newPassport, payloadMatchesSite } from "./launch.js";
import { completeLinkLogin, startLinkLogin } from "./relay.js";
import { resolveSite, type Site } from "./site.js";
import { loadSession, saveCredential, type Session } from "./store.js";

export type LoginMethod = "auto" | "browser" | "link";

export type LoginResult =
  | { status: "signed_in"; session: Session }
  | { status: "waiting_for_browser"; site: string }
  | { status: "link"; site: string; url: string; expiresAt: string };

export class SiteUrlRequiredError extends Error {
  constructor() {
    super(
      "No Moodle site is configured yet. Ask the user for the address of their Moodle site " +
        "(for example https://moodle.example.edu) and call login again with site_url.",
    );
    this.name = "SiteUrlRequiredError";
  }
}

/** Validate a token against the site and save it. */
export async function saveVerifiedToken(siteUrl: string, token: string): Promise<Session> {
  const info = await new MoodleClient(siteUrl, token).call<Record<string, any>>("core_webservice_get_site_info");
  return saveCredential(
    { siteUrl, userId: info.userid, fullName: info.fullname, username: info.username, siteName: info.sitename },
    token,
  );
}

interface BrowserAttempt {
  site: string;
  startedAt: number;
  promise: Promise<Session>;
  settled: boolean;
  error?: Error;
}

let browserAttempt: BrowserAttempt | null = null;

/** State of a browser sign-in started by this process, for auth_status. */
export function browserAttemptState(): { site: string; state: "waiting" | "failed"; error?: string } | null {
  if (!browserAttempt) return null;
  if (!browserAttempt.settled) return { site: browserAttempt.site, state: "waiting" };
  if (browserAttempt.error) return { site: browserAttempt.site, state: "failed", error: browserAttempt.error.message };
  return null;
}

function startBrowserAttempt(site: Site): BrowserAttempt {
  const passport = newPassport();
  const url = launchUrl(site.url, passport, { confirmed: true });
  const roots = [site.url, site.config.wwwroot, site.config.httpswwwroot].filter((r): r is string => !!r);
  const attempt: BrowserAttempt = {
    site: site.url,
    startedAt: Date.now(),
    settled: false,
    promise: browserLogin(url).then((payload) => {
      if (!payloadMatchesSite(payload, roots, passport)) {
        throw new Error("Moodle answered with a token signed for a different site; nothing was saved.");
      }
      return saveVerifiedToken(site.url, payload.token);
    }),
  };
  attempt.promise.then(
    () => {
      attempt.settled = true;
    },
    (error: Error) => {
      attempt.settled = true;
      attempt.error = error;
    },
  );
  browserAttempt = attempt;
  return attempt;
}

async function waitFor(attempt: BrowserAttempt, waitMs: number): Promise<LoginResult> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref());
  const session = await Promise.race([attempt.promise, timeout]);
  return session ? { status: "signed_in", session } : { status: "waiting_for_browser", site: attempt.site };
}

export interface LoginOptions {
  siteUrl?: string;
  code?: string;
  method?: LoginMethod;
  /** How long to wait for a browser sign-in before returning `waiting_for_browser`. */
  waitMs?: number;
}

export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const waitMs = options.waitMs ?? 240_000;

  if (options.code) {
    const { siteUrl, payload } = await completeLinkLogin(options.code);
    return { status: "signed_in", session: await saveVerifiedToken(siteUrl, payload.token) };
  }

  // A browser window from an earlier call is still open: keep waiting on it.
  if (browserAttempt && !browserAttempt.settled && options.method !== "link") {
    return waitFor(browserAttempt, waitMs);
  }

  const target = options.siteUrl ?? env("MOODLE_URL") ?? (await loadSession())?.siteUrl;
  if (!target) throw new SiteUrlRequiredError();
  const site = await resolveSite(target);

  const method = options.method ?? (env("MOODLE_LOGIN_METHOD") as LoginMethod | undefined) ?? "auto";
  const browserAvailable = canShowBrowserWindow() && findBrowser() !== null;
  if (method === "browser" && !findBrowser()) {
    throw new Error("No Chrome, Edge, Brave, Chromium or Vivaldi installation was found. Use method \"link\" instead.");
  }
  if (method === "browser" || (method === "auto" && browserAvailable)) {
    return waitFor(startBrowserAttempt(site), waitMs);
  }

  const { url, expiresAt } = await startLinkLogin(site.url);
  return { status: "link", site: site.url, url, expiresAt };
}
