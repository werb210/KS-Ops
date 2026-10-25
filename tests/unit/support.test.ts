// KS_OPS_v16_SUPPORT - support_level on licensee CRM pushes, and in-app support tickets (and follow-ups) forwarded to
// BF-Server's POST /api/ks/support/ingest through the CRM outbox. HTTP and the database are faked.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { flushCrmOutbox } from "../../src/crm/outbox.js";
import {
  enqueueSupportMessage, noteSupportAvailable, pushSupportToBf, SUPPORT_NOT_AVAILABLE_MS, SUPPORT_PARKED_AT, supportPayload,
  type SupportIngestPayload,
} from "../../src/crm/support.js";
import { crmLicenseeCreated, crmLicenseeUpdated } from "../../src/crm/triggers.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { fakeDb, jsonResponse, licenseeRow, makeDeps } from "../helpers.js";

const KEY = "ks-ops-crm-key-0123456789-0123456789";
const NOW = new Date("2026-10-25T12:00:00Z");
const LICENSEE_KEY = "ksops_licensee_key_0123456789";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";

/** An in-memory crm_outbox answering by SQL content (the CRM and support statements). */
function outbox() {
  type Row = { id: number; source: string; external_id: string; payload: any; version: number; attempts: number; next_attempt_at: Date; sent_at: Date | null; last_error: string | null };
  const rows: Row[] = [];
  const pending = (s: unknown, e: unknown) => rows.find((r) => r.source === s && r.external_id === e && !r.sent_at);
  const handlers: Array<[RegExp, (p: unknown[]) => any[]]> = [
    [/SELECT id, payload, version, attempts, next_attempt_at FROM crm_outbox/, (p) => {
      const r = pending(p[0], p[1]);
      return r ? [{ ...r, payload: structuredClone(r.payload) }] : [];
    }],
    [/INSERT INTO crm_outbox .* WHERE NOT EXISTS/, (p) => {
      if (rows.some((r) => r.source === p[0] && r.external_id === p[1])) return [];
      const r: Row = { id: rows.length + 1, source: String(p[0]), external_id: String(p[1]), payload: JSON.parse(String(p[2])), version: 1, attempts: 0, next_attempt_at: p[3] as Date, sent_at: null, last_error: null };
      rows.push(r);
      return [{ id: r.id }];
    }],
    [/INSERT INTO crm_outbox/, (p) => {
      if (pending(p[0], p[1])) return [];
      const r: Row = { id: rows.length + 1, source: String(p[0]), external_id: String(p[1]), payload: JSON.parse(String(p[2])), version: 1, attempts: 0, next_attempt_at: p[3] as Date, sent_at: null, last_error: null };
      rows.push(r);
      return [{ id: r.id }];
    }],
    [/UPDATE crm_outbox SET payload = \$3::jsonb/, (p) => {
      const r = rows.find((x) => x.id === p[0] && x.version === p[1] && !x.sent_at);
      if (!r) return [];
      Object.assign(r, { payload: JSON.parse(String(p[2])), version: r.version + 1, next_attempt_at: p[3] });
      return [{ id: r.id }];
    }],
    [/UPDATE crm_outbox SET next_attempt_at = \$2, updated_at = now\(\) WHERE id IN/, (p) => {
      const due = rows.filter((r) => !r.sent_at && r.next_attempt_at.getTime() <= (p[0] as Date).getTime()).slice(0, Number(p[2]));
      due.forEach((r) => (r.next_attempt_at = p[1] as Date));
      return due.map((r) => ({ ...r, payload: structuredClone(r.payload) }));
    }],
    [/SET sent_at = \$3/, (p) => {
      const r = rows.find((x) => x.id === p[0] && x.version === p[1]);
      if (!r) return [];
      Object.assign(r, { sent_at: p[2], attempts: r.attempts + 1, last_error: null });
      return [{ id: r.id }];
    }],
    [/SET attempts = attempts \+ 1, last_error = \$2/, (p) => {
      const r = rows.find((x) => x.id === p[0])!;
      Object.assign(r, { attempts: r.attempts + 1, last_error: p[1], next_attempt_at: p[2] });
      return [];
    }],
  ];
  return { rows, handlers };
}

const saved = { url: process.env.BF_CRM_URL, key: process.env.BF_CRM_KEY };
beforeEach(() => {
  process.env.BF_CRM_KEY = KEY;
  process.env.BF_CRM_URL = "https://bf.example.test/";
  noteSupportAvailable();
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.BF_CRM_KEY; else process.env.BF_CRM_KEY = saved.key;
  if (saved.url === undefined) delete process.env.BF_CRM_URL; else process.env.BF_CRM_URL = saved.url;
  vi.restoreAllMocks();
});

