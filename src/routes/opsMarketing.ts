// KS_OPS_PROSPECT_MARKETING_v1 - staff API for Keystone marketing to prospective licensees (the staff portal's
// Keystone silo > Marketing). Mounted under /api/ops/marketing behind requireStaff.
//   GET   /status                              sender, domain authentication, tracking, warnings
//   GET   /prospects?statuses=&sources=&plans=&countries=&regions=&q=&eligible=&limit=&offset=
//   POST  /prospects                           add one (with the consent staff record)
//   POST  /prospects/import                    { rows: [...], consent: {...} } up to 2,000
//   GET   /prospects/:id                       prospect, eligibility, timeline, sends, sequences
//   PATCH /prospects/:id                       details, status, plan interest, consent
//   POST  /prospects/:id/replied               mark replied (stops their sequences)
//   POST  /audience                            { filters } -> total, eligible, blocked by reason
//   GET   /templates  POST /templates  PATCH /templates/:id  POST /templates/:id/archive
//   POST  /preview                             { subject, fields } -> rendered HTML and text
//   POST  /test                                { subject, fields, to: [emails] } (max 5)
//   GET   /campaigns  POST /campaigns  GET /campaigns/:id  PATCH /campaigns/:id (draft only)
//   POST  /campaigns/:id/send                  { send_at? } now or scheduled
//   POST  /campaigns/:id/cancel                scheduled or sending -> cancelled (queued rows dropped)
//   GET   /sequences  POST /sequences  GET /sequences/:id  PATCH /sequences/:id
//   POST  /sequences/:id/enroll                { filters } or { prospect_ids }
//   POST  /enrollments/:id/stop
//   GET   /suppressions  POST /suppressions  POST /suppressions/remove (staff-added entries only)
import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import {
  BLOCK_MESSAGES, CONSENT_LABELS, CONSENT_TYPES, defaultExpiry, isEmail, PROSPECT_SOURCES, PROSPECT_STATUSES,
  SUPPRESSION_REASONS, type ConsentType,
} from "../marketing/consent.js";
import { campaignStats, enrollProspects, queueCampaign, stopEnrollmentByStaff, testSend } from "../marketing/engine.js";
import { markReplied, recordEvent, suppressProspectEmail } from "../marketing/events.js";
import { addProspectEvent, audienceSummary, eligibilityOf, findProspects, prospectWithSuppression, upsertProspect, type SegmentFilters } from "../marketing/prospects.js";
import { renderEmail, templateFieldsSchema } from "../marketing/render.js";
import { marketingStatus, sendingProblem } from "../marketing/settings.js";

const MAX_IMPORT = 2000;
const strList = z.array(z.string().trim().min(1).max(60)).max(60).optional();
export const filtersSchema = z
  .object({
    statuses: z.array(z.enum(PROSPECT_STATUSES)).max(10).optional(),
    sources: z.array(z.enum(PROSPECT_SOURCES)).max(10).optional(),
    plans: strList,
    countries: strList,
    regions: strList,
    q: z.string().trim().max(200).optional(),
  })
  .strict();

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Enter a valid date.");

const consentSchema = z
  .object({
    consent_type: z.enum(CONSENT_TYPES, { error: "Choose the type of consent." }),
    consent_source: z.string().trim().max(500).optional(),
    consent_text: z.string().trim().max(2000).optional(),
    consent_at: isoDate.optional(),
    consent_expires_at: isoDate.nullable().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.consent_type !== "none" && !c.consent_source) {
      ctx.addIssue({ code: "custom", path: ["consent_source"], message: "Say where the consent came from (form, call, email, website...)." });
    }
    if (c.consent_type.startsWith("implied") && !c.consent_at) {
      ctx.addIssue({ code: "custom", path: ["consent_at"], message: "Implied consent needs the date it was given." });
    }
  });

const prospectSchema = z.object({
  email: z.string().trim().toLowerCase().refine(isEmail, "Enter a valid email address."),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(200).optional(),
  country: z.enum(["CA", "US"]).optional(),
  province_state: z.string().trim().toUpperCase().max(40).optional(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  plan_interest: z.enum(["starter", "growth", "pro"]).nullable().optional(),
});

const patchSchema = prospectSchema
  .omit({ email: true })
  .extend({ consent: consentSchema.optional(), country: z.enum(["CA", "US"]).nullable().optional(), province_state: z.string().trim().toUpperCase().max(40).nullable().optional() })
  .strict();

const templateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name.").max(200),
  subject: z.string().trim().min(1, "Write a subject line.").max(200),
  fields: templateFieldsSchema,
});

const campaignSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(200),
  template_id: z.string().regex(UUID_RE).nullable().optional(),
  subject: z.string().trim().min(1, "Write a subject line.").max(200),
  fields: templateFieldsSchema,
  filters: filtersSchema.default({}),
});

const stepSchema = z.object({ wait_days: z.number().int().min(0).max(365), template_id: z.string().regex(UUID_RE, "Choose a template for every step.") });
const sequenceSchema = z.object({
  name: z.string().trim().min(1, "Give the sequence a name.").max(200),
  steps: z.array(stepSchema).max(20).default([]),
  status: z.enum(["draft", "active", "paused"]).optional(),
});

/** ?statuses=a,b&sources=... as filters. */
function filtersFromQuery(q: Record<string, unknown>): SegmentFilters {
  const split = (k: string) => {
    const v = String(q[k] ?? "").trim();
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60) : undefined;
  };
  return { statuses: split("statuses"), sources: split("sources"), plans: split("plans"), countries: split("countries"), regions: split("regions"), q: String(q.q ?? "").slice(0, 200) || undefined };
}

function consentRecord(c: z.infer<typeof consentSchema>, now: Date, by: string) {
  const at = c.consent_at ? new Date(c.consent_at) : c.consent_type === "express" ? now : null;
  const expires = c.consent_expires_at !== undefined && c.consent_expires_at !== null ? new Date(c.consent_expires_at) : at ? defaultExpiry(c.consent_type as ConsentType, at) : null;
  return {
    consent_type: c.consent_type,
    consent_source: c.consent_source ?? null,
    consent_text: c.consent_text ?? null,
    consent_at: at,
    consent_expires_at: c.consent_type === "express" || c.consent_type === "us_opt_out" ? null : expires,
    consent_recorded_by: by,
  };
}

