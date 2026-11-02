// KS_OPS_PROSPECT_MARKETING_v1 - sending: campaigns (now or scheduled), sequence steps and test sends.
//
// Campaigns: "send" snapshots the segment into ks_mkt_sends - eligible prospects queued, the rest stored as blocked
// with the reason - and the worker sends the queued ones from send_at on. Sequences: each active enrolment sends its
// next step when due, after checking the stop rules (reply, sign-up, demo booked since enrolment). Either way, the
// prospect's consent and the suppression list are checked again right before each email leaves (deliver()).
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { STOP_MESSAGES, stopReason, type BlockReason } from "./consent.js";
import { recordEvent } from "./events.js";
import { findProspects, prospectWithSuppression, eligibilityOf, type SegmentFilters } from "./prospects.js";
import { renderEmail, type TemplateFields } from "./render.js";
import { sendMarketingEmail } from "./sendgrid.js";
import { sendingProblem } from "./settings.js";

type EngineDeps = Pick<Deps, "db" | "fetch" | "now">;
const DAY_MS = 86_400_000;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_MS = 10 * 60_000;
export const BATCH = 50;

let problemLogged: string | null = null;
function canSendNow(): boolean {
  const p = sendingProblem();
  if (p && p !== problemLogged) console.warn(`[marketing] sending is waiting: ${p}`);
  problemLogged = p;
  return p === null;
}

export type DeliverOutcome = "sent" | "blocked" | "failed" | "retry";

/** Sends one queued row (or records why not). */
export async function deliver(
  deps: EngineDeps,
  send: { id: string | number; prospect_id: string; attempts: number },
  content: { subject: string; fields: Partial<TemplateFields>; label: string },
): Promise<{ outcome: DeliverOutcome; reason?: BlockReason | string }> {
  const now = deps.now();
  const p = await prospectWithSuppression(deps.db, send.prospect_id);
  if (!p) {
    await deps.db.query(`UPDATE ks_mkt_sends SET status = 'blocked', block_reason = 'prospect_deleted', lease_until = NULL WHERE id = $1`, [send.id]);
    return { outcome: "blocked", reason: "prospect_deleted" };
  }
  const ok = eligibilityOf(p, now);
  if (!ok.ok) {
    await deps.db.query(`UPDATE ks_mkt_sends SET status = 'blocked', block_reason = $2, lease_until = NULL WHERE id = $1`, [send.id, ok.reason]);
    await recordEvent(deps.db, p, "email_blocked", `Not sent (${content.label}): ${ok.message}`, now, { dedupeKey: `blocked:${send.id}`, sendId: send.id });
    return { outcome: "blocked", reason: ok.reason };
  }
  const email = renderEmail(content.subject, content.fields, p);
  const r = await sendMarketingEmail(deps.fetch, { email: p.email, name: p.name }, email, { ks_mkt_send_id: String(send.id) });
  if (r.ok) {
    await deps.db.query(
      `UPDATE ks_mkt_sends SET status = 'sent', sent_at = $2, sg_message_id = $3, subject = $4, attempts = attempts + 1, error = NULL, lease_until = NULL WHERE id = $1`,
      [send.id, now, r.message_id, email.subject],
    );
    await deps.db.query(`UPDATE ks_prospects SET last_emailed_at = $2 WHERE id = $1`, [p.id, now]);
    await recordEvent(deps.db, p, "email_sent", `Sent "${email.subject}" (${content.label}).`, now, { dedupeKey: `sent:${send.id}`, sendId: send.id, crm: true });
    return { outcome: "sent" };
  }
  const attempts = Number(send.attempts) + 1;
  if (r.permanent || attempts >= MAX_ATTEMPTS) {
    await deps.db.query(`UPDATE ks_mkt_sends SET status = 'failed', error = $2, attempts = $3, lease_until = NULL WHERE id = $1`, [send.id, r.error.slice(0, 500), attempts]);
    console.warn(`[marketing] send ${send.id} failed for good: ${r.error}`);
    return { outcome: "failed", reason: r.error };
  }
  await deps.db.query(`UPDATE ks_mkt_sends SET error = $2, attempts = $3, lease_until = $4 WHERE id = $1`, [send.id, r.error.slice(0, 500), attempts, new Date(now.getTime() + RETRY_MS)]);
  console.warn(`[marketing] send ${send.id} failed (attempt ${attempts}), retrying: ${r.error}`);
  return { outcome: "retry", reason: r.error };
}

// ---- campaigns ----