const licensee = () => licenseeRow({ support_level: "premium", website: "https://northwind.example" }) as any;

function samplePayload(): SupportIngestPayload {
  return supportPayload(
    licensee(),
    { id: TICKET_ID, subject: "Calls drop", priority: "high", requester_name: "Dee", requester_email: "dee@northwind.example" },
    { id: "44444444-4444-4444-8444-444444444444", body: "Calls drop after 10 minutes.", created_at: NOW },
    { isFollowUp: false, requesterPhone: "403 555 0123", now: NOW },
  );
}

describe("licensee CRM pushes carry company.support_level", () => {
  it("on create and on a refresh (a support level change alone pushes again)", async () => {
    const o = outbox();
    const deps = { db: fakeDb(o.handlers), now: () => NOW };
    const l = licensee();
    await crmLicenseeCreated(deps, l);
    expect(o.rows[0]!.payload.company).toMatchObject({ support_level: "premium", plan: "growth" });
    await crmLicenseeUpdated(deps, { ...l, support_level: "dedicated" });
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]!.payload.company.support_level).toBe("dedicated");
  });
});

describe("support ingest client", () => {
  it("posts to {BF_CRM_URL}/api/ks/support/ingest with X-KS-Ops-Key and the payload", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true, ticket_id: "t1" }, 201));
    const p = samplePayload();
    expect(await pushSupportToBf(f as unknown as typeof fetch, p)).toEqual({ ok: true, status: 201 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bf.example.test/api/ks/support/ingest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-KS-Ops-Key"]).toBe(KEY);
    expect(JSON.parse(String(init.body))).toEqual(p);
  });

  it("404 and 503 are 'not available yet'; 400 and 422 are rejected", async () => {
    for (const [status, notAvailable, rejected] of [[404, true, false], [503, true, false], [500, false, false], [401, false, false], [400, false, true], [422, false, true]] as const) {
      const f = vi.fn(async () => jsonResponse({ error: "x" }, status));
      expect(await pushSupportToBf(f as unknown as typeof fetch, samplePayload())).toMatchObject({ ok: false, status, notAvailable, rejected });
    }
  });

  it("does nothing without BF_CRM_KEY, and never throws", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET"); });
    expect(await pushSupportToBf(f as unknown as typeof fetch, samplePayload())).toMatchObject({ ok: false, error: "ECONNRESET", notAvailable: false });
    delete process.env.BF_CRM_KEY;
    expect(await pushSupportToBf(f as unknown as typeof fetch, samplePayload())).toMatchObject({ skipped: true });
    expect(f).toHaveBeenCalledTimes(1);
    const o = outbox();
    expect(await enqueueSupportMessage({ db: fakeDb(o.handlers), now: () => NOW }, samplePayload())).toBe(false);
    expect(o.rows).toHaveLength(0);
  });

  it("builds the payload: stable message_id, external_id (ticket), channel in_app, licensee with support level, requester", () => {
    expect(samplePayload()).toEqual({
      message_id: "ks-ops:ticket-message:44444444-4444-4444-8444-444444444444",
      external_id: `ks-ops:ticket:${TICKET_ID}`,
      is_follow_up: false,
      channel: "in_app",
      subject: "Calls drop",
      message: "Calls drop after 10 minutes.",
      priority: "high",
      sent_at: NOW.toISOString(),
      licensee: {
        licensee_id: "22222222-2222-4222-8222-222222222222", name: "Northwind Capital", company_code: "northwind",
        plan: "growth", support_level: "premium", status: "active", website: "https://northwind.example",
      },
      requester: { name: "Dee", email: "dee@northwind.example", phone: "+14035550123" },
    });
    // No requester: the licensee's own contact (with its phone).
    const p = supportPayload(licensee(), { id: TICKET_ID, subject: "S" }, { id: "m", body: "B" }, { isFollowUp: true, now: NOW });
    expect(p.requester).toEqual({ name: "Nora North", email: "nora@northwind.example", phone: "+14035550199" });
    expect(p).not.toHaveProperty("priority");
  });
});

