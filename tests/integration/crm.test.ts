// The Keystone CRM outbox against a real Postgres: the partial unique index keeps one pending row per record, merges
// coalesce, leasing and backoff work, and a demo sign-up -> open -> progress -> finish reaches BF-Server's endpoint as
// the right pushes.
import type pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { enqueueCrm, flushCrmOutbox } from "../../src/crm/outbox.js";
import { fakeMailer, jsonResponse } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let now = new Date("2026-10-23T12:00:00Z");
const CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
const DEMO_KEY = "demo-ops-key-0123456789";
const crmCalls: Array<Record<string, any>> = [];
let crmStatus = 200;

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (url.endsWith("/api/ks/crm/upsert")) {
    if (headers["X-KS-Ops-Key"] !== CRM_KEY) return jsonResponse({ error: "invalid_ops_key" }, 401);
    if (crmStatus !== 200) return jsonResponse({ error: "down" }, crmStatus);
    crmCalls.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true, contact_id: "c1", company_id: "k1", stage: "lead" });
  }
  if (/\/api\/demo\/ops\/sessions$/.test(url) && init.method === "POST") {
    const body = JSON.parse(String(init.body));
    return jsonResponse({ session_id: "90000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa", staff_token: "staff", client_code: "abcdefghjk", client_url: "https://client.example/demo/x", expires_at: body.expires_at }, 201);
  }
  return new Response("unexpected", { status: 500 });
});

let deps: Deps;

beforeAll(async () => {
  pool = await freshPool();
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => now };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE crm_outbox, demo_signups CASCADE");
  process.env.BF_CRM_KEY = CRM_KEY;
  process.env.BF_CRM_URL = "https://bf.example.test";
  crmCalls.length = 0;
  crmStatus = 200;
  now = new Date("2026-10-23T12:00:00Z");
});
afterEach(() => {
  delete process.env.BF_CRM_KEY;
  delete process.env.BF_CRM_URL;
});

const flush = () => flushCrmOutbox(deps);

