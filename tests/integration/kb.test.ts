// KS_OPS_KB_v1 against a real Postgres: article CRUD and permissions, full-text and semantic search, audience filtering
// on every reader (website, licensee staff, licensee admins), the support assistant (grounded answers with citations,
// "no good answer" logging, escalation, no other licensee's data), the website assistant (no internal costs, lead
// capture into the CRM outbox, hand-off email and task) and the rate limits.
import type pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { seedKnowledgeBase } from "../../src/kb/seed.js";
import { embedPending } from "../../src/kb/repo.js";
import { INTERNAL_COST_REPLY } from "../../src/assistant/guard.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
const now = new Date("2026-10-27T15:00:00Z");
const mail = fakeMailer();
const openaiBodies: Array<Record<string, any>> = [];
let chatReply: Record<string, unknown> = { answer: "", sources: [] };
let embedFor: (text: string) => number[] = () => [1, 0, 0];

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === "https://api.openai.com/v1/chat/completions") {
    openaiBodies.push(JSON.parse(String(init.body)));
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(chatReply) } }] });
  }
  if (url === "https://api.openai.com/v1/embeddings") {
    const input = JSON.parse(String(init.body)).input as string[];
    return jsonResponse({ data: input.map((t, index) => ({ index, embedding: embedFor(t) })) });
  }
  return jsonResponse({ ok: true });
});

let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

async function makeLicensee(code: string, name: string, plan = "starter"): Promise<{ id: string; key: string }> {
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: name, legal_name: `${name} Inc.`, company_code: code,
    contact_name: "Sam Owner", contact_email: `sam@${code}.example`, contact_phone: "403-555-0177",
    plan, billing: "monthly", support_level: "email", seats: plan === "pro" ? 2 : 3, country: "CA", status: "active",
  });
  expect(res.status).toBe(201);
  return { id: res.body.licensee.id, key: res.body.ops_key };
}

beforeAll(async () => {
  pool = await freshPool();
  await pool.query("TRUNCATE kb_articles, kb_images, kb_questions, assistant_leads, kb_seed_runs, crm_outbox");
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => now };
  expect(await seedKnowledgeBase(pool)).toBeGreaterThanOrEqual(40);
  expect(await seedKnowledgeBase(pool)).toBe(0); // once only
});
afterAll(async () => {
  await pool.end();
});
beforeEach(() => {
  openaiBodies.length = 0;
  mail.sent.length = 0;
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.BF_CRM_KEY;
  delete process.env.KS_HELP_LICENSEE_DAILY_LIMIT;
});

