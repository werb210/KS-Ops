// KS_OPS_OUTREACH_v1 - staff API for selling Keystone to brokerages through every channel (the staff portal's
// Keystone silo > Marketing > Brokerages / Channels). Mounted under /api/ops behind requireStaff.
//   GET   /outreach/brokerages?qualification=&status=&countries=&q=&min_score=&has=owner|address|callable&limit=&offset=
//   POST  /outreach/import                     { rows: [...] (up to 1,000 a call), consent? }
//   GET   /outreach/brokerages/:id             the firm, its people (decision-makers first), touches and links
//   PATCH /outreach/brokerages/:id             details; setting the qualification locks it against re-scoring
//   PATCH /outreach/people/:id                 title, phones, email, do-not-call flags, owner flag
//   GET   /outreach/call-list?limit=&rest_days= owners and decision-makers who may be called, best firms first
//   POST  /outreach/touches                    log a call, letter, meeting, post... with its outcome and cost
//   GET   /outreach/channels                   the scoreboard        PATCH /outreach/channels/:key  test window, budget, keep / drop
//   GET   /outreach/items?channel=             POST /outreach/items   PATCH /outreach/items/:id
//   POST  /outreach/links                      a tracked link for a channel / firm / item
//   GET   /outreach/referrals                  POST /outreach/referrals   PATCH /outreach/referrals/:id
//   GET   /outreach/fit-rules                  PUT /outreach/fit-rules (re-scores every firm)
//   GET   /outreach/letter                     PUT /outreach/letter          the owner letter's wording
//   GET   /outreach/mail/ready?countries=      how many firms can get a letter now
//   POST  /outreach/mail/batches               { name, limit, countries?, cost_per_letter_cents? } -> a mail batch
//   GET   /outreach/mail/batches/:id/letters   print-ready PDF (base64)      GET .../labels  address label CSV
//   GET   /outreach/ads/linkedin-audience      company list CSV for LinkedIn matched audiences
import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { CONSENT_TYPES, defaultExpiry, type ConsentType } from "../marketing/consent.js";
import { DEFAULT_FIT_RULES, FIRM_TYPES, FIRM_TYPE_LABELS, fitRules, QUALIFICATIONS, contactRank, isDecisionMaker } from "../outreach/rules.js";
import { addTouch, brokerageDetail, importRows, listBrokerages, loadFitRules, newCode, rescore, scoreboard, TOUCH_OUTCOMES } from "../outreach/store.js";
import { opsPublicUrl, publicSiteUrl } from "../config.js";
import { createMailBatch, DEFAULT_LETTER, labelsCsv, letterFrom, lettersPdf, linkedInAudienceCsv, loadLetter, pickRecipients, type Recipient } from "../outreach/mail.js"; // KS_OPS_OUTREACH_v2

