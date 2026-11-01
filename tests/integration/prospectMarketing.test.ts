// KS_OPS_PROSPECT_MARKETING_v1 - Keystone prospect marketing end to end against real Postgres: prospects synced from
// the demo, beta, website assistant and licensee records with their consent; consent gating and the suppression list
// at queue time and at send time; unsubscribe (link and one-click); SendGrid events; sequences stopping on reply,
// demo booking and sign-up; the Keystone CRM pull and the CRM timeline push.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { runCampaigns, runSequences } from "../../src/marketing/engine.js";
import { flushTimelineOutbox } from "../../src/marketing/events.js";
import { pullCrmContacts, syncLocalSources } from "../../src/marketing/prospects.js";
import { unsubscribeToken } from "../../src/marketing/render.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
let offsetMs = 0;
const DAY = 86_400_000;
const sent: Array<{ to: string; subject: string; body: any }> = [];
const timeline: any[] = [];
let crmContacts: any[] = [];
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const WEBHOOK_TOKEN = "webhook-token-0123456789-abcdefghij";

async function prospect(email: string) {
  return (await pool.query(`SELECT p.*, s.reason AS suppressed FROM ks_prospects p LEFT JOIN ks_mkt_suppressions s ON s.email = lower(p.email) WHERE lower(p.email) = $1`, [email])).rows[0];
}

