// KS_OPS_AUTO_PROVISION_v1 - the opaque token behind the website's "We're setting up your system" page.
//
// token = base64url(licensee id as 16 bytes || first 16 bytes of HMAC-SHA256(key, "ks-provision-status:" + id))
// The key is derived from OPS_ENCRYPTION_KEY. It is stable (the same link works from the Stripe success page and from
// an email), unguessable (128-bit MAC) and needs no storage. It only ever shows setup progress and, once ready, the
// licensee's public portal address.
import { createHmac, timingSafeEqual } from "node:crypto";
import { encryptionKey } from "../lib/crypto.js";
import { UUID_RE } from "../lib/http.js";

function macKey(): Buffer | null {
  const k = encryptionKey();
  return k ? createHmac("sha256", k).update("ks-provision-status-key").digest() : null;
}

function mac(key: Buffer, id: string): Buffer {
  return createHmac("sha256", key).update(`ks-provision-status:${id.toLowerCase()}`).digest().subarray(0, 16);
}

/** The status token for a licensee, or null when OPS_ENCRYPTION_KEY is not set. */
export function statusTokenFor(licenseeId: string): string | null {
  const key = macKey();
  if (!key || !UUID_RE.test(licenseeId)) return null;
  const idBytes = Buffer.from(licenseeId.replace(/-/g, ""), "hex");
  return Buffer.concat([idBytes, mac(key, licenseeId)]).toString("base64url");
}

/** The licensee id inside a valid token, or null. */
export function licenseeIdFromStatusToken(token: unknown): string | null {
  const key = macKey();
  if (!key || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const buf = Buffer.from(token, "base64url");
  if (buf.length !== 32) return null;
  const hex = buf.subarray(0, 16).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return timingSafeEqual(buf.subarray(16), mac(key, id)) ? id : null;
}
