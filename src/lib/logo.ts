// KS_OPS_v13_LOGO - the logo a licensee uploads on sign-up: PNG, JPG or SVG, at most 500 KB. Stored in licensee_logos
// (bytea) and served from GET /api/public/logos/<key>; that address goes into licensees.logo_url, so the logo reaches
// the directory and the licensee's settings the same way a logo link always has.
import type { Q } from "../db.js";
import { newSecret } from "./crypto.js";

export const MAX_LOGO_BYTES = 500 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export type LogoInput = { content_type: string; data_base64: string; filename?: string | null };
export type CheckedLogo = { contentType: LogoType; data: Buffer; filename: string | null };

/** SVG content that could run script or pull in other files when the image is opened on its own. */
const SVG_UNSAFE = /<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|<!DOCTYPE|\bon[a-z]+\s*=|javascript:|data:text\/html|xlink:href\s*=\s*["']?\s*(?!#)|\bhref\s*=\s*["']?\s*(?!#|data:image\/)/i;

/** What the bytes really are (the declared type is not trusted), or null. */
export function sniffLogo(data: Buffer): LogoType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const head = data.subarray(0, 4096).toString("utf8").replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/** Checks an uploaded logo. Returns the logo, or a message for the person. */
export function checkLogo(input: LogoInput): { ok: true; logo: CheckedLogo } | { ok: false; error: string } {
  const b64 = String(input.data_base64 ?? "").replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, error: "The logo file could not be read. Try a PNG, JPG or SVG." };
  const data = Buffer.from(b64, "base64");
  if (!data.length) return { ok: false, error: "The logo file is empty." };
  if (data.length > MAX_LOGO_BYTES) return { ok: false, error: "The logo is too large. Use a file under 500 KB." };
  const type = sniffLogo(data);
  if (!type) return { ok: false, error: "Use a PNG, JPG or SVG file for the logo." };
  if (type === "image/svg+xml" && SVG_UNSAFE.test(data.toString("utf8"))) {
    return { ok: false, error: "This SVG contains scripts or links we can't accept. Export it again as a plain SVG or a PNG." };
  }
  const filename = input.filename ? String(input.filename).replace(/[^A-Za-z0-9._ ()-]/g, "_").slice(0, 150) : null;
  return { ok: true, logo: { contentType: type, data, filename } };
}

/** Saves (or replaces) the licensee's logo and returns its public key. */
export async function saveLogo(db: Q, licenseeId: string, logo: CheckedLogo): Promise<string> {
  const key = newSecret(18);
  const r = await db.query(
    `INSERT INTO licensee_logos (licensee_id, logo_key, content_type, data, filename)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (licensee_id) DO UPDATE SET logo_key = EXCLUDED.logo_key, content_type = EXCLUDED.content_type,
       data = EXCLUDED.data, filename = EXCLUDED.filename, updated_at = now()
     RETURNING logo_key`,
    [licenseeId, key, logo.contentType, logo.data, logo.filename],
  );
  return String(r.rows[0]?.logo_key ?? key);
}

export async function logoByKey(db: Q, key: string): Promise<{ content_type: string; data: Buffer } | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return null;
  const r = await db.query("SELECT content_type, data FROM licensee_logos WHERE logo_key = $1", [key]);
  return (r.rows[0] as { content_type: string; data: Buffer } | undefined) ?? null;
}

export const logoPath = (key: string) => `/api/public/logos/${encodeURIComponent(key)}`;