beforeAll(async () => {
  process.env.BF_CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.KS_MARKETING_FROM = "hello@keystone.example";
  process.env.KS_OPS_PUBLIC_URL = "https://ops.keystone.example";
  process.env.KS_MARKETING_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
  pool = await freshPool();
  await pool.query(
    `TRUNCATE ks_prospects, ks_prospect_events, ks_mkt_suppressions, ks_mkt_templates, ks_mkt_campaigns, ks_mkt_sequences,
              ks_mkt_enrollments, ks_mkt_sends, ks_mkt_timeline_outbox, ks_mkt_sync_state, demo_signups, beta_signups, assistant_leads CASCADE`,
  );
  let n = 0;
  deps = {
    db: pool,
    fetch: (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      if (u === "https://api.sendgrid.com/v3/mail/send") {
        const body = JSON.parse(String(init.body));
        sent.push({ to: body.personalizations[0].to[0].email, subject: body.subject, body });
        return new Response("", { status: 202, headers: { "x-message-id": `msg-${++n}` } });
      }
      if (u.includes("/api/ks/marketing/events")) {
        timeline.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes("/api/ks/marketing/contacts")) return new Response(JSON.stringify({ contacts: crmContacts }), { status: 200 });
      if (u.includes("whitelabel/domains")) return new Response(JSON.stringify([{ domain: "keystone.example", valid: true }]), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    mailer: fakeMailer().mailer,
    stripe: () => null,
    now: () => new Date(Date.now() + offsetMs),
  };

  // Sources: a demo sign-up (implied, inquiry), a beta sign-up (implied), a website-assistant lead (express), a
  // customer (implied, business) and an old demo sign-up whose 6 months are over.
  await pool.query(`INSERT INTO demo_signups (name, email, company, token_hash, expires_at) VALUES ('Dee Demo', 'dee@demo.example', 'Demo Co', 'x', now() + interval '7 days')`);
  await pool.query(
    `INSERT INTO demo_signups (name, email, company, token_hash, expires_at, created_at) VALUES ('Old Olly', 'olly@old.example', 'Old Co', 'y', now(), now() - interval '8 months')`,
  );
  await pool.query(`INSERT INTO beta_signups (name, email, brokerage) VALUES ('Bea Beta', 'bea@beta.example', 'Beta Co')`);
  await pool.query(
    `INSERT INTO assistant_leads (name, email, brokerage, team_size, consent, consent_text, wants) VALUES ('Ali Lead', 'ali@lead.example', 'Lead Co', '2-5', true, 'I agree', 'info')`,
  );
  await pool.query(
    `INSERT INTO licensees (company_name, legal_name, company_code, contact_name, contact_email, contact_phone, country, province_state, status, plan)
     VALUES ('Cust Co', 'Cust Co Inc.', 'cust-co', 'Cass Customer', 'cass@cust.example', '4035550100', 'CA', 'AB', 'active', 'growth')`,
  );
});

afterAll(async () => {
  await pool?.end();
});

describe("prospects and consent", () => {
  it("syncs every source with the consent it gives", async () => {
    const r = await syncLocalSources(deps);
    expect(r.failed).toBe(0);
    expect(await prospect("dee@demo.example")).toMatchObject({ status: "demo_booked", consent_type: "implied_inquiry", source: "demo_signup" });
    expect(await prospect("bea@beta.example")).toMatchObject({ status: "lead", consent_type: "implied_inquiry" });
    expect(await prospect("ali@lead.example")).toMatchObject({ status: "lead", consent_type: "express", consent_text: "I agree" });
    expect(await prospect("cass@cust.example")).toMatchObject({ status: "customer", consent_type: "implied_business", province_state: "AB", plan_interest: "growth" });
    // A second run changes nothing (no duplicate timeline entries).
    await syncLocalSources(deps);
    const ev = await pool.query(`SELECT count(*)::int AS n FROM ks_prospect_events e JOIN ks_prospects p ON p.id = e.prospect_id WHERE p.email = 'dee@demo.example' AND e.type = 'demo_booked'`);
    expect(ev.rows[0].n).toBe(1);
  });

  it("staff add a cold prospect with no consent: it is listed as blocked, with the reason", async () => {
    const add = await request(app()).post("/api/ops/marketing/prospects").set(staff()).send({ email: "cold@nobody.example", name: "Cole Cold", country: "CA" });
    expect(add.status).toBe(201);
    const list = await request(app()).get("/api/ops/marketing/prospects?q=cold").set(staff());
    expect(list.body.prospects[0].eligibility).toMatchObject({ ok: false, reason: "no_consent" });
    const noSource = await request(app()).patch(`/api/ops/marketing/prospects/${add.body.prospect.id}`).set(staff()).send({ consent: { consent_type: "express" } });
    expect(noSource.status).toBe(400);
    expect(noSource.body.errors["consent.consent_source"] ?? noSource.body.errors.consent_source ?? JSON.stringify(noSource.body.errors)).toMatch(/where the consent came from/);
  });

  it("the audience preview counts who can be emailed and why the rest cannot", async () => {
    const r = await request(app()).post("/api/ops/marketing/audience").set(staff()).send({ filters: {} });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    expect(r.body.eligible).toBe(4); // dee, bea, ali, cass
    expect(r.body.blocked).toEqual({ no_consent: 1, consent_expired: 1 });
  });
});

describe("campaigns", () => {
  let templateId = "";
  let campaignId = "";

  it("a test send goes to staff only, marked [Test]", async () => {
    const t = await request(app()).post("/api/ops/marketing/templates").set(staff()).send({
      name: "Launch", subject: "Keystone for {{company}}", fields: { headline: "Hi {{first_name}}", body: "Keystone is here.", cta_label: "See plans", cta_url: "https://keystone.example/plans" },
    });
    expect(t.status).toBe(201);
    templateId = t.body.template.id;
    const r = await request(app()).post("/api/ops/marketing/test").set(staff()).send({ subject: t.body.template.subject, fields: t.body.template.fields, to: ["todd@staff.example"] });
    expect(r.status).toBe(200);
    expect(sent.map((s) => s.to)).toEqual(["todd@staff.example"]);
    expect(sent[0]!.subject).toBe("[Test] Keystone for Sample Brokerage");
    sent.length = 0;
  });

  it("queues only consenting, unsuppressed prospects and sends with the unsubscribe headers", async () => {
    await request(app()).post("/api/ops/marketing/suppressions").set(staff()).send({ email: "bea@beta.example", note: "asked by phone" });
    const c = await request(app()).post("/api/ops/marketing/campaigns").set(staff()).send({
      name: "Launch email", template_id: templateId, subject: "Keystone for {{company}}", fields: { body: "Hello {{first_name}}" }, filters: { statuses: ["lead", "demo_booked", "customer"] },
    });
    expect(c.status).toBe(201);
    campaignId = c.body.campaign.id;
    const q = await request(app()).post(`/api/ops/marketing/campaigns/${campaignId}/send`).set(staff()).send({});
    expect(q.status).toBe(200);
    expect(q.body.queued).toBe(3); // dee, ali, cass
    expect(q.body.blocked).toEqual({ suppressed_manual: 1, no_consent: 1, consent_expired: 1 });
    // Ali unsubscribes after queueing but before the send: the last check catches it.
    const t = unsubscribeToken("ali@lead.example");
    const u = await request(app()).post(`/api/public/marketing/unsubscribe?t=${encodeURIComponent(t)}`).type("form").send("List-Unsubscribe=One-Click");
    expect(u.status).toBe(200);
    const r = await runCampaigns(deps);
    expect(r).toMatchObject({ sent: 2, blocked: 1 });
    expect(sent.map((s) => s.to).sort()).toEqual(["cass@cust.example", "dee@demo.example"]);
    for (const s of sent) {
      expect(s.body.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/ops\.keystone\.example\/api\/public\/marketing\/unsubscribe\?t=/);
      expect(s.body.content[1].value).toContain("450 Sparling Crt SW");
    }
    const detail = await request(app()).get(`/api/ops/marketing/campaigns/${campaignId}`).set(staff());
    expect(detail.body.campaign.status).toBe("sent");
    expect(detail.body.stats).toMatchObject({ sent: 2, blocked: 4 });
    expect(detail.body.stats.blocked_by_reason).toMatchObject({ suppressed_unsubscribed: 1 });
  });

  it("records SendGrid events and suppresses a hard bounce", async () => {
    const rows = (await pool.query(`SELECT id, email FROM ks_mkt_sends WHERE campaign_id = $1 AND status = 'sent' ORDER BY email`, [campaignId])).rows;
    const cass = rows.find((r: any) => r.email === "cass@cust.example");
    const dee = rows.find((r: any) => r.email === "dee@demo.example");
    const events = [
      { event: "open", email: "dee@demo.example", timestamp: Math.floor(Date.now() / 1000), sg_event_id: "e1", ks_mkt: "1", ks_mkt_send_id: String(dee.id) },
      { event: "click", email: "dee@demo.example", timestamp: Math.floor(Date.now() / 1000), sg_event_id: "e2", url: "https://keystone.example/plans", ks_mkt: "1", ks_mkt_send_id: String(dee.id) },
      { event: "bounce", type: "bounce", email: "cass@cust.example", reason: "550 no such user", timestamp: Math.floor(Date.now() / 1000), sg_event_id: "e3", ks_mkt: "1", ks_mkt_send_id: String(cass.id) },
      { event: "open", email: "someone@bf.example", sg_event_id: "bf1" },
    ];
    const bad = await request(app()).post("/api/public/marketing/sendgrid-events?token=wrong-token-0123456789-xxxx").set("Content-Type", "application/json").send(JSON.stringify(events));
    expect(bad.status).toBe(403);
    const r = await request(app()).post(`/api/public/marketing/sendgrid-events?token=${WEBHOOK_TOKEN}`).set("Content-Type", "application/json").send(JSON.stringify(events));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: 3, ignored: 1 });
    expect((await pool.query(`SELECT opened_at, clicked_at FROM ks_mkt_sends WHERE id = $1`, [dee.id])).rows[0].clicked_at).not.toBeNull();
    expect((await prospect("cass@cust.example")).suppressed).toBe("hard_bounce");
  });

  it("writes marketing events to the Keystone CRM timeline", async () => {
    const r = await flushTimelineOutbox(deps);
    expect(r.failed).toBe(0);
    const all = timeline.flatMap((t) => t.events.map((e: any) => `${t.email} ${e.type}`));
    expect(all).toEqual(expect.arrayContaining(["dee@demo.example email_sent", "dee@demo.example email_opened", "dee@demo.example email_clicked", "ali@lead.example unsubscribed", "cass@cust.example email_bounced"]));
    expect((await flushTimelineOutbox(deps)).sent).toBe(0);
  });
});

