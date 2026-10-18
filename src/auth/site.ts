/**
 * Site discovery through `tool_mobile_get_public_config`, a function Moodle
 * exposes without login so the mobile app can decide how to sign in.
 */

import { normalizeSiteUrl } from "../config.js";

export interface PublicConfig {
  wwwroot: string;
  httpswwwroot?: string;
  sitename?: string;
  /** 1 = inside the app, 2 = system browser, 3 = embedded browser. */
  typeoflogin?: number;
  launchurl?: string;
  enablewebservices?: number;
  enablemobilewebservice?: number;
  maintenanceenabled?: number;
  identityproviders?: { name: string; url: string }[];
}

export interface Site {
  /** Canonical site URL (Moodle's wwwroot, no trailing slash). */
  url: string;
  config: PublicConfig;
}

async function fetchPublicConfig(base: string, fetchImpl: typeof fetch): Promise<PublicConfig | null> {
  const body = JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]);
  for (const script of ["service-nologin.php", "service.php"]) {
    try {
      const response = await fetchImpl(`${base}/lib/ajax/${script}?info=tool_mobile_get_public_config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { error?: boolean; data?: PublicConfig }[];
      const first = Array.isArray(data) ? data[0] : undefined;
      if (first && !first.error && first.data?.wwwroot) return first.data;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Find the Moodle site behind what the user typed (which may include a page
 * path such as `/my/`) and return its canonical URL and public config.
 */
export async function resolveSite(input: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Site> {
  const normalized = normalizeSiteUrl(input);
  const url = new URL(normalized);
  const segments = url.pathname.split("/").filter(Boolean);
  const candidates: string[] = [];
  for (let n = segments.length; n >= 0; n--) {
    candidates.push(`${url.origin}${n ? "/" + segments.slice(0, n).join("/") : ""}`);
  }

  for (const base of candidates) {
    const config = await fetchPublicConfig(base, fetchImpl);
    if (!config) continue;
    if (config.enablewebservices === 0 || config.enablemobilewebservice === 0) {
      throw new Error(
        `${config.sitename ?? base} does not allow the Moodle mobile app service, which this server needs. ` +
          "Only a site administrator can enable it.",
      );
    }
    return { url: config.wwwroot.replace(/\/+$/, ""), config };
  }
  throw new Error(`Could not find a Moodle site at ${normalized}. Check the address (e.g. https://moodle.example.edu).`);
}