describe("knowledge base CRUD and permissions", () => {
  let id = "";

  it("refuses anyone without a staff token", async () => {
    expect((await request(app()).get("/api/ops/kb/articles")).status).toBe(401);
    expect((await request(app()).post("/api/ops/kb/articles").set({ Authorization: "Bearer nope" }).send({})).status).toBe(401);
  });

  it("creates a draft, refuses an empty published article and a taken address, then publishes and audits", async () => {
    const bad = await request(app()).post("/api/ops/kb/articles").set(staff()).send({ title: "Empty", category: "Test", status: "published" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.body_md).toMatch(/Write the article/);
    const taken = await request(app()).post("/api/ops/kb/articles").set(staff()).send({ title: "x", category: "Test", slug: "pipeline-stages" });
    expect(taken.status).toBe(409);

    const r = await request(app()).post("/api/ops/kb/articles").set(staff()).send({
      title: "Reset the zebra widget", category: "Test", audience: "admins", plans: ["pro"],
      body_md: "## Steps\n1. Open the zebra widget\n2. Press reset",
    });
    expect(r.status).toBe(201);
    expect(r.body.article).toMatchObject({ slug: "reset-the-zebra-widget", status: "draft", audience: "admins", plans: ["pro"], plans_label: "Pro" });
    expect(r.body.article.body_html).toContain("<ol><li>Open the zebra widget</li>");
    id = r.body.article.id;

    const p = await request(app()).patch(`/api/ops/kb/articles/${id}`).set(staff()).send({ status: "published" });
    expect(p.status).toBe(200);
    expect(p.body.article.status).toBe("published");
    expect(p.body.article.published_at).toBeTruthy();
    const audit = await pool.query("SELECT action FROM staff_audit WHERE action LIKE 'kb.%' ORDER BY id");
    expect(audit.rows.map((x) => x.action)).toEqual(["kb.article_created", "kb.article_updated"]);
  });

  it("lists drafts for staff only, filters, previews and deletes", async () => {
    const list = await request(app()).get("/api/ops/kb/articles?q=zebra").set(staff());
    expect(list.body.articles.map((a: any) => a.slug)).toEqual(["reset-the-zebra-widget"]);
    const prev = await request(app()).post("/api/ops/kb/preview").set(staff()).send({ body_md: "<b>x</b>" });
    expect(prev.body.html).toBe("<p>&lt;b&gt;x&lt;/b&gt;</p>");
    const del = await request(app()).delete(`/api/ops/kb/articles/${id}`).set(staff());
    expect(del.status).toBe(200);
    expect((await request(app()).get(`/api/ops/kb/articles/${id}`).set(staff())).status).toBe(404);
  });

  it("stores PNG images and serves them publicly as images only", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const r = await request(app()).post("/api/ops/kb/images").set(staff()).send({ content_type: "image/png", data_base64: png.toString("base64"), filename: "shot.png" });
    expect(r.status).toBe(201);
    expect(r.body.markdown).toBe(`![shot](/api/public/kb/images/${r.body.id})`);
    const img = await request(app()).get(r.body.path);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-security-policy"]).toContain("default-src 'none'");
    const svg = await request(app()).post("/api/ops/kb/images").set(staff()).send({ data_base64: Buffer.from("<svg></svg>").toString("base64") });
    expect(svg.status).toBe(400);
  });
});