describe("support rows in the outbox", () => {
  it("queues each message once, however often it is queued", async () => {
    const o = outbox();
    const deps = { db: fakeDb(o.handlers), now: () => NOW };
    expect(await enqueueSupportMessage(deps, samplePayload())).toBe(true);
    expect(await enqueueSupportMessage(deps, samplePayload())).toBe(false);
    o.rows[0]!.sent_at = NOW;
    expect(await enqueueSupportMessage(deps, samplePayload())).toBe(false);
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]).toMatchObject({ source: "ks_support", external_id: "ks-ops:ticket-message:44444444-4444-4444-8444-444444444444" });
  });

  it("404/503: waits the long backoff and logs once; other failures use the normal backoff; success sends", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    let now = NOW;
    const p1 = samplePayload();
    const p2 = { ...samplePayload(), message_id: "ks-ops:ticket-message:m2", is_follow_up: true };
    await enqueueSupportMessage({ db, now: () => now }, p1);
    await enqueueSupportMessage({ db, now: () => now }, p2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = vi.fn(async () => jsonResponse({ error: "not_found" }, 404));
    expect(await flushCrmOutbox({ db, fetch: missing as unknown as typeof fetch, now: () => now })).toEqual({ tried: 2, sent: 0, failed: 2 });
    expect(o.rows.map((r) => r.next_attempt_at)).toEqual([new Date(NOW.getTime() + SUPPORT_NOT_AVAILABLE_MS), new Date(NOW.getTime() + SUPPORT_NOT_AVAILABLE_MS)]);
    expect(o.rows[0]!.last_error).toContain("404");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("not available yet");
    // Still missing next time (503): no more log lines.
    now = new Date(NOW.getTime() + SUPPORT_NOT_AVAILABLE_MS);
    const busy = vi.fn(async () => jsonResponse({ error: "unavailable" }, 503));
    await flushCrmOutbox({ db, fetch: busy as unknown as typeof fetch, now: () => now });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(o.rows[0]!.attempts).toBe(2);
    // Deployed: both go, each with its own message_id.
    now = new Date(now.getTime() + SUPPORT_NOT_AVAILABLE_MS);
    const ok = vi.fn(async () => jsonResponse({ ok: true }, 201));
    expect(await flushCrmOutbox({ db, fetch: ok as unknown as typeof fetch, now: () => now })).toEqual({ tried: 2, sent: 2, failed: 0 });
    const sent = ok.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(sent.map((s) => s.message_id)).toEqual([p1.message_id, p2.message_id]);
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe("https://bf.example.test/api/ks/support/ingest");
    // A later outage logs again (once); a 500 is an ordinary failure with the normal backoff, logged each time.
    await enqueueSupportMessage({ db, now: () => now }, { ...p1, message_id: "ks-ops:ticket-message:m3" });
    await enqueueSupportMessage({ db, now: () => now }, { ...p1, message_id: "ks-ops:ticket-message:m4" });
    const mixed = vi.fn(async (_u: string, init: RequestInit) =>
      JSON.parse(String(init.body)).message_id.endsWith("m3") ? jsonResponse({}, 404) : jsonResponse({ error: "boom" }, 500));
    await flushCrmOutbox({ db, fetch: mixed as unknown as typeof fetch, now: () => now });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(o.rows[3]!.next_attempt_at).toEqual(new Date(now.getTime() + 60_000));
  });
});

describe("rejected payloads (400/422)", () => {
  it("logs the details each time and gives up after the normal backoff ladder (6 tries)", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    let now = NOW;
    await enqueueSupportMessage({ db, now: () => now }, samplePayload());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(async () => jsonResponse({ error: "invalid_payload", errors: { message: "Required" } }, 400));
    const waits = [60_000, 5 * 60_000, 30 * 60_000, 120 * 60_000, 12 * 60 * 60_000];
    for (const wait of waits) {
      await flushCrmOutbox({ db, fetch: bad as unknown as typeof fetch, now: () => now });
      expect(o.rows[0]!.next_attempt_at).toEqual(new Date(now.getTime() + wait));
      now = o.rows[0]!.next_attempt_at;
    }
    expect(warn).toHaveBeenCalledTimes(5);
    expect(String(warn.mock.calls[0]![0])).toContain('{"message":"Required"}');
    await flushCrmOutbox({ db, fetch: bad as unknown as typeof fetch, now: () => now });
    expect(o.rows[0]).toMatchObject({ attempts: 6, sent_at: null, next_attempt_at: SUPPORT_PARKED_AT });
    expect(o.rows[0]!.last_error).toMatch(/^gave_up: bf_support_status_400 invalid_payload/);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("giving up");
    // Parked: never tried again.
    now = new Date(now.getTime() + 365 * 24 * 3_600_000);
    expect((await flushCrmOutbox({ db, fetch: bad as unknown as typeof fetch, now: () => now })).tried).toBe(0);
    expect(bad).toHaveBeenCalledTimes(6);
  });
});

