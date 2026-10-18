// Pure helpers for the sign-in helper page. No DOM access here, so the same
// module runs in Node tests (WebCrypto is global in Node >= 19).

export const HANDLER_SCHEME = "web+moodlestudent";
export const CODE_PREFIX = "msmcp1.";
export const KDF_INFO = "moodle-student-mcp/login/v1";
export const PENDING_TTL_MS = 15 * 60 * 1000;

const TOKEN_LINK = /[a-z][a-z0-9+.-]*:\/\/token=([A-Za-z0-9+/=_-]+)/i;

const utf8 = (text) => new TextEncoder().encode(text);

export function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Validate the parameters the MCP server put in the link. */
export function parseStartParams(params) {
  const site = params.get("site") ?? "";
  const passport = params.get("passport") ?? "";
  const pk = params.get("pk") ?? "";
  let url;
  try {
    url = new URL(site);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (!/^[0-9a-f]{16,64}$/i.test(passport)) return null;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(pk)) return null;
  return { site: site.replace(/\/+$/, ""), passport, pk };
}

/** The launch.php address that hands the token to this page. */
export function moodleLaunchUrl(site, passport) {
  const params = new URLSearchParams({
    service: "moodle_mobile_app",
    passport,
    urlscheme: HANDLER_SCHEME,
    confirmed: "1",
  });
  return `${site}/admin/tool/mobile/launch.php?${params.toString()}`;
}

/** Decode `scheme://token=BASE64` (also URL-encoded) into `{ siteId, token }`. */
export function decodeTokenLink(text) {
  let candidate = String(text).trim();
  try {
    if (/%3A%2F%2F/i.test(candidate)) candidate = decodeURIComponent(candidate);
  } catch {
    // Leave as is.
  }
  const match = TOKEN_LINK.exec(candidate);
  if (!match) return null;
  let raw;
  try {
    raw = new TextDecoder().decode(base64urlDecode(match[1]));
  } catch {
    return null;
  }
  const [siteId, token] = raw.split(":::");
  if (!siteId || !token || !/^[A-Za-z0-9]+$/.test(token)) return null;
  return { siteId, token };
}

/**
 * Encrypt `plaintext` so only the MCP server holding the private key for
 * `serverPublicKey` can read it: ephemeral ECDH P-256 -> HKDF-SHA256
 * (salt = passport) -> AES-256-GCM. Output: prefix + base64url(ephemeral
 * public key | iv | ciphertext+tag).
 */
export async function encryptForServer(serverPublicKey, passport, plaintext) {
  const subtle = globalThis.crypto.subtle;
  const serverKey = await subtle.importKey(
    "raw",
    base64urlDecode(serverPublicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, ephemeral.privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(passport), info: utf8(KDF_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, utf8(plaintext)));
  const publicRaw = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));

  const out = new Uint8Array(publicRaw.length + iv.length + ciphertext.length);
  out.set(publicRaw, 0);
  out.set(iv, publicRaw.length);
  out.set(ciphertext, publicRaw.length + iv.length);
  return CODE_PREFIX + base64urlEncode(out);
}

/** Build the code to paste back from a token link and the pending login. */
export async function codeFromTokenLink(link, pending) {
  const payload = decodeTokenLink(link);
  if (!payload) return null;
  return encryptForServer(pending.pk, pending.passport, `${payload.siteId}:::${payload.token}`);
}
