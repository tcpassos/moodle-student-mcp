import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, normalizeSiteUrl } from "../src/config.js";
import { resolveCredential, sameSite } from "../src/auth/credentials.js";
import { clearCredential, loadCredential, saveCredential } from "../src/auth/store.js";

const VARS = ["MOODLE_URL", "MOODLE_TOKEN", "MOODLE_TOKEN_FILE", "MOODLE_USERNAME", "MOODLE_PASSWORD"];

beforeEach(async () => {
  for (const name of VARS) delete process.env[name];
  process.env.MOODLE_STUDENT_MCP_HOME = await mkdtemp(join(tmpdir(), "msmcp-home-"));
  process.env.MOODLE_CREDENTIAL_STORE = "file";
});

afterEach(() => {
  for (const name of VARS) delete process.env[name];
});

describe("config helpers", () => {
  it("treats unexpanded plugin placeholders as unset", () => {
    process.env.MOODLE_URL = "${user_config.moodle_url}";
    expect(env("MOODLE_URL")).toBeUndefined();
  });

  it("normalizes what users type as their Moodle address", () => {
    expect(normalizeSiteUrl("moodle.example.edu/")).toBe("https://moodle.example.edu");
    expect(normalizeSiteUrl("https://x.edu/moodle/webservice/rest/server.php")).toBe("https://x.edu/moodle");
    expect(sameSite("http://X.edu/", "https://x.edu")).toBe(true);
  });
});

describe("credential chain", () => {
  it("returns null when nothing is configured", async () => {
    expect(await resolveCredential()).toBeNull();
  });

  it("uses the saved sign-in", async () => {
    await saveCredential({ siteUrl: "https://moodle.example.edu", userId: 5, fullName: "Ana" }, "tok123");
    const credential = await resolveCredential();
    expect(credential).toMatchObject({ siteUrl: "https://moodle.example.edu", token: "tok123", source: "saved sign-in" });
  });

  it("prefers MOODLE_TOKEN over the saved sign-in", async () => {
    await saveCredential({ siteUrl: "https://moodle.example.edu", userId: 5 }, "saved");
    process.env.MOODLE_URL = "https://moodle.example.edu";
    process.env.MOODLE_TOKEN = "fromenv";
    expect(await resolveCredential()).toMatchObject({ token: "fromenv", source: "environment token" });
  });

  it("reads MOODLE_TOKEN_FILE", async () => {
    const file = join(process.env.MOODLE_STUDENT_MCP_HOME!, "secret");
    await writeFile(file, "filetoken\n");
    process.env.MOODLE_URL = "https://moodle.example.edu";
    process.env.MOODLE_TOKEN_FILE = file;
    expect(await resolveCredential()).toMatchObject({ token: "filetoken" });
  });

  it("requires MOODLE_URL next to MOODLE_TOKEN", async () => {
    process.env.MOODLE_TOKEN = "x";
    await expect(resolveCredential()).rejects.toThrow(/MOODLE_URL/);
  });

  it("ignores a saved sign-in for a different MOODLE_URL", async () => {
    await saveCredential({ siteUrl: "https://moodle.example.edu", userId: 5 }, "saved");
    process.env.MOODLE_URL = "https://other.example.edu";
    expect(await resolveCredential()).toBeNull();
  });

  it("logs out", async () => {
    await saveCredential({ siteUrl: "https://moodle.example.edu", userId: 5 }, "saved");
    expect(await clearCredential()).toBe(true);
    expect(await loadCredential()).toBeNull();
  });
});
