// KS_OPS_PROSPECT_MARKETING_v1 - Keystone prospects: one record per email, kept up to date from every place a
// prospect shows up, with the consent each source gives.
//
// Sources (synced every 2 minutes by the marketing worker, from cursors in ks_mkt_sync_state):
//   demo_signups     self-serve demo sign-up   -> demo booked, implied consent (inquiry, 6 months)
//   beta_signups     beta programme sign-up     -> lead, implied consent (inquiry, 6 months)
//   assistant_leads  Keystone Maya lead form    -> lead (demo booked when they asked for a live demo), express consent
//                                                 (the form's consent box and its wording are stored)
//   licensees        sign-ups and customers     -> trial / customer / lost, implied consent (existing customer)
//   BF-Server's Keystone CRM (contacts in silo KS, GET /api/ks/marketing/contacts) -> status from the pipeline stage,
//                    country and province; no consent of its own; "opted out of marketing" there is suppressed here
//   staff: added by hand or imported (with the consent they record), and edited on the prospect screen.
// Merging: blanks are filled but staff values are kept; the status only moves forward (consent.ts nextStatus); the
// stronger consent wins (express is never replaced by implied); booking, sign-up and reply times keep the latest.
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { bfCrmConfigured, bfCrmKey, bfCrmUrl } from "../lib/bfCrm.js";
import { CONSENT_TEXT as ASSISTANT_CONSENT_TEXT } from "../assistant/leads.js";
import {
  addMonths, BUSINESS_MONTHS_AFTER_END, CONSENT_LABELS, eligibility, mergeConsent, nextStatus, statusFromCrmStage,
  statusFromLicensee, type ConsentRecord, type Eligibility, type ProspectSource, type ProspectStatus, type SuppressionReason,
} from "./consent.js";

export type ProspectRow = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  title: string | null;
  country: string | null;
  province_state: string | null;
  status: ProspectStatus;
  source: string;
  sources: string[];
  plan_interest: string | null;
  consent_type: string;
  consent_source: string | null;
  consent_text: string | null;
  consent_at: Date | string | null;
  consent_expires_at: Date | string | null;
  consent_recorded_by: string | null;
  licensee_id: string | null;
  crm_contact_id: string | null;
  demo_booked_at: Date | string | null;
  signed_up_at: Date | string | null;
  last_replied_at: Date | string | null;
  last_emailed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  suppressed?: string | null;
};

