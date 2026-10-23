// Demo sign-ups and their progress events.
import type { Q } from "../db.js";
import type { DemoEvent, Digest } from "./digest.js";
import type { LenderEmail } from "./emails.js";

export type DemoSignup = {
  id: string; name: string; email: string; phone: string | null; company: string; ip: string | null; user_agent: string | null; token_hash: string;
  status: "pending" | "active" | "completed" | "wiped"; link_sends: number; last_link_sent_at: Date; server_session_id: string | null;
  opened_at: Date | null; open_count: number; first_activity_at: Date | null; last_activity_at: Date | null; event_count: number;
  completed_at: Date | null; expires_at: Date; digest: Partial<Digest>; package_filename: string | null; has_package?: boolean;
  prospect_package_sent_at: Date | null; sales_completed_sent_at: Date | null; sales_unfinished_sent_at: Date | null;
  mail_attempts: number; wiped_at: Date | null; created_at: Date; updated_at: Date;
};

const COLS = `id, name, email, phone, company, ip, user_agent, token_hash, status, link_sends, last_link_sent_at, server_session_id,
  opened_at, open_count, first_activity_at, last_activity_at, event_count, completed_at, expires_at, digest, package_filename,
  (package_pdf IS NOT NULL) AS has_package, prospect_package_sent_at, sales_completed_sent_at, sales_unfinished_sent_at,
  mail_attempts, wiped_at, created_at, updated_at`;

export async function getSignup(db: Q, id: string): Promise<DemoSignup | null> {
  const r = await db.query(`SELECT ${COLS} FROM demo_signups WHERE id = $1`, [id]);
  return (r.rows[0] as DemoSignup) ?? null;
}