describe("audience filtering and search", () => {
  let lic: { id: string; key: string };
  beforeAll(async () => {
    lic = await makeLicensee("kb-north", "North Capital", "starter");
    await request(app()).post("/api/ops/kb/articles").set(staff()).send({ title: "Draft about zebras", category: "Test", body_md: "zebra zebra zebra zebra zebra", audience: "public" });
  });
  const lk = () => ({ "X-KS-Ops-Key": lic.key });

  it("the website sees published public articles only", async () => {
    const all = await request(app()).get("/api/public/kb/articles");
    expect(all.status).toBe(200);
    expect(all.body.articles.length).toBeGreaterThan(5);
    expect(new Set(all.body.articles.map((a: any) => a.audience))).toEqual(new Set(["public"]));
    expect((await request(app()).get("/api/public/kb/articles/add-users-and-roles")).status).toBe(404); // admins
    expect((await request(app()).get("/api/public/kb/articles/pipeline-stages")).status).toBe(404); // all staff
    expect((await request(app()).get("/api/public/kb/articles?q=zebra")).body.articles).toEqual([]); // draft
    const one = await request(app()).get("/api/public/kb/articles/plans-compared");
    expect(one.status).toBe(200);
    expect(one.body.article.body_html).toContain("<table>");
  });

  it("licensee staff read public and all-staff articles; only admins read admin articles", async () => {
    const asStaff = await request(app()).post(`/api/licensees/${lic.id}/kb/article`).set(lk()).send({ slug: "add-users-and-roles", viewer_role: "Staff" });
    expect(asStaff.status).toBe(404);
    const asAdmin = await request(app()).post(`/api/licensees/${lic.id}/kb/article`).set(lk()).send({ slug: "add-users-and-roles", viewer_role: "Admin" });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.article.on_your_plan).toBe(true);
    const staffList = await request(app()).post(`/api/licensees/${lic.id}/kb/search`).set(lk()).send({ viewer_role: "Staff" });
    expect(staffList.body.articles.some((a: any) => a.audience === "admins")).toBe(false);
    expect(staffList.body.articles.some((a: any) => a.audience === "all_staff")).toBe(true);
    const cats = await request(app()).post(`/api/licensees/${lic.id}/kb/categories`).set(lk()).send({ viewer_role: "Admin" });
    expect(cats.body.categories.find((c: any) => c.category === "Integrations and API").count).toBe(3);
  });

  it("marks articles for other plans, and full-text search finds the right article", async () => {
    const r = await request(app()).post(`/api/licensees/${lic.id}/kb/search`).set(lk()).send({ q: "How do I turn on single sign-on?", viewer_role: "Admin" });
    expect(r.body.articles[0].slug).toBe("single-sign-on");
    expect(r.body.articles[0].on_your_plan).toBe(false); // Pro only, licensee on Starter
    const p = await request(app()).get("/api/public/kb/articles?q=where is my data stored canada");
    expect(p.body.articles[0].slug).toBe("security-and-data-residency");
  });

  it("refuses a wrong key, and one licensee's key on another licensee's id", async () => {
    const other = await makeLicensee("kb-south", "South Funding");
    expect((await request(app()).post(`/api/licensees/${lic.id}/kb/search`).set({ "X-KS-Ops-Key": "wrong" }).send({})).status).toBe(401);
    expect((await request(app()).post(`/api/licensees/${other.id}/kb/search`).set(lk()).send({})).status).toBe(401);
    expect((await request(app()).post(`/api/licensees/${other.id}/kb/ask`).set(lk()).send({ messages: [{ role: "user", text: "hi" }] })).status).toBe(401);
  });

  it("semantic search finds an article that shares no words with the question", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    embedFor = (t) => (t.startsWith("The iPhone dialler") ? [0, 1, 0] : /handheld gadget/i.test(t) ? [0, 0.98, 0.05] : [1, 0, 0]);
    const done = await embedPending(deps, 200);
    expect(done.embedded).toBeGreaterThan(40);
    const r = await request(app()).post(`/api/licensees/${lic.id}/kb/search`).set(lk()).send({ q: "handheld gadget", viewer_role: "Staff" });
    expect(r.body.articles[0].slug).toBe("iphone-dialler");
  });
});

