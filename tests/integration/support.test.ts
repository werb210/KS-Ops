// KS_OPS_v16_SUPPORT against a real Postgres: a support level change pushes the company again, and a licensee's ticket
// and follow-up reach BF-Server's /api/ks/support/ingest through crm_outbox - held while it answers 404, sent once each.
import type pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { flushCrmOutbox } from "../../src/crm/outbox.js";
import { enqueueSupportMessage, noteSupportAvailable, SUPPORT_NOT_AVAILABLE_MS, type SupportIngestPayload } from "../../src/crm/support.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let now = new Date("2026-10-25T12:00:00Z");
const CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
const ingest: SupportIngestPayload[] = [];
const upserts: Array<Record<string, any>> = [];
let ingestStatus = 404;

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (headers["X-KS-Ops-Key"] !== CRM_KEY) return new Response("unexpected", { status: 500 });
  if (url === "https://bf.example.test/api/ks/support/ingest") {
    if (ingestStatus !== 200) return jsonResponse({ error: "not_found" }, ingestStatus);
    ingest.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true }, 201);
  }
  if (url === "https://bf.example.test/api/ks/crm/upsert") {
    upserts.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true });
  }
  return new Response("unexpected", { status: 500 });
});

let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

beforeAll(async () => {
  pool = await freshPool();
  await pool.query("TRUNCATE crm_outbox");
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => now };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(() => {
  process.env.BF_CRM_KEY = CRM_KEY;
  process.env.BF_CRM_URL = "https://bf.example.test";
  noteSupportAvailable();
});
afterEach(() => {
  delete process.env.BF_CRM_KEY;
  delete process.env.BF_CRM_URL;
  vi.restoreAllMocks();
});

describe("support level and support tickets (real Postgres)", () => {
  let id = "";
  let opsKey = "";

  it("pushes company.support_level on create and again when only the support level changes", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Support Co", legal_name: "Support Co Inc.", company_code: "support-co",
      contact_name: "Sam Support", contact_email: "sam@support.example", contact_phone: "403-555-0177",
      plan: "starter", billing: "monthly", support_level: "email", seats: 2, country: "CA", status: "trial",
    });
    expect(res.status).toBe(201);
    id = res.body.licensee.id;
    opsKey = res.body.ops_key;
    await flushCrmOutbox(deps);
    expect(upserts.at(-1)).toMatchObject({ external_id: id, company: { support_level: "email" } });
    const n = upserts.length;
    const p = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ support_level: "premium" });
    expect(p.status).toBe(200);
    await flushCrmOutbox(deps);
    expect(upserts).toHaveLength(n + 1);
    expect(upserts.at(-1)).toMatchObject({ external_id: id, company: { support_level: "premium" } });
  });

  it("forwards a ticket and its follow-up; 404 holds them (logged once), then each is sent exactly once", async () => {
    const t = await request(app()).post(`/api/licensees/${id}/tickets`).set("X-KS-Ops-Key", opsKey)
      .send({ subject: "Cannot upload", body: "Uploads fail with a 413.", priority: "high", requester_name: "Ria", requester_email: "ria@support.example" });
    expect(t.status).toBe(201);
    await pool.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [t.body.ticket_id]);
    const f = await request(app()).post(`/api/licensees/${id}/tickets/${t.body.ticket_id}/messages`).set("X-KS-Ops-Key", opsKey)
      .send({ body: "Still failing." });
    expect(f.status).toBe(201);
    expect((await pool.query("SELECT status FROM tickets WHERE id = $1", [t.body.ticket_id])).rows[0].status).toBe("open");

    const rows = (await pool.query("SELECT * FROM crm_outbox WHERE source = 'ks_support' ORDER BY id")).rows;
    expect(rows).toHaveLength(2);
    // Queuing the same message again adds nothing.
    expect(await enqueueSupportMessage(deps, rows[0].payload)).toBe(false);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingestStatus = 404;
    expect(await flushCrmOutbox(deps)).toMatchObject({ tried: 2, failed: 2 });
    const held = (await pool.query("SELECT next_attempt_at, sent_at FROM crm_outbox WHERE source = 'ks_support'")).rows;
    for (const r of held) {
      expect(r.sent_at).toBeNull();
      expect(new Date(r.next_attempt_at).getTime()).toBe(now.getTime() + SUPPORT_NOT_AVAILABLE_MS);
    }
    expect(warn).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + SUPPORT_NOT_AVAILABLE_MS);
    ingestStatus = 200;
    expect(await flushCrmOutbox(deps)).toMatchObject({ tried: 2, sent: 2 });
    expect(await flushCrmOutbox(deps)).toMatchObject({ tried: 0 });
    expect(ingest).toHaveLength(2);
    expect(ingest[0]).toMatchObject({
      ticket_ref: `ks-ops:ticket:${t.body.ticket_id}`, is_follow_up: false, channel: "in_app", subject: "Cannot upload",
      body: "Uploads fail with a 413.", priority: "high",
      company: { licensee_id: id, name: "Support Co", company_code: "support-co", support_level: "premium" },
      contact: { name: "Ria", email: "ria@support.example", phone: null },
    });
    expect(ingest[1]).toMatchObject({
      message_id: `ks-ops:ticket-message:${f.body.message_id}`, ticket_ref: `ks-ops:ticket:${t.body.ticket_id}`, is_follow_up: true,
      body: "Still failing.",
    });
    expect(new Set(ingest.map((p) => p.message_id)).size).toBe(2);
    expect(await enqueueSupportMessage(deps, ingest[0]!)).toBe(false);
  });
});
