// The self-serve demo against a real Postgres: sign-up -> magic link -> open (session on the demo server) -> progress
// events -> completion (package to the prospect, note to sales) -> idle note -> expiry wipe; plus the caps.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { runDemoJobs } from "../../src/demo/jobs.js";
import { fakeMailer, jsonResponse } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let now = new Date("2026-10-22T12:00:00Z");
const KEY = "demo-ops-key-0123456789";
const lastOpenBody: Record<string, any> = {};
const server = { sessions: new Map<string, any>(), deleted: [] as string[], up: true };

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (headers["X-KS-Ops-Key"] !== KEY) return new Response("bad key", { status: 401 });
  if (!server.up) return new Response("down", { status: 503 });
  const m = /\/api\/demo\/ops\/sessions(?:\/([^/]+))?$/.exec(url);
  if (m && init.method === "POST") {
    const body = JSON.parse(String(init.body));
    lastOpenBody[body.ops_session_id] = body;
    const existing = server.sessions.get(body.ops_session_id);
    const s = existing ?? { session_id: `9${String(server.sessions.size).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, body };
    server.sessions.set(body.ops_session_id, s);
    return jsonResponse({ session_id: s.session_id, staff_token: `staff-${body.ops_session_id}-${Date.now()}`, client_code: "abcdefghjk", client_url: "https://client.example/demo/abcdefghjk", expires_at: body.expires_at }, existing ? 200 : 201);
  }
  if (m && init.method === "DELETE") { server.deleted.push(decodeURIComponent(m[1]!)); return new Response(null, { status: 204 }); }
  return new Response("unexpected", { status: 500 });
});

const mail = fakeMailer();
let deps: Deps;
const app = () => createApp(deps);

function linkFrom(text: string): { id: string; token: string } {
  const m = /\/demo#d=([0-9a-f-]+)&t=([A-Za-z0-9_-]+)/.exec(text);
  if (!m) throw new Error("no link in: " + text);
  return { id: m[1]!, token: m[2]! };
}

async function signUp(email: string, ip = "203.0.113.10") {
  return request(app()).post("/api/public/demo/signup").set("X-Forwarded-For", ip).send({ name: "Dana Prospect", email, company: "BrokerCo" });
}

const evts = (types: Array<[string, string | null, Record<string, unknown>?]>, base = now) =>
  ({ events: types.map(([type, step, data], i) => ({ type, step, data: data ?? {}, at: new Date(base.getTime() + i * 60_000).toISOString() })) });

beforeAll(async () => {
  pool = await freshPool();
  await pool.query("TRUNCATE demo_signups CASCADE");
  process.env.KS_DEMO_SERVER_URL = "https://demo-server.example";
  process.env.KS_DEMO_OPS_KEY = KEY;
  process.env.KS_DEMO_PORTAL_URL = "https://portal.example";
  process.env.DEMO_PER_IP_DAY = "3";
  process.env.DEMO_MAX_ACTIVE = "50";
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => now };
});
afterAll(async () => {
  for (const k of ["KS_DEMO_SERVER_URL", "KS_DEMO_OPS_KEY", "KS_DEMO_PORTAL_URL", "DEMO_PER_IP_DAY", "DEMO_MAX_ACTIVE"]) delete process.env[k];
  await pool.end();
});
beforeEach(() => { mail.sent.length = 0; });

describe("demo: sign-up to finished", () => {
  let id = "";
  let token = "";

  it("signs up and emails a magic link; the token is stored only as a hash", async () => {
    const r = await signUp("Dana@BrokerCo.example");
    expect(r.status).toBe(201);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toEqual(["dana@brokerco.example"]);
    ({ id, token } = linkFrom(mail.sent[0]!.text));
    const row = (await pool.query("SELECT * FROM demo_signups WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "pending", email: "dana@brokerco.example", ip: "203.0.113.10" });
    expect(row.token_hash).not.toContain(token);
    expect(new Date(row.expires_at).getTime() - now.getTime()).toBe(7 * 86_400_000);
  });

  it("opening with a wrong token fails; the right one creates the session on the demo server and returns a staff token", async () => {
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: id, token: "nope" })).status).toBe(404);
    const r = await request(app()).post("/api/public/demo/open").send({ demo_id: id, token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ server_url: "https://demo-server.example", name: "Dana Prospect", company: "BrokerCo", client_url: "https://client.example/demo/abcdefghjk" });
    expect(r.body.staff_token).toMatch(/^staff-/);
    expect(server.sessions.get(id).body).toMatchObject({ name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo" });
    // Opening again (resume) reuses the same server session.
    const again = await request(app()).post("/api/public/demo/open").send({ demo_id: id, token });
    expect(again.status).toBe(200);
    expect(server.sessions.size).toBe(1);
    const row = (await pool.query("SELECT status, open_count, server_session_id FROM demo_signups WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "active", open_count: 2 });
  });

  it("asking again with the same email re-sends a fresh link to the same demo (old link stops working)", async () => {
    const r = await signUp("dana@brokerco.example");
    expect(r.status).toBe(200);
    expect(r.body.resent).toBe(true);
    const fresh = linkFrom(mail.sent[0]!.text);
    expect(fresh.id).toBe(id);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: id, token })).status).toBe(404);
    token = fresh.token;
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: id, token })).status).toBe(200);
  });

  it("stores progress events from the demo server (key required), skipping malformed ones", async () => {
    const body = evts([["portal_opened", null], ["step_completed", "welcome"], ["borrower_joined", "borrower", { via: "link", device: "iPhone" }],
      ["document_uploaded", "borrower", { document: "Bank statement - September 2026", fraud_status: "red" }],
      ["document_decision", "documents", { document: "Bank statement - September 2026", decision: "rejected", fraud_status: "red" }],
      ["call_completed", "call"], ["lenders_selected", "lenders", { lenders: ["aspen-ridge"] }]]);
    body.events.push({ type: "BAD TYPE", step: null, data: {}, at: "yesterday" } as any);
    expect((await request(app()).post(`/api/demo/sessions/${id}/events`).send(body)).status).toBe(401);
    const r = await request(app()).post(`/api/demo/sessions/${id}/events`).set("X-KS-Ops-Key", KEY).send(body);
    expect(r.status).toBe(202);
    expect(r.body.stored).toBe(7);
    const row = (await pool.query("SELECT event_count, status FROM demo_signups WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ event_count: 7, status: "active" });
  });

  it("on completion: the prospect gets the package attached and sales gets the summary, once", async () => {
    await request(app()).post(`/api/demo/sessions/${id}/events`).set("X-KS-Ops-Key", KEY)
      .send(evts([["submitted", "submit", { lenders: ["Aspen Ridge Capital"] }]], new Date(now.getTime() + 20 * 60_000)));
    const pdf = Buffer.from("%PDF-1.7\nsample package").toString("base64");
    expect((await request(app()).post(`/api/demo/sessions/${id}/complete`).set("X-KS-Ops-Key", KEY).send({ package_pdf_base64: "bm90IGEgcGRm" })).status).toBe(400);
    const r = await request(app()).post(`/api/demo/sessions/${id}/complete`).set("X-KS-Ops-Key", KEY)
      .send({ package_pdf_base64: pdf, package_filename: "Lender-Submission-Package-SAMPLE.pdf", summary: { name: "Dana Prospect" } });
    expect(r.status).toBe(202);
    const toProspect = mail.sent.find((m) => m.to[0] === "dana@brokerco.example")!;
    expect(toProspect.attachments?.[0]).toMatchObject({ filename: "Lender-Submission-Package-SAMPLE.pdf", base64: pdf });
    const toSales = mail.sent.find((m) => m.to[0] === "sales@example.test")!;
    expect(toSales.subject).toBe("Demo finished: Dana Prospect (BrokerCo)");
    expect(toSales.text).toContain("Used the phone: Yes - opened the borrower link on an iPhone");
    expect(toSales.text).toContain("Caught it - rejected the doctored September statement");
    expect(toSales.text).toContain("Lenders picked: Aspen Ridge Capital");
    mail.sent.length = 0;
    await request(app()).post(`/api/demo/sessions/${id}/complete`).set("X-KS-Ops-Key", KEY).send({ package_pdf_base64: pdf });
    await runDemoJobs(deps);
    expect(mail.sent).toHaveLength(0);
    const row = (await pool.query("SELECT status, digest FROM demo_signups WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("completed");
    expect(row.digest.submitted).toBe(true);
  });

  it("KS_OPS_v12 with the real lender email in the completion, the prospect gets that email and its zip; it is wiped at expiry", async () => {
    mail.sent.length = 0;
    expect((await signUp("lena@lenderco.example", "203.0.113.55")).status).toBe(201);
    const l = linkFrom(mail.sent[0]!.text);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: l.id, token: l.token })).status).toBe(200);
    mail.sent.length = 0;
    const zip = Buffer.from("PK\x03\x04 zip", "latin1").toString("base64");
    const lender_email = {
      lender_name: "Aspen Ridge Capital", subject: "BrokerCo application package: Juniper Hollow Millwork Ltd. ($250,000)",
      html: "<div>Hello Aspen Ridge Capital team,</div>", text: "Hello Aspen Ridge Capital team,",
      attachments: [{ filename: "application-x.zip", content_type: "application/zip", base64: zip }],
    };
    const bad = await request(app()).post(`/api/demo/sessions/${l.id}/complete`).set("X-KS-Ops-Key", KEY)
      .send({ package_pdf_base64: Buffer.from("%PDF-1.7").toString("base64"), lender_email: { ...lender_email, attachments: [] } });
    expect(bad.status).toBe(400);
    const r = await request(app()).post(`/api/demo/sessions/${l.id}/complete`).set("X-KS-Ops-Key", KEY)
      .send({ package_pdf_base64: Buffer.from("%PDF-1.7 signed app").toString("base64"), package_filename: "signed-application.pdf", lender_email });
    expect(r.status).toBe(202);
    const toProspect = mail.sent.find((m) => m.to[0] === "lena@lenderco.example")!;
    expect(toProspect.subject).toBe(lender_email.subject);
    expect(toProspect.attachments).toEqual([{ filename: "application-x.zip", contentType: "application/zip", base64: zip }]);
    expect(toProspect.html).toContain("Keystone demo - this is exactly what your lender would receive (sample data).");
    expect(toProspect.html!.endsWith(lender_email.html)).toBe(true);
    expect(mail.sent.some((m) => m.subject.startsWith("Demo finished:"))).toBe(true);
    await pool.query("UPDATE demo_signups SET expires_at = $2 WHERE id = $1", [l.id, new Date(now.getTime() - 1000)]);
    await runDemoJobs(deps);
    expect((await pool.query("SELECT status, package_pdf, package_mail FROM demo_signups WHERE id = $1", [l.id])).rows[0]).toMatchObject({ status: "wiped", package_pdf: null, package_mail: null });
  });

  it("after 7 days the session is wiped on the demo server and here (events, package, link), keeping the lead for sales", async () => {
    now = new Date(now.getTime() + 8 * 86_400_000);
    const r = await runDemoJobs(deps);
    expect(r.wiped).toBeGreaterThanOrEqual(1);
    expect(server.deleted).toContain(id);
    const row = (await pool.query("SELECT status, package_pdf, token_hash, email, digest FROM demo_signups WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "wiped", package_pdf: null, token_hash: "", email: "dana@brokerco.example" });
    expect(row.digest.submitted).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM demo_events WHERE signup_id = $1", [id])).rows[0].n).toBe(0);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: id, token })).status).toBe(404);
  });
});

describe("demo: a repeat sign-up with new details", () => {
  it("updates the same demo's name, company and phone, and the reopened demo (and demo server) uses them", async () => {
    const ip = "198.51.100.77";
    const first = await request(app()).post("/api/public/demo/signup").set("X-Forwarded-For", ip)
      .send({ name: "Claude", email: "repeat@brokerco.example", company: "Test Brokerage", phone: "(403) 555-0199" });
    expect(first.status).toBe(201);
    const { id, token } = linkFrom(mail.sent[0]!.text);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: id, token })).body).toMatchObject({ name: "Claude", company: "Test Brokerage" });
    mail.sent.length = 0;

    const again = await request(app()).post("/api/public/demo/signup").set("X-Forwarded-For", ip)
      .send({ name: "Demo Check", email: "Repeat@BrokerCo.example", company: "Big Broker", phone: "(403) 555-0123" });
    expect(again.status).toBe(200);
    expect(again.body.resent).toBe(true);
    const fresh = linkFrom(mail.sent[0]!.text);
    expect(fresh.id).toBe(id);
    expect(mail.sent[0]!.text).toContain("Hi Demo,");
    expect(mail.sent[0]!.text).toContain("Big Broker");
    const rows = (await pool.query("SELECT name, company, phone FROM demo_signups WHERE lower(email) = 'repeat@brokerco.example'")).rows;
    expect(rows).toEqual([{ name: "Demo Check", company: "Big Broker", phone: "+14035550123" }]);

    const open = await request(app()).post("/api/public/demo/open").send({ demo_id: id, token: fresh.token });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ name: "Demo Check", company: "Big Broker" });
    expect(lastOpenBody[id]).toMatchObject({ name: "Demo Check", company: "Big Broker", email: "repeat@brokerco.example" });

    // No phone the second time: the earlier phone is kept.
    await request(app()).post("/api/public/demo/signup").set("X-Forwarded-For", ip)
      .send({ name: "Demo Check", email: "repeat@brokerco.example", company: "Big Broker" });
    expect((await pool.query("SELECT phone FROM demo_signups WHERE id = $1", [id])).rows[0].phone).toBe("+14035550123");
    // Out of the way of the idle and cap tests below.
    await pool.query("DELETE FROM demo_signups WHERE id = $1", [id]);
  });
});

describe("demo: unfinished, never opened, caps", () => {
  it("an opened demo idle for 24 hours sends sales one 'not finished' note; a never-opened one is just deleted at expiry", async () => {
    mail.sent.length = 0;
    expect((await signUp("idle@x.example", "198.51.100.1")).status).toBe(201);
    const idle = linkFrom(mail.sent[0]!.text);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: idle.id, token: idle.token })).status).toBe(200);
    await request(app()).post(`/api/demo/sessions/${idle.id}/events`).set("X-KS-Ops-Key", KEY)
      .send(evts([["portal_opened", null], ["step_completed", "welcome"], ["step_viewed", "documents"]]));
    expect((await signUp("never@x.example", "198.51.100.2")).status).toBe(201);
    const never = linkFrom(mail.sent[mail.sent.length - 1]!.text);
    mail.sent.length = 0;
    await runDemoJobs(deps);
    expect(mail.sent).toHaveLength(0); // not idle yet
    now = new Date(now.getTime() + 25 * 3_600_000);
    await runDemoJobs(deps);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toBe("Demo not finished: Dana Prospect (BrokerCo)");
    expect(mail.sent[0]!.text).toContain("They got as far as: Review documents and the fraud check");
    await runDemoJobs(deps);
    expect(mail.sent).toHaveLength(1); // once
    now = new Date(now.getTime() + 7 * 86_400_000);
    await runDemoJobs(deps);
    expect((await pool.query("SELECT count(*)::int AS n FROM demo_signups WHERE id = $1", [never.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT status FROM demo_signups WHERE id = $1", [idle.id])).rows[0].status).toBe("wiped");
  });

  it("caps sign-ups per IP per day and demos open at once", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 3; i++) expect((await signUp(`cap${i}@x.example`, ip)).status).toBe(201);
    const r = await signUp("cap9@x.example", ip);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("too_many_demos");
    process.env.DEMO_MAX_ACTIVE = "3";
    const busy = await signUp("busy@x.example", "192.0.2.78");
    expect(busy.status).toBe(503);
    expect(busy.body.error).toBe("demo_busy");
    process.env.DEMO_MAX_ACTIVE = "50";
  });

  it("an expired demo's link answers 410", async () => {
    mail.sent.length = 0;
    expect((await signUp("late@x.example", "192.0.2.90")).status).toBe(201);
    const l = linkFrom(mail.sent[0]!.text);
    await pool.query("UPDATE demo_signups SET expires_at = $2 WHERE id = $1", [l.id, new Date(now.getTime() - 1000)]);
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: l.id, token: l.token })).status).toBe(410);
  });

  it("when the demo server is down, opening says so (503) and nothing is marked opened", async () => {
    mail.sent.length = 0;
    expect((await signUp("down@x.example", "192.0.2.91")).status).toBe(201);
    const l = linkFrom(mail.sent[0]!.text);
    server.up = false;
    expect((await request(app()).post("/api/public/demo/open").send({ demo_id: l.id, token: l.token })).status).toBe(503);
    server.up = true;
    expect((await pool.query("SELECT status FROM demo_signups WHERE id = $1", [l.id])).rows[0].status).toBe("pending");
  });
});