export async function queueCampaign(
  deps: Pick<Deps, "db" | "now">,
  campaignId: string,
  sendAt: Date,
): Promise<{ ok: true; queued: number; blocked: Record<string, number> } | { ok: false; status: number; error: string; message: string }> {
  const c = (await deps.db.query(`SELECT * FROM ks_mkt_campaigns WHERE id = $1`, [campaignId])).rows[0];
  if (!c) return { ok: false, status: 404, error: "not_found", message: "Campaign not found." };
  if (c.status !== "draft") return { ok: false, status: 409, error: "not_draft", message: "This campaign has already been scheduled or sent." };
  const problem = sendingProblem();
  if (problem) return { ok: false, status: 409, error: "sending_not_configured", message: problem };
  const { rows } = await findProspects(deps.db, (c.filters ?? {}) as SegmentFilters, deps.now(), { limit: 50_000 });
  const ids: string[] = [];
  const emails: string[] = [];
  const statuses: string[] = [];
  const reasons: Array<string | null> = [];
  const blocked: Record<string, number> = {};
  let queued = 0;
  for (const p of rows) {
    ids.push(p.id);
    emails.push(p.email);
    if (p.eligibility.ok) {
      statuses.push("queued");
      reasons.push(null);
      queued++;
    } else {
      statuses.push("blocked");
      reasons.push(p.eligibility.reason);
      blocked[p.eligibility.reason] = (blocked[p.eligibility.reason] ?? 0) + 1;
    }
  }
  const claim = await deps.db.query(
    `UPDATE ks_mkt_campaigns SET status = 'scheduled', send_at = $2, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id`,
    [campaignId, sendAt],
  );
  if (!claim.rows.length) return { ok: false, status: 409, error: "not_draft", message: "This campaign has already been scheduled or sent." };
  if (ids.length) {
    await deps.db.query(
      `INSERT INTO ks_mkt_sends (campaign_id, prospect_id, email, subject, status, block_reason)
       SELECT $1, x.pid::uuid, x.email, $2, x.status, x.reason
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) AS x(pid, email, status, reason)
       ON CONFLICT (campaign_id, prospect_id) WHERE campaign_id IS NOT NULL DO NOTHING`,
      [campaignId, c.subject, ids, emails, statuses, reasons],
    );
  }
  return { ok: true, queued, blocked };
}

/** Sends due campaign emails, BATCH per campaign per run. */
export async function runCampaigns(deps: EngineDeps): Promise<{ sent: number; blocked: number; failed: number }> {
  const out = { sent: 0, blocked: 0, failed: 0 };
  const now = deps.now();
  const due = await deps.db.query(
    `SELECT id, subject, fields, name, status FROM ks_mkt_campaigns WHERE status IN ('scheduled', 'sending') AND send_at <= $1 ORDER BY send_at LIMIT 5`,
    [now],
  );
  if (!due.rows.length || !canSendNow()) return out;
  for (const c of due.rows) {
    if (c.status === "scheduled") {
      await deps.db.query(`UPDATE ks_mkt_campaigns SET status = 'sending', started_at = coalesce(started_at, $2), updated_at = now() WHERE id = $1 AND status = 'scheduled'`, [c.id, now]);
    }
    const leased = await deps.db.query(
      `UPDATE ks_mkt_sends SET lease_until = $3
        WHERE id IN (SELECT id FROM ks_mkt_sends WHERE campaign_id = $1 AND status = 'queued' AND (lease_until IS NULL OR lease_until <= $2)
                      ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, prospect_id, attempts`,
      [c.id, now, new Date(now.getTime() + LEASE_MS)],
    );
    for (const s of leased.rows) {
      const r = await deliver(deps, s, { subject: c.subject, fields: c.fields ?? {}, label: `campaign "${c.name}"` });
      if (r.outcome === "sent") out.sent++;
      else if (r.outcome === "blocked") out.blocked++;
      else if (r.outcome === "failed") out.failed++;
    }
    const left = await deps.db.query(`SELECT count(*)::int AS n FROM ks_mkt_sends WHERE campaign_id = $1 AND status = 'queued'`, [c.id]);
    if (Number(left.rows[0]?.n ?? 0) === 0) {
      await deps.db.query(`UPDATE ks_mkt_campaigns SET status = 'sent', finished_at = $2, updated_at = now() WHERE id = $1 AND status = 'sending'`, [c.id, deps.now()]);
    }
  }
  return out;
}

