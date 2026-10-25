// KS_OPS_v16_SUPPORT - in-app support tickets go to the Keystone support queue on BF-Server:
//   POST {BF_CRM_URL}/api/ks/support/ingest with X-KS-Ops-Key (the same BF_CRM_KEY as the CRM upsert).
//
// Every licensee-authored ticket message (the opening message and each follow-up on the same ticket) is one push with
// a stable message_id ("ks-ops:ticket-message:<ticket_messages.id>"), so a retry or a resend is never a duplicate.
// Pushes ride the CRM outbox (src/crm/outbox.ts, source "ks_support", external_id = message_id): they survive restarts
// and outages and are retried with backoff. They are never merged: each message is its own row, queued once.
//
// Until BF-Server has the endpoint, it answers 404 (or 503): that is "not available yet". Such rows wait
// SUPPORT_NOT_AVAILABLE_MS and are tried again, for ever, and it is logged once (again only after a success).
import type { Q } from "../db.js";
import { bfCrmConfigured, bfCrmKey, bfCrmUrl, CRM_TIMEOUT_MS } from "../lib/bfCrm.js";
import { normalizeNaPhone } from "../lib/sms.js";
import type { LicenseeRow } from "../licensees/repo.js";

export const SUPPORT_SOURCE = "ks_support";
export const SUPPORT_INGEST_PATH = "/api/ks/support/ingest";
/** Wait between tries while BF-Server answers 404/503 (the endpoint is not deployed yet). */
export const SUPPORT_NOT_AVAILABLE_MS = 6 * 60 * 60_000;
export const MAX_SUPPORT_BODY = 20_000;

export type SupportIngestPayload = {
  message_id: string;
  ticket_ref: string;
  is_follow_up: boolean;
  channel: "in_app";
  subject: string;
  body: string;
  priority: string | null;
  sent_at: string;
  company: {
    licensee_id: string;
    name: string;
    company_code: string;
    plan: string | null;
    support_level: string | null;
    status: string | null;
    website: string | null;
  };
  contact: { name: string | null; email: string | null; phone: string | null };
};

export type SupportPushResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; notAvailable: boolean; skipped?: boolean };

/** Sends one message to the ingest endpoint. Never throws. 404 and 503 come back as notAvailable. */
export async function pushSupportToBf(
  fetchImpl: typeof fetch,
  payload: SupportIngestPayload,
  opts: { timeoutMs?: number } = {},
): Promise<SupportPushResult> {
  if (!bfCrmConfigured()) return { ok: false, status: null, error: "bf_crm_not_configured", notAvailable: false, skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CRM_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${bfCrmUrl()}${SUPPORT_INGEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": bfCrmKey() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await r.json()) as Record<string, unknown>;
    } catch {
      /* body was not JSON */
    }
    if (r.ok) return { ok: true, status: r.status };
    const code = typeof body.error === "string" ? ` ${body.error}` : "";
    return {
      ok: false,
      status: r.status,
      error: `bf_support_status_${r.status}${code}`,
      notAvailable: r.status === 404 || r.status === 503,
    };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, status: null, error: "bf_support_timeout", notAvailable: false };
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err), notAvailable: false };
  } finally {
    clearTimeout(timer);
  }
}

// "Not available yet" is logged once, and again only after the endpoint has worked in between.
let notAvailableLogged = false;
export function noteSupportNotAvailable(error: string): void {
  if (notAvailableLogged) return;
  notAvailableLogged = true;
  console.warn(
    `[support] BF-Server's ${SUPPORT_INGEST_PATH} is not available yet (${error}); support tickets are kept and retried every ` +
      `${SUPPORT_NOT_AVAILABLE_MS / 3_600_000} h. This is logged once.`,
  );
}
export function noteSupportAvailable(): void {
  notAvailableLogged = false;
}

type TicketLike = { id: string; subject: string; priority?: string | null; requester_name?: string | null; requester_email?: string | null };
type MessageLike = { id: string; body: string; created_at?: Date | string | null };
type SupportLicensee = Pick<
  LicenseeRow,
  "id" | "company_name" | "company_code" | "plan" | "support_level" | "status" | "website" | "contact_name" | "contact_email" | "contact_phone"
>;

export const supportMessageId = (messageId: string) => `ks-ops:ticket-message:${messageId}`;
export const supportTicketRef = (ticketId: string) => `ks-ops:ticket:${ticketId}`;

const phoneOf = (raw: string | null | undefined): string | null => {
  const s = String(raw ?? "").trim();
  return s ? normalizeNaPhone(s) ?? s : null;
};

/**
 * The ingest payload for one licensee-authored ticket message. The contact is the requester; with no requester (or
 * the requester is the licensee's own contact) the licensee's contact fills the gaps, including the phone.
 */
export function supportPayload(
  l: SupportLicensee,
  t: TicketLike,
  m: MessageLike,
  opts: { isFollowUp: boolean; requesterPhone?: string | null; now: Date },
): SupportIngestPayload {
  const reqEmail = t.requester_email?.trim() || null;
  const sameAsLicensee = !reqEmail || reqEmail.toLowerCase() === String(l.contact_email ?? "").toLowerCase();
  const body = String(m.body);
  return {
    message_id: supportMessageId(m.id),
    ticket_ref: supportTicketRef(t.id),
    is_follow_up: opts.isFollowUp,
    channel: "in_app",
    subject: t.subject,
    body: body.length > MAX_SUPPORT_BODY ? body.slice(0, MAX_SUPPORT_BODY) : body,
    priority: t.priority ?? null,
    sent_at: new Date(m.created_at ?? opts.now).toISOString(),
    company: {
      licensee_id: l.id,
      name: l.company_name,
      company_code: l.company_code,
      plan: l.plan ?? null,
      support_level: l.support_level ?? null,
      status: l.status ?? null,
      website: l.website ?? null,
    },
    contact: {
      name: t.requester_name?.trim() || (sameAsLicensee ? l.contact_name : null) || null,
      email: reqEmail ?? l.contact_email ?? null,
      phone: phoneOf(opts.requesterPhone) ?? (sameAsLicensee ? phoneOf(l.contact_phone) : null),
    },
  };
}

/**
 * Queues one message for the support ingest (once: a message already queued or sent is never queued again). Does
 * nothing without BF_CRM_KEY. Never throws: a database problem is logged.
 */
export async function enqueueSupportMessage(deps: { db: Q; now: () => Date }, payload: SupportIngestPayload): Promise<boolean> {
  if (!bfCrmConfigured()) return false;
  try {
    const r = await deps.db.query(
      `INSERT INTO crm_outbox (source, external_id, payload, next_attempt_at)
       SELECT $1, $2, $3::jsonb, $4
        WHERE NOT EXISTS (SELECT 1 FROM crm_outbox WHERE source = $1 AND external_id = $2)
       ON CONFLICT (source, external_id) WHERE sent_at IS NULL DO NOTHING RETURNING id`,
      [SUPPORT_SOURCE, payload.message_id, JSON.stringify(payload), deps.now()],
    );
    return r.rows.length > 0;
  } catch (err) {
    console.error(`[support] could not queue ${payload.message_id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** A licensee-authored ticket message (new ticket or follow-up): queue it for BF-Server's support queue. */
export async function forwardTicketMessage(
  deps: { db: Q; now: () => Date },
  l: SupportLicensee,
  t: TicketLike,
  m: MessageLike,
  opts: { isFollowUp: boolean; requesterPhone?: string | null },
): Promise<void> {
  await enqueueSupportMessage(deps, supportPayload(l, t, m, { ...opts, now: deps.now() }));
}
