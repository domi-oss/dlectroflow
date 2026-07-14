// AES-256-GCM encryption for OAuth token columns. Pure (no Prisma/SDK imports).
// Envelope: "v1:" + base64( iv(12) | authTag(16) | ciphertext ). See
// docs/superpowers/specs/2026-07-13-token-encryption-design.md.
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Load + validate the key on every call (cheap; avoids stale caching in tests). */
function getKey(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENC_KEY is not set (64 hex chars required).");
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (64 hex chars); got ${key.length}.`,
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const sep = stored.indexOf(":");
  const version = sep === -1 ? "" : stored.slice(0, sep);
  const payload = sep === -1 ? "" : stored.slice(sep + 1);
  if (version !== VERSION || !payload) {
    throw new Error("Unrecognized token envelope (expected v1).");
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Malformed token envelope.");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptNullable(v: string | null | undefined): string | null {
  return v == null ? null : encryptToken(v);
}

/**
 * Decrypt a stored token, treating any undecryptable value as "absent" (null).
 * A null/undefined column is null; a value that fails to decrypt (wrong key
 * after rotation, corruption, a stray non-`v1:` value) also yields null rather
 * than throwing — so token reads degrade to "not connected" (prompting a
 * reconnect) instead of surfacing a 500 on every focus/schedule action. Use
 * `decryptToken` directly when a decryption failure should be fatal.
 */
export function decryptNullable(v: string | null | undefined): string | null {
  if (v == null) return null;
  try {
    return decryptToken(v);
  } catch {
    return null;
  }
}
