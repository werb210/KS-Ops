// KS_OPS_OUTREACH_v1 - brokerages, the people at them, the list import (built for large lists), touches through every
// channel and the channel scoreboard. See migrations/025_outreach.sql and ./rules.ts.
import type { Q } from "../db.js";
import { isEmail, type ConsentRecord } from "../marketing/consent.js";
import { upsertProspect } from "../marketing/prospects.js";
import {
  classify, contactRank, countryCode, domainOf, fitRules, isOwnerRank, nameKey, priority, FIRM_TYPES,
  type FirmFacts, type FirmType, type FitRules, type Qualification,
} from "./rules.js";

const clean = (v: unknown, max = 300): string | null => {
  const s = String(v ?? "").trim();
  return s && s.toLowerCase() !== "nan" ? s.slice(0, max) : null;
};
const yes = (v: unknown) => /^(y|yes|true|1)$/i.test(String(v ?? "").trim());
const int = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/[, ]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Math.round(n) : null;
};
const tools = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[;,|]/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 40).map((s) => s.slice(0, 80));

export type ImportRow = Record<string, unknown>;
export type ImportResult = {
  rows: number; brokerages_added: number; brokerages_updated: number; people_added: number; people_updated: number;
  prospects_linked: number; excluded: number; skipped: Array<{ row: number; error: string }>;
};

export async function loadFitRules(db: Q): Promise<FitRules> {
  const r = await db.query(`SELECT fit_rules FROM ks_outreach_settings WHERE id = 1`);
  return fitRules(r.rows[0]?.fit_rules);
}

/** Works out a firm's qualification (unless staff locked it) and its priority score from what is on file. */
export async function rescore(db: Q, brokerageId: string, rules?: FitRules): Promise<void> {
  const b = (await db.query(`SELECT * FROM ks_brokerages WHERE id = $1`, [brokerageId])).rows[0];
  if (!b) return;
  const people = (await db.query(`SELECT title, email, direct_phone, mobile_phone, direct_dnc, mobile_dnc, needs_review FROM ks_broker_people WHERE brokerage_id = $1`, [brokerageId])).rows;
  const facts: FirmFacts = {
    country: b.country, firm_type: (FIRM_TYPES as readonly string[]).includes(b.firm_type) ? (b.firm_type as FirmType) : null,
    employee_count: b.employee_count, website: b.website, has_address: Boolean(b.address_line1 && b.city), people,
  };
  const p = priority(facts, rules ?? (await loadFitRules(db)));
  const c = classify(facts);
  await db.query(
    `UPDATE ks_brokerages SET fit_score = $2, fit_reasons = $3::jsonb,
            qualification = CASE WHEN qualification_locked THEN qualification ELSE $4 END,
            qualification_reason = CASE WHEN qualification_locked THEN qualification_reason ELSE $5 END, updated_at = now()
      WHERE id = $1`,
    [brokerageId, p.score, JSON.stringify(p.reasons), c.qualification, c.reason],
  );
}