export type ProspectInput = {
  email: string;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  title?: string | null;
  country?: string | null;
  province_state?: string | null;
  source: ProspectSource;
  status?: ProspectStatus | null;
  plan_interest?: string | null;
  consent?: (ConsentRecord & { consent_recorded_by?: string | null }) | null;
  licensee_id?: string | null;
  crm_contact_id?: string | null;
  demo_booked_at?: Date | null;
  signed_up_at?: Date | null;
  /** A timeline entry for this sighting (kept once per dedupe key). */
  event?: { type: string; summary: string; at: Date; dedupe_key: string } | null;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const later = (a: Date | string | null | undefined, b: Date | string | null | undefined): Date | null => {
  const x = a ? new Date(a) : null;
  const y = b ? new Date(b) : null;
  if (!x) return y;
  if (!y) return x;
  return y.getTime() > x.getTime() ? y : x;
};
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
const clean = (v: string | null | undefined, max = 200) => (blank(v) ? null : String(v).trim().slice(0, max));
const upper = (v: string | null | undefined) => (blank(v) ? null : String(v).trim().toUpperCase().slice(0, 40));

/** Adds a timeline entry. Returns false when the dedupe key was already used. */
export async function addProspectEvent(
  db: Q,
  prospectId: string,
  type: string,
  summary: string,
  at: Date,
  opts: { dedupeKey?: string | null; sendId?: number | string | null } = {},
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO ks_prospect_events (prospect_id, type, summary, at, send_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [prospectId, type, summary.slice(0, 1000), at, opts.sendId ?? null, opts.dedupeKey ?? null],
  );
  return r.rows.length > 0;
}

/** Creates or updates the prospect for this email. Returns its id. */
export async function upsertProspect(db: Q, now: Date, input: ProspectInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  await db.query(
    `INSERT INTO ks_prospects (email, source, sources) VALUES ($1, $2, ARRAY[$2]::text[])
     ON CONFLICT ((lower(email))) DO NOTHING`,
    [email, input.source],
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = (await db.query(`SELECT *, updated_at::text AS ver FROM ks_prospects WHERE lower(email) = $1`, [email])).rows[0] as
      | (ProspectRow & { ver: string })
      | undefined;
    if (!cur) throw new Error(`prospect ${email} vanished`);
    const status = input.status ? nextStatus(cur.status, input.status) : cur.status;
    const incoming: ConsentRecord | null = input.consent ?? null;
    const consent = incoming ? mergeConsent(cur, incoming, now) : cur;
    const consentChanged = consent !== cur;
    const sources = cur.sources.includes(input.source) ? cur.sources : [...cur.sources, input.source];
    const upd = await db.query(
      `UPDATE ks_prospects SET
          name = $3, company = $4, phone = $5, title = $6, country = $7, province_state = $8,
          status = $9, sources = $10::text[], plan_interest = $11,
          consent_type = $12, consent_source = $13, consent_text = $14, consent_at = $15, consent_expires_at = $16,
          consent_recorded_by = $17, licensee_id = $18, crm_contact_id = $19,
          demo_booked_at = $20, signed_up_at = $21, updated_at = now()
        WHERE id = $1 AND updated_at::text = $2 RETURNING id`,
      [
        cur.id, cur.ver,
        cur.name ?? clean(input.name), cur.company ?? clean(input.company), cur.phone ?? clean(input.phone, 40), cur.title ?? clean(input.title),
        cur.country ?? upper(input.country), cur.province_state ?? upper(input.province_state),
        status, sources,
        input.source === "licensee" || input.source === "website_signup" ? clean(input.plan_interest, 40) ?? cur.plan_interest : cur.plan_interest ?? clean(input.plan_interest, 40),
        consent.consent_type, consent.consent_source ?? null, consent.consent_text ?? null, iso(consent.consent_at), iso(consent.consent_expires_at),
        consentChanged ? input.consent?.consent_recorded_by ?? "sync" : cur.consent_recorded_by,
        cur.licensee_id ?? input.licensee_id ?? null, input.crm_contact_id ?? cur.crm_contact_id,
        later(cur.demo_booked_at, input.demo_booked_at), later(cur.signed_up_at, input.signed_up_at),
      ],
    );
    if (!upd.rows.length) continue; // changed under us: read again
    if (input.event) {
      await addProspectEvent(db, cur.id, input.event.type, input.event.summary, input.event.at, { dedupeKey: input.event.dedupe_key });
    }
    if (status !== cur.status) {
      await addProspectEvent(db, cur.id, "status_changed", `Status: ${cur.status} -> ${status} (from ${input.source.replace(/_/g, " ")}).`, now);
    }
    if (consentChanged) {
      await addProspectEvent(
        db, cur.id, "consent_changed",
        `Consent: ${CONSENT_LABELS[consent.consent_type as keyof typeof CONSENT_LABELS] ?? consent.consent_type}${consent.consent_source ? ` (${consent.consent_source})` : ""}.`,
        now,
      );
    }
    return cur.id;
  }
  throw new Error(`prospect ${email} kept changing`);
}

// ---- suppression ----

/** Puts an email on the suppression list (the first reason is kept). Returns true when it was added now. */
export async function suppress(db: Q, email: string, reason: SuppressionReason, source: string, opts: { note?: string | null; by?: string | null } = {}): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const r = await db.query(
    `INSERT INTO ks_mkt_suppressions (email, reason, source, note, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING RETURNING email`,
    [e, reason, source.slice(0, 200), opts.note ?? null, opts.by ?? null],
  );
  return r.rows.length > 0;
}

