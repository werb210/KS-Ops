// The shared fraud watchlist across Keystone licensees. Only keyed hashes are stored (see migrations/003_watchlist.sql).
//   opt-in / opt-out (opting out deletes everything the licensee shared)
//   report   - replace the entries for one confirmed-fraud file (application_ref is an opaque hash from the licensee)
//   withdraw - delete one file's entries (the file was restored out of Fraud)
//   check    - which of these hashes were reported by OTHER licensees, and by how many
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Q } from "./db.js";

export const WATCH_KINDS = ["phone", "email", "business_number", "address", "bank_account", "person"] as const;
export const MAX_ENTRIES = 50;

const entry = z.object({
  kind: z.enum(WATCH_KINDS),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "hash must be 64 hex characters"),
});

export const reportSchema = z.object({
  application_ref: z.string().regex(/^[0-9a-f]{32,128}$/, "application_ref must be a hex hash"),
  entries: z.array(entry).max(MAX_ENTRIES, `at most ${MAX_ENTRIES} entries`),
});

export const withdrawSchema = z.object({ application_ref: reportSchema.shape.application_ref });
export const checkSchema = z.object({ entries: z.array(entry).min(1, "entries is required").max(MAX_ENTRIES, `at most ${MAX_ENTRIES} entries`) });
export const optInSchema = z.object({ opt_in: z.boolean({ error: (iss) => (iss.input === undefined ? "opt_in is required" : "opt_in must be true or false") }) });

/** The hash as stored: keyed once more with KS_WATCHLIST_OPS_PEPPER when it is set. Never change that value once used. */
export function storedHash(hash: string, env: NodeJS.ProcessEnv = process.env): string {
  const pepper = String(env.KS_WATCHLIST_OPS_PEPPER ?? "").trim();
  return pepper ? createHmac("sha256", pepper).update(hash).digest("hex") : hash;
}

export async function setOptIn(db: Q, licenseeId: string, optIn: boolean, now: Date): Promise<{ removed: number }> {
  await db.query(`UPDATE licensees SET watchlist_opt_in = $2, watchlist_opt_in_at = $3 WHERE id = $1`, [licenseeId, optIn, optIn ? now : null]);
  if (optIn) return { removed: 0 };
  const r = await db.query(`DELETE FROM watchlist_entries WHERE licensee_id = $1`, [licenseeId]);
  return { removed: r.rowCount ?? 0 };
}

export async function replaceReport(db: Q, licenseeId: string, ref: string, entries: Array<{ kind: string; hash: string }>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  await db.query(`DELETE FROM watchlist_entries WHERE licensee_id = $1 AND application_ref = $2`, [licenseeId, ref]);
  let stored = 0;
  for (const e of entries) {
    const r = await db.query(
      `INSERT INTO watchlist_entries (licensee_id, application_ref, kind, hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (licensee_id, application_ref, kind, hash) DO NOTHING`,
      [licenseeId, ref, e.kind, storedHash(e.hash, env)],
    );
    stored += r.rowCount ?? 0;
  }
  return stored;
}

export async function withdraw(db: Q, licenseeId: string, ref: string): Promise<number> {
  const r = await db.query(`DELETE FROM watchlist_entries WHERE licensee_id = $1 AND application_ref = $2`, [licenseeId, ref]);
  return r.rowCount ?? 0;
}

export type WatchMatch = { kind: string; hash: string; brokerages: number; reports: number };

/** Matches reported by other opted-in licensees. The answer carries the caller's own hashes back, nothing else. */
export async function checkEntries(db: Q, licenseeId: string, entries: Array<{ kind: string; hash: string }>, env: NodeJS.ProcessEnv = process.env): Promise<WatchMatch[]> {
  const byStored = new Map(entries.map((e) => [storedHash(e.hash, env), e]));
  const r = await db.query(
    `SELECT w.hash, w.kind, COUNT(DISTINCT w.licensee_id)::int AS brokerages, COUNT(DISTINCT (w.licensee_id, w.application_ref))::int AS reports
       FROM watchlist_entries w JOIN licensees l ON l.id = w.licensee_id
      WHERE w.hash = ANY($1::text[]) AND w.licensee_id <> $2 AND l.watchlist_opt_in = true
      GROUP BY w.hash, w.kind`,
    [[...byStored.keys()], licenseeId],
  );
  const out: WatchMatch[] = [];
  for (const row of r.rows) {
    const mine = byStored.get(row.hash);
    if (mine && mine.kind === row.kind) out.push({ kind: mine.kind, hash: mine.hash, brokerages: row.brokerages, reports: row.reports });
  }
  return out;
}

export async function watchlistStats(db: Q): Promise<{ opted_in_licensees: number; files: number; entries: number }> {
  const r = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM licensees WHERE watchlist_opt_in) AS opted_in_licensees,
            (SELECT COUNT(DISTINCT (licensee_id, application_ref))::int FROM watchlist_entries) AS files,
            (SELECT COUNT(*)::int FROM watchlist_entries) AS entries`,
  );
  const row = r.rows[0] ?? {};
  return { opted_in_licensees: row.opted_in_licensees ?? 0, files: row.files ?? 0, entries: row.entries ?? 0 };
}
