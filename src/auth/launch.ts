/**
 * The mobile-app SSO handshake (`admin/tool/mobile/launch.php`).
 *
 * After the user signs in, Moodle sends the browser to
 * `<urlscheme>://token=BASE64`, where BASE64 encodes
 * `md5(wwwroot + passport):::TOKEN[:::PRIVATETOKEN]`. With `confirmed=1`
 * Moodle renders a page holding that link instead of a bare redirect, which
 * the browser login reads over the DevTools protocol.
 *
 * Sites force the scheme to `moodlemobile` by default (tool_mobile's
 * forcedurlscheme), so no web page can be registered to receive the link;
 * that is why signing in needs a browser this program controls.
 */

import { createHash, randomBytes } from "node:crypto";

export const MOBILE_SERVICE = "moodle_mobile_app";

export const TOKEN_LINK_PATTERN = /[a-z][a-z0-9+.-]*:\/\/token=([A-Za-z0-9+/=_-]+)/i;

export function newPassport(): string {
  return randomBytes(16).toString("hex");
}

export function launchUrl(
  siteUrl: string,
  passport: string,
  options: { urlScheme?: string; confirmed?: boolean } = {},
): string {
  const params = new URLSearchParams({
    service: MOBILE_SERVICE,
    passport,
    urlscheme: options.urlScheme ?? "moodlemobile",
  });
  if (options.confirmed) params.set("confirmed", "1");
  // URLSearchParams encodes "+" as %2B, which PHP would otherwise read as a space.
  return `${siteUrl}/admin/tool/mobile/launch.php?${params.toString()}`;
}

export interface LaunchPayload {
  siteId: string;
  token: string;
}

/** Decode `siteid:::token[:::private]` from base64 (standard or URL-safe). */
export function decodePayload(base64: string): LaunchPayload | null {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = Buffer.from(padded, "base64").toString("utf8");
  const [siteId, token] = raw.split(":::");
  if (!siteId || !token || !/^[A-Za-z0-9]+$/.test(token)) return null;
  return { siteId, token };
}

/** Find a `scheme://token=...` link in a URL, header or HTML page and decode it. */
export function extractPayload(text: string): LaunchPayload | null {
  const match = TOKEN_LINK_PATTERN.exec(text);
  return match ? decodePayload(match[1]!) : null;
}

/**
 * Check that the payload answers our passport on this site: Moodle signs it
 * as md5(wwwroot + passport). Tries the http/https and trailing-slash
 * variants of the site URL, since wwwroot may differ from the address we used.
 */
export function payloadMatchesSite(payload: LaunchPayload, siteUrls: string[], passport: string): boolean {
  const variants = new Set<string>();
  for (const url of siteUrls) {
    const bare = url.replace(/\/+$/, "");
    for (const candidate of [bare, `${bare}/`]) {
      variants.add(candidate);
      variants.add(candidate.replace(/^https:/, "http:"));
      variants.add(candidate.replace(/^http:/, "https:"));
    }
  }
  return [...variants].some((root) => createHash("md5").update(root + passport).digest("hex") === payload.siteId);
}