describe("sequences", () => {
  let seqId = "";
  it("sends step 1, then stops on a reply before step 2", async () => {
    await request(app()).patch(`/api/ops/marketing/prospects/${(await prospect("cold@nobody.example")).id}`).set(staff())
      .send({ consent: { consent_type: "express", consent_source: "Asked for info at a trade show (badge scan)", consent_at: new Date().toISOString() } });
    const tpls = (await request(app()).get("/api/ops/marketing/templates").set(staff())).body.templates;
    const s = await request(app()).post("/api/ops/marketing/sequences").set(staff()).send({
      name: "Nurture", steps: [{ wait_days: 0, template_id: tpls[0].id }, { wait_days: 3, template_id: tpls[0].id }], status: "active",
    });
    expect(s.status).toBe(201);
    seqId = s.body.sequence.id;
    const e = await request(app()).post(`/api/ops/marketing/sequences/${seqId}/enroll`).set(staff()).send({ filters: { q: "cold@" } });
    expect(e.body).toMatchObject({ enrolled: 1, already: 0 });
    sent.length = 0;
    const r1 = await runSequences(deps);
    expect(r1.sent).toBe(1);
    expect(sent[0]!.to).toBe("cold@nobody.example");
    const p = await prospect("cold@nobody.example");
    offsetMs = 1 * DAY;
    await request(app()).post(`/api/ops/marketing/prospects/${p.id}/replied`).set(staff()).send({});
    offsetMs = 4 * DAY;
    sent.length = 0;
    await runSequences(deps);
    expect(sent.length).toBe(0);
    const en = (await pool.query(`SELECT status, stopped_reason FROM ks_mkt_enrollments WHERE sequence_id = $1`, [seqId])).rows[0];
    expect(en).toEqual({ status: "stopped", stopped_reason: "replied" });
  });

  it("stops when the prospect books a demo or signs up after enrolling", async () => {
    offsetMs = 0;
    await request(app()).post("/api/ops/marketing/prospects").set(staff()).send({
      email: "nina@next.example", name: "Nina Next", consent: { consent_type: "express", consent_source: "Email reply asking for news" },
    });
    await request(app()).post("/api/ops/marketing/prospects").set(staff()).send({
      email: "sam@signup.example", name: "Sam Signup", consent: { consent_type: "express", consent_source: "Call notes" },
    });
    const ids = [(await prospect("nina@next.example")).id, (await prospect("sam@signup.example")).id, (await prospect("bea@beta.example")).id];
    const e = await request(app()).post(`/api/ops/marketing/sequences/${seqId}/enroll`).set(staff()).send({ prospect_ids: ids });
    expect(e.body).toMatchObject({ enrolled: 2, blocked: { suppressed_manual: 1 } }); // bea is suppressed
    await new Promise((r) => setTimeout(r, 20));
    await pool.query(`INSERT INTO demo_signups (name, email, company, token_hash, expires_at) VALUES ('Nina Next', 'nina@next.example', 'Next Co', 'z', now() + interval '7 days')`);
    await pool.query(
      `INSERT INTO licensees (company_name, legal_name, company_code, contact_name, contact_email, contact_phone, status, plan)
       VALUES ('Sam Co', 'Sam Co Inc.', 'sam-co', 'Sam Signup', 'sam@signup.example', '4035550101', 'pending_payment', 'starter')`,
    );
    await syncLocalSources(deps);
    sent.length = 0;
    await runSequences(deps);
    expect(sent.map((s) => s.to)).not.toContain("nina@next.example");
    expect(sent.map((s) => s.to)).not.toContain("sam@signup.example");
    const rows = (await pool.query(
      `SELECT p.email, e.status, e.stopped_reason FROM ks_mkt_enrollments e JOIN ks_prospects p ON p.id = e.prospect_id WHERE e.sequence_id = $1 AND p.email IN ('nina@next.example','sam@signup.example') ORDER BY p.email`,
      [seqId],
    )).rows;
    expect(rows).toEqual([
      { email: "nina@next.example", status: "stopped", stopped_reason: "demo_booked" },
      { email: "sam@signup.example", status: "stopped", stopped_reason: "signed_up" },
    ]);
  });

  it("an unsubscribe stops every sequence at once", async () => {
    await request(app()).post("/api/ops/marketing/prospects").set(staff()).send({ email: "uma@unsub.example", consent: { consent_type: "express", consent_source: "Form" } });
    await request(app()).post(`/api/ops/marketing/sequences/${seqId}/enroll`).set(staff()).send({ filters: { q: "uma@" } });
    const t = unsubscribeToken("uma@unsub.example");
    const page = await request(app()).post(`/api/public/marketing/unsubscribe?t=${encodeURIComponent(t)}`).type("form").send("");
    expect(page.text).toContain("You are unsubscribed");
    const en = (await pool.query(`SELECT e.status, e.stopped_reason FROM ks_mkt_enrollments e JOIN ks_prospects p ON p.id = e.prospect_id WHERE p.email = 'uma@unsub.example'`)).rows[0];
    expect(en).toEqual({ status: "stopped", stopped_reason: "unsubscribed" });
    const rm = await request(app()).post("/api/ops/marketing/suppressions/remove").set(staff()).send({ email: "uma@unsub.example" });
    expect(rm.status).toBe(409);
  });
});