export function opsMarketingRouter(deps: Deps): Router {
  const r = Router();
  const bad = (res: any, errors: Record<string, string>) => res.status(400).json({ error: "validation_error", errors });

  r.get("/marketing/status", h(async (req, res) => {
    res.json({
      ...(await marketingStatus(deps.fetch, deps.now(), req.query.refresh === "1")),
      consent_types: CONSENT_TYPES.map((k) => ({ key: k, label: CONSENT_LABELS[k] })),
      block_reasons: BLOCK_MESSAGES,
    });
  }));

  // ---- prospects ----

  r.get("/marketing/prospects", h(async (req, res) => {
    const f = filtersFromQuery(req.query as Record<string, unknown>);
    const parsed = filtersSchema.safeParse(f);
    if (!parsed.success) return bad(res, { filters: "Unknown status or source in the filters." });
    const { rows, total } = await findProspects(deps.db, parsed.data, deps.now(), { limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 });
    const want = String(req.query.eligible ?? "");
    const out = want === "yes" ? rows.filter((p) => p.eligibility.ok) : want === "no" ? rows.filter((p) => !p.eligibility.ok) : rows;
    res.json({ prospects: out, total });
  }));

  r.post("/marketing/prospects", h(async (req, res) => {
    const parsed = parseBody(prospectSchema.extend({ consent: consentSchema.optional() }), req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    const existing = await deps.db.query(`SELECT id FROM ks_prospects WHERE lower(email) = $1`, [v.email]);
    if (existing.rows.length) return res.status(409).json({ error: "exists", message: "That email is already a prospect.", id: existing.rows[0].id });
    const actor = actorOf(req);
    const id = await upsertProspect(deps.db, deps.now(), {
      ...v, source: "manual", status: v.status ?? "lead",
      consent: v.consent ? consentRecord(v.consent, deps.now(), actor) : null,
      event: { type: "created", summary: `Added by ${actor}.`, at: deps.now(), dedupe_key: `manual:${v.email}` },
    });
    res.status(201).json({ prospect: await prospectWithSuppression(deps.db, id) });
  }));

  r.post("/marketing/prospects/import", h(async (req, res) => {
    const body = req.body ?? {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) return bad(res, { rows: "Paste at least one row." });
    if (rows.length > MAX_IMPORT) return bad(res, { rows: `At most ${MAX_IMPORT} rows at a time.` });
    let consent = null;
    if (body.consent) {
      const c = consentSchema.safeParse(body.consent);
      if (!c.success) return bad(res, Object.fromEntries(c.error.issues.map((i) => [`consent.${i.path.join(".")}`, i.message])));
      consent = consentRecord(c.data, deps.now(), actorOf(req));
    }
    const result = { added: 0, updated: 0, skipped: [] as Array<{ row: number; email: string; error: string }> };
    for (let i = 0; i < rows.length; i++) {
      const p = prospectSchema.safeParse(rows[i]);
      if (!p.success) {
        result.skipped.push({ row: i + 1, email: String(rows[i]?.email ?? ""), error: p.error.issues[0]?.message ?? "Invalid row." });
        continue;
      }
      const had = (await deps.db.query(`SELECT 1 FROM ks_prospects WHERE lower(email) = $1`, [p.data.email])).rows.length > 0;
      await upsertProspect(deps.db, deps.now(), { ...p.data, source: "import", status: p.data.status ?? "lead", consent });
      if (had) result.updated++;
      else result.added++;
    }
    res.json(result);
  }));

  r.get("/marketing/prospects/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const p = await prospectWithSuppression(deps.db, req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const [events, sends, enrollments] = await Promise.all([
      deps.db.query(`SELECT id, type, summary, at FROM ks_prospect_events WHERE prospect_id = $1 ORDER BY at DESC, id DESC LIMIT 200`, [p.id]),
      deps.db.query(
        `SELECT s.id, s.subject, s.status, s.block_reason, s.sent_at, s.opened_at, s.clicked_at, s.bounced_at, s.campaign_id, c.name AS campaign_name,
                s.enrollment_id, s.step_index, q.name AS sequence_name, s.created_at
           FROM ks_mkt_sends s LEFT JOIN ks_mkt_campaigns c ON c.id = s.campaign_id
           LEFT JOIN ks_mkt_enrollments e ON e.id = s.enrollment_id LEFT JOIN ks_mkt_sequences q ON q.id = e.sequence_id
          WHERE s.prospect_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
        [p.id],
      ),
      deps.db.query(
        `SELECT e.id, e.status, e.next_step, e.next_send_at, e.stopped_reason, e.enrolled_at, e.finished_at, q.name AS sequence_name, q.id AS sequence_id
           FROM ks_mkt_enrollments e JOIN ks_mkt_sequences q ON q.id = e.sequence_id WHERE e.prospect_id = $1 ORDER BY e.enrolled_at DESC`,
        [p.id],
      ),
    ]);
    res.json({ prospect: p, eligibility: eligibilityOf(p, deps.now()), events: events.rows, sends: sends.rows, enrollments: enrollments.rows });
  }));

  r.patch("/marketing/prospects/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const parsed = parseBody(patchSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const p = await prospectWithSuppression(deps.db, req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    const v = parsed.data;
    const actor = actorOf(req);
    const now = deps.now();
    const sets: string[] = [];
    const vals: unknown[] = [p.id];
    const set = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    for (const k of ["name", "company", "phone", "title", "country", "province_state", "plan_interest"] as const) {
      if (v[k] !== undefined) set(k, v[k] === "" ? null : v[k]);
    }
    if (v.status && v.status !== p.status) {
      set("status", v.status);
      if (v.status === "demo_booked") set("demo_booked_at", now);
      if (v.status === "trial" || v.status === "customer") set("signed_up_at", now);
    }
    if (v.consent) {
      const c = consentRecord(v.consent, now, actor);
      set("consent_type", c.consent_type);
      set("consent_source", c.consent_source);
      set("consent_text", c.consent_text);
      set("consent_at", c.consent_at);
      set("consent_expires_at", c.consent_expires_at);
      set("consent_recorded_by", actor);
    }
    if (!sets.length) return res.json({ prospect: p, eligibility: eligibilityOf(p, now) });
    await deps.db.query(`UPDATE ks_prospects SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    if (v.status && v.status !== p.status) await addProspectEvent(deps.db, p.id, "status_changed", `Status: ${p.status} -> ${v.status} (${actor}).`, now);
    if (v.consent) {
      await recordEvent(deps.db, p, "consent_changed", `Consent recorded by ${actor}: ${CONSENT_LABELS[v.consent.consent_type]}${v.consent.consent_source ? ` (${v.consent.consent_source})` : ""}.`, now, { crm: true });
    }
    const fresh = (await prospectWithSuppression(deps.db, p.id))!;
    res.json({ prospect: fresh, eligibility: eligibilityOf(fresh, now) });
  }));

  r.post("/marketing/prospects/:id/replied", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const stopped = await markReplied(deps.db, req.params.id, deps.now(), `marked by ${actorOf(req)}`);
    res.json({ ok: true, stopped });
  }));

  r.post("/marketing/audience", h(async (req, res) => {
    const parsed = parseBody(z.object({ filters: filtersSchema.default({}) }), req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    res.json(await audienceSummary(deps.db, parsed.data.filters, deps.now()));
  }));

  // ---- templates, preview and test ----

  r.get("/marketing/templates", h(async (req, res) => {
    const all = req.query.archived === "1";
    const t = await deps.db.query(`SELECT * FROM ks_mkt_templates WHERE ($1 OR NOT archived) ORDER BY updated_at DESC LIMIT 500`, [all]);
    res.json({ templates: t.rows });
  }));

  r.post("/marketing/templates", h(async (req, res) => {
    const parsed = parseBody(templateSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const t = await deps.db.query(
      `INSERT INTO ks_mkt_templates (name, subject, fields, created_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
      [parsed.data.name, parsed.data.subject, JSON.stringify(parsed.data.fields), actorOf(req)],
    );
    res.status(201).json({ template: t.rows[0] });
  }));

  r.patch("/marketing/templates/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const parsed = parseBody(templateSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const t = await deps.db.query(
      `UPDATE ks_mkt_templates SET name = $2, subject = $3, fields = $4::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, parsed.data.name, parsed.data.subject, JSON.stringify(parsed.data.fields)],
    );
    if (!t.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ template: t.rows[0] });
  }));

  r.post("/marketing/templates/:id/archive", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const archived = req.body?.archived !== false;
    const t = await deps.db.query(`UPDATE ks_mkt_templates SET archived = $2, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, archived]);
    if (!t.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ template: t.rows[0] });
  }));

  r.post("/marketing/preview", h(async (req, res) => {
    const parsed = parseBody(z.object({ subject: z.string().max(200).default(""), fields: templateFieldsSchema }), req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const sample = { email: "alex@sample-brokerage.example", name: "Alex Sample", company: "Sample Brokerage", consent_type: "express" };
    let out;
    try {
      out = renderEmail(parsed.data.subject, parsed.data.fields, sample, { base: "https://example.invalid" });
    } catch {
      out = null;
    }
    if (!out) return res.status(409).json({ error: "unsubscribe_not_configured", message: "Unsubscribe links cannot be signed: set OPS_JWT_SECRET on KS-Ops." });
    res.json({ subject: out.subject, html: out.html, text: out.text });
  }));

  r.post("/marketing/test", h(async (req, res) => {
    const parsed = parseBody(
      z.object({
        subject: z.string().trim().min(1, "Write a subject line.").max(200),
        fields: templateFieldsSchema,
        to: z.array(z.string().trim().toLowerCase().refine(isEmail, "Enter valid email addresses.")).min(1, "Add an address to send the test to.").max(5, "At most 5 test addresses."),
      }),
      req.body,
    );
    if (!parsed.ok) return bad(res, parsed.errors);
    const problem = sendingProblem();
    if (problem) return res.status(409).json({ error: "sending_not_configured", message: problem });
    res.json(await testSend(deps, parsed.data, parsed.data.to));
  }));

  // ---- campaigns ----

  r.get("/marketing/campaigns", h(async (_req, res) => {
    const c = await deps.db.query(
      `SELECT c.id, c.name, c.subject, c.status, c.send_at, c.started_at, c.finished_at, c.created_by, c.created_at, c.filters,
              (SELECT count(*) FILTER (WHERE status = 'sent')::int FROM ks_mkt_sends s WHERE s.campaign_id = c.id) AS sent,
              (SELECT count(*) FILTER (WHERE status = 'blocked')::int FROM ks_mkt_sends s WHERE s.campaign_id = c.id) AS blocked,
              (SELECT count(opened_at)::int FROM ks_mkt_sends s WHERE s.campaign_id = c.id) AS opened,
              (SELECT count(clicked_at)::int FROM ks_mkt_sends s WHERE s.campaign_id = c.id) AS clicked
         FROM ks_mkt_campaigns c ORDER BY c.created_at DESC LIMIT 200`,
    );
    res.json({ campaigns: c.rows });
  }));

  r.post("/marketing/campaigns", h(async (req, res) => {
    const parsed = parseBody(campaignSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    const c = await deps.db.query(
      `INSERT INTO ks_mkt_campaigns (name, template_id, subject, fields, filters, created_by) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [v.name, v.template_id ?? null, v.subject, JSON.stringify(v.fields), JSON.stringify(v.filters), actorOf(req)],
    );
    res.status(201).json({ campaign: c.rows[0] });
  }));

  r.get("/marketing/campaigns/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const c = (await deps.db.query(`SELECT * FROM ks_mkt_campaigns WHERE id = $1`, [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: "not_found" });
    const recipients = await deps.db.query(
      `SELECT s.id, s.email, s.status, s.block_reason, s.error, s.sent_at, s.opened_at, s.clicked_at, s.bounced_at, s.unsubscribed_at, p.name, p.company, p.id AS prospect_id
         FROM ks_mkt_sends s JOIN ks_prospects p ON p.id = s.prospect_id WHERE s.campaign_id = $1 ORDER BY s.id LIMIT 2000`,
      [c.id],
    );
    res.json({ campaign: c, stats: await campaignStats(deps.db, c.id), recipients: recipients.rows });
  }));

  r.patch("/marketing/campaigns/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const parsed = parseBody(campaignSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    const c = await deps.db.query(
      `UPDATE ks_mkt_campaigns SET name = $2, template_id = $3, subject = $4, fields = $5::jsonb, filters = $6::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'draft' RETURNING *`,
      [req.params.id, v.name, v.template_id ?? null, v.subject, JSON.stringify(v.fields), JSON.stringify(v.filters)],
    );
    if (!c.rows.length) return res.status(409).json({ error: "not_draft", message: "Only a draft can be changed." });
    res.json({ campaign: c.rows[0] });
  }));

  r.post("/marketing/campaigns/:id/send", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const raw = req.body?.send_at;
    let at = deps.now();
    if (raw) {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) return bad(res, { send_at: "Enter a valid date and time." });
      if (d.getTime() > deps.now().getTime() + 90 * 86_400_000) return bad(res, { send_at: "Schedule at most 90 days ahead." });
      if (d.getTime() > at.getTime()) at = d;
    }
    const out = await queueCampaign(deps, req.params.id, at);
    if (!out.ok) return res.status(out.status).json({ error: out.error, message: out.message });
    res.json({ ...out, send_at: at.toISOString() });
  }));

  r.post("/marketing/campaigns/:id/cancel", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const c = await deps.db.query(
      `UPDATE ks_mkt_campaigns SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'sending') RETURNING id`,
      [req.params.id],
    );
    if (!c.rows.length) return res.status(409).json({ error: "not_cancellable", message: "Only a scheduled or sending campaign can be cancelled." });
    const dropped = await deps.db.query(`DELETE FROM ks_mkt_sends WHERE campaign_id = $1 AND status = 'queued' RETURNING id`, [req.params.id]);
    res.json({ ok: true, not_sent: dropped.rows.length });
  }));

  // ---- sequences ----

  r.get("/marketing/sequences", h(async (_req, res) => {
    const s = await deps.db.query(
      `SELECT q.*, (SELECT count(*)::int FROM ks_mkt_enrollments e WHERE e.sequence_id = q.id AND e.status = 'active') AS active,
              (SELECT count(*)::int FROM ks_mkt_enrollments e WHERE e.sequence_id = q.id) AS enrolled
         FROM ks_mkt_sequences q ORDER BY q.updated_at DESC LIMIT 200`,
    );
    res.json({ sequences: s.rows });
  }));

  r.post("/marketing/sequences", h(async (req, res) => {
    const parsed = parseBody(sequenceSchema, req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const s = await deps.db.query(
      `INSERT INTO ks_mkt_sequences (name, steps, status, created_by) VALUES ($1, $2::jsonb, $3, $4) RETURNING *`,
      [parsed.data.name, JSON.stringify(parsed.data.steps), parsed.data.status ?? "draft", actorOf(req)],
    );
    res.status(201).json({ sequence: s.rows[0] });
  }));

  r.get("/marketing/sequences/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const s = (await deps.db.query(`SELECT * FROM ks_mkt_sequences WHERE id = $1`, [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: "not_found" });
    const e = await deps.db.query(
      `SELECT e.*, p.email, p.name, p.company FROM ks_mkt_enrollments e JOIN ks_prospects p ON p.id = e.prospect_id
        WHERE e.sequence_id = $1 ORDER BY e.enrolled_at DESC LIMIT 2000`,
      [s.id],
    );
    res.json({ sequence: s, enrollments: e.rows });
  }));

  r.patch("/marketing/sequences/:id", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const parsed = parseBody(sequenceSchema.partial(), req.body);
    if (!parsed.ok) return bad(res, parsed.errors);
    const v = parsed.data;
    if (v.status === "active") {
      const cur = (await deps.db.query(`SELECT steps FROM ks_mkt_sequences WHERE id = $1`, [req.params.id])).rows[0];
      const steps = v.steps ?? cur?.steps ?? [];
      if (!steps.length) return bad(res, { steps: "Add at least one step before turning the sequence on." });
    }
    const s = await deps.db.query(
      `UPDATE ks_mkt_sequences SET name = coalesce($2, name), steps = coalesce($3::jsonb, steps), status = coalesce($4, status), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, v.name ?? null, v.steps ? JSON.stringify(v.steps) : null, v.status ?? null],
    );
    if (!s.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ sequence: s.rows[0] });
  }));

  r.post("/marketing/sequences/:id/enroll", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const parsed = parseBody(
      z.object({ filters: filtersSchema.optional(), prospect_ids: z.array(z.string().regex(UUID_RE)).max(5000).optional() }),
      req.body,
    );
    if (!parsed.ok) return bad(res, parsed.errors);
    const out = await enrollProspects(deps, req.params.id, parsed.data, actorOf(req));
    if (!out.ok) return res.status(out.status).json({ error: out.error, message: out.message });
    res.json(out);
  }));

  r.post("/marketing/enrollments/:id/stop", h(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const ok = await stopEnrollmentByStaff(deps.db, req.params.id, actorOf(req), deps.now());
    if (!ok) return res.status(409).json({ error: "not_active", message: "That enrolment has already finished." });
    res.json({ ok: true });
  }));

  // ---- suppression list ----

  r.get("/marketing/suppressions", h(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const s = await deps.db.query(
      `SELECT * FROM ks_mkt_suppressions WHERE ($1 = '' OR email ILIKE '%' || $1 || '%') ORDER BY created_at DESC LIMIT 1000`,
      [q.slice(0, 200)],
    );
    res.json({ suppressions: s.rows, reasons: SUPPRESSION_REASONS });
  }));

  r.post("/marketing/suppressions", h(async (req, res) => {
    const parsed = parseBody(
      z.object({ email: z.string().trim().toLowerCase().refine(isEmail, "Enter a valid email address."), note: z.string().trim().max(500).optional() }),
      req.body,
    );
    if (!parsed.ok) return bad(res, parsed.errors);
    const added = await suppressProspectEmail(deps.db, parsed.data.email, "manual", "staff", deps.now(), { note: parsed.data.note ?? null, by: actorOf(req) });
    res.status(added ? 201 : 200).json({ ok: true, added });
  }));

  r.post("/marketing/suppressions/remove", h(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) return bad(res, { email: "Enter a valid email address." });
    const cur = (await deps.db.query(`SELECT reason FROM ks_mkt_suppressions WHERE email = $1`, [email])).rows[0];
    if (!cur) return res.status(404).json({ error: "not_found" });
    // An unsubscribe, bounce or spam report is the person's (or their server's) decision: only staff-added entries can go.
    if (cur.reason !== "manual") {
      return res.status(409).json({ error: "not_removable", message: "Only entries staff added can be removed. Someone who unsubscribed, bounced or reported spam stays suppressed." });
    }
    await deps.db.query(`DELETE FROM ks_mkt_suppressions WHERE email = $1 AND reason = 'manual'`, [email]);
    const p = (await deps.db.query(`SELECT id FROM ks_prospects WHERE lower(email) = $1`, [email])).rows[0];
    if (p) await addProspectEvent(deps.db, p.id, "unsuppressed", `Removed from the suppression list by ${actorOf(req)}.`, deps.now());
    res.json({ ok: true });
  }));

  return r;
}

