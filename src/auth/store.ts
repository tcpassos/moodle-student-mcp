/**
 * Persistent sign-in: non-secret session details in `session.json` and the
 * token in the OS credential store (Windows Credential Manager, macOS
 * Keychain, Linux Secret Service). Where no credential store is available
 * (headless Linux, containers) the token goes to a 0600 file instead.
 * Nothing is ever written inside the user's project.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_NAME, configDir, env, legacyConfigDirs } from "../config.js";

export interface Session {
  siteUrl: string;
  userId: number;
  fullName?: string;
  username?: string;
  siteName?: string;
  store: "keychain" | "file";
  savedAt: string;
}

/** A saved sign-in and its folder; `token` is null, and `problem` says why, when the token cannot be read. */
export type SavedCredential = { session: Session; dir: string } & ({ token: string } | { token: null; problem: string });

interface Located {
  session: Session;
  dir: string;
}

const SESSION_FILE = "session.json";
const TOKEN_FILE = "token";
const sessionFile = () => join(configDir(), SESSION_FILE);
const tokenFile = () => join(configDir(), TOKEN_FILE);

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

type KeyringEntry = {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | null>;
  deletePassword(): Promise<boolean>;
};

async function keyringEntry(account: string): Promise<KeyringEntry | null> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(APP_NAME, account) as KeyringEntry;
  } catch {
    return null;
  }
}

function preferredStore(): "auto" | "keychain" | "file" {
  const value = env("MOODLE_CREDENTIAL_STORE")?.toLowerCase();
  return value === "keychain" || value === "file" ? value : "auto";
}

function credentialStoreName(): string {
  if (process.platform === "win32") return "Windows Credential Manager";
  if (process.platform === "darwin") return "macOS Keychain";
  return "Secret Service keyring";
}

/** Save a verified token, replacing any previous sign-in. */
export async function saveCredential(details: Omit<Session, "store" | "savedAt">, token: string): Promise<Session> {
  await clearCredential();
  let store: Session["store"] = "file";
  const preference = preferredStore();
  if (preference !== "file") {
    const entry = await keyringEntry(details.siteUrl);
    try {
      if (!entry) throw new Error("No OS credential store available");
      await entry.setPassword(token);
      if ((await entry.getPassword()) !== token) throw new Error("OS credential store did not keep the token");
      store = "keychain";
    } catch (error) {
      if (preference === "keychain") throw error;
    }
  }
  if (store === "file") await writePrivateFile(tokenFile(), token);

  const session: Session = { ...details, store, savedAt: new Date().toISOString() };
  await writePrivateFile(sessionFile(), JSON.stringify(session, null, 2));
  return session;
}

async function readSession(dir: string): Promise<Session | null> {
  const session = await readJson<Session>(join(dir, SESSION_FILE));
  return typeof session?.siteUrl === "string" ? session : null;
}

/** Sessions saved by earlier versions in the legacy Windows locations, newest first. */
async function legacySessions(): Promise<Located[]> {
  const found = await Promise.all(
    (await legacyConfigDirs()).map(async (dir) => {
      const session = await readSession(dir);
      return session ? { session, dir } : null;
    }),
  );
  const savedAt = ({ session }: Located) => Date.parse(session.savedAt) || 0;
  return found.filter((entry): entry is Located => entry !== null).sort((a, b) => savedAt(b) - savedAt(a));
}

/**
 * The saved session. When the config folder has none but an earlier version
 * left one in a legacy location, it is copied into the config folder. The
 * original stays put, for older versions still running inside a packaged app;
 * logging out or signing in again removes it.
 */
async function locateSession(): Promise<Located | null> {
  const dir = configDir();
  const session = await readSession(dir);
  if (session) return { session, dir };
  const [legacy] = await legacySessions();
  if (!legacy) return null;
  try {
    if (legacy.session.store === "file") {
      const token = await readFile(join(legacy.dir, TOKEN_FILE), "utf8").catch(() => null);
      if (token) await writePrivateFile(tokenFile(), token);
    }
    await writePrivateFile(sessionFile(), JSON.stringify(legacy.session, null, 2));
    return { session: legacy.session, dir };
  } catch {
    return legacy; // Could not copy it: keep reading it where it is.
  }
}

export async function loadSession(): Promise<Session | null> {
  return (await locateSession())?.session ?? null;
}

async function readToken({ session, dir }: Located): Promise<{ token: string } | { problem: string }> {
  if (session.store !== "keychain") {
    const path = join(dir, TOKEN_FILE);
    const token = (await readFile(path, "utf8").catch(() => "")).trim();
    return token ? { token } : { problem: `the token file ${path} is missing or empty` };
  }
  const entry = await keyringEntry(session.siteUrl);
  if (!entry) {
    return { problem: "the OS credential store is not available to this program (the @napi-rs/keyring module did not load)" };
  }
  try {
    const token = await entry.getPassword();
    if (token) return { token };
    return {
      problem: `the ${credentialStoreName()} has no "${APP_NAME}" entry for this site (it was removed, or saved by another user account)`,
    };
  } catch (error) {
    return { problem: `the ${credentialStoreName()} failed (${error instanceof Error ? error.message : String(error)})` };
  }
}

export async function loadCredential(): Promise<SavedCredential | null> {
  const located = await locateSession();
  if (!located) return null;
  const result = await readToken(located);
  if ("token" in result) return { ...located, token: result.token };
  return {
    ...located,
    token: null,
    problem:
      `Found the saved Moodle sign-in for ${located.session.siteUrl} (${join(located.dir, SESSION_FILE)}), ` +
      `but could not read its token: ${result.problem}.`,
  };
}

async function removeSessionFiles(dir: string): Promise<boolean> {
  let removed = false;
  for (const path of [join(dir, TOKEN_FILE), join(dir, SESSION_FILE)]) {
    try {
      await rm(path);
      removed = true;
    } catch {
      // Not there.
    }
  }
  return removed;
}

/** Remove the saved sign-in, including copies earlier versions left behind. Returns true if something was removed. */
export async function clearCredential(): Promise<boolean> {
  const dir = configDir();
  const current = await readSession(dir);
  const saved = [...(current ? [{ session: current, dir }] : []), ...(await legacySessions())];
  let removed = false;
  for (const siteUrl of new Set(saved.map(({ session }) => session.siteUrl))) {
    const entry = await keyringEntry(siteUrl);
    if (await entry?.deletePassword().catch(() => false)) removed = true;
  }
  for (const target of new Set([dir, ...saved.map((entry) => entry.dir)])) {
    if (await removeSessionFiles(target)) removed = true;
  }
  return removed;
}
