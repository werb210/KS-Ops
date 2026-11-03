// KS_SHARED_HOSTING_v1 - the registry's encryption, the same in every repository:
//   key    = SHA-256(KS_TENANT_KEY)  (any length string -> 32-byte AES-256 key)
//   format = "v1:<iv base64>:<auth tag base64>:<ciphertext base64>", AES-256-GCM, 12-byte random IV, UTF-8 plaintext.
// env_enc decrypts to a JSON object of string values.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function tenantKey(raw: string): Buffer | null {
  return raw ? createHash("sha256").update(raw, "utf8").digest() : null;
}

export function encryptTenant(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decryptTenant(stored: string, key: Buffer): string {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unknown_tenant_secret_format");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("unknown_tenant_secret_format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
}

/** env_enc -> object of strings. An empty column is an empty object. */
export function decryptEnv(stored: string, key: Buffer): Record<string, string> {
  if (!stored) return {};
  const parsed = JSON.parse(decryptTenant(stored, key)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tenant_env_not_an_object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

export function encryptEnv(values: Record<string, string>, key: Buffer): string {
  const clean: Record<string, string> = {};
  for (const k of Object.keys(values).sort()) if (typeof values[k] === "string") clean[k] = values[k];
  return encryptTenant(JSON.stringify(clean), key);
}