export async function campaignStats(db: Q, campaignId: string) {
  const r = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(delivered_at)::int AS delivered, count(opened_at)::int AS opened, count(clicked_at)::int AS clicked,
            count(bounced_at)::int AS bounced, count(spam_at)::int AS spam, count(unsubscribed_at)::int AS unsubscribed
       FROM ks_mkt_sends WHERE campaign_id = $1`,
    [campaignId],
  );
  const blocked = await db.query(
    `SELECT block_reason, count(*)::int AS n FROM ks_mkt_sends WHERE campaign_id = $1 AND status = 'blocked' GROUP BY block_reason`,
    [campaignId],
  );
  return { ...r.rows[0], blocked_by_reason: Object.fromEntries(blocked.rows.map((b: any) => [b.block_reason, b.n])) };
}

// ---- sequences ----

export type SequenceStep = { wait_days: number; template_id: string };

export async function enrollProspects(
  deps: Pick<Deps, "db" | "now">,
  sequenceId: string,
  target: { filters?: SegmentFilters; prospect_ids?: string[] },
  actor: string,
): Promise<{ ok: true; enrolled: number; already: number; blocked: Record<string, number> } | { ok: false; status: number; error: string; message: string }> {
  const seq = (await deps.db.query(`SELECT * FROM ks_mkt_sequences WHERE id = $1`, [sequenceId])).rows[0];
  if (!seq) return { ok: false, status: 404, error: "not_found", message: "Sequence not found." };
  const steps = (seq.steps ?? []) as SequenceStep[];
  if (!steps.length) return { ok: false, status: 409, error: "no_steps", message: "Add at least one step first." };
  const now = deps.now();
  let rows;
  if (target.prospect_ids?.length) {
    const r = await deps.db.query(
      `SELECT p.*, s.reason AS suppressed FROM ks_prospects p LEFT JOIN ks_mkt_suppressions s ON s.email = lower(p.email) WHERE p.id = ANY($1::uuid[])`,
      [target.prospect_ids],
    );
    rows = r.rows.map((p: any) => ({ ...p, eligibility: eligibilityOf(p, now) }));
  } else {
    rows = (await findProspects(deps.db, target.filters ?? {}, now, { limit: 50_000 })).rows;
  }
  const first = new Date(now.getTime() + Math.max(0, Number(steps[0]!.wait_days) || 0) * DAY_MS);
  let enrolled = 0;
  let already = 0;
  const blocked: Record<string, number> = {};
  for (const p of rows) {
    if (!p.eligibility.ok) {
      blocked[p.eligibility.reason] = (blocked[p.eligibility.reason] ?? 0) + 1;
      continue;
    }
    const ins = await deps.db.query(
      `INSERT INTO ks_mkt_enrollments (sequence_id, prospect_id, next_send_at, enrolled_by, enrolled_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sequence_id, prospect_id) DO NOTHING RETURNING id`,
      [sequenceId, p.id, first, actor, now],
    );
    if (ins.rows.length) {
      enrolled++;
      await recordEvent(deps.db, p, "sequence_enrolled", `Enrolled in the sequence "${seq.name}" by ${actor}.`, now);
    } else already++;
  }
  return { ok: true, enrolled, already, blocked };
}

/** Sends due sequence steps (BATCH per run), stopping enrolments whose stop rules are met. */
export async function runSequences(deps: EngineDeps): Promise<{ sent: number; stopped: number; completed: number }> {
  const out = { sent: 0, stopped: 0, completed: 0 };
  const now = deps.now();
  const leased = await deps.db.query(
    `UPDATE ks_mkt_enrollments SET next_send_at = $2, updated_at = now()
      WHERE id IN (SELECT e.id FROM ks_mkt_enrollments e JOIN ks_mkt_sequences q ON q.id = e.sequence_id
                    WHERE e.status = 'active' AND q.status = 'active' AND e.next_send_at <= $1
                    ORDER BY e.next_send_at LIMIT ${BATCH} FOR UPDATE OF e SKIP LOCKED)
      RETURNING id, sequence_id, prospect_id, next_step, enrolled_at`,
    [now, new Date(now.getTime() + LEASE_MS)],
  );
  if (!leased.rows.length) return out;
  if (!canSendNow()) {
    // Put them back as they were due, so nothing is skipped while sending is not set up.
    await deps.db.query(`UPDATE ks_mkt_enrollments SET next_send_at = $2 WHERE id = ANY($1::uuid[])`, [leased.rows.map((r: any) => r.id), now]);
    return out;
  }
  for (const e of leased.rows) {
    const seq = (await deps.db.query(`SELECT name, steps FROM ks_mkt_sequences WHERE id = $1`, [e.sequence_id])).rows[0];
    const p = await prospectWithSuppression(deps.db, e.prospect_id);
    const finish = async (status: "completed" | "stopped", reason: string | null, summary: string, crm = false) => {
      await deps.db.query(
        `UPDATE ks_mkt_enrollments SET status = $2, stopped_reason = $3, finished_at = $4, next_send_at = NULL, updated_at = now() WHERE id = $1`,
        [e.id, status, reason, deps.now()],
      );
      if (p) await recordEvent(deps.db, p, status === "completed" ? "sequence_completed" : "sequence_stopped", summary, deps.now(), { crm });
      if (status === "completed") out.completed++;
      else out.stopped++;
    };
    if (!seq || !p) {
      await finish("stopped", "missing", "Sequence stopped: the sequence or prospect no longer exists.");
      continue;
    }
    const why = stopReason({ ...p, enrolled_at: e.enrolled_at });
    if (why) {
      await finish("stopped", why, `Sequence "${seq.name}" stopped: ${STOP_MESSAGES[why]}`, true);
      continue;
    }
    const steps = (seq.steps ?? []) as SequenceStep[];
    const idx = Number(e.next_step);
    const step = steps[idx];
    if (!step) {
      await finish("completed", null, `Finished the sequence "${seq.name}".`);
      continue;
    }
    const tpl = (await deps.db.query(`SELECT subject, fields FROM ks_mkt_templates WHERE id = $1`, [step.template_id])).rows[0];
    if (!tpl) {
      await finish("stopped", "template_missing", `Sequence "${seq.name}" stopped: step ${idx + 1}'s template is missing.`);
      continue;
    }
    await deps.db.query(
      `INSERT INTO ks_mkt_sends (enrollment_id, step_index, prospect_id, email, subject, status) VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT (enrollment_id, step_index) WHERE enrollment_id IS NOT NULL DO NOTHING`,
      [e.id, idx, p.id, p.email, tpl.subject],
    );
    const send = (await deps.db.query(`SELECT id, prospect_id, attempts, status FROM ks_mkt_sends WHERE enrollment_id = $1 AND step_index = $2`, [e.id, idx])).rows[0];
    let outcome: DeliverOutcome = send.status === "sent" ? "sent" : send.status === "blocked" ? "blocked" : send.status === "failed" ? "failed" : "retry";
    let reason: string | undefined;
    if (send.status === "queued") {
      const r = await deliver(deps, send, { subject: tpl.subject, fields: tpl.fields ?? {}, label: `sequence "${seq.name}", step ${idx + 1}` });
      outcome = r.outcome;
      reason = r.reason;
      if (outcome === "sent") out.sent++;
    }
    if (outcome === "sent") {
      const next = steps[idx + 1];
      if (!next) await finish("completed", null, `Finished the sequence "${seq.name}".`);
      else {
        await deps.db.query(
          `UPDATE ks_mkt_enrollments SET next_step = $2, next_send_at = $3, updated_at = now() WHERE id = $1`,
          [e.id, idx + 1, new Date(deps.now().getTime() + Math.max(0, Number(next.wait_days) || 0) * DAY_MS)],
        );
      }
    } else if (outcome === "blocked") {
      await finish("stopped", `blocked:${reason ?? "unknown"}`, `Sequence "${seq.name}" stopped: not allowed to email them (${reason ?? "unknown"}).`);
    } else if (outcome === "failed") {
      await finish("stopped", "send_failed", `Sequence "${seq.name}" stopped: the email could not be sent (${reason ?? "error"}).`);
    } else {
      await deps.db.query(`UPDATE ks_mkt_enrollments SET next_send_at = $2 WHERE id = $1`, [e.id, new Date(deps.now().getTime() + RETRY_MS)]);
    }
  }
  return out;
}

