// KS_OPS_v16_SUPPORT - in-app support tickets go to the Keystone support queue on BF-Server:
//   POST {BF_CRM_URL}/api/ks/support/ingest with X-KS-Ops-Key (the same BF_CRM_KEY as the CRM upsert).
//
// Every licensee-authored ticket message (the opening message and each follow-up on the same ticket) is one push with
// a stable message_id ("ks-ops:ticket-message:<ticket_messages.id>"), so a retry or a resend is never a duplicate, and
// the ticket's external_id ("ks-ops:ticket:<tickets.id>", the same for every follow-up). The endpoint requires
// external_id, subject, message, message_id, licensee and requester (priority optional).
// Pushes ride the CRM outbox (src/crm/outbox.ts, source "ks_support", external_id = message_id): they survive restarts
// and outages and are retried with backoff. They are never merged: each message is its own row, queued once.
//
// Until BF-Server has the endpoint, it answers 404 (or 503): that is "not available yet". Such rows wait
// SUPPORT_NOT_AVAILABLE_MS and are tried again, for ever, and it is logged once (again only after a success).
// A 400/422 (the endpoint rejected the payload) is logged with its details each time and given up after the normal
// backoff ladder (SUPPORT_REJECTED_MAX_ATTEMPTS tries): the row is parked (next_attempt_at far in the future).
import type { Q } from "../db.js";
import { bfCrmConfigured, bfCrmKey, bfCrmUrl, CRM_TIMEOUT_MS } from "../lib/bfCrm.js";
import { normalizeNaPhone } from "../lib/sms.js";
import type { LicenseeRow } from "../licensees/repo.js";

export const SUPPORT_SOURCE = "ks_support";
export const SUPPORT_INGEST_PATH = "/api/ks/support/ingest";
/** Wait between tries while BF-Server answers 404/503 (the endpoint is not deployed yet). */
export const SUPPORT_NOT_AVAILABLE_MS = 6 * 60 * 60_000;
export const MAX_SUPPORT_BODY = 20_000;
/** A rejected (400/422) row is tried this many times in all (the normal backoff ladder), then parked. */
export const SUPPORT_REJECTED_MAX_ATTEMPTS = 6;
/** Where a parked row's next_attempt_at goes: it is never due again. */
export const SUPPORT_PARKED_AT = new Date("9999-12-31T00:00:00Z");

export type SupportIngestPayload = {
  external_id: string;
  message_id: string;
  subject: string;
  message: string;
  priority?: "low" | "normal" | "high" | "urgent";
  licensee: {
    company_code: string;
    name: string;
    support_level: string | null;
    licensee_id: string;
    plan: string | null;
    status: string | null;
    website: string | null;
  };
  requester: { name: string | null; email: string | null; phone: string | null };
  channel: "in_app";
  is_follow_up: boolean;
  sent_at: string;
};

export type SupportPushResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; notAvailable: boolean; rejected?: boolean; skipped?: boolean };

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
    const detail = body.errors ? ` ${JSON.stringify(body.errors).slice(0, 500)}` : body.details ? ` ${JSON.stringify(body.details).slice(0, 500)}` : "";
    return {
      ok: false,
      status: r.status,
      error: `bf_support_status_${r.status}${code}${detail}`,
      notAvailable: r.status === 404 || r.status === 503,
      rejected: r.status === 400 || r.status === 422,
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

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
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
  const text = String(m.body);
  const priority = (PRIORITIES as readonly string[]).includes(String(t.priority)) ? (t.priority as SupportIngestPayload["priority"]) : undefined;
  return {
    external_id: supportTicketRef(t.id),
    message_id: supportMessageId(m.id),
    subject: t.subject,
    message: text.length > MAX_SUPPORT_BODY ? text.slice(0, MAX_SUPPORT_BODY) : text,
    ...(priority ? { priority } : {}),
    licensee: {
      company_code: l.company_code,
      name: l.company_name,
      support_level: l.support_level ?? null,
      licensee_id: l.id,
      plan: l.plan ?? null,
      status: l.status ?? null,
      website: l.website ?? null,
    },
    requester: {
      name: t.requester_name?.trim() || (sameAsLicensee ? l.contact_name : null) || null,
      email: reqEmail ?? l.contact_email ?? null,
      phone: phoneOf(opts.requesterPhone) ?? (sameAsLicensee ? phoneOf(l.contact_phone) : null),
    },
    channel: "in_app",
    is_follow_up: opts.isFollowUp,
    sent_at: new Date(m.created_at ?? opts.now).toISOString(),
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