describe("crm_outbox (real Postgres)", () => {
  it("coalesces pushes for one record into one pending row, then starts a new one after sending", async () => {
    await enqueueCrm(deps, { source: "licensee", external_id: "l1", stage: "signed_up", company: { name: "Co", status: "trial" } });
    await enqueueCrm(deps, { source: "licensee", external_id: "l1", stage: "paying", events: [{ type: "payment", at: now.toISOString(), summary: "paid" }] });
    await enqueueCrm(deps, { source: "licensee", external_id: "l1", company: { status: "active" } });
    await enqueueCrm(deps, { source: "website_signup", external_id: "l1", stage: "signed_up" });
    const rows = (await pool.query("SELECT source, external_id, payload, version FROM crm_outbox WHERE sent_at IS NULL ORDER BY id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ source: "licensee", version: 3, payload: { stage: "paying", company: { name: "Co", status: "active" }, events: [{ type: "payment" }] } });

    expect(await flush()).toEqual({ tried: 2, sent: 2, failed: 0 });
    expect(crmCalls.map((c) => c.source).sort()).toEqual(["licensee", "website_signup"]);
    await enqueueCrm(deps, { source: "licensee", external_id: "l1", company: { status: "suspended" } });
    const all = (await pool.query("SELECT sent_at FROM crm_outbox WHERE source = 'licensee' ORDER BY id")).rows;
    expect(all.map((r) => r.sent_at !== null)).toEqual([true, false]);
  });

  it("many writers at once still leave one pending row with every event", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        enqueueCrm(deps, { source: "demo_signup", external_id: "d1", events: [{ type: "demo_step", at: new Date(now.getTime() + i * 1000).toISOString(), summary: `s${i}` }] }),
      ),
    );
    const rows = (await pool.query("SELECT payload FROM crm_outbox WHERE sent_at IS NULL")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.events).toHaveLength(12);
  });

  it("retries a 404 (endpoint not deployed yet) with backoff, then sends", async () => {
    await enqueueCrm(deps, { source: "licensee", external_id: "l2", stage: "signed_up" });
    crmStatus = 404;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await flush()).toEqual({ tried: 1, sent: 0, failed: 1 });
    let row = (await pool.query("SELECT attempts, next_attempt_at, last_error, sent_at FROM crm_outbox")).rows[0];
    expect(row).toMatchObject({ attempts: 1, sent_at: null });
    expect(new Date(row.next_attempt_at).getTime()).toBe(now.getTime() + 60_000);
    expect(row.last_error).toContain("404");
    expect((await flush()).tried).toBe(0);
    crmStatus = 200;
    now = new Date(now.getTime() + 60_000);
    expect(await flush()).toEqual({ tried: 1, sent: 1, failed: 0 });
    row = (await pool.query("SELECT attempts, last_error, sent_at FROM crm_outbox")).rows[0];
    expect(row).toMatchObject({ attempts: 2, last_error: null });
    expect(row.sent_at).not.toBeNull();
    warn.mockRestore();
  });

  it("a demo sign-up, open, progress and finish reach the CRM as lead -> demo_started -> demo_finished", async () => {
    process.env.KS_DEMO_SERVER_URL = "https://demo-server.example";
    process.env.KS_DEMO_OPS_KEY = DEMO_KEY;
    process.env.KS_DEMO_PORTAL_URL = "https://portal.example";
    try {
      const app = createApp(deps);
      const s = await request(app).post("/api/public/demo/signup").set("X-Forwarded-For", "203.0.113.77").send({ name: "Dana Prospect", email: "dana.crm@brokerco.example", company: "BrokerCo" });
      expect(s.status).toBe(201);
      const m = /#d=([0-9a-f-]+)&t=([A-Za-z0-9_-]+)/.exec(s.body.open_url)!;
      const id = m[1]!;
      await flush();
      expect(crmCalls.at(-1)).toMatchObject({ source: "demo_signup", external_id: id, stage: "lead", contact: { email: "dana.crm@brokerco.example" }, company: { name: "BrokerCo" } });

      expect((await request(app).post("/api/public/demo/open").send({ demo_id: id, token: m[2] })).status).toBe(200);
      expect((await request(app).post("/api/public/demo/open").send({ demo_id: id, token: m[2] })).status).toBe(200);
      await flush();
      expect(crmCalls.at(-1)).toMatchObject({ stage: "demo_started", events: [{ type: "demo_opened" }] });
      expect(crmCalls.filter((c) => c.stage === "demo_started")).toHaveLength(1); // first open only

      const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
      const ev = await request(app).post(`/api/demo/sessions/${id}/events`).set("X-KS-Ops-Key", DEMO_KEY)
        .send({ events: [{ type: "step_completed", step: "welcome", at: at(1) }, { type: "borrower_joined", step: "borrower", at: at(2), data: { via: "link" } }] });
      expect(ev.status).toBe(202);
      const before = crmCalls.length;
      await flush();
      expect(crmCalls.length).toBe(before); // progress is held back a minute
      now = new Date(now.getTime() + 61_000);
      await flush();
      expect(crmCalls.at(-1)!.events.map((e: any) => e.summary)).toEqual([
        "Reached step 1 of 9: Welcome (completed).",
        "Reached step 2 of 9: Be the borrower (phone).",
      ]);

      await request(app).post(`/api/demo/sessions/${id}/events`).set("X-KS-Ops-Key", DEMO_KEY)
        .send({ events: [{ type: "submitted", step: "submit", at: at(5), data: { lenders: ["Aspen Ridge Capital"] } }] });
      const pdf = Buffer.from("%PDF-1.7 sample").toString("base64");
      expect((await request(app).post(`/api/demo/sessions/${id}/complete`).set("X-KS-Ops-Key", DEMO_KEY).send({ package_pdf_base64: pdf })).status).toBe(202);
      await flush();
      const last = crmCalls.at(-1)!;
      expect(last.stage).toBe("demo_finished");
      expect(last.events.filter((e: any) => e.type === "demo_completed")).toHaveLength(1);
      expect(last.note).toContain("finished the Keystone demo");
      expect(last.note).toContain("Lenders picked: Aspen Ridge Capital");
    } finally {
      delete process.env.KS_DEMO_SERVER_URL;
      delete process.env.KS_DEMO_OPS_KEY;
      delete process.env.KS_DEMO_PORTAL_URL;
    }
  });
});
