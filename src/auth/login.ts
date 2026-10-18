/**
 * Sign-in orchestration shared by the `login` MCP tool and the CLI.
 *
 * Signing in needs a browser the user can see: we open it, the user signs in
 * (SSO and MFA included) and the token is captured without any copy-paste or
 * passing through the model. Environments without one (cloud sandboxes, SSH,
 * containers, CI) are configured with MOODLE_URL + MOODLE_TOKEN instead,
 * obtained by signing in once on a computer that has a browser.
 */

import { APP_NAME, env } from "../config.js";
import { MoodleClient } from "../moodle/client.js";
import { browserLogin, canShowBrowserWindow, findBrowser } from "./browser.js";
import { launchUrl, newPassport, payloadMatchesSite } from "./launch.js";
import { resolveSite, type Site } from "./site.js";
import { loadSession, saveCredential, type Session } from "./store.js";

export type LoginResult = { status: "signed_in"; session: Session } | { status: "waiting_for_browser"; site: string };

export class SiteUrlRequiredError extends Error {
  constructor() {
    super(
      "No Moodle site is configured yet. Ask the user for the address of their Moodle site " +
        "(for example https://moodle.example.edu) and call login again with site_url.",
    );
    this.name = "SiteUrlRequiredError";
  }
}

export const REMOTE_SETUP_HINT =
  "Set MOODLE_URL and MOODLE_TOKEN as secret environment variables of this environment. The user gets them on a " +
  `computer with a browser by running \`npx -y @tcpassos/${APP_NAME} login\` and then ` +
  `\`npx -y @tcpassos/${APP_NAME} token\`, which copies both lines to the clipboard. The environment must also ` +
  "be allowed to reach the Moodle host (in Claude Code on the web: Network access > Custom). Accounts with a " +
  "Moodle password (not SSO) can use MOODLE_URL, MOODLE_USERNAME and MOODLE_PASSWORD instead. Never ask the " +
  "user to paste the token or password into the chat.";

export class NoBrowserError extends Error {
  constructor(reason: "no_display" | "no_browser") {
    super(
      reason === "no_display"
        ? "This environment has no screen to show a browser (cloud sandbox, SSH or container), so it cannot sign " +
            `in to Moodle by itself. ${REMOTE_SETUP_HINT}`
        : "No Chrome, Edge, Brave, Chromium or Vivaldi installation was found to sign in with. Install one of them, " +
            `or set MOODLE_BROWSER to the path of a Chromium-based browser. ${REMOTE_SETUP_HINT}`,
    );
    this.name = "NoBrowserError";
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
  /** How long to wait for the browser sign-in before returning `waiting_for_browser`. */
  waitMs?: number;
}

export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const waitMs = options.waitMs ?? 240_000;

  // A browser window from an earlier call is still open: keep waiting on it.
  if (browserAttempt && !browserAttempt.settled) return waitFor(browserAttempt, waitMs);

  if (!canShowBrowserWindow()) throw new NoBrowserError("no_display");
  if (!findBrowser()) throw new NoBrowserError("no_browser");

  const target = options.siteUrl ?? env("MOODLE_URL") ?? (await loadSession())?.siteUrl;
  if (!target) throw new SiteUrlRequiredError();
  return waitFor(startBrowserAttempt(await resolveSite(target)), waitMs);
}