describe("Ask Maya (support assistant)", () => {
  let a: { id: string; key: string };
  let b: { id: string; key: string };
  beforeAll(async () => {
    a = await makeLicensee("kb-alpha", "Alpha Lending", "growth");
    b = await makeLicensee("kb-beta", "Beta Brokers Secret", "pro");
  });
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    embedFor = () => [1, 0, 0];
  });
  const ask = (lic: { id: string; key: string }, text: string, extra: Record<string, unknown> = {}) =>
    request(app()).post(`/api/licensees/${lic.id}/kb/ask`).set({ "X-KS-Ops-Key": lic.key }).send({
      messages: [{ role: "user", text }], viewer: { role: "Admin", user_ref: "user-ref-alpha-1" }, ...extra,
    });

  it("answers from the knowledge base and cites only articles it was given", async () => {
    chatReply = { answer: "Open **Settings** > **Phone lines** and choose **Get a number**.", sources: ["get-phone-numbers", "made-up-article"], confident: true };
    const r = await ask(a, "How do I get a phone number?", {
      context: { integrations: { phone: true, microsoft_365: false }, usage: { minutes: { used: 40, included: 1500 } } },
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("answered");
    expect(r.body.citations).toEqual([{ slug: "get-phone-numbers", title: "Get your phone numbers", category: "Phone" }]);
    expect(r.body.offer_support).toBe(false);
    const sent = JSON.stringify(openaiBodies[0].messages);
    expect(sent).toContain("### get-phone-numbers");
    expect(sent).toContain("Plan: Growth");
    expect(sent).toContain("Phone and texting: connected");
    expect(sent).toContain("Alpha Lending");
    // Nothing about any other licensee reaches the model.
    expect(sent).not.toContain("Beta Brokers Secret");
    expect(sent).not.toContain("kb-beta");
  });

  it("an answer with no citations is no good answer: support is offered and the question is reported", async () => {
    chatReply = { answer: "I think you might try restarting.", sources: [], confident: false, needs_person: true };
    const r = await ask(a, "Why does my fax machine reject Keystone documents?");
    expect(r.body.outcome).toBe("no_answer");
    expect(r.body.offer_support).toBe(true);
    expect(r.body.citations).toEqual([]);
    const report = await request(app()).get("/api/ops/kb/report?days=7").set(staff());
    expect(report.body.questions.map((q: any) => q.question)).toContain("Why does my fax machine reject Keystone documents?");
    expect(report.body.totals.no_answer).toBeGreaterThanOrEqual(1);
  });

  it("asking for a person offers Contact support without calling the model", async () => {
    const n = openaiBodies.length;
    const r = await ask(a, "Can I talk to a real person please?");
    expect(r.body).toMatchObject({ outcome: "escalated", offer_support: true });
    expect(openaiBodies.length).toBe(n);
  });

  it("never passes internal costs through", async () => {
    chatReply = { answer: "Our margin on minutes is high.", sources: ["allowances-usage-and-overage"], confident: true };
    const r = await ask(a, "What does a minute over my allowance cost?");
    expect(r.body.answer).toBe(INTERNAL_COST_REPLY);
  });

  it("without OpenAI it falls back to the closest articles", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await ask(a, "pipeline stages hold fraud");
    expect(r.body.ai).toBeUndefined();
    expect(r.body.citations[0].slug).toBe("pipeline-stages");
  });

  it("rate limits per person per hour and per licensee per day, and the limit is per licensee", async () => {
    chatReply = { answer: "See the article.", sources: ["pipeline-stages"], confident: true };
    await pool.query(
      `INSERT INTO kb_questions (channel, licensee_id, asker_ref, question, outcome, created_at)
       SELECT 'portal', $1, 'user-ref-flood', 'q', 'answered', $2 FROM generate_series(1, 30)`,
      [a.id, new Date(now.getTime() - 60_000)],
    );
    const flooded = await request(app()).post(`/api/licensees/${a.id}/kb/ask`).set({ "X-KS-Ops-Key": a.key })
      .send({ messages: [{ role: "user", text: "pipeline" }], viewer: { role: "Staff", user_ref: "user-ref-flood" } });
    expect(flooded.status).toBe(429);
    process.env.KS_HELP_LICENSEE_DAILY_LIMIT = "5";
    expect((await ask(a, "pipeline stages")).status).toBe(429);
    expect((await ask(b, "pipeline stages")).status).toBe(200); // another licensee is not affected
  });
});