const MAX_IMPORT = 1000;
const opt = (max: number) => z.string().trim().max(max).nullable().optional();
const cents = z.number().int().min(0).max(100_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.");

const brokeragePatch = z.object({
  name: z.string().trim().min(1).max(200).optional(), website: opt(300), country: opt(40), province_state: opt(60), city: opt(120),
  address_line1: opt(200), address_line2: opt(200), postal_code: opt(20), employee_count: z.number().int().min(1).max(10_000_000).nullable().optional(),
  seats_estimate: z.number().int().min(1).max(100_000).nullable().optional(), current_tools: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  products: opt(300), firm_type: z.enum(FIRM_TYPES).nullable().optional(), qualification: z.enum(QUALIFICATIONS).optional(),
  qualification_reason: opt(500), unlock_qualification: z.boolean().optional(), status: z.enum(["working", "parked", "customer"]).optional(),
  assigned_to: opt(120), notes: opt(5000),
}).strict();
const personPatch = z.object({
  title: opt(200), email: z.string().trim().toLowerCase().email("Enter a valid email.").nullable().optional(), direct_phone: opt(60), mobile_phone: opt(60),
  direct_dnc: z.boolean().optional(), mobile_dnc: z.boolean().optional(), is_owner: z.boolean().optional(), needs_review: z.boolean().optional(),
}).strict();
const touchSchema = z.object({
  channel_key: z.string().trim().min(1).max(60), brokerage_id: z.string().regex(UUID_RE).nullable().optional(), person_id: z.string().regex(UUID_RE).nullable().optional(),
  item_id: z.string().regex(UUID_RE).nullable().optional(), direction: z.enum(["out", "in"]).optional(), outcome: z.enum(TOUCH_OUTCOMES),
  summary: opt(2000), cost_cents: cents.optional(), at: z.string().trim().refine((v) => !Number.isNaN(new Date(v).getTime()), "Enter a valid date.").optional(),
});
const channelPatch = z.object({
  active: z.boolean().optional(), test_started_on: day.nullable().optional(), test_weeks: z.number().int().min(1).max(52).optional(),
  budget_cents: cents.optional(), decision: z.enum(["testing", "keep", "drop"]).optional(), notes: opt(2000),
}).strict();
export const ITEM_KINDS = ["event", "community", "podcast", "webinar", "ad_campaign", "directory", "video", "partner", "landing_page", "mail_batch", "other"] as const;
const itemSchema = z.object({
  channel_key: z.string().trim().min(1).max(60), kind: z.enum(ITEM_KINDS), name: z.string().trim().min(1, "Give it a name.").max(200), url: opt(500),
  happens_on: day.nullable().optional(), cost_cents: cents.optional(), status: z.enum(["planned", "in_progress", "live", "done", "dropped"]).optional(), notes: opt(5000),
});
const linkSchema = z.object({
  channel_key: z.string().trim().min(1).max(60), brokerage_id: z.string().regex(UUID_RE).nullable().optional(), item_id: z.string().regex(UUID_RE).nullable().optional(),
  target_url: z.string().trim().url("Enter the full address, starting with https://").max(1000).refine((u) => /^https:\/\//i.test(u), "The address must start with https://"),
  label: opt(200),
});
const referralSchema = z.object({
  referrer_licensee_id: z.string().regex(UUID_RE).nullable().optional(), referrer_name: z.string().trim().min(1, "Who is referring?").max(200),
  referred_brokerage_id: z.string().regex(UUID_RE).nullable().optional(), referred_name: opt(200), reward: opt(300), reward_cents: cents.optional(), notes: opt(2000),
});
const referralPatch = z.object({
  referred_brokerage_id: z.string().regex(UUID_RE).nullable().optional(), referred_name: opt(200), referred_licensee_id: z.string().regex(UUID_RE).nullable().optional(),
  status: z.enum(["open", "referred", "signed_up", "reward_owed", "reward_applied", "void"]).optional(), reward: opt(300), reward_cents: cents.optional(), notes: opt(2000),
}).strict();
const consentSchema = z.object({
  consent_type: z.enum(CONSENT_TYPES), consent_source: z.string().trim().max(500).optional(), consent_text: z.string().trim().max(2000).optional(),
  consent_at: z.string().trim().optional(),
});

/** UPDATE ... SET for the keys present in a parsed PATCH body. */
function setClause(data: Record<string, unknown>, first = 2): { sql: string; params: unknown[] } {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  return { sql: keys.map((k, i) => `${k} = $${i + first}`).join(", "), params: keys.map((k) => data[k]) };
}

export function opsOutreachRouter(deps: Deps): Router {
  const r = Router();
  const bad = (res: any, errors: Record<string, string>) => res.status(400).json({ error: "validation_error", errors });
  const notFound = (res: any) => res.status(404).json({ error: "not_found" });
  const split = (v: unknown) => { const s = String(v ?? "").trim(); return s ? s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20) : undefined; };
  const channelExists = async (key: string) => (await deps.db.query(`SELECT 1 FROM ks_mkt_channels WHERE key = $1`, [key])).rows.length > 0;

  r.get("/outreach/meta", (_req, res) => {
    res.json({ qualifications: QUALIFICATIONS, firm_types: FIRM_TYPES.map((k) => ({ key: k, label: FIRM_TYPE_LABELS[k] })), outcomes: TOUCH_OUTCOMES, item_kinds: ITEM_KINDS, max_import: MAX_IMPORT });
  });

  // ---- brokerages ----
  r.get("/outreach/brokerages", h(async (req, res) => {
    res.json(await listBrokerages(deps.db, {
      qualification: split(req.query.qualification), status: split(req.query.status), countries: split(req.query.countries),
      q: String(req.query.q ?? "").slice(0, 200), min_score: Number(req.query.min_score) || 0, has: String(req.query.has ?? ""),
    }, { limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 }));
  }));

  r.post("/outreach/import", h(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return bad(res, { rows: "Choose a list with at least one row." });
    if (rows.length > MAX_IMPORT) return bad(res, { rows: `At most ${MAX_IMPORT} rows a call.` });
    let consent = null;
    if (req.body?.consent && req.body.consent.consent_type !== "none") {
      const c = consentSchema.safeParse(req.body.consent);
      if (!c.success) return bad(res, { consent: "Choose the type of consent and where it came from." });
      const at = c.data.consent_at && !Number.isNaN(new Date(c.data.consent_at).getTime()) ? new Date(c.data.consent_at) : deps.now();
      const t = c.data.consent_type as ConsentType;
      consent = {
        consent_type: t, consent_source: c.data.consent_source ?? null, consent_text: c.data.consent_text ?? null, consent_at: at,
        consent_expires_at: t === "express" || t === "us_opt_out" ? null : defaultExpiry(t, at), consent_recorded_by: actorOf(req),
      };
    }
    res.json(await importRows(deps.db, deps.now(), rows, { consent, by: actorOf(req) }));
  }));

  r.get("/outreach/brokerages/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const d = await brokerageDetail(deps.db, req.params.id);
    return d ? res.json(d) : notFound(res);
  }));

  r.patch("/outreach/brokerages/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const parsed = parseBody(brokeragePatch, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const { unlock_qualification, ...data } = parsed.data as Record<string, unknown> & { unlock_qualification?: boolean };
    const extra: Record<string, unknown> = {};
    // A person's decision on the qualification stands until they unlock it.
    if (data.qualification !== undefined) { extra.qualification_locked = true; if (data.qualification_reason === undefined) extra.qualification_reason = `Set by ${actorOf(req)}.`; }
    if (unlock_qualification) extra.qualification_locked = false;
    if (typeof data.country === "string") data.country = data.country.toUpperCase();
    const all = { ...data, ...extra };
    if (!Object.keys(all).length) return bad(res, { form: "Nothing to change." });
    const s = setClause(all);
    const u = await deps.db.query(`UPDATE ks_brokerages SET ${s.sql}, updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id, ...s.params]);
    if (!u.rows.length) return notFound(res);
    await rescore(deps.db, req.params.id);
    res.json(await brokerageDetail(deps.db, req.params.id));
  }));

  r.patch("/outreach/people/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const parsed = parseBody(personPatch, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const s = setClause(parsed.data as Record<string, unknown>);
    if (!s.sql) return bad(res, { form: "Nothing to change." });
    const u = await deps.db.query(`UPDATE ks_broker_people SET ${s.sql}, updated_at = now() WHERE id = $1 RETURNING brokerage_id`, [req.params.id, ...s.params]);
    if (!u.rows.length) return notFound(res);
    await rescore(deps.db, u.rows[0].brokerage_id);
    res.json(await brokerageDetail(deps.db, u.rows[0].brokerage_id));
  }));

  // KS_OPS_OUTREACH_v1 (phone) - who to call next: decision-makers at kept, working firms with a number that may be
  // called, best firms first, one person per firm, skipping firms phoned in the last few days.
  r.get("/outreach/call-list", h(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const rest = Math.min(Math.max(Number(req.query.rest_days) || 3, 0), 90);
    const rows = (await deps.db.query(
      `SELECT p.id AS person_id, p.name, p.title, p.is_owner,
              CASE WHEN p.direct_phone IS NOT NULL AND NOT p.direct_dnc THEN p.direct_phone END AS direct_phone,
              CASE WHEN p.mobile_phone IS NOT NULL AND NOT p.mobile_dnc THEN p.mobile_phone END AS mobile_phone,
              b.id AS brokerage_id, b.name AS brokerage, b.country, b.province_state, b.fit_score, b.current_tools, b.last_touch_at,
              (SELECT count(*)::int FROM ks_mkt_touches t WHERE t.brokerage_id = b.id AND t.channel_key = 'phone') AS calls
         FROM ks_broker_people p JOIN ks_brokerages b ON b.id = p.brokerage_id
        WHERE b.qualification = 'keep' AND b.status = 'working'
          AND ((p.direct_phone IS NOT NULL AND NOT p.direct_dnc) OR (p.mobile_phone IS NOT NULL AND NOT p.mobile_dnc))
          AND NOT EXISTS (SELECT 1 FROM ks_mkt_touches t WHERE t.brokerage_id = b.id AND t.channel_key = 'phone' AND t.at > $1::timestamptz - ($2::int * interval '1 day'))
          AND NOT EXISTS (SELECT 1 FROM ks_mkt_touches t WHERE t.brokerage_id = b.id AND t.outcome IN ('not_interested', 'signup'))
        ORDER BY b.fit_score DESC, b.name, p.is_owner DESC, p.name`, [deps.now(), rest])).rows;
    const seen = new Set<string>();
    const out = [];
    for (const row of rows.map((x: any) => ({ ...x, rank: contactRank(x.title) })).sort((a: any, b: any) => b.fit_score - a.fit_score || a.brokerage.localeCompare(b.brokerage) || a.rank - b.rank)) {
      if (seen.has(row.brokerage_id) || !isDecisionMaker(row.rank)) continue;
      seen.add(row.brokerage_id);
      out.push(row);
      if (out.length >= limit) break;
    }
    res.json({ calls: out });
  }));

  // ---- touches ----
  r.post("/outreach/touches", h(async (req, res) => {
    const parsed = parseBody(touchSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    if (!(await channelExists(v.channel_key))) return bad(res, { channel_key: "Unknown channel." });
    const id = await addTouch(deps.db, { ...v, at: v.at ? new Date(v.at) : deps.now(), by: actorOf(req) });
    res.status(201).json({ id });
  }));

  // ---- channels ----
  r.get("/outreach/channels", h(async (_req, res) => res.json({ channels: await scoreboard(deps.db, deps.now()) })));
  r.patch("/outreach/channels/:key", h(async (req, res) => {
    const parsed = parseBody(channelPatch, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const s = setClause(parsed.data as Record<string, unknown>);
    if (!s.sql) return bad(res, { form: "Nothing to change." });
    const u = await deps.db.query(`UPDATE ks_mkt_channels SET ${s.sql}, updated_at = now() WHERE key = $1 RETURNING key`, [req.params.key, ...s.params]);
    if (!u.rows.length) return notFound(res);
    res.json({ channels: await scoreboard(deps.db, deps.now()) });
  }));

  // ---- items (events, communities, podcasts, ad campaigns, directories, videos, partners, pages) ----
  r.get("/outreach/items", h(async (req, res) => {
    const channel = String(req.query.channel ?? "").trim() || null;
    const rows = (await deps.db.query(
      `SELECT i.*, (SELECT count(*)::int FROM ks_mkt_touches t WHERE t.item_id = i.id) AS touches,
              (SELECT count(*)::int FROM ks_mkt_touches t WHERE t.item_id = i.id AND t.outcome IN ('owner_conversation', 'demo', 'signup')) AS wins,
              (SELECT COALESCE(sum(l.clicks), 0)::int FROM ks_mkt_links l WHERE l.item_id = i.id) AS clicks
         FROM ks_mkt_channel_items i WHERE ($1::text IS NULL OR i.channel_key = $1) ORDER BY COALESCE(i.happens_on, i.created_at::date) DESC, i.name LIMIT 500`, [channel])).rows;
    res.json({ items: rows });
  }));
  r.post("/outreach/items", h(async (req, res) => {
    const parsed = parseBody(itemSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    if (!(await channelExists(v.channel_key))) return bad(res, { channel_key: "Unknown channel." });
    const ins = await deps.db.query(
      `INSERT INTO ks_mkt_channel_items (channel_key, kind, name, url, happens_on, cost_cents, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [v.channel_key, v.kind, v.name, v.url ?? null, v.happens_on ?? null, v.cost_cents ?? 0, v.status ?? "planned", v.notes ?? null, actorOf(req)]);
    res.status(201).json({ item: ins.rows[0] });
  }));
  r.patch("/outreach/items/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const parsed = parseBody(itemSchema.partial().omit({ channel_key: true }).strict(), req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const s = setClause(parsed.data as Record<string, unknown>);
    if (!s.sql) return bad(res, { form: "Nothing to change." });
    const u = await deps.db.query(`UPDATE ks_mkt_channel_items SET ${s.sql}, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, ...s.params]);
    return u.rows.length ? res.json({ item: u.rows[0] }) : notFound(res);
  }));

  // ---- tracked links ----
  r.post("/outreach/links", h(async (req, res) => {
    const parsed = parseBody(linkSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    if (!(await channelExists(v.channel_key))) return bad(res, { channel_key: "Unknown channel." });
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const ins = await deps.db.query(
        `INSERT INTO ks_mkt_links (code, channel_key, brokerage_id, item_id, target_url, label, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING RETURNING *`,
        [code, v.channel_key, v.brokerage_id ?? null, v.item_id ?? null, v.target_url, v.label ?? null, actorOf(req)]);
      if (ins.rows.length) {
        const base = opsPublicUrl(`${req.protocol}://${req.get("host") ?? ""}`);
        return res.status(201).json({ link: ins.rows[0], url: `${base}/api/public/marketing/l/${code}` });
      }
    }
    return res.status(500).json({ error: "link_code", message: "A link could not be made. Try again." });
  }));

  // ---- referrals ----
  r.get("/outreach/referrals", h(async (_req, res) => {
    const rows = (await deps.db.query(
      `SELECT f.*, b.name AS referred_brokerage FROM ks_referrals f LEFT JOIN ks_brokerages b ON b.id = f.referred_brokerage_id ORDER BY f.created_at DESC LIMIT 500`)).rows;
    res.json({ referrals: rows, owed_cents: rows.filter((x: any) => x.status === "reward_owed").reduce((a: number, x: any) => a + (x.reward_cents || 0), 0) });
  }));
  r.post("/outreach/referrals", h(async (req, res) => {
    const parsed = parseBody(referralSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    const ins = await deps.db.query(
      `INSERT INTO ks_referrals (referrer_licensee_id, referrer_name, code, referred_brokerage_id, referred_name, status, reward, reward_cents, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [v.referrer_licensee_id ?? null, v.referrer_name, newCode(8).toUpperCase(), v.referred_brokerage_id ?? null, v.referred_name ?? null,
        v.referred_brokerage_id || v.referred_name ? "referred" : "open", v.reward ?? null, v.reward_cents ?? 0, v.notes ?? null, actorOf(req)]);
    if (v.referred_brokerage_id) await addTouch(deps.db, { channel_key: "referrals", brokerage_id: v.referred_brokerage_id, direction: "in", outcome: "reply", summary: `Referred by ${v.referrer_name}.`, at: deps.now(), by: actorOf(req) });
    res.status(201).json({ referral: ins.rows[0] });
  }));
  r.patch("/outreach/referrals/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return notFound(res);
    const parsed = parseBody(referralPatch, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const data = { ...(parsed.data as Record<string, unknown>) };
    if (data.status === "reward_applied") { data.reward_applied_at = deps.now(); data.reward_applied_by = actorOf(req); }
    const s = setClause(data);
    if (!s.sql) return bad(res, { form: "Nothing to change." });
    const u = await deps.db.query(`UPDATE ks_referrals SET ${s.sql}, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, ...s.params]);
    return u.rows.length ? res.json({ referral: u.rows[0] }) : notFound(res);
  }));

  // ---- priority rules ----
  r.get("/outreach/fit-rules", h(async (_req, res) => res.json({ rules: await loadFitRules(deps.db), defaults: DEFAULT_FIT_RULES })));
  r.put("/outreach/fit-rules", h(async (req, res) => {
    const rules = fitRules(req.body?.rules);
    await deps.db.query(`UPDATE ks_outreach_settings SET fit_rules = $1::jsonb, updated_by = $2, updated_at = now() WHERE id = 1`, [JSON.stringify(rules), actorOf(req)]);
    const ids = (await deps.db.query(`SELECT id FROM ks_brokerages WHERE qualification <> 'remove'`)).rows.map((x: any) => x.id as string);
    const run = async () => { for (const id of ids) await rescore(deps.db, id, rules); };
    // A long list is re-scored after the answer goes back; a short one before, so the screen shows the new order at once.
    if (ids.length > 2000) void run().catch((e) => console.error("[outreach] re-score failed", e instanceof Error ? e.message : String(e)));
    else await run();
    res.json({ rules, rescored: ids.length, in_background: ids.length > 2000 });
  }));

  // ---- KS_OPS_OUTREACH_v2: physical mail ----
  const letterSchema = z.object({
    greeting: z.string().trim().min(1).max(500), body: z.string().trim().min(1, "Write the letter.").max(4000), closing: z.string().trim().max(500),
    signature: z.string().trim().max(500), ps: z.string().trim().max(500),
    target_url: z.string().trim().max(500).refine((u) => u === "" || /^https:\/\//i.test(u), "The address must start with https://"),
  });
  r.get("/outreach/letter", h(async (_req, res) => res.json({ letter: await loadLetter(deps.db), defaults: DEFAULT_LETTER, merge_fields: ["first_name", "name", "company", "title"] })));
  const saveLetter = h(async (req, res) => {
    const parsed = parseBody(letterSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    await deps.db.query(`UPDATE ks_outreach_settings SET letter = $1::jsonb, updated_by = $2, updated_at = now() WHERE id = 1`, [JSON.stringify(parsed.data), actorOf(req)]);
    res.json({ letter: letterFrom(parsed.data) });
  });
  r.put("/outreach/letter", saveLetter);
  r.post("/outreach/letter", saveLetter); // the staff portal's client sends GET, POST and PATCH only
  r.get("/outreach/mail/ready", h(async (req, res) => {
    const list = await pickRecipients(deps.db, { limit: 2000, countries: split(req.query.countries) });
    const noAddress = Number((await deps.db.query(`SELECT count(*)::int AS n FROM ks_brokerages WHERE qualification = 'keep' AND status = 'working' AND (address_line1 IS NULL OR city IS NULL)`)).rows[0]?.n ?? 0);
    res.json({ ready: list.length, without_address: noAddress, first: list.slice(0, 10).map((x) => ({ company: x.company, name: x.name, city: x.city })) });
  }));
  const batchSchema = z.object({
    name: z.string().trim().min(1, "Name the batch.").max(200), limit: z.number().int().min(1).max(500), countries: z.array(z.string().trim().min(2).max(3)).max(5).optional(),
    brokerage_ids: z.array(z.string().regex(UUID_RE)).max(500).optional(), cost_per_letter_cents: cents.optional(),
  });
  r.post("/outreach/mail/batches", h(async (req, res) => {
    const parsed = parseBody(batchSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const made = await createMailBatch(deps.db, deps.now(), {
      ...parsed.data, by: actorOf(req), base_url: opsPublicUrl(`${req.protocol}://${req.get("host") ?? ""}`), fallback_url: publicSiteUrl(),
    });
    if (!made) return bad(res, { limit: "No firm is ready for a letter: each needs a mailing address and a decision-maker, and must not have had a letter already." });
    res.status(201).json(made);
  }));
  const batchOf = async (id: string): Promise<{ name: string; recipients: Recipient[]; letter: unknown } | null> => {
    if (!UUID_RE.test(id)) return null;
    const row = (await deps.db.query(`SELECT name, data FROM ks_mkt_channel_items WHERE id = $1 AND kind = 'mail_batch'`, [id])).rows[0];
    return row && Array.isArray(row.data?.recipients) ? { name: row.name, recipients: row.data.recipients, letter: row.data.letter } : null;
  };
  const fileName = (name: string, ext: string) => `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "letters"}.${ext}`;
  r.get("/outreach/mail/batches/:id/letters", h(async (req, res) => {
    const b = await batchOf(req.params.id);
    if (!b) return notFound(res);
    const pdf = await lettersPdf(b.recipients, letterFrom(b.letter), deps.now());
    res.setHeader("Cache-Control", "no-store");
    res.json({ filename: fileName(b.name, "pdf"), content_type: "application/pdf", data_base64: pdf.toString("base64"), letters: b.recipients.length });
  }));
  r.get("/outreach/mail/batches/:id/labels", h(async (req, res) => {
    const b = await batchOf(req.params.id);
    if (!b) return notFound(res);
    res.json({ filename: fileName(`${b.name}-labels`, "csv"), content_type: "text/csv", csv: labelsCsv(b.recipients) });
  }));

  // ---- KS_OPS_OUTREACH_v2: paid ads ----
  r.get("/outreach/ads/linkedin-audience", h(async (req, res) => {
    const out = await linkedInAudienceCsv(deps.db, split(req.query.countries));
    res.json({ filename: "keystone-linkedin-company-list.csv", content_type: "text/csv", ...out });
  }));

  return r;
}