describe("the Keystone CRM", () => {
  it("pulls Keystone CRM contacts, maps the stage and honours an opt-out there", async () => {
    crmContacts = [
      { id: "c1", email: "crm@lost.example", name: "Lou Lost", company_name: "Lost Co", ks_stage: "lost", country: "US", province_state: "WA", marketing_opt_out: false, updated_at: new Date().toISOString() },
      { id: "c2", email: "optout@crm.example", name: "Otto", ks_stage: "lead", marketing_opt_out: true, updated_at: new Date().toISOString() },
    ];
    const r = await pullCrmContacts(deps);
    expect(r).toEqual({ seen: 2 });
    expect(await prospect("crm@lost.example")).toMatchObject({ status: "lost", consent_type: "none", country: "US", province_state: "WA", crm_contact_id: "c1" });
    expect((await prospect("optout@crm.example")).suppressed).toBe("crm_opt_out");
  });

  it("filters segments by status, source, plan and region", async () => {
    const r = await request(app()).get("/api/ops/marketing/prospects?regions=AB&plans=growth").set(staff());
    expect(r.body.prospects.map((p: any) => p.email)).toEqual(["cass@cust.example"]);
    const s = await request(app()).get("/api/ops/marketing/prospects?sources=crm&statuses=lost").set(staff());
    expect(s.body.prospects.map((p: any) => p.email)).toEqual(["crm@lost.example"]);
  });

  it("shows the sender status with warnings", async () => {
    const r = await request(app()).get("/api/ops/marketing/status?refresh=1").set(staff());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ can_send: true, domain: { domain: "keystone.example", authenticated: true } });
    expect(r.body.warnings.join(" ")).toMatch(/default mailing address/);
  });
});