export async function suppressionOf(db: Q, email: string): Promise<string | null> {
  const r = await db.query(`SELECT reason FROM ks_mkt_suppressions WHERE email = lower($1)`, [email]);
  return r.rows[0]?.reason ?? null;
}

export async function prospectWithSuppression(db: Q, id: string): Promise<ProspectRow | null> {
  const r = await db.query(
    `SELECT p.*, s.reason AS suppressed FROM ks_prospects p LEFT JOIN ks_mkt_suppressions s ON s.email = lower(p.email) WHERE p.id = $1`,
    [id],
  );
  return (r.rows[0] as ProspectRow) ?? null;
}

export const eligibilityOf = (p: ProspectRow, now: Date): Eligibility => eligibility({ ...p, suppressed: p.suppressed ?? null }, now);

// ---- segments ----

export type SegmentFilters = {
  statuses?: string[];
  sources?: string[];
  plans?: string[];
  countries?: string[];
  regions?: string[];
  q?: string;
};

const list = (v: string[] | undefined, up = false) => (v && v.length ? v.map((s) => (up ? s.trim().toUpperCase() : s.trim())) : null);

/** The prospects matching the filters, each with its eligibility (consent and suppression checked). */
export async function findProspects(
  db: Q,
  f: SegmentFilters,
  now: Date,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: Array<ProspectRow & { eligibility: Eligibility }>; total: number }> {
  const q = String(f.q ?? "").trim();
  const params = [
    list(f.statuses), list(f.sources), list(f.plans), list(f.countries, true), list(f.regions, true), q ? `%${q}%` : null,
  ];
  const where = `($1::text[] IS NULL OR p.status = ANY($1))
      AND ($2::text[] IS NULL OR p.sources && $2)
      AND ($3::text[] IS NULL OR p.plan_interest = ANY($3))
      AND ($4::text[] IS NULL OR upper(p.country) = ANY($4))
      AND ($5::text[] IS NULL OR upper(p.province_state) = ANY($5))
      AND ($6::text IS NULL OR p.email ILIKE $6 OR coalesce(p.name, '') ILIKE $6 OR coalesce(p.company, '') ILIKE $6)`;
  const total = Number((await db.query(`SELECT count(*)::int AS n FROM ks_prospects p WHERE ${where}`, params)).rows[0]?.n ?? 0);
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 50_000);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const r = await db.query(
    `SELECT p.*, s.reason AS suppressed FROM ks_prospects p LEFT JOIN ks_mkt_suppressions s ON s.email = lower(p.email)
      WHERE ${where} ORDER BY p.updated_at DESC, p.id LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows: r.rows.map((p: ProspectRow) => ({ ...p, eligibility: eligibilityOf(p, now) })), total };
}

/** How many of a segment can be emailed, and how many are blocked for each reason. */
export async function audienceSummary(db: Q, f: SegmentFilters, now: Date) {
  const { rows, total } = await findProspects(db, f, now, { limit: 50_000 });
  const blocked: Record<string, number> = {};
  let eligible = 0;
  for (const p of rows) {
    if (p.eligibility.ok) eligible++;
    else blocked[p.eligibility.reason] = (blocked[p.eligibility.reason] ?? 0) + 1;
  }
  return { total, eligible, blocked };
}

// ---- sync from KS-Ops's own records ----

type SyncDeps = Pick<Deps, "db" | "now">;
const OVERLAP = "5 minutes";

async function cursorOf(db: Q, name: string): Promise<Date> {
  const r = await db.query(`SELECT cursor_at FROM ks_mkt_sync_state WHERE name = $1`, [name]);
  return r.rows[0]?.cursor_at ? new Date(r.rows[0].cursor_at) : new Date(0);
}

async function saveCursor(db: Q, name: string, at: Date | null, error: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO ks_mkt_sync_state (name, cursor_at, last_run_at, last_error) VALUES ($1, $2, now(), $3)
     ON CONFLICT (name) DO UPDATE SET cursor_at = coalesce(EXCLUDED.cursor_at, ks_mkt_sync_state.cursor_at), last_run_at = now(), last_error = $3`,
    [name, at, error],
  );
}

