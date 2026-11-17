// KS_OPS_MKT_FLOW_v1 - the Keystone email flow: everyone gets the first email, and what each prospect does next picks
// the following one. Same rules as the Insurance flows on BI-Server:
//   never opened       -> n2, n3, n4, a week apart, then finished
//   opened (no click)  -> o1 two business days after the open, then o2 a week later, then finished
//   clicked a link     -> c1 (inside sending hours) and a call task in the Keystone CRM, then finished
// A flow is a sequence of kind 'flow' whose seven steps are, in order, e1 n2 n3 n4 o1 o2 c1 (FLOW_KEYS). A prospect
// only moves up (none -> opened -> clicked). Replies, sign-ups, demo bookings, unsubscribes and bounces stop it.
import type { Deps } from "../deps.js";
import { STOP_MESSAGES, stopReason } from "./consent.js";
import { deliver, BATCH, type DeliverOutcome } from "./engine.js";
import { recordEvent } from "./events.js";
import { prospectWithSuppression, findProspects, eligibilityOf, type SegmentFilters } from "./prospects.js";
import { sendingProblem } from "./settings.js";

type FlowDeps = Pick<Deps, "db" | "fetch" | "now">;
export const FLOW_KEYS = ["e1", "n2", "n3", "n4", "o1", "o2", "c1"] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];
export type Track = "none" | "opened" | "clicked";
export const FLOW_LABELS: Record<FlowKey, string> = {
  e1: "First email (everyone)", n2: "Not opened, week 1", n3: "Not opened, week 2", n4: "Not opened, week 3 (last)",
  o1: "Opened: more details", o2: "Opened: example", c1: "Clicked: let's talk",
};
export const stepIndex = (k: FlowKey): number => FLOW_KEYS.indexOf(k);
const DAY = 86_400_000;
const LISTEN_DAYS = 30;
const LEASE_MS = 2 * 60_000;
const RETRY_MS = 10 * 60_000;

