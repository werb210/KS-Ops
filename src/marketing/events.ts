// KS_OPS_PROSPECT_MARKETING_v1 - what happens after an email goes out:
//   - SendGrid Event Webhook (POST /api/public/marketing/sendgrid-events): delivered, opened, clicked, bounced, spam
//     report, unsubscribe -> the send row, the prospect's timeline, the suppression list (hard bounce, spam report,
//     unsubscribe) and the Keystone CRM timeline on BF-Server;
//   - unsubscribes from our own link and one-click header;
//   - replies: found in the reply mailbox (Microsoft 365, Mail.Read) or marked by staff -> sequences stop;
//   - the timeline outbox: marketing events written to the Keystone CRM contact on BF-Server
//     (POST {BF_CRM_URL}/api/ks/marketing/events, X-KS-Ops-Key), retried with the CRM outbox's back-off. BF-Server
//     creates the Keystone contact when there is none yet (imported or hand-added prospects).
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { env } from "../config.js";
import { backoffMs } from "../crm/outbox.js";
import { bfCrmConfigured, bfCrmKey, bfCrmUrl } from "../lib/bfCrm.js";
import { graphAccessToken } from "../lib/email.js";
import type { SuppressionReason } from "./consent.js";
import { addProspectEvent, suppress } from "./prospects.js";
import { replyMailbox } from "./settings.js";

export type TimelineEvent = { key: string; type: string; at: string; summary: string };

