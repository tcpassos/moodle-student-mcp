/**
 * Link login: sign in from any device, even when this server has no browser.
 *
 * 1. The server creates a one-time P-256 key pair and a passport, keeps the
 *    private key in a 0600 file, and hands out a link to the static helper
 *    page with the public key in the URL fragment (never sent to a server).
 * 2. The helper page sends the user to Moodle's launch.php; after sign-in
 *    Moodle hands the token back to the page (protocol handler, or the user
 *    pastes the "launch the app" link).
 * 3. The page encrypts `siteid:::token` to the server's public key (ECDH +
 *    HKDF-SHA256 + AES-256-GCM) and shows a short code.
 * 4. The user pastes the code in the chat. The model only ever sees
 *    ciphertext that nobody but this server can open; the server decrypts,
 *    checks the passport signature and saves the token.
 */

import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { configDir, loginHelperUrl } from "../config.js";
import { newPassport, parsePlainPayload, payloadMatchesSite, type LaunchPayload } from "./launch.js";
import { readJson, writePrivateFile } from "./store.js";

export const CODE_PREFIX = "msmcp1.";
export const KDF_INFO = "moodle-student-mcp/login/v1";
const PENDING_TTL_MS = 15 * 60 * 1000;

export interface PendingLogin {
  siteUrl: string;
  passport: string;
  privateKey: string;
  publicKey: string;
  createdAt: string;
  expiresAt: string;
}

const pendingFile = () => join(configDir(), "pending-login.json");

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export async function startLinkLogin(siteUrl: string): Promise<{ url: string; expiresAt: string }> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const now = Date.now();
  const pending: PendingLogin = {
    siteUrl,
    passport: newPassport(),
    privateKey: ecdh.getPrivateKey("hex"),
    publicKey: base64url(ecdh.getPublicKey()),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_TTL_MS).toISOString(),
  };
  await writePrivateFile(pendingFile(), JSON.stringify(pending, null, 2));

  const fragment = new URLSearchParams({ v: "1", site: siteUrl, passport: pending.passport, pk: pending.publicKey });
  return { url: `${loginHelperUrl()}#${fragment.toString()}`, expiresAt: pending.expiresAt };
}

export async function loadPendingLogin(): Promise<PendingLogin | null> {
  const pending = await readJson<PendingLogin>(pendingFile());
  if (!pending) return null;
  if (Date.parse(pending.expiresAt) < Date.now()) {
    await clearPendingLogin();
    return null;
  }
  return pending;
}

export async function clearPendingLogin(): Promise<void> {
  await rm(pendingFile(), { force: true });
}

export function looksLikeLoginCode(text: string): boolean {
  return text.replace(/\s+/g, "").startsWith(CODE_PREFIX);
}

/** Decrypt a login code produced by the helper page for `pending`. */
export function decryptLoginCode(code: string, pending: Pick<PendingLogin, "privateKey" | "passport">): string {
  const compact = code.replace(/\s+/g, "");
  if (!compact.startsWith(CODE_PREFIX)) throw new Error("This is not a Moodle login code.");
  const bytes = Buffer.from(compact.slice(CODE_PREFIX.length), "base64url");
  if (bytes.length < 65 + 12 + 16 + 1) throw new Error("The login code is incomplete. Copy it again.");

  const ephemeralPublicKey = bytes.subarray(0, 65);
  const iv = bytes.subarray(65, 77);
  const ciphertext = bytes.subarray(77, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(pending.privateKey, "hex"));
  const shared = ecdh.computeSecret(ephemeralPublicKey);
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(pending.passport, "utf8"), KDF_INFO, 32));

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("This login code does not belong to the current login attempt. Start the login again.");
  }
}

/** Turn a pasted code into a verified payload for the pending login. */
export async function completeLinkLogin(code: string): Promise<{ siteUrl: string; payload: LaunchPayload }> {
  const pending = await loadPendingLogin();
  if (!pending) throw new Error("No login is waiting for a code (it may have expired). Start the login again.");
  const payload = parsePlainPayload(decryptLoginCode(code, pending));
  if (!payload) throw new Error("The login code is malformed. Start the login again.");
  if (!payloadMatchesSite(payload, [pending.siteUrl], pending.passport)) {
    throw new Error(`The login code was issued by a different site than ${pending.siteUrl}.`);
  }
  await clearPendingLogin();
  return { siteUrl: pending.siteUrl, payload };
}