type SourceSpec = { name: string; sql: string; toInput: (row: any) => ProspectInput | null; ts: (row: any) => Date };

const SOURCES: SourceSpec[] = [
  {
    name: "demo_signups",
    sql: `SELECT id, name, email, company, phone, created_at FROM demo_signups WHERE created_at >= $1::timestamptz - interval '${OVERLAP}' ORDER BY created_at LIMIT 500`,
    ts: (r) => new Date(r.created_at),
    toInput: (r) => ({
      email: r.email, name: r.name, company: r.company, phone: r.phone, source: "demo_signup", status: "demo_booked",
      demo_booked_at: new Date(r.created_at),
      consent: { consent_type: "implied_inquiry", consent_source: "Self-serve demo sign-up on the Keystone website", consent_at: new Date(r.created_at), consent_expires_at: addMonths(new Date(r.created_at), 6) },
      event: { type: "demo_booked", summary: "Signed up for the self-serve Keystone demo.", at: new Date(r.created_at), dedupe_key: `demo_signup:${r.id}` },
    }),
  },
  {
    name: "beta_signups",
    sql: `SELECT id, name, email, brokerage, created_at FROM beta_signups WHERE created_at >= $1::timestamptz - interval '${OVERLAP}' ORDER BY created_at LIMIT 500`,
    ts: (r) => new Date(r.created_at),
    toInput: (r) => ({
      email: r.email, name: r.name, company: r.brokerage, source: "beta_signup", status: "lead",
      consent: { consent_type: "implied_inquiry", consent_source: "Beta programme sign-up on the Keystone website", consent_at: new Date(r.created_at), consent_expires_at: addMonths(new Date(r.created_at), 6) },
      event: { type: "signup", summary: "Joined the beta programme on the website.", at: new Date(r.created_at), dedupe_key: `beta_signup:${r.id}` },
    }),
  },
  {
    name: "assistant_leads",
    sql: `SELECT id, name, email, brokerage, phone, consent, consent_text, wants, created_at FROM assistant_leads WHERE created_at >= $1::timestamptz - interval '${OVERLAP}' ORDER BY created_at LIMIT 500`,
    ts: (r) => new Date(r.created_at),
    toInput: (r) => {
      const demo = r.wants === "live_demo";
      return {
        email: r.email, name: r.name, company: r.brokerage, phone: r.phone, source: "assistant", status: demo ? "demo_booked" : "lead",
        demo_booked_at: demo ? new Date(r.created_at) : null,
        consent: r.consent
          ? { consent_type: "express", consent_source: "Consent box on the Keystone website assistant's contact form", consent_text: r.consent_text || ASSISTANT_CONSENT_TEXT, consent_at: new Date(r.created_at), consent_expires_at: null }
          : { consent_type: "implied_inquiry", consent_source: "Keystone website assistant inquiry", consent_at: new Date(r.created_at), consent_expires_at: addMonths(new Date(r.created_at), 6) },
        event: { type: demo ? "demo_booked" : "signup", summary: demo ? "Asked the website assistant for a live demo." : "Left their details with the website assistant.", at: new Date(r.created_at), dedupe_key: `assistant_lead:${r.id}` },
      };
    },
  },
  {
    name: "licensees",
    sql: `SELECT id, company_name, contact_name, contact_email, contact_phone, country, province_state, status, plan, source, created_at, updated_at, cancelled_at
            FROM licensees WHERE updated_at >= $1::timestamptz - interval '${OVERLAP}' AND contact_email LIKE '%@%' ORDER BY updated_at LIMIT 500`,
    ts: (r) => new Date(r.updated_at),
    toInput: (r) => {
      const created = new Date(r.created_at);
      const ended = r.status === "cancelled" ? new Date(r.cancelled_at ?? r.updated_at) : null;
      return {
        email: r.contact_email, name: r.contact_name, company: r.company_name, phone: r.contact_phone, country: r.country, province_state: r.province_state,
        source: r.source === "website" ? "website_signup" : "licensee", status: statusFromLicensee(String(r.status)), plan_interest: r.plan,
        licensee_id: r.id, signed_up_at: created,
        consent: {
          consent_type: "implied_business",
          consent_source: ended ? "Keystone subscription (ended)" : "Keystone subscription",
          consent_at: created,
          consent_expires_at: ended ? addMonths(ended, BUSINESS_MONTHS_AFTER_END) : null,
        },
        event: { type: "signup", summary: `Signed up for Keystone (${r.plan}).`, at: created, dedupe_key: `licensee:${r.id}` },
      };
    },
  },
];