async function findBrokerage(db: Q, externalId: string | null, domain: string | null, key: string, country: string | null) {
  if (externalId) {
    const r = await db.query(`SELECT * FROM ks_brokerages WHERE external_id = $1 LIMIT 1`, [externalId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (domain) {
    const r = await db.query(`SELECT * FROM ks_brokerages WHERE domain = $1 LIMIT 1`, [domain]);
    if (r.rows[0]) return r.rows[0];
  }
  const r = await db.query(`SELECT * FROM ks_brokerages WHERE name_key = $1 AND COALESCE(country, '') = COALESCE($2, '') LIMIT 1`, [key, country]);
  return r.rows[0] ?? null;
}

/**
 * Imports list rows (one person per row, as a ZoomInfo export gives them). Firms are matched by company id, then
 * domain, then name; people by person id, then name within the firm. A firm marked "remove" is the exclusion ledger:
 * its rows are counted and left out. People with an email also become marketing prospects, with the consent staff
 * recorded for this import (none = they cannot be emailed until consent is recorded).
 */
export async function importRows(
  db: Q, now: Date, rows: ImportRow[], opts: { consent?: (ConsentRecord & { consent_recorded_by?: string | null }) | null; by: string },
): Promise<ImportResult> {
  const out: ImportResult = { rows: rows.length, brokerages_added: 0, brokerages_updated: 0, people_added: 0, people_updated: 0, prospects_linked: 0, excluded: 0, skipped: [] };
  const rules = await loadFitRules(db);
  const touched = new Set<string>();
  const seenFirm = new Map<string, { id: string; removed: boolean }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const company = clean(r.company, 200);
    if (!company || !nameKey(company)) { out.skipped.push({ row: i + 1, error: "No company name." }); continue; }
    const email = clean(r.email, 320)?.toLowerCase() ?? null;
    if (email && !isEmail(email)) { out.skipped.push({ row: i + 1, error: `"${email}" is not an email address.` }); continue; }
    const country = countryCode(clean(r.country, 60));
    const website = clean(r.website, 300);
    const domain = domainOf(website, email);
    const externalId = clean(r.company_id, 80);
    const key = nameKey(company);
    const cacheKey = externalId ? `x:${externalId}` : domain ? `d:${domain}` : `n:${key}|${country ?? ""}`;
    let firm = seenFirm.get(cacheKey);
    if (!firm) {
      const existing = await findBrokerage(db, externalId, domain, key, country);
      const firmType = (FIRM_TYPES as readonly string[]).includes(String(r.firm_type ?? "")) ? String(r.firm_type) : null;
      const vals = [
        website, country, clean(r.province_state, 60)?.toUpperCase() ?? null, clean(r.city, 120), clean(r.address_line1, 200), clean(r.address_line2, 200),
        clean(r.postal_code, 20)?.toUpperCase() ?? null, int(r.employee_count), tools(r.technologies), clean(r.products, 300), externalId, domain, firmType,
      ];
      if (existing) {
        await db.query(
          `UPDATE ks_brokerages SET website = COALESCE(website, $2), country = COALESCE(country, $3), province_state = COALESCE($4, province_state),
                  city = COALESCE($5, city), address_line1 = COALESCE($6, address_line1), address_line2 = COALESCE($7, address_line2),
                  postal_code = COALESCE($8, postal_code), employee_count = COALESCE($9, employee_count),
                  current_tools = CASE WHEN cardinality($10::text[]) > 0 AND cardinality(current_tools) = 0 THEN $10::text[] ELSE current_tools END,
                  products = COALESCE(products, $11), external_id = COALESCE(external_id, $12), domain = COALESCE(domain, $13),
                  firm_type = COALESCE(firm_type, $14), updated_at = now()
            WHERE id = $1`,
          [existing.id, ...vals],
        );
        firm = { id: existing.id, removed: existing.qualification === "remove" };
        if (!firm.removed) out.brokerages_updated++;
      } else {
        const ins = await db.query(
          `INSERT INTO ks_brokerages (name, name_key, website, country, province_state, city, address_line1, address_line2, postal_code, employee_count,
                                      current_tools, products, external_id, domain, firm_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13, $14, $15)
           ON CONFLICT (name_key, COALESCE(country, '')) DO UPDATE SET updated_at = now() RETURNING id, qualification`,
          [company, key, ...vals],
        );
        firm = { id: ins.rows[0].id, removed: ins.rows[0].qualification === "remove" };
        if (!firm.removed) out.brokerages_added++;
      }
      seenFirm.set(cacheKey, firm);
    }
    if (firm.removed) { out.excluded++; continue; }
    touched.add(firm.id);

    const person = clean(r.contact_name, 200);
    if (!person) continue; // a firm-only row
    const pKey = nameKey(person) || person.toLowerCase();
    const personExt = clean(r.person_id, 80);
    const title = clean(r.title, 200);
    const review = /^review\b/i.test(String(r.qualification_status ?? ""));
    const have = personExt
      ? (await db.query(`SELECT id FROM ks_broker_people WHERE external_id = $1 OR (brokerage_id = $2 AND name_key = $3) LIMIT 1`, [personExt, firm.id, pKey])).rows[0]
      : (await db.query(`SELECT id FROM ks_broker_people WHERE brokerage_id = $1 AND name_key = $2 LIMIT 1`, [firm.id, pKey])).rows[0];
    const pv = [
      title, email, clean(r.direct_phone, 60), clean(r.mobile_phone, 60), yes(r.direct_dnc), yes(r.mobile_dnc), isOwnerRank(contactRank(title)),
      review, clean(r.verification_url, 500), clean(r.qualification_status, 300), personExt,
    ];
    let personId: string;
    if (have) {
      personId = have.id;
      await db.query(
        `UPDATE ks_broker_people SET title = COALESCE($2, title), email = COALESCE($3, email), direct_phone = COALESCE($4, direct_phone),
                mobile_phone = COALESCE($5, mobile_phone), direct_dnc = direct_dnc OR $6, mobile_dnc = mobile_dnc OR $7,
                is_owner = is_owner OR $8, needs_review = $9, verification_url = COALESCE($10, verification_url),
                qualification = COALESCE($11, qualification), external_id = COALESCE(external_id, $12), updated_at = now()
          WHERE id = $1`,
        [personId, ...pv],
      );
      out.people_updated++;
    } else {
      personId = (await db.query(
        `INSERT INTO ks_broker_people (brokerage_id, name, name_key, title, email, direct_phone, mobile_phone, direct_dnc, mobile_dnc, is_owner,
                                       needs_review, verification_url, qualification, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (brokerage_id, name_key) DO UPDATE SET updated_at = now() RETURNING id`,
        [firm.id, person, pKey, ...pv],
      )).rows[0].id;
      out.people_added++;
    }
    if (email) {
      const prospectId = await upsertProspect(db, now, {
        email, name: person, company, phone: clean(r.direct_phone, 40) ?? clean(r.mobile_phone, 40), title, country,
        province_state: clean(r.province_state, 40), source: "import", status: "lead", consent: opts.consent ?? null,
        event: { type: "created", summary: `Imported with the brokerage list by ${opts.by}.`, at: now, dedupe_key: `outreach-import:${email}` },
      });
      await db.query(`UPDATE ks_broker_people SET prospect_id = $2 WHERE id = $1 AND prospect_id IS DISTINCT FROM $2`, [personId, prospectId]);
      out.prospects_linked++;
    }
  }
  for (const id of touched) await rescore(db, id, rules);
  out.skipped = out.skipped.slice(0, 200);
  return out;
}

export type BrokerageFilters = { qualification?: string[]; status?: string[]; countries?: string[]; q?: string; min_score?: number; has?: string };

export async function listBrokerages(db: Q, f: BrokerageFilters, opts: { limit?: number; offset?: number } = {}) {
  const q = String(f.q ?? "").trim();
  const arr = (v?: string[]) => (v && v.length ? v : null);
  const params = [arr(f.qualification), arr(f.status), arr(f.countries?.map((c) => c.toUpperCase())), q ? `%${q}%` : null, Number(f.min_score) || 0];
  const has = f.has === "owner" ? `AND EXISTS (SELECT 1 FROM ks_broker_people p WHERE p.brokerage_id = b.id AND p.is_owner)`
    : f.has === "address" ? `AND b.address_line1 IS NOT NULL AND b.city IS NOT NULL`
    : f.has === "callable" ? `AND EXISTS (SELECT 1 FROM ks_broker_people p WHERE p.brokerage_id = b.id AND ((p.direct_phone IS NOT NULL AND NOT p.direct_dnc) OR (p.mobile_phone IS NOT NULL AND NOT p.mobile_dnc)))`
    : "";
  const where = `($1::text[] IS NULL OR b.qualification = ANY($1)) AND ($2::text[] IS NULL OR b.status = ANY($2))
     AND ($3::text[] IS NULL OR upper(b.country) = ANY($3)) AND ($4::text IS NULL OR b.name ILIKE $4 OR coalesce(b.domain, '') ILIKE $4)
     AND b.fit_score >= $5 ${has}`;
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const total = Number((await db.query(`SELECT count(*)::int AS n FROM ks_brokerages b WHERE ${where}`, params)).rows[0]?.n ?? 0);
  const rows = (await db.query(
    `SELECT b.*, (SELECT count(*)::int FROM ks_broker_people p WHERE p.brokerage_id = b.id) AS people,
            (SELECT count(*)::int FROM ks_broker_people p WHERE p.brokerage_id = b.id AND p.is_owner) AS owners,
            (SELECT count(*)::int FROM ks_mkt_touches t WHERE t.brokerage_id = b.id) AS touches
       FROM ks_brokerages b WHERE ${where} ORDER BY b.fit_score DESC, b.name LIMIT ${limit} OFFSET ${offset}`, params)).rows;
  const counts = (await db.query(`SELECT qualification, count(*)::int AS n FROM ks_brokerages GROUP BY 1`)).rows;
  return { brokerages: rows, total, counts: Object.fromEntries(counts.map((c: any) => [c.qualification, c.n])) };
}

export async function brokerageDetail(db: Q, id: string) {
  const b = (await db.query(`SELECT * FROM ks_brokerages WHERE id = $1`, [id])).rows[0];
  if (!b) return null;
  const [people, touches, links] = await Promise.all([
    db.query(`SELECT * FROM ks_broker_people WHERE brokerage_id = $1 ORDER BY is_owner DESC, name`, [id]),
    db.query(`SELECT t.*, p.name AS person_name, i.name AS item_name FROM ks_mkt_touches t LEFT JOIN ks_broker_people p ON p.id = t.person_id
               LEFT JOIN ks_mkt_channel_items i ON i.id = t.item_id WHERE t.brokerage_id = $1 ORDER BY t.at DESC LIMIT 200`, [id]),
    db.query(`SELECT * FROM ks_mkt_links WHERE brokerage_id = $1 ORDER BY created_at DESC`, [id]),
  ]);
  const ranked = people.rows.map((p: any) => ({ ...p, rank: contactRank(p.title) })).sort((a: any, b2: any) => a.rank - b2.rank || a.name.localeCompare(b2.name));
  return { brokerage: b, people: ranked, touches: touches.rows, links: links.rows };
}

export const TOUCH_OUTCOMES = ["sent", "no_answer", "voicemail", "reply", "conversation", "owner_conversation", "demo", "signup", "not_interested", "do_not_contact", "click"] as const;
export type TouchInput = {
  channel_key: string; brokerage_id?: string | null; person_id?: string | null; item_id?: string | null; direction?: "out" | "in";
  outcome: (typeof TOUCH_OUTCOMES)[number]; summary?: string | null; cost_cents?: number; at?: Date; by: string;
};
export async function addTouch(db: Q, t: TouchInput): Promise<string> {
  const id = (await db.query(
    `INSERT INTO ks_mkt_touches (channel_key, brokerage_id, person_id, item_id, direction, outcome, summary, cost_cents, at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [t.channel_key, t.brokerage_id ?? null, t.person_id ?? null, t.item_id ?? null, t.direction ?? "out", t.outcome, clean(t.summary, 2000), Math.max(0, Math.round(t.cost_cents ?? 0)), t.at ?? new Date(), t.by],
  )).rows[0].id as string;
  if (t.brokerage_id) await db.query(`UPDATE ks_brokerages SET last_touch_at = GREATEST(COALESCE(last_touch_at, $2), $2), updated_at = now() WHERE id = $1`, [t.brokerage_id, t.at ?? new Date()]);
  // "Do not contact" from a call: never ring that person again.
  if (t.outcome === "do_not_contact" && t.person_id) await db.query(`UPDATE ks_broker_people SET direct_dnc = true, mobile_dnc = true, updated_at = now() WHERE id = $1`, [t.person_id]);
  return id;
}

/** One row per channel: what went out, what came back, what it cost, and where the 4-week test stands. */
export async function scoreboard(db: Q, now: Date) {
  const rows = (await db.query(
    `SELECT c.*,
            COALESCE(t.touches, 0) AS touches, COALESCE(t.firms, 0) AS firms, COALESCE(t.replies, 0) AS replies,
            COALESCE(t.conversations, 0) AS conversations, COALESCE(t.owner_conversations, 0) AS owner_conversations,
            COALESCE(t.demos, 0) AS demos, COALESCE(t.signups, 0) AS signups, COALESCE(t.clicks, 0) AS clicks,
            COALESCE(t.touch_cost, 0) + COALESCE(i.item_cost, 0) AS cost_cents, COALESCE(i.items, 0) AS items
       FROM ks_mkt_channels c
       LEFT JOIN (SELECT channel_key, count(*) FILTER (WHERE direction = 'out' AND outcome <> 'click')::int AS touches,
                         count(DISTINCT brokerage_id)::int AS firms,
                         count(*) FILTER (WHERE outcome IN ('reply', 'conversation', 'owner_conversation', 'demo', 'signup'))::int AS replies,
                         count(*) FILTER (WHERE outcome IN ('conversation', 'owner_conversation'))::int AS conversations,
                         count(*) FILTER (WHERE outcome = 'owner_conversation')::int AS owner_conversations,
                         count(*) FILTER (WHERE outcome = 'demo')::int AS demos, count(*) FILTER (WHERE outcome = 'signup')::int AS signups,
                         count(*) FILTER (WHERE outcome = 'click')::int AS clicks, sum(cost_cents)::int AS touch_cost
                    FROM ks_mkt_touches GROUP BY 1) t ON t.channel_key = c.key
       LEFT JOIN (SELECT channel_key, count(*)::int AS items, sum(cost_cents)::int AS item_cost FROM ks_mkt_channel_items WHERE status <> 'dropped' GROUP BY 1) i ON i.channel_key = c.key
      ORDER BY c.sort, c.name`)).rows;
  // Email is sent by the campaign and sequence engine, so its numbers come from there as well as from logged touches.
  const mail = (await db.query(
    `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicks FROM ks_mkt_sends`)).rows[0] ?? {};
  const replied = Number((await db.query(`SELECT count(*)::int AS n FROM ks_prospects WHERE last_replied_at IS NOT NULL`)).rows[0]?.n ?? 0);
  for (const c of rows) if (c.key === "email") { c.touches += mail.sent ?? 0; c.clicks += mail.clicks ?? 0; c.replies += replied; }
  return rows.map((c: any) => {
    const start = c.test_started_on ? new Date(c.test_started_on) : null;
    const end = start ? new Date(start.getTime() + c.test_weeks * 7 * 86_400_000) : null;
    return {
      ...c,
      test_ends_on: end ? end.toISOString().slice(0, 10) : null,
      test_days_left: end ? Math.ceil((end.getTime() - now.getTime()) / 86_400_000) : null,
      cost_per_owner_conversation_cents: c.owner_conversations > 0 ? Math.round(c.cost_cents / c.owner_conversations) : null,
      over_budget: c.budget_cents > 0 && c.cost_cents > c.budget_cents,
    };
  });
}

export function newCode(len = 7): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/** A tracked link's click: counted, and logged as an inbound touch so it shows on the brokerage and the scoreboard. */
export async function recordClick(db: Q, code: string, now: Date): Promise<string | null> {
  const r = await db.query(`UPDATE ks_mkt_links SET clicks = clicks + 1, last_click_at = $2 WHERE code = $1 RETURNING *`, [code, now]);
  const l = r.rows[0];
  if (!l) return null;
  await addTouch(db, { channel_key: l.channel_key, brokerage_id: l.brokerage_id, item_id: l.item_id, direction: "in", outcome: "click", summary: l.label ? `Opened the link "${l.label}".` : "Opened a tracked link.", at: now, by: "link" });
  return l.target_url as string;
}

export type { Qualification };