// ---- test sends ----

/** Sends a template to staff addresses, marked [Test], with the real footer and an unsubscribe link for that address. */
export async function testSend(
  deps: Pick<Deps, "db" | "fetch">,
  content: { subject: string; fields: Partial<TemplateFields> },
  to: string[],
): Promise<{ sent: string[]; failed: Array<{ email: string; error: string }> }> {
  const sent: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];
  for (const raw of to) {
    const email = raw.trim().toLowerCase();
    const p = (await deps.db.query(`SELECT name, company, consent_type FROM ks_prospects WHERE lower(email) = $1`, [email])).rows[0];
    const r = await sendMarketingEmail(
      deps.fetch,
      { email },
      renderEmail(content.subject, content.fields, { email, name: p?.name ?? "Alex Sample", company: p?.company ?? "Sample Brokerage", consent_type: p?.consent_type ?? "express" }, { test: true }),
      { ks_mkt_test: "1" },
    );
    if (r.ok) sent.push(email);
    else failed.push({ email, error: r.error });
  }
  return { sent, failed };
}

/** Stops one enrolment by hand. */
export async function stopEnrollmentByStaff(db: Q, enrollmentId: string, actor: string, now: Date): Promise<boolean> {
  const r = await db.query(
    `UPDATE ks_mkt_enrollments SET status = 'stopped', stopped_reason = 'staff', finished_at = $2, next_send_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING prospect_id`,
    [enrollmentId, now],
  );
  if (!r.rows.length) return false;
  const p = (await db.query(`SELECT id, email FROM ks_prospects WHERE id = $1`, [r.rows[0].prospect_id])).rows[0];
  if (p) await recordEvent(db, p, "sequence_stopped", `Sequence stopped by ${actor}.`, now);
  return true;
}