describe("Keystone Maya on the website", () => {
  beforeAll(async () => {
    await pool.query("UPDATE kb_articles SET embedding = NULL, embedded_at = NULL"); // full text only here
  });
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    embedFor = () => [1, 0, 0];
  });
  const chat = (text: string, extra: Record<string, unknown> = {}) =>
    request(app()).post("/api/public/assistant/chat").send({ messages: [{ role: "user", text }], session: "sess-0001-abcdef", ...extra });

  it("answers from the live catalogue, public articles and the page, with links and actions", async () => {
    chatReply = { answer: "Growth is $119 CAD a seat a month billed yearly. See [Pricing](/pricing).", sources: ["plans-compared", "add-users-and-roles"], actions: ["start_demo", "signup", "hack"], confident: true };
    const r = await chat("Compare the plans: what do Starter and Growth cost?", { page: { path: "/pricing", title: "Pricing", text: "Starter Growth Pro prices" } });
    expect(r.status).toBe(200);
    expect(r.body.citations).toEqual([{ slug: "plans-compared", title: "Plans compared: Starter, Growth and Pro", category: "Plans and billing", url: "/help/plans-compared" }]);
    expect(r.body.actions.map((x: any) => x.kind)).toEqual(["start_demo", "signup"]);
    const sent = JSON.stringify(openaiBodies[0].messages);
    expect(sent).toContain('\\"seat_price_annual\\":119');
    expect(sent).toContain("The visitor is on /pricing");
    expect(sent).not.toContain("### add-users-and-roles"); // admin articles never reach the website assistant
  });

  it("never quotes internal costs, even when the model does", async () => {
    chatReply = { answer: "Twilio charges us $0.01, so our margin is good.", sources: [], actions: [], confident: true };
    const r = await chat("What does Keystone pay for texts?");
    expect(r.body.answer).toBe(INTERNAL_COST_REPLY);
    expect(r.body.answer).not.toMatch(/0\.01|margin/);
  });

  it("captures a lead with consent into the CRM outbox, and hands off a live-demo request to sales", async () => {
    process.env.BF_CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
    const noConsent = await request(app()).post("/api/public/assistant/lead").send({ name: "Pat Lee", email: "pat@leecap.example", brokerage: "Lee Capital", team_size: "2-5" });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.errors.consent).toBeTruthy();

    const info = await request(app()).post("/api/public/assistant/lead").send({ name: "Pat Lee", email: "pat@leecap.example", brokerage: "Lee Capital", team_size: "2-5", consent: true });
    expect(info.status).toBe(201);
    expect(info.body.handed_off).toBe(false);
    expect(mail.sent).toHaveLength(0);

    const demo = await request(app()).post("/api/public/assistant/lead").send({
      name: "Robin Ray", email: "robin@raycap.example", brokerage: "Ray Capital", team_size: "6-15", phone: "(403) 555-0123",
      consent: true, wants: "live_demo", message: "Tuesdays are best",
      transcript: [{ role: "user", text: "Can I see it with someone?" }, { role: "assistant", text: "Happy to set that up." }],
    });
    expect(demo.status).toBe(201);
    expect(demo.body.handed_off).toBe(true);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["sales@example.test"]);
    expect(mail.sent[0].subject).toBe("Live demo request: Robin Ray, Ray Capital");
    expect(mail.sent[0].text).toContain("Can I see it with someone?");
    const rows = await pool.query("SELECT payload FROM crm_outbox WHERE source = 'website_signup' AND external_id = $1", [demo.body.id]);
    const p = rows.rows[0].payload;
    expect(p).toMatchObject({ stage: "lead", contact: { name: "Robin Ray", email: "robin@raycap.example", phone: "+14035550123" }, company: { name: "Ray Capital" } });
    expect(p.task).toMatchObject({ title: "Book a live demo with Robin Ray (Ray Capital)", due_at: "2026-10-28T17:00:00.000Z", priority: "high" });
    expect(p.note).toContain("Consent to be contacted: yes");
    const infoRow = await pool.query("SELECT payload FROM crm_outbox WHERE external_id = $1", [info.body.id]);
    expect(infoRow.rows[0].payload.task).toBeUndefined();
  });

  it("refuses the honeypot", async () => {
    const r = await request(app()).post("/api/public/assistant/lead").send({ website_url: "spam", name: "x", email: "x@y.test", brokerage: "x", team_size: "1", consent: true });
    expect(r.status).toBe(400);
  });

  it("rate limits a browser session per day", async () => {
    const { sha256Hex } = await import("../../src/lib/crypto.js");
    const ref = sha256Hex("website:sess-flood-000001").slice(0, 32);
    await pool.query(
      `INSERT INTO kb_questions (channel, asker_ref, question, outcome, created_at) SELECT 'website', $1, 'q', 'answered', $2 FROM generate_series(1, 40)`,
      [ref, new Date(now.getTime() - 60_000)],
    );
    const r = await request(app()).post("/api/public/assistant/chat").send({ messages: [{ role: "user", text: "price?" }], session: "sess-flood-000001" });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate_limited");
  });
});
