// Secrets: ops keys, signup tokens and their hashes.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Compares a presented secret with a stored sha256 hex hash in constant time. */
export function matchesHash(given: unknown, storedHashHex: string | null | undefined): boolean {
  if (!storedHashHex || typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(given).digest();
  let b: Buffer;
  try {
    b = Buffer.from(storedHashHex, "hex");
  } catch {
    return false;
  }
  if (b.length !== a.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time comparison of two strings of any length (both are hashed first). */
export function safeEqual(given: unknown, expected: string): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** A new random secret, URL-safe. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** OPS_ENCRYPTION_KEY as 32 bytes: 64 hex characters or base64 of 32 bytes. Null when unset or wrong length. */
export function encryptionKey(raw: string = String(process.env.OPS_ENCRYPTION_KEY ?? "").trim()): Buffer | null {
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

/** AES-256-GCM. Output: "v1:" + base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(stored: string, key: Buffer): string {
  if (!stored.startsWith("v1:")) throw new Error("unknown_secret_format");
  const buf = Buffer.from(stored.slice(3), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
