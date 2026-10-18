import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { extractPayload, launchUrl, payloadMatchesSite } from "../src/auth/launch.js";
import { login, NoBrowserError } from "../src/auth/login.js";

const SITE = "https://moodle.example.edu";
const TOKEN = "0123456789abcdef0123456789abcdef";

function tokenLink(site: string, passport: string, scheme = "moodlemobile"): string {
  const siteId = createHash("md5").update(site + passport).digest("hex");
  return `${scheme}://token=${Buffer.from(`${siteId}:::${TOKEN}:::private123`).toString("base64")}`;
}

describe("launch.php handshake", () => {
  it("asks Moodle for the confirmation page that holds the token link", () => {
    expect(launchUrl(SITE, "abc", { confirmed: true })).toBe(
      `${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=abc&urlscheme=moodlemobile&confirmed=1`,
    );
    // A scheme with "+" must reach PHP encoded, or it is read as a space.
    expect(launchUrl(SITE, "abc", { urlScheme: "web+x" })).toContain("urlscheme=web%2Bx");
  });

  it("extracts the token from a redirect or from Moodle's confirmation page", () => {
    const link = tokenLink(SITE, "p1");
    expect(extractPayload(link)?.token).toBe(TOKEN);
    expect(extractPayload(`<a id="launchapp" href="${link}">Launch</a>`)?.token).toBe(TOKEN);
    expect(extractPayload(tokenLink(SITE, "p1", "brandedapp"))?.token).toBe(TOKEN);
    expect(extractPayload(`${SITE}/admin/tool/mobile/launch.php?passport=p1`)).toBeNull();
  });

  it("checks the md5(wwwroot + passport) signature", () => {
    const payload = extractPayload(tokenLink(SITE, "p1"))!;
    expect(payloadMatchesSite(payload, [SITE], "p1")).toBe(true);
    expect(payloadMatchesSite(payload, [`${SITE}/`], "p1")).toBe(true);
    expect(payloadMatchesSite(payload, [SITE], "other")).toBe(false);
    expect(payloadMatchesSite(payload, ["https://evil.test"], "p1")).toBe(false);
  });
});

describe("login without a screen", () => {
  const saved = { ssh: process.env.SSH_CONNECTION, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY };

  afterEach(() => {
    for (const [name, value] of [
      ["SSH_CONNECTION", saved.ssh],
      ["DISPLAY", saved.display],
      ["WAYLAND_DISPLAY", saved.wayland],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("explains how to configure MOODLE_URL and MOODLE_TOKEN instead", async () => {
    process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const error = await login({ siteUrl: SITE }).catch((e) => e);
    expect(error).toBeInstanceOf(NoBrowserError);
    expect(error.message).toContain("MOODLE_TOKEN");
    expect(error.message).toContain("token`");
  });
});