/** Sending hours: weekdays 9:00 to 17:00 Alberta time (UTC-6 all year). */
export function inSendingHours(at: Date): Date {
  const d = new Date(at.getTime());
  for (let i = 0; i < 24 * 8; i++) {
    const local = new Date(d.getTime() - 6 * 3_600_000);
    const wd = local.getUTCDay();
    const h = local.getUTCHours();
    if (wd >= 1 && wd <= 5 && h >= 9 && h < 17) return d;
    // jump to the next whole hour
    d.setUTCMinutes(0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return d;
}
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Date(d.getTime() - 6 * 3_600_000).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

export type Next = { key: FlowKey; at: Date } | null;
export function nextAfterSend(key: FlowKey, track: Track, at: Date): Next {
  if (track === "clicked") return null;
  if (track === "opened") return key === "o1" ? { key: "o2", at: inSendingHours(new Date(at.getTime() + 7 * DAY)) } : null;
  const order: FlowKey[] = ["e1", "n2", "n3", "n4"];
  const n = order[order.indexOf(key) + 1];
  return n && order.includes(key) ? { key: n, at: inSendingHours(new Date(at.getTime() + 7 * DAY)) } : null;
}
export function onOpen(track: Track, sent: string[], at: Date): { track: Track; next: Next } | null {
  if (track !== "none" || !sent.length) return null;
  return { track: "opened", next: sent.includes("o1") ? null : { key: "o1", at: inSendingHours(addBusinessDays(at, 2)) } };
}
export function onClick(track: Track, sent: string[], at: Date): { track: Track; next: Next } | null {
  if (track === "clicked" || !sent.length) return null;
  return { track: "clicked", next: sent.includes("c1") ? null : { key: "c1", at: inSendingHours(at) } };
}

/** Enrols prospects in a flow, starting `daily_new` a day (the first email is spread over the days). */
export async function enrollInFlow(
  deps: Pick<Deps, "db" | "now">,
  seq: { id: string; name: string; daily_new: number },
  target: { filters?: SegmentFilters; prospect_ids?: string[] },
  actor: string,
): Promise<{ ok: true; enrolled: number; already: number; blocked: Record<string, number> }> {
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
  const perDay = Math.max(1, Math.min(1000, Number(seq.daily_new) || 50));
  const existing = Number((await deps.db.query(`SELECT count(*)::int AS n FROM ks_mkt_enrollments WHERE sequence_id = $1`, [seq.id])).rows[0]?.n ?? 0);
  let enrolled = 0, already = 0;
  const blocked: Record<string, number> = {};
  for (const p of rows) {
    if (!p.eligibility.ok) { blocked[p.eligibility.reason] = (blocked[p.eligibility.reason] ?? 0) + 1; continue; }
    const day = Math.floor((existing + enrolled) / perDay);
    const first = inSendingHours(new Date(now.getTime() + day * DAY));
    const ins = await deps.db.query(
      `INSERT INTO ks_mkt_enrollments (sequence_id, prospect_id, next_send_at, enrolled_by, enrolled_at, flow_next) VALUES ($1, $2, $3, $4, $5, 'e1')
       ON CONFLICT (sequence_id, prospect_id) DO NOTHING RETURNING id`,
      [seq.id, p.id, first, actor, now],
    );
    if (ins.rows.length) {
      enrolled++;
      await recordEvent(deps.db, p, "sequence_enrolled", `Added to the email flow "${seq.name}" by ${actor}.`, now);
    } else already++;
  }
  return { ok: true, enrolled, already, blocked };
}

/** Moves prospects up when their opens and clicks arrive. A real click asks for a call in the Keystone CRM. */
export async function applyFlowEvents(deps: FlowDeps): Promise<{ opened: number; clicked: number }> {
  const r = await deps.db.query(
    `SELECT e.id, e.prospect_id, e.track, e.flow_sent, e.flow_next, e.status, q.name AS flow_name,
            min(s.opened_at) AS opened_at, min(s.human_clicked_at) AS clicked_at
       FROM ks_mkt_enrollments e
       JOIN ks_mkt_sequences q ON q.id = e.sequence_id AND q.kind = 'flow'
       JOIN ks_mkt_sends s ON s.enrollment_id = e.id
      WHERE e.track <> 'clicked'
        AND (e.status = 'active' OR (e.status = 'completed' AND e.flow_last_sent_at > $1))
      GROUP BY e.id, q.name
     HAVING (e.track = 'none' AND (min(s.opened_at) IS NOT NULL OR min(s.human_clicked_at) IS NOT NULL))
         OR (e.track = 'opened' AND min(s.human_clicked_at) IS NOT NULL)
      LIMIT 500`,
    [new Date(deps.now().getTime() - LISTEN_DAYS * DAY)],
  );
  let opened = 0, clicked = 0;
  for (const e of r.rows) {
    const sent = (e.flow_sent ?? []) as string[];
    const change = e.clicked_at ? onClick(e.track, sent, new Date(e.clicked_at)) : onOpen(e.track, sent, new Date(e.opened_at));
    if (!change) continue;
    await deps.db.query(
      `UPDATE ks_mkt_enrollments
          SET track = $2::text, opened_at = coalesce(opened_at, $3::timestamptz), clicked_at = coalesce(clicked_at, $4::timestamptz),
              flow_next = CASE WHEN $5::text IS NULL THEN flow_next ELSE $5::text END,
              next_send_at = CASE WHEN $5::text IS NULL THEN next_send_at ELSE $6::timestamptz END,
              status = CASE WHEN $5::text IS NULL THEN status ELSE 'active' END, finished_at = CASE WHEN $5::text IS NULL THEN finished_at ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [e.id, change.track, e.opened_at ?? e.clicked_at, e.clicked_at, change.next?.key ?? null, change.next?.at ?? null],
    );
    const p = await prospectWithSuppression(deps.db, e.prospect_id);
    if (change.track === "clicked") {
      clicked++;
      if (p) {
        await recordEvent(deps.db, p, "flow_clicked",
          `Clicked a link in the "${e.flow_name}" emails${p.company ? ` (${p.company})` : ""}. They have been sent the demo link; call them.`,
          new Date(e.clicked_at), { dedupeKey: `flow_click:${e.id}`, crm: true });
      }
    } else opened++;
  }
  return { opened, clicked };
}

/** Sends the flow emails that are due. */
export async function runFlows(deps: FlowDeps): Promise<{ sent: number; stopped: number; completed: number; opened: number; clicked: number }> {
  const events = await applyFlowEvents(deps);
  const out = { sent: 0, stopped: 0, completed: 0, ...events };
  if (sendingProblem() !== null) return out;
  const now = deps.now();
  if (inSendingHours(now).getTime() > now.getTime()) return out; // outside sending hours
  const leased = await deps.db.query(
    `UPDATE ks_mkt_enrollments SET next_send_at = $2, updated_at = now()
      WHERE id IN (SELECT e.id FROM ks_mkt_enrollments e JOIN ks_mkt_sequences q ON q.id = e.sequence_id
                    WHERE e.status = 'active' AND q.status = 'active' AND q.kind = 'flow' AND e.flow_next IS NOT NULL AND e.next_send_at <= $1
                    ORDER BY e.next_send_at LIMIT ${BATCH} FOR UPDATE OF e SKIP LOCKED)
      RETURNING id, sequence_id, prospect_id, track, flow_sent, flow_next, enrolled_at`,
    [now, new Date(now.getTime() + LEASE_MS)],
  );
  for (const e of leased.rows) {
    const seq = (await deps.db.query(`SELECT name, steps, from_name FROM ks_mkt_sequences WHERE id = $1`, [e.sequence_id])).rows[0];
    const p = await prospectWithSuppression(deps.db, e.prospect_id);
    const finish = async (status: "completed" | "stopped", reason: string | null, summary: string, crm = false) => {
      await deps.db.query(
        `UPDATE ks_mkt_enrollments SET status = $2::text, stopped_reason = $3::text, finished_at = $4::timestamptz, next_send_at = NULL, flow_next = NULL, updated_at = now() WHERE id = $1`,
        [e.id, status, reason, deps.now()],
      );
      if (p) await recordEvent(deps.db, p, status === "completed" ? "sequence_completed" : "sequence_stopped", summary, deps.now(), { crm });
      if (status === "completed") out.completed++; else out.stopped++;
    };
    if (!seq || !p) { await finish("stopped", "missing", "Email flow stopped: the flow or prospect no longer exists."); continue; }
    const why = stopReason({ ...p, enrolled_at: e.enrolled_at });
    if (why) { await finish("stopped", why, `Email flow "${seq.name}" stopped: ${STOP_MESSAGES[why]}`, true); continue; }
    const key = e.flow_next as FlowKey;
    const idx = stepIndex(key);
    const step = (seq.steps ?? [])[idx];
    const tpl = step ? (await deps.db.query(`SELECT subject, fields FROM ks_mkt_templates WHERE id = $1`, [step.template_id])).rows[0] : null;
    if (!tpl) { await finish("stopped", "template_missing", `Email flow "${seq.name}" stopped: the "${FLOW_LABELS[key] ?? key}" email is missing.`); continue; }
    await deps.db.query(
      `INSERT INTO ks_mkt_sends (enrollment_id, step_index, prospect_id, email, subject, status) VALUES ($1, $2, $3, $4, $5, 'queued')
       ON CONFLICT (enrollment_id, step_index) WHERE enrollment_id IS NOT NULL DO NOTHING`,
      [e.id, idx, p.id, p.email, tpl.subject],
    );
    const send = (await deps.db.query(`SELECT id, prospect_id, attempts, status FROM ks_mkt_sends WHERE enrollment_id = $1 AND step_index = $2`, [e.id, idx])).rows[0];
    let outcome: DeliverOutcome = send.status === "sent" ? "sent" : send.status === "blocked" ? "blocked" : send.status === "failed" ? "failed" : "retry";
    let reason: string | undefined;
    if (send.status === "queued") {
      const r = await deliver(deps, send, { subject: tpl.subject, fields: tpl.fields ?? {}, label: `email flow "${seq.name}", ${FLOW_LABELS[key]}`, fromName: seq.from_name });
      outcome = r.outcome; reason = r.reason;
      if (outcome === "sent") out.sent++;
    }
    if (outcome === "sent") {
      const at = deps.now();
      const next = nextAfterSend(key, e.track as Track, at);
      await deps.db.query(
        `UPDATE ks_mkt_enrollments SET flow_sent = array_append(flow_sent, $2::text), flow_last_sent_at = $3::timestamptz, flow_next = $4::text, next_send_at = $5::timestamptz,
                status = CASE WHEN $4::text IS NULL THEN 'completed' ELSE 'active' END, finished_at = CASE WHEN $4::text IS NULL THEN $3::timestamptz ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [e.id, key, at, next?.key ?? null, next?.at ?? null],
      );
      if (!next) out.completed++;
    } else if (outcome === "blocked") {
      await finish("stopped", `blocked:${reason ?? "unknown"}`, `Email flow "${seq.name}" stopped: not allowed to email them (${reason ?? "unknown"}).`);
    } else if (outcome === "failed") {
      await finish("stopped", "send_failed", `Email flow "${seq.name}" stopped: the email could not be sent (${reason ?? "error"}).`);
    } else {
      await deps.db.query(`UPDATE ks_mkt_enrollments SET next_send_at = $2 WHERE id = $1`, [e.id, new Date(deps.now().getTime() + RETRY_MS)]);
    }
  }
  return out;
}

/** When a flow is turned on, the people still waiting for their first email are spread from today, daily_new a day. */
export async function spreadFirstEmails(deps: Pick<Deps, "db" | "now">, sequenceId: string): Promise<number> {
  const seq = (await deps.db.query(`SELECT daily_new FROM ks_mkt_sequences WHERE id = $1 AND kind = 'flow'`, [sequenceId])).rows[0];
  if (!seq) return 0;
  const perDay = Math.max(1, Math.min(1000, Number(seq.daily_new) || 50));
  const waiting = (await deps.db.query(
    `SELECT id FROM ks_mkt_enrollments WHERE sequence_id = $1 AND status = 'active' AND flow_next = 'e1' AND cardinality(flow_sent) = 0 ORDER BY enrolled_at, id`,
    [sequenceId],
  )).rows;
  const now = deps.now();
  for (let i = 0; i < waiting.length; i++) {
    const at = inSendingHours(new Date(now.getTime() + Math.floor(i / perDay) * DAY));
    await deps.db.query(`UPDATE ks_mkt_enrollments SET next_send_at = $2 WHERE id = $1`, [waiting[i].id, at]);
  }
  return waiting.length;
}
