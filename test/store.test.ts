import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDir, legacyConfigDirs } from "../src/config.js";
import { NotSignedInError, resolveCredential } from "../src/auth/credentials.js";
import { clearCredential, loadCredential, saveCredential, type Session } from "../src/auth/store.js";

// An in-memory OS credential store, so tests never touch the real one.
const keyring = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly key: string;
    constructor(service: string, account: string) {
      this.key = `${service}|${account}`;
    }
    async setPassword(password: string) {
      keyring.set(this.key, password);
    }
    async getPassword() {
      return keyring.get(this.key) ?? null;
    }
    async deletePassword() {
      return keyring.delete(this.key);
    }
  },
}));

const SITE = "https://moodle.example.edu";
const KEY = `moodle-student-mcp|${SITE}`;
const VARS = [
  "MOODLE_STUDENT_MCP_HOME",
  "MOODLE_CREDENTIAL_STORE",
  "MOODLE_URL",
  "MOODLE_TOKEN",
  "MOODLE_TOKEN_FILE",
  "MOODLE_USERNAME",
  "MOODLE_PASSWORD",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];
const realPlatform = process.platform;
let savedEnv: Record<string, string | undefined>;
let profile: string;

const appDataCopy = () => join(profile, "AppData", "Roaming", "moodle-student-mcp");
const packageCopy = (name: string) =>
  join(profile, "AppData", "Local", "Packages", name, "LocalCache", "Roaming", "moodle-student-mcp");

async function writeLegacy(dir: string, session: Partial<Session> = {}, token?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const saved = { siteUrl: SITE, userId: 5, store: "keychain", savedAt: "2026-10-01T10:00:00.000Z", ...session };
  await writeFile(join(dir, "session.json"), JSON.stringify(saved));
  if (token !== undefined) await writeFile(join(dir, "token"), token);
}

async function notSignedInReason(): Promise<string> {
  const error = await resolveCredential().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NotSignedInError);
  return (error as NotSignedInError).reason;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  Object.defineProperty(process, "platform", { value: "win32" });
  profile = join(await mkdtemp(join(tmpdir(), "msmcp-win-")), "profile");
  process.env.USERPROFILE = profile;
  process.env.APPDATA = join(profile, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(profile, "AppData", "Local");
  keyring.clear();
  // Guard: everything below must stay inside the temporary profile.
  expect(configDir()).toBe(join(profile, ".moodle-student-mcp"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("config folder on Windows", () => {
  it("lives in the user profile, outside the AppData that packaged apps virtualize", () => {
    expect(configDir()).toBe(join(profile, ".moodle-student-mcp"));
  });

  it("lists the old AppData folder and the packaged apps' private copies of it", async () => {
    await mkdir(join(profile, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
    await mkdir(join(profile, "AppData", "Local", "Packages", "Other.App_123"), { recursive: true });
    const [first, ...copies] = await legacyConfigDirs();
    expect(first).toBe(appDataCopy());
    expect(copies.sort()).toEqual([packageCopy("Claude_pzs8sxrjxfjjc"), packageCopy("Other.App_123")].sort());
  });

  it("uses MOODLE_STUDENT_MCP_HOME as is, without looking at legacy folders", async () => {
    process.env.MOODLE_STUDENT_MCP_HOME = join(profile, "custom");
    await writeLegacy(appDataCopy());
    expect(configDir()).toBe(resolve(profile, "custom"));
    expect(await legacyConfigDirs()).toEqual([]);
    expect(await loadCredential()).toBeNull();
  });
});

describe("sign-ins saved by earlier versions", () => {
  it("picks up a sign-in Claude Desktop kept in its private AppData copy", async () => {
    keyring.set(KEY, "tok123");
    await writeLegacy(packageCopy("Claude_pzs8sxrjxfjjc"), { fullName: "Ana" });

    expect(await resolveCredential()).toMatchObject({
      siteUrl: SITE,
      token: "tok123",
      source: "saved sign-in",
      session: { fullName: "Ana" },
      savedIn: configDir(),
    });
    // Copied into the new folder; the original stays for older versions still running in the app.
    expect(JSON.parse(await readFile(join(configDir(), "session.json"), "utf8"))).toMatchObject({ fullName: "Ana" });
    expect(existsSync(join(packageCopy("Claude_pzs8sxrjxfjjc"), "session.json"))).toBe(true);
  });

  it("copies a file-store token from the old AppData folder", async () => {
    await writeLegacy(appDataCopy(), { store: "file" }, "filetok\n");
    expect(await loadCredential()).toMatchObject({ token: "filetok", dir: configDir() });
    expect(await readFile(join(configDir(), "token"), "utf8")).toBe("filetok\n");
  });

  it("takes the newest of several legacy sign-ins", async () => {
    keyring.set(KEY, "tok");
    await writeLegacy(appDataCopy(), { fullName: "Old", savedAt: "2026-09-01T10:00:00.000Z" });
    await writeLegacy(packageCopy("Claude_pzs8sxrjxfjjc"), { fullName: "New", savedAt: "2026-10-15T10:00:00.000Z" });
    expect((await loadCredential())?.session.fullName).toBe("New");
  });

  it("prefers the sign-in in the new folder over legacy copies", async () => {
    await saveCredential({ siteUrl: SITE, userId: 5, fullName: "Current" }, "current");
    await writeLegacy(packageCopy("Claude_pzs8sxrjxfjjc"), { fullName: "Legacy", savedAt: "2099-01-01T00:00:00.000Z" });
    expect(await loadCredential()).toMatchObject({ token: "current", session: { fullName: "Current" } });
  });

  it("logs out of every copy, so a legacy one cannot come back", async () => {
    keyring.set(KEY, "tok");
    await writeLegacy(appDataCopy());
    await writeLegacy(packageCopy("Claude_pzs8sxrjxfjjc"));
    await loadCredential();

    expect(await clearCredential()).toBe(true);
    expect(await loadCredential()).toBeNull();
    expect(keyring.size).toBe(0);
    expect(existsSync(join(appDataCopy(), "session.json"))).toBe(false);
    expect(existsSync(join(packageCopy("Claude_pzs8sxrjxfjjc"), "session.json"))).toBe(false);
  });
});

describe("saved sign-in whose token cannot be read", () => {
  it("says the OS credential store lost the token instead of just 'not signed in'", async () => {
    await saveCredential({ siteUrl: SITE, userId: 5 }, "tok");
    keyring.clear();
    const reason = await notSignedInReason();
    expect(reason).toContain(`Found the saved Moodle sign-in for ${SITE}`);
    expect(reason).toContain(join(configDir(), "session.json"));
    expect(reason).toMatch(/Windows Credential Manager has no "moodle-student-mcp" entry/);
    expect(reason).toMatch(/Sign in again/);
  });

  it("names the missing token file of the file store", async () => {
    process.env.MOODLE_CREDENTIAL_STORE = "file";
    await saveCredential({ siteUrl: SITE, userId: 5 }, "tok");
    await rm(join(configDir(), "token"));
    expect(await notSignedInReason()).toContain(`the token file ${join(configDir(), "token")} is missing`);
  });

  it("still ignores a saved sign-in for a different MOODLE_URL", async () => {
    await saveCredential({ siteUrl: SITE, userId: 5 }, "tok");
    keyring.clear();
    process.env.MOODLE_URL = "https://other.example.edu";
    expect(await resolveCredential()).toBeNull();
  });
});
