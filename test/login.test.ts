import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  codeFromTokenLink,
  decodeTokenLink,
  moodleLaunchUrl,
  parseStartParams,
} from "../docs/login/login.js";
import { extractPayload, launchUrl, payloadMatchesSite } from "../src/auth/launch.js";
import { completeLinkLogin, decryptLoginCode, loadPendingLogin, startLinkLogin } from "../src/auth/relay.js";

const SITE = "https://moodle.example.edu";
const TOKEN = "0123456789abcdef0123456789abcdef";

function tokenLink(site: string, passport: string, scheme = "moodlemobile"): string {
  const siteId = createHash("md5").update(site + passport).digest("hex");
  return `${scheme}://token=${Buffer.from(`${siteId}:::${TOKEN}:::private123`).toString("base64")}`;
}

beforeEach(async () => {
  process.env.MOODLE_STUDENT_MCP_HOME = await mkdtemp(join(tmpdir(), "msmcp-home-"));
  process.env.MOODLE_LOGIN_HELPER_URL = "https://helper.test/login/";
});

describe("launch.php handshake", () => {
  it("encodes the + in the handler scheme", () => {
    const url = launchUrl(SITE, "abc", { urlScheme: "web+moodlestudent", confirmed: true });
    expect(url).toContain("urlscheme=web%2Bmoodlestudent");
    expect(url).toContain("confirmed=1");
    expect(moodleLaunchUrl(SITE, "abc")).toContain("urlscheme=web%2Bmoodlestudent");
  });

  it("extracts the token from a redirect or from Moodle's confirmation page", () => {
    const link = tokenLink(SITE, "p1");
    expect(extractPayload(link)?.token).toBe(TOKEN);
    expect(extractPayload(`<a id="launchapp" href="${link}">Launch</a>`)?.token).toBe(TOKEN);
  });

  it("checks the md5(wwwroot + passport) signature", () => {
    const payload = extractPayload(tokenLink(SITE, "p1"))!;
    expect(payloadMatchesSite(payload, [SITE], "p1")).toBe(true);
    expect(payloadMatchesSite(payload, [`${SITE}/`], "p1")).toBe(true);
    expect(payloadMatchesSite(payload, [SITE], "other")).toBe(false);
    expect(payloadMatchesSite(payload, ["https://evil.test"], "p1")).toBe(false);
  });
});

describe("helper page helpers", () => {
  it("decodes token links, also URL-encoded by a protocol handler", () => {
    const link = tokenLink(SITE, "p1", "web+moodlestudent");
    expect(decodeTokenLink(link)?.token).toBe(TOKEN);
    expect(decodeTokenLink(encodeURIComponent(link))?.token).toBe(TOKEN);
    expect(decodeTokenLink("https://example.com")).toBeNull();
  });

  it("rejects unsafe start parameters", () => {
    const ok = new URLSearchParams({ site: SITE, passport: "a".repeat(32), pk: "A".repeat(87) });
    expect(parseStartParams(ok)).not.toBeNull();
    expect(parseStartParams(new URLSearchParams({ ...Object.fromEntries(ok), site: "javascript:alert(1)" }))).toBeNull();
    expect(parseStartParams(new URLSearchParams({ ...Object.fromEntries(ok), site: "http://moodle.example.edu" }))).toBeNull();
    expect(parseStartParams(new URLSearchParams({ ...Object.fromEntries(ok), site: "http://localhost:8080" }))).not.toBeNull();
  });
});

describe("link login", () => {
  it("round-trips: server link -> page code -> server decrypt", async () => {
    const { url } = await startLinkLogin(SITE);
    expect(url.startsWith("https://helper.test/login/#")).toBe(true);

    const start = parseStartParams(new URLSearchParams(url.split("#")[1]));
    expect(start?.site).toBe(SITE);

    const code = await codeFromTokenLink(tokenLink(SITE, start!.passport), start!);
    expect(code).toMatch(/^msmcp1\./);
    expect(code).not.toContain(TOKEN);

    const result = await completeLinkLogin(`  ${code}\n`);
    expect(result.siteUrl).toBe(SITE);
    expect(result.payload.token).toBe(TOKEN);
    expect(await loadPendingLogin()).toBeNull();
  });

  it("rejects codes from another login attempt", async () => {
    const first = await startLinkLogin(SITE);
    const start = parseStartParams(new URLSearchParams(first.url.split("#")[1]))!;
    const code = (await codeFromTokenLink(tokenLink(SITE, start.passport), start))!;

    await startLinkLogin(SITE); // replaces the pending key pair
    await expect(completeLinkLogin(code)).rejects.toThrow(/does not belong/);
  });

  it("rejects a token signed for another site", async () => {
    const { url } = await startLinkLogin(SITE);
    const start = parseStartParams(new URLSearchParams(url.split("#")[1]))!;
    const code = (await codeFromTokenLink(tokenLink("https://evil.test", start.passport), start))!;
    await expect(completeLinkLogin(code)).rejects.toThrow(/different site/);
  });

  it("refuses text that is not a code", () => {
    expect(() => decryptLoginCode("hello", { privateKey: "00", passport: "x" })).toThrow(/not a Moodle login code/);
  });
});
