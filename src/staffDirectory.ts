// KS_STAFF_DIRECTORY_v1 - which brokerage(s) a staff member belongs to, from their work email or mobile number.
//
// Replaces typing a company code in the Keystone dialler and iPad portal. How KS-Ops learns each licensee's staff:
// the licensee's KS-server pushes the FULL list of its active staff identifiers, as hashes, whenever a user is
// created or changed and again on a timer (POST /api/licensees/:id/staff-directory, X-KS-Ops-Key). A full list
// replaces the previous one, so a missed push or a user changed outside the normal screens is corrected by the next
// one; KS-Ops never has to reach into a licensee's server, and a licensee server that is down does not slow lookups.
//
// The hash is the same on both sides (see KS-server src/staffDirectory/hash.ts):
//   SHA-256("ks-staff-directory:v1:" + kind + ":" + value)
//   email: trimmed and lower-cased; phone: North American, as +1 and ten digits.
// Stored hashes are keyed once more with KS_STAFF_DIRECTORY_PEPPER when it is set (never change it once used).
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { Q } from "./db.js";
import { DIRECTORY_STATUSES } from "./licensees/validation.js";

export const STAFF_KINDS = ["email", "phone"] as const;
export type StaffKind = (typeof STAFF_KINDS)[number];
export const MAX_STAFF_ENTRIES = 5000;
const HASH_PREFIX = "ks-staff-directory:v1:";

export const staffDirectorySchema = z.object({
  entries: z
    .array(z.object({ kind: z.enum(STAFF_KINDS), hash: z.string().regex(/^[0-9a-f]{64}$/, "hash must be 64 hex characters") }))
    .max(MAX_STAFF_ENTRIES, `at most ${MAX_STAFF_ENTRIES} entries`),
});

export const lookupSchema = z.object({
  identifier: z.string({ required_error: "identifier is required" }).trim().min(3).max(254),
});

/** A typed email or phone number as { kind, value }, or null when it is neither. */
export function normalizeIdentifier(raw: unknown): { kind: StaffKind; value: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (s.includes("@")) {
    const email = s.toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { kind: "email", value: email };
  }
  if (/[^0-9+().\s-]/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return { kind: "phone", value: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) return { kind: "phone", value: `+${digits}` };
  return null;
}

/** The hash a licensee server sends for one identifier. */
export function identifierHash(kind: StaffKind, value: string): string {
  return createHash("sha256").update(`${HASH_PREFIX}${kind}:${value}`).digest("hex");
}

/** The hash as stored: keyed with KS_STAFF_DIRECTORY_PEPPER when it is set. */
export function storedStaffHash(hash: string, env: NodeJS.ProcessEnv = process.env): string {
  const pepper = String(env.KS_STAFF_DIRECTORY_PEPPER ?? "").trim();
  return pepper ? createHmac("sha256", pepper).update(hash).digest("hex") : hash;
}

/** Replaces one licensee's staff list with `entries`. Returns how many entries it now has. */
export async function replaceStaffDirectory(
  db: Q,
  licenseeId: string,
  entries: Array<{ kind: StaffKind; hash: string }>,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const unique = new Map<string, { kind: StaffKind; hash: string }>();
  for (const e of entries) {
    const stored = storedStaffHash(e.hash, env);
    unique.set(`${e.kind}:${stored}`, { kind: e.kind, hash: stored });
  }
  const kinds = [...unique.values()].map((e) => e.kind);
  const hashes = [...unique.values()].map((e) => e.hash);
  // Remove what is no longer there, then add what is new (both by content, so a repeat push changes nothing).
  await db.query(
    `DELETE FROM staff_directory_entries d
      WHERE d.licensee_id = $1
        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS n(kind, hash) WHERE n.kind = d.kind AND n.hash = d.hash)`,
    [licenseeId, kinds, hashes],
  );
  if (hashes.length) {
    await db.query(
      `INSERT INTO staff_directory_entries (licensee_id, kind, hash)
       SELECT $1, n.kind, n.hash FROM unnest($2::text[], $3::text[]) AS n(kind, hash)
       ON CONFLICT (licensee_id, kind, hash) DO NOTHING`,
      [licenseeId, kinds, hashes],
    );
  }
  await db.query(`UPDATE licensees SET staff_directory_synced_at = $2, staff_directory_count = $3 WHERE id = $1`, [
    licenseeId,
    now,
    hashes.length,
  ]);
  return hashes.length;
}

export type StaffMatch = { name: string; server_url: string };

/** The live brokerages whose staff list holds this identifier: display name and server address only. */
export async function lookupStaff(db: Q, raw: unknown, env: NodeJS.ProcessEnv = process.env): Promise<StaffMatch[]> {
  const id = normalizeIdentifier(raw);
  // An unusable identifier still runs the same query (with a hash nothing can match), so it takes the same time.
  const hash = storedStaffHash(id ? identifierHash(id.kind, id.value) : identifierHash("email", "\u0000"), env);
  const r = await db.query(
    `SELECT DISTINCT l.company_name, l.server_url
       FROM staff_directory_entries e JOIN licensees l ON l.id = e.licensee_id
      WHERE e.hash = $1 AND e.kind = $2 AND l.status = ANY($3::text[]) AND l.server_url IS NOT NULL
      ORDER BY l.company_name`,
    [hash, id?.kind ?? "email", DIRECTORY_STATUSES],
  );
  return r.rows.map((row) => ({ name: String(row.company_name), server_url: String(row.server_url) }));
}