/** The newest demo for this email that has not expired (any status but wiped). */
export async function liveSignupForEmail(db: Q, email: string, now: Date): Promise<DemoSignup | null> {
  const r = await db.query(
    `SELECT ${COLS} FROM demo_signups WHERE lower(email) = lower($1) AND status <> 'wiped' AND expires_at > $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, now],
  );
  return (r.rows[0] as DemoSignup) ?? null;
}

export async function countRecentForEmail(db: Q, email: string, since: Date): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM demo_signups WHERE lower(email) = lower($1) AND created_at > $2`, [email, since]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function countRecentForIp(db: Q, ip: string, since: Date): Promise<number> {
  if (!ip) return 0;
  const r = await db.query(`SELECT count(*)::int AS n FROM demo_signups WHERE ip = $1 AND created_at > $2`, [ip, since]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function countActive(db: Q, now: Date): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM demo_signups WHERE status IN ('pending','active') AND expires_at > $1`, [now]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function insertSignup(
  db: Q,
  s: { name: string; email: string; phone: string | null; company: string; ip: string; userAgent: string; tokenHash: string; expiresAt: Date; now: Date },
): Promise<DemoSignup> {
  const r = await db.query(
    `INSERT INTO demo_signups (name, email, phone, company, ip, user_agent, token_hash, expires_at, created_at, last_link_sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING ${COLS}`,
    [s.name, s.email, s.phone, s.company, s.ip || null, s.userAgent || null, s.tokenHash, s.expiresAt, s.now],
  );
  return r.rows[0] as DemoSignup;
}

/**
 * A fresh magic link for an existing demo (the old link stops working). A repeat sign-up also brings what the person just
 * typed: name and company replace the old ones, and a phone (when given) replaces the old phone. Returns the updated row.
 */
export async function replaceToken(
  db: Q, id: string, tokenHash: string, now: Date, phone: string | null = null,
  details: { name?: string | null; company?: string | null } = {},
): Promise<DemoSignup | null> {
  const r = await db.query(
    `UPDATE demo_signups SET token_hash = $2, link_sends = link_sends + 1, last_link_sent_at = $3, phone = COALESCE($4, phone),
            name = COALESCE($5, name), company = COALESCE($6, company), updated_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [id, tokenHash, now, phone, details.name ?? null, details.company ?? null],
  );
  return (r.rows[0] as DemoSignup) ?? null;
}

export async function markOpened(db: Q, id: string, serverSessionId: string): Promise<void> {
  await db.query(
    `UPDATE demo_signups SET server_session_id = $2, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            opened_at = COALESCE(opened_at, now()), open_count = open_count + 1, updated_at = now()
      WHERE id = $1`,
    [id, serverSessionId],
  );
}

export const MAX_EVENTS = 3000;

/** Stores events (up to MAX_EVENTS per demo) and moves the activity times forward. */
export async function addEvents(db: Q, id: string, events: Array<{ type: string; step: string | null; data: Record<string, unknown>; at: Date }>): Promise<number> {
  if (!events.length) return 0;
  const room = MAX_EVENTS - Number((await db.query(`SELECT event_count FROM demo_signups WHERE id = $1`, [id])).rows[0]?.event_count ?? 0);
  const take = events.slice(0, Math.max(0, room));
  if (take.length) {
    await db.query(
      `INSERT INTO demo_events (signup_id, type, step, data, at)
       SELECT $1, e.type, e.step, e.data, e.at
         FROM jsonb_to_recordset($2::jsonb) AS e(type text, step text, data jsonb, at timestamptz)`,
      [id, JSON.stringify(take.map((e) => ({ ...e, at: e.at.toISOString() })))],
    );
  }
  const times = events.map((e) => e.at.getTime());
  const submitted = events.some((e) => e.type === "submitted");
  await db.query(
    `UPDATE demo_signups SET event_count = event_count + $2,
            first_activity_at = LEAST(COALESCE(first_activity_at, $3), $3),
            last_activity_at = GREATEST(COALESCE(last_activity_at, $4), $4),
            completed_at = CASE WHEN $5 AND completed_at IS NULL THEN $4 ELSE completed_at END,
            status = CASE WHEN $5 AND status IN ('pending','active') THEN 'completed' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [id, take.length, new Date(Math.min(...times)), new Date(Math.max(...times)), submitted],
  );
  return take.length;
}

export async function eventsFor(db: Q, id: string): Promise<DemoEvent[]> {
  const r = await db.query(`SELECT type, step, data, at FROM demo_events WHERE signup_id = $1 ORDER BY at, id`, [id]);
  return r.rows as DemoEvent[];
}

/** The first package wins (a retried completion does not replace it). mail: the real lender email (KS_OPS_v12). */
export async function storePackage(db: Q, id: string, pdf: Buffer | null, filename: string, mail: LenderEmail | null = null): Promise<void> {
  await db.query(
    `UPDATE demo_signups SET
            package_mail = CASE WHEN package_pdf IS NULL AND package_mail IS NULL THEN $4::jsonb ELSE package_mail END,
            package_pdf = COALESCE(package_pdf, $2), package_filename = COALESCE(package_filename, $3),
            status = CASE WHEN status IN ('pending','active') THEN 'completed' ELSE status END,
            completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE id = $1`,
    [id, pdf, filename, mail ? JSON.stringify(mail) : null],
  );
}

export async function packageOf(db: Q, id: string): Promise<{ pdf: Buffer | null; filename: string; mail: LenderEmail | null } | null> {
  const r = await db.query(
    `SELECT package_pdf, package_filename, package_mail FROM demo_signups WHERE id = $1 AND (package_pdf IS NOT NULL OR package_mail IS NOT NULL)`,
    [id],
  );
  const row = r.rows[0];
  return row ? { pdf: (row.package_pdf as Buffer) ?? null, filename: String(row.package_filename ?? ""), mail: (row.package_mail as LenderEmail) ?? null } : null;
}

export async function setDigest(db: Q, id: string, digest: Digest): Promise<void> {
  await db.query(`UPDATE demo_signups SET digest = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(digest)]);
}

/** Marks one email as sent, only if it was not already (true when this call claimed it). */
export async function claimMail(db: Q, id: string, column: "prospect_package_sent_at" | "sales_completed_sent_at" | "sales_unfinished_sent_at"): Promise<boolean> {
  const allowed = ["prospect_package_sent_at", "sales_completed_sent_at", "sales_unfinished_sent_at"];
  if (!allowed.includes(column)) throw new Error("bad column");
  const r = await db.query(`UPDATE demo_signups SET ${column} = now(), updated_at = now() WHERE id = $1 AND ${column} IS NULL RETURNING id`, [id]);
  return (r.rowCount ?? r.rows.length) > 0;
}

export async function releaseMail(db: Q, id: string, column: "prospect_package_sent_at" | "sales_completed_sent_at" | "sales_unfinished_sent_at"): Promise<void> {
  const allowed = ["prospect_package_sent_at", "sales_completed_sent_at", "sales_unfinished_sent_at"];
  if (!allowed.includes(column)) throw new Error("bad column");
  await db.query(`UPDATE demo_signups SET ${column} = NULL, mail_attempts = mail_attempts + 1, updated_at = now() WHERE id = $1`, [id]);
}

/** Expired and wiped: drop the events and the package; keep the lead (name, email, company, digest) for sales. */
export async function markWiped(db: Q, id: string): Promise<void> {
  await db.query(`DELETE FROM demo_events WHERE signup_id = $1`, [id]);
  await db.query(
    `UPDATE demo_signups SET status = 'wiped', wiped_at = now(), package_pdf = NULL, package_mail = NULL, token_hash = '', updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** Never-opened sign-ups (the email was never proved): removed completely once expired. */
export async function deleteSignup(db: Q, id: string): Promise<void> {
  await db.query(`DELETE FROM demo_signups WHERE id = $1`, [id]);
}