describe("licensee ticket routes forward to the support queue", () => {
  function setup() {
    const o = outbox();
    const l = licenseeRow({ ops_key_hash: sha256Hex(LICENSEE_KEY), support_level: "priority" });
    const messages: Array<{ id: string; ticket_id: string; body: string }> = [];
    const statusUpdates: unknown[] = [];
    const db = fakeDb([
      ...o.handlers,
      [/SELECT \* FROM licensees WHERE id/, () => [l]],
      [/INSERT INTO tickets/, () => [{ id: TICKET_ID }]],
      [/INSERT INTO ticket_messages/, (p) => {
        const m = { id: `5555555${messages.length}-5555-4555-8555-555555555555`, ticket_id: String(p[0]), body: String(p[3]), created_at: NOW };
        messages.push(m);
        return [m];
      }],
      [/SELECT \* FROM tickets WHERE id = \$1 AND licensee_id = \$2/, (p) =>
        p[0] === TICKET_ID && p[1] === l.id
          ? [{ id: TICKET_ID, licensee_id: l.id, subject: "Calls drop", priority: "urgent", status: "resolved", requester_name: "Dee", requester_email: "dee@northwind.example" }]
          : []],
      [/UPDATE tickets SET status = CASE/, (p) => { statusUpdates.push(p); return []; }],
    ]);
    const app = createApp(makeDeps({ db, now: () => NOW }));
    return { o, l, app, messages, statusUpdates };
  }

  it("a new ticket and a follow-up each queue one ingest push on the same ticket", async () => {
    const { o, l, app, messages, statusUpdates } = setup();
    const t = await request(app).post(`/api/licensees/${l.id}/tickets`).set("X-KS-Ops-Key", LICENSEE_KEY)
      .send({ subject: "Calls drop", body: "Calls drop after 10 minutes.", priority: "urgent", requester_name: "Dee", requester_email: "dee@northwind.example", requester_phone: "403-555-0123" });
    expect(t.status).toBe(201);
    const f = await request(app).post(`/api/licensees/${l.id}/tickets/${TICKET_ID}/messages`).set("X-KS-Ops-Key", LICENSEE_KEY)
      .send({ message: "Still happening today." });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ ok: true, ticket_id: TICKET_ID, message_id: messages[1]!.id });
    expect(statusUpdates).toHaveLength(1);
    const support = o.rows.filter((r) => r.source === "ks_support");
    expect(support).toHaveLength(2);
    expect(support[0]!.payload).toMatchObject({
      message_id: `ks-ops:ticket-message:${messages[0]!.id}`, external_id: `ks-ops:ticket:${TICKET_ID}`, is_follow_up: false,
      channel: "in_app", subject: "Calls drop", message: "Calls drop after 10 minutes.", priority: "urgent",
      licensee: { licensee_id: l.id, name: "Northwind Capital", company_code: "northwind", support_level: "priority" },
      requester: { name: "Dee", email: "dee@northwind.example", phone: "+14035550123" },
    });
    expect(support[1]!.payload).toMatchObject({
      message_id: `ks-ops:ticket-message:${messages[1]!.id}`, external_id: `ks-ops:ticket:${TICKET_ID}`, is_follow_up: true,
      message: "Still happening today.", priority: "urgent", requester: { name: "Dee", email: "dee@northwind.example" },
    });
  });

  it("a follow-up on an unknown or another licensee's ticket is 404 and queues nothing", async () => {
    const { o, l, app } = setup();
    const other = "66666666-6666-4666-8666-666666666666";
    const r = await request(app).post(`/api/licensees/${l.id}/tickets/${other}/messages`).set("X-KS-Ops-Key", LICENSEE_KEY).send({ body: "Hi" });
    expect(r.status).toBe(404);
    const bad = await request(app).post(`/api/licensees/${l.id}/tickets/${TICKET_ID}/messages`).set("X-KS-Ops-Key", LICENSEE_KEY).send({});
    expect(bad.status).toBe(400);
    const noKey = await request(app).post(`/api/licensees/${l.id}/tickets/${TICKET_ID}/messages`).send({ body: "Hi" });
    expect(noKey.status).toBe(401);
    expect(o.rows).toHaveLength(0);
  });
});