/** Queues an event for the prospect's Keystone CRM timeline. Never throws. */
export async function enqueueTimeline(db: Q, email: string, ev: TimelineEvent): Promise<void> {
  if (!bfCrmConfigured()) return;
  try {
    await db.query(`INSERT INTO ks_mkt_timeline_outbox (email, event) VALUES (lower($1), $2::jsonb)`, [email, JSON.stringify(ev)]);
  } catch (err) {
    console.error(`[marketing] could not queue a CRM timeline event for ${email}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Records something on the prospect's timeline here and, when `crm` is set, on the Keystone CRM contact too. */
export async function recordEvent(
  db: Q,
  p: { id: string; email: string },
  type: string,
  summary: string,
  at: Date,
  opts: { dedupeKey?: string | null; sendId?: number | string | null; crm?: boolean } = {},
): Promise<boolean> {
  const added = await addProspectEvent(db, p.id, type, summary, at, { dedupeKey: opts.dedupeKey, sendId: opts.sendId });
  if (added && opts.crm) {
    await enqueueTimeline(db, p.email, { key: opts.dedupeKey ?? `${type}:${p.id}:${at.toISOString()}`, type, at: at.toISOString(), summary });
  }
  return added;
}

/** Stops every active sequence the prospect is in. Returns how many were stopped. */
export async function stopEnrollments(db: Q, prospectId: string, reason: string, now: Date): Promise<number> {
  const r = await db.query(
    `UPDATE ks_mkt_enrollments SET status = 'stopped', stopped_reason = $2, finished_at = $3, next_send_at = NULL, updated_at = now()
      WHERE prospect_id = $1 AND status = 'active' RETURNING id`,
    [prospectId, reason, now],
  );
  return r.rows.length;
}

const SUPPRESSION_TEXT: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed from Keystone marketing email.",
  hard_bounce: "Email bounced (hard bounce): suppressed.",
  spam_report: "Reported a Keystone email as spam: suppressed.",
  crm_opt_out: "Opted out of marketing in the Keystone CRM.",
  manual: "Added to the suppression list by staff.",
};

/** Suppresses the email, notes it on the timeline (here and in the CRM) and stops their sequences. */
export async function suppressProspectEmail(
  db: Q,
  email: string,
  reason: SuppressionReason,
  source: string,
  now: Date,
  opts: { note?: string | null; by?: string | null; dedupeKey?: string | null } = {},
): Promise<boolean> {
  const added = await suppress(db, email, reason, source, { note: opts.note, by: opts.by });
  const p = (await db.query(`SELECT id, email FROM ks_prospects WHERE lower(email) = lower($1)`, [email])).rows[0];
  if (p) {
    // The CRM hears about the person's own decisions (unsubscribe, spam report) and hard bounces, which set its opt-out
    // flag; a staff entry here stays here, so removing it later is not undone by the next CRM pull.
    const crm = reason === "unsubscribed" || reason === "hard_bounce" || reason === "spam_report";
    if (added) await recordEvent(db, p, reason === "unsubscribed" ? "unsubscribed" : "suppressed", SUPPRESSION_TEXT[reason], now, { crm, dedupeKey: opts.dedupeKey ?? null });
    await stopEnrollments(db, p.id, reason === "unsubscribed" ? "unsubscribed" : "suppressed", now);
  }
  return added;
}

/** Marks a reply (once per dedupe key, so a message seen twice changes nothing) and stops their sequences. */
export async function markReplied(db: Q, prospectId: string, at: Date, how: string, dedupeKey: string | null = null): Promise<number> {
  const p = (await db.query(`SELECT id, email FROM ks_prospects WHERE id = $1`, [prospectId])).rows[0];
  if (!p) return 0;
  const added = await recordEvent(db, p, "replied", `Replied (${how}).`, at, { crm: true, dedupeKey });
  if (!added && dedupeKey) return 0;
  await db.query(`UPDATE ks_prospects SET last_replied_at = greatest(coalesce(last_replied_at, $2), $2), updated_at = now() WHERE id = $1`, [prospectId, at]);
  const stopped = await stopEnrollments(db, prospectId, "replied", at);
  if (stopped) await addProspectEvent(db, prospectId, "sequence_stopped", `${stopped} sequence(s) stopped: they replied.`, at);
  return stopped;
}

// ---- SendGrid Event Webhook ----

type SgEvent = {
  event?: string; email?: string; timestamp?: number; sg_event_id?: string; type?: string; reason?: string; url?: string;
  ks_mkt?: string; ks_mkt_send_id?: string;
};

export async function processSendgridEvents(deps: Pick<Deps, "db" | "now">, events: unknown): Promise<{ handled: number; ignored: number }> {
  let handled = 0;
  let ignored = 0;
  for (const raw of Array.isArray(events) ? (events as SgEvent[]) : []) {
    const sendId = String(raw?.ks_mkt_send_id ?? "");
    if (!/^\d{1,18}$/.test(sendId)) {
      ignored++;
      continue;
    }
    try {
      const send = (await deps.db.query(
        `SELECT s.id, s.prospect_id, s.email, s.subject, s.opened_at, s.clicked_at FROM ks_mkt_sends s WHERE s.id = $1`,
        [sendId],
      )).rows[0];
      if (!send) {
        ignored++;
        continue;
      }
      const at = raw.timestamp ? new Date(Number(raw.timestamp) * 1000) : deps.now();
      const key = raw.sg_event_id ? `sg:${raw.sg_event_id}` : `sg:${sendId}:${raw.event}:${raw.timestamp ?? ""}`;
      const p = { id: String(send.prospect_id), email: String(send.email) };
      const subj = send.subject ? ` "${String(send.subject).slice(0, 120)}"` : "";
      switch (raw.event) {
        case "delivered":
          await deps.db.query(`UPDATE ks_mkt_sends SET delivered_at = coalesce(delivered_at, $2) WHERE id = $1`, [sendId, at]);
          break;
        case "open": {
          const first = !send.opened_at;
          await deps.db.query(`UPDATE ks_mkt_sends SET opened_at = coalesce(opened_at, $2) WHERE id = $1`, [sendId, at]);
          if (first) await recordEvent(deps.db, p, "email_opened", `Opened${subj}.`, at, { dedupeKey: `open:${sendId}`, sendId, crm: true });
          break;
        }
        case "click": {
          const first = !send.clicked_at;
          await deps.db.query(`UPDATE ks_mkt_sends SET clicked_at = coalesce(clicked_at, $2) WHERE id = $1`, [sendId, at]);
          const url = raw.url ? ` (${String(raw.url).slice(0, 200)})` : "";
          await recordEvent(deps.db, p, "email_clicked", `Clicked a link in${subj}${url}.`, at, { dedupeKey: key, sendId, crm: first });
          break;
        }
        case "bounce": {
          const hard = String(raw.type ?? "bounce") === "bounce";
          if (hard) {
            await deps.db.query(`UPDATE ks_mkt_sends SET bounced_at = coalesce(bounced_at, $2) WHERE id = $1`, [sendId, at]);
            await recordEvent(deps.db, p, "email_bounced", `Bounced${subj}: ${String(raw.reason ?? "").slice(0, 200)}`, at, { dedupeKey: key, sendId, crm: true });
            await suppressProspectEmail(deps.db, p.email, "hard_bounce", "SendGrid bounce", deps.now());
          } else {
            await recordEvent(deps.db, p, "email_blocked", `Not delivered (temporary)${subj}: ${String(raw.reason ?? "").slice(0, 200)}`, at, { dedupeKey: key, sendId });
          }
          break;
        }
        case "dropped":
          await recordEvent(deps.db, p, "email_dropped", `SendGrid did not send${subj}: ${String(raw.reason ?? "").slice(0, 200)}`, at, { dedupeKey: key, sendId });
          break;
        case "spamreport":
          await deps.db.query(`UPDATE ks_mkt_sends SET spam_at = coalesce(spam_at, $2) WHERE id = $1`, [sendId, at]);
          await suppressProspectEmail(deps.db, p.email, "spam_report", "SendGrid spam report", deps.now(), { dedupeKey: key });
          break;
        case "unsubscribe":
        case "group_unsubscribe":
          await deps.db.query(`UPDATE ks_mkt_sends SET unsubscribed_at = coalesce(unsubscribed_at, $2) WHERE id = $1`, [sendId, at]);
          await suppressProspectEmail(deps.db, p.email, "unsubscribed", "SendGrid unsubscribe", deps.now(), { dedupeKey: key });
          break;
        default:
          ignored++;
          continue;
      }
      handled++;
    } catch (err) {
      console.error(`[marketing] webhook event ${raw?.event} for send ${sendId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { handled, ignored };
}

// ---- the Keystone CRM timeline (BF-Server) ----

let crmEventsNotDeployedLogged = false;
const NOT_DEPLOYED_WAIT_MS = 60 * 60_000;

export async function flushTimelineOutbox(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  if (!bfCrmConfigured()) return out;
  const now = deps.now();
  const due = await deps.db.query(
    `UPDATE ks_mkt_timeline_outbox SET next_attempt_at = $2
      WHERE id IN (SELECT id FROM ks_mkt_timeline_outbox WHERE sent_at IS NULL AND next_attempt_at <= $1 ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)
      RETURNING id, email, event, attempts`,
    [now, new Date(now.getTime() + 2 * 60_000)],
  );
  const byEmail = new Map<string, Array<{ id: string; event: TimelineEvent; attempts: number }>>();
  for (const r of due.rows) {
    const list = byEmail.get(r.email) ?? [];
    list.push({ id: String(r.id), event: r.event as TimelineEvent, attempts: Number(r.attempts) });
    byEmail.set(r.email, list);
  }
  for (const [email, rows] of byEmail) {
    const p = (await deps.db.query(`SELECT name, company, phone FROM ks_prospects WHERE lower(email) = $1`, [email])).rows[0] ?? {};
    const ids = rows.map((r) => r.id);
    let error = "";
    let notDeployed = false;
    try {
      const r = await deps.fetch(`${bfCrmUrl()}/api/ks/marketing/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-KS-Ops-Key": bfCrmKey() },
        body: JSON.stringify({ email, contact: { name: p.name ?? null, company: p.company ?? null, phone: p.phone ?? null }, events: rows.map((r) => r.event).slice(0, 50) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        await deps.db.query(`UPDATE ks_mkt_timeline_outbox SET sent_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = ANY($1::bigint[])`, [ids, deps.now()]);
        out.sent += rows.length;
        crmEventsNotDeployedLogged = false;
        continue;
      }
      notDeployed = r.status === 404 || r.status === 503;
      error = `bf_status_${r.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    out.failed += rows.length;
    if (notDeployed && !crmEventsNotDeployedLogged) {
      crmEventsNotDeployedLogged = true;
      console.warn(`[marketing] BF-Server has no Keystone marketing events endpoint yet (${error}); timeline events wait and retry hourly`);
    } else if (!notDeployed) {
      console.warn(`[marketing] CRM timeline push for ${email} failed: ${error}`);
    }
    const failures = Math.max(...rows.map((r) => r.attempts)) + 1;
    const next = new Date(deps.now().getTime() + (notDeployed ? NOT_DEPLOYED_WAIT_MS : backoffMs(failures)));
    await deps.db.query(`UPDATE ks_mkt_timeline_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3 WHERE id = ANY($1::bigint[])`, [ids, error.slice(0, 500), next]);
  }
  return out;
}

// ---- replies (Microsoft 365 mailbox) ----

/**
 * Looks for new mail in the reply mailbox from prospects emailed in the last 120 days, and marks them replied (which
 * stops their sequences). Needs the Graph app's Mail.Read application permission; without it the error is stored and
 * shown on the status screen.
 */
export async function pollReplies(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ checked: number; replied: number; error?: string }> {
  const mailbox = replyMailbox();
  if (!mailbox) return { checked: 0, replied: 0 };
  const st = (await deps.db.query(`SELECT cursor_at FROM ks_mkt_sync_state WHERE name = 'reply_mailbox'`)).rows[0];
  const since = st?.cursor_at ? new Date(st.cursor_at) : new Date(deps.now().getTime() - 86_400_000);
  const save = (at: Date | null, error: string | null) =>
    deps.db.query(
      `INSERT INTO ks_mkt_sync_state (name, cursor_at, last_run_at, last_error) VALUES ('reply_mailbox', $1, now(), $2)
       ON CONFLICT (name) DO UPDATE SET cursor_at = coalesce(EXCLUDED.cursor_at, ks_mkt_sync_state.cursor_at), last_run_at = now(), last_error = $2`,
      [at, error],
    );
  try {
    const token = await graphAccessToken(deps.fetch);
    const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$filter=${filter}&$orderby=receivedDateTime asc&$top=50&$select=id,from,subject,receivedDateTime`;
    const r = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 401 || r.status === 403) {
      await save(null, "The Microsoft 365 app cannot read the reply mailbox: grant it the Mail.Read application permission.");
      return { checked: 0, replied: 0, error: `graph_status_${r.status}` };
    }
    if (!r.ok) throw new Error(`graph_status_${r.status}`);
    const body = (await r.json()) as { value?: Array<{ id: string; receivedDateTime: string; from?: { emailAddress?: { address?: string } } }> };
    let last: Date | null = null;
    let replied = 0;
    const msgs = body.value ?? [];
    for (const m of msgs) {
      last = new Date(m.receivedDateTime);
      const from = String(m.from?.emailAddress?.address ?? "").trim().toLowerCase();
      if (!from.includes("@") || from === mailbox.toLowerCase() || from === env("SENDGRID_FROM").toLowerCase()) continue;
      const p = (await deps.db.query(
        `SELECT p.id FROM ks_prospects p
          WHERE lower(p.email) = $1 AND EXISTS (SELECT 1 FROM ks_mkt_sends s WHERE s.prospect_id = p.id AND s.status = 'sent' AND s.sent_at > $2::timestamptz - interval '120 days')`,
        [from, last],
      )).rows[0];
      if (!p) continue;
      await markReplied(deps.db, String(p.id), last, "email to the sales mailbox", `reply:${m.id}`);
      replied++;
    }
    await save(last, null);
    return { checked: msgs.length, replied };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[marketing] reply check failed: ${msg}`);
    await save(null, msg.slice(0, 500));
    return { checked: 0, replied: 0, error: msg };
  }
}