/** Brings in new and changed records from KS-Ops's own tables. Never throws; problems are logged. */
export async function syncLocalSources(deps: SyncDeps): Promise<{ seen: number; failed: number }> {
  let seen = 0;
  let failed = 0;
  for (const s of SOURCES) {
    try {
      const since = await cursorOf(deps.db, s.name);
      const rows = (await deps.db.query(s.sql, [since])).rows;
      let last: Date | null = null;
      for (const row of rows) {
        const input = s.toInput(row);
        if (input && String(input.email ?? "").includes("@")) {
          try {
            await upsertProspect(deps.db, deps.now(), input);
            seen++;
          } catch (err) {
            failed++;
            console.error(`[marketing] sync ${s.name} ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        last = s.ts(row);
      }
      if (last) await saveCursor(deps.db, s.name, last);
    } catch (err) {
      failed++;
      console.error(`[marketing] sync ${s.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { seen, failed };
}

// ---- sync from the Keystone CRM on BF-Server ----

let crmNotDeployedLogged = false;

/**
 * Pulls Keystone CRM contacts changed since the last pull (GET {BF_CRM_URL}/api/ks/marketing/contacts, X-KS-Ops-Key).
 * 404 means BF-Server does not have the endpoint yet: logged once, tried again next time.
 */
export async function pullCrmContacts(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ seen: number; error?: string }> {
  if (!bfCrmConfigured()) return { seen: 0, error: "bf_crm_not_configured" };
  const since = await cursorOf(deps.db, "crm_contacts");
  let seen = 0;
  try {
    const url = `${bfCrmUrl()}/api/ks/marketing/contacts?since=${encodeURIComponent(since.toISOString())}&limit=500`;
    const r = await deps.fetch(url, { headers: { "X-KS-Ops-Key": bfCrmKey(), Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 404 || r.status === 503) {
      if (!crmNotDeployedLogged) console.warn(`[marketing] BF-Server has no Keystone marketing contacts endpoint yet (${r.status}); will keep trying`);
      crmNotDeployedLogged = true;
      await saveCursor(deps.db, "crm_contacts", null, `bf_status_${r.status}`);
      return { seen: 0, error: `bf_status_${r.status}` };
    }
    if (!r.ok) throw new Error(`bf_status_${r.status}`);
    crmNotDeployedLogged = false;
    const body = (await r.json()) as { contacts?: any[] };
    let last: Date | null = null;
    for (const c of body.contacts ?? []) {
      last = c.updated_at ? new Date(c.updated_at) : last;
      const email = String(c.email ?? "").trim().toLowerCase();
      if (!email.includes("@")) continue;
      const id = await upsertProspect(deps.db, deps.now(), {
        email, name: c.name, company: c.company_name, phone: c.phone, title: c.job_title,
        country: c.country, province_state: c.province_state, source: "crm", status: statusFromCrmStage(c.ks_stage), crm_contact_id: c.id ?? null,
      });
      if (c.marketing_opt_out === true && (await suppress(deps.db, email, "crm_opt_out", "Keystone CRM"))) {
        await addProspectEvent(deps.db, id, "suppressed", "Opted out of marketing in the Keystone CRM.", deps.now());
      }
      seen++;
    }
    await saveCursor(deps.db, "crm_contacts", last);
    return { seen };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[marketing] Keystone CRM pull failed: ${msg}`);
    await saveCursor(deps.db, "crm_contacts", null, msg.slice(0, 500));
    return { seen, error: msg };
  }
}
