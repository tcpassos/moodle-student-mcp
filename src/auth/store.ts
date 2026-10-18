/**
 * Persistent sign-in: non-secret session details in `session.json` and the
 * token in the OS credential store (Windows Credential Manager, macOS
 * Keychain, Linux Secret Service). Where no credential store is available
 * (headless Linux, containers) the token goes to a 0600 file instead.
 * Nothing is ever written inside the user's project.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_NAME, configDir, env } from "../config.js";

export interface Session {
  siteUrl: string;
  userId: number;
  fullName?: string;
  username?: string;
  siteName?: string;
  store: "keychain" | "file";
  savedAt: string;
}

const sessionFile = () => join(configDir(), "session.json");
const tokenFile = () => join(configDir(), "token");

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

export async function loadSession(): Promise<Session | null> {
  return readJson<Session>(sessionFile());
}

export async function loadCredential(): Promise<{ session: Session; token: string } | null> {
  const session = await loadSession();
  if (!session?.siteUrl) return null;
  let token: string | null = null;
  if (session.store === "keychain") {
    const entry = await keyringEntry(session.siteUrl);
    token = entry ? await entry.getPassword().catch(() => null) : null;
  } else {
    token = (await readFile(tokenFile(), "utf8").catch(() => "")).trim() || null;
  }
  return token ? { session, token } : null;
}

/** Remove the saved sign-in. Returns true if something was removed. */
export async function clearCredential(): Promise<boolean> {
  const session = await loadSession();
  let removed = false;
  if (session?.siteUrl) {
    const entry = await keyringEntry(session.siteUrl);
    removed = (await entry?.deletePassword().catch(() => false)) ?? false;
  }
  for (const path of [tokenFile(), sessionFile()]) {
    try {
      await rm(path);
      removed = true;
    } catch {
      // Not there.
    }
  }
  return removed;
}
