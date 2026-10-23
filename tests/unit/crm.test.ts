// The Keystone CRM push (BF-Server POST /api/ks/crm/upsert): the client, the outbox (coalescing, backoff) and every
// trigger (demo sign-ups, website sign-ups, staff-created licensees, Stripe payments and status changes).
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { bfCrmConfigured, bfCrmUrl, pushToBfCrm, type CrmPayload } from "../../src/lib/bfCrm.js";
import { backoffMs, enqueueCrm, flushCrmOutbox, mergePayload, normalizePayload } from "../../src/crm/outbox.js";
import {
  crmDemoCompleted, crmDemoOpened, crmDemoProgress, crmDemoSignup, crmDemoUnfinished, crmLicenseeCreated, crmLicenseePaid,
  crmLicenseeStatus, demoStepEvents, licenseeSource,
} from "../../src/crm/triggers.js";
import { digestEvents, type DemoEvent } from "../../src/demo/digest.js";
import { expirePendingSignups } from "../../src/workers.js";
import { fakeDb, fakeMailer, fakeStripe, jsonResponse, licenseeRow, makeDeps, validSignup } from "../helpers.js";

const KEY = "ks-ops-crm-key-0123456789-0123456789";
const NOW = new Date("2026-10-23T12:00:00Z");

/** An in-memory crm_outbox behind fakeDb handlers that answer by SQL content. */
function outbox() {
  type Row = { id: number; source: string; external_id: string; payload: CrmPayload; version: number; attempts: number; next_attempt_at: Date; sent_at: Date | null; last_error: string | null };
  const rows: Row[] = [];
  const pending = (s: unknown, e: unknown) => rows.find((r) => r.source === s && r.external_id === e && !r.sent_at);
  const handlers: Array<[RegExp, (p: unknown[]) => any[]]> = [
    [/SELECT id, payload, version, attempts, next_attempt_at FROM crm_outbox/, (p) => {
      const r = pending(p[0], p[1]);
      return r ? [{ ...r, payload: structuredClone(r.payload) }] : [];
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
    [/UPDATE crm_outbox SET next_attempt_at = \$2, updated_at = now\(\) WHERE id = \$1 AND sent_at IS NULL/, (p) => {
      const r = rows.find((x) => x.id === p[0])!;
      r.next_attempt_at = p[1] as Date;
      return [];
    }],
  ];
  return { rows, handlers, pendingFor: (source: string, id: string) => pending(source, id)?.payload };
}

const saved = { url: process.env.BF_CRM_URL, key: process.env.BF_CRM_KEY };
beforeEach(() => {
  process.env.BF_CRM_KEY = KEY;
  delete process.env.BF_CRM_URL;
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.BF_CRM_KEY; else process.env.BF_CRM_KEY = saved.key;
  if (saved.url === undefined) delete process.env.BF_CRM_URL; else process.env.BF_CRM_URL = saved.url;
  vi.restoreAllMocks();
});

const payload: CrmPayload = { source: "demo_signup", external_id: "d1", stage: "lead", contact: { name: "Dana", email: "dana@x.example" } };

describe("BF-Server CRM client", () => {
  it("posts to {BF_CRM_URL}/api/ks/crm/upsert with the key header and JSON body", async () => {
    process.env.BF_CRM_URL = "https://bf.example.test/";
    const f = vi.fn(async () => jsonResponse({ ok: true, contact_id: "c1", company_id: null, stage: "lead" }));
    const r = await pushToBfCrm(f as unknown as typeof fetch, payload);
    expect(r).toMatchObject({ ok: true, status: 200, body: { contact_id: "c1" } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bf.example.test/api/ks/crm/upsert");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "X-KS-Ops-Key": KEY });
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it("defaults to the Boreal server", () => {
    expect(bfCrmUrl()).toBe("https://server.boreal.financial");
  });

  it("does nothing when BF_CRM_KEY is not set", async () => {
    delete process.env.BF_CRM_KEY;
    expect(bfCrmConfigured()).toBe(false);
    const f = vi.fn();
    expect(await pushToBfCrm(f as unknown as typeof fetch, payload)).toMatchObject({ ok: false, skipped: true });
    expect(f).not.toHaveBeenCalled();
    const db = fakeDb();
    expect(await enqueueCrm({ db, now: () => NOW }, payload)).toBe(false);
    expect(db.calls).toHaveLength(0);
    expect(await flushCrmOutbox({ db, fetch: f as unknown as typeof fetch, now: () => NOW })).toEqual({ tried: 0, sent: 0, failed: 0 });
    expect(db.calls).toHaveLength(0);
  });

  it("gives up after the timeout and never throws", async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    }));
    expect(await pushToBfCrm(hang as unknown as typeof fetch, payload, { timeoutMs: 20 })).toEqual({ ok: false, status: null, error: "bf_crm_timeout" });
    const boom = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await pushToBfCrm(boom as unknown as typeof fetch, payload)).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });

  it("reports HTTP errors with the status and error code", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "validation_error", errors: { stage: "bad" } }, 400));
    const r = await pushToBfCrm(f as unknown as typeof fetch, payload);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toContain("validation_error");
  });
});

describe("CRM outbox", () => {
  it("backs off 1 min, 5 min, 30 min, 2 h, 12 h, then daily", () => {
    expect([1, 2, 3, 4, 5, 6, 30].map((n) => backoffMs(n) / 60_000)).toEqual([1, 5, 30, 120, 720, 1440, 1440]);
  });

  it("merges: newest contact/company values, furthest stage, combined events, joined notes", () => {
    const a: CrmPayload = {
      source: "website_signup", external_id: "l1", stage: "paying", contact: { name: "A", email: "a@x.example" },
      company: { name: "Co", status: "provisioning" }, note: "first", events: [{ type: "payment", at: "2026-10-23T10:00:00.000Z", summary: "paid" }],
    };
    const b: CrmPayload = {
      source: "website_signup", external_id: "l1", contact: { name: "B" }, company: { status: "active" }, note: "second",
      events: [{ type: "payment", at: "2026-10-23T10:00:00.000Z", summary: "dup" }, { type: "status_change", at: "2026-10-23T11:00:00.000Z", summary: "s" }],
    };
    const m = mergePayload(a, b);
    expect(m.stage).toBe("paying");
    expect(m.contact).toEqual({ name: "B", email: "a@x.example" });
    expect(m.company).toEqual({ name: "Co", status: "active" });
    expect(m.note).toBe("first\n\nsecond");
    expect(m.events!.map((e) => e.type)).toEqual(["payment", "status_change"]);
    expect(mergePayload({ ...a, stage: "lead" }, { ...b, stage: "demo_started" }).stage).toBe("demo_started");
  });

  it("trims to the endpoint's limits", () => {
    const p = normalizePayload({
      source: "demo_signup", external_id: "x".repeat(150), note: "n".repeat(5000),
      events: Array.from({ length: 60 }, (_, i) => ({ type: "demo_step" as const, at: new Date(i * 1000).toISOString(), summary: "s".repeat(400) })),
    });
    expect(p.external_id).toHaveLength(100);
    expect(p.note).toHaveLength(4000);
    expect(p.events).toHaveLength(50);
    expect(p.events![0]!.summary).toHaveLength(300);
  });

  it("keeps one pending row per record and only the latest state", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    const deps = { db, now: () => NOW };
    await enqueueCrm(deps, payload);
    await enqueueCrm(deps, { source: "demo_signup", external_id: "d1", stage: "demo_started", events: [{ type: "demo_opened", at: NOW.toISOString(), summary: "o" }] });
    await enqueueCrm(deps, { source: "demo_signup", external_id: "d2", stage: "lead" });
    expect(o.rows).toHaveLength(2);
    expect(o.pendingFor("demo_signup", "d1")).toMatchObject({ stage: "demo_started", contact: { name: "Dana" }, events: [{ type: "demo_opened" }] });
  });

  it("never throws when the database fails", async () => {
    const db = fakeDb([[/crm_outbox/, () => { throw new Error("db down"); }]]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await enqueueCrm({ db, now: () => NOW }, payload)).toBe(false);
    expect(err.mock.calls[0]![0]).toContain("db down");
  });

  it("sends due rows, retries 404/503 with backoff and logs every failure", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    let now = NOW;
    await enqueueCrm({ db, now: () => now }, payload);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = vi.fn(async () => jsonResponse({ error: "not_found" }, 404));
    expect(await flushCrmOutbox({ db, fetch: down as unknown as typeof fetch, now: () => now })).toEqual({ tried: 1, sent: 0, failed: 1 });
    expect(o.rows[0]).toMatchObject({ attempts: 1, sent_at: null, next_attempt_at: new Date(NOW.getTime() + 60_000) });
    expect(o.rows[0]!.last_error).toContain("404");
    expect(warn).toHaveBeenCalledTimes(1);
    // Not due yet: nothing is tried.
    now = new Date(NOW.getTime() + 30_000);
    expect((await flushCrmOutbox({ db, fetch: down as unknown as typeof fetch, now: () => now })).tried).toBe(0);
    now = new Date(NOW.getTime() + 61_000);
    const busy = vi.fn(async () => jsonResponse({ error: "ks_crm_not_configured" }, 503));
    await flushCrmOutbox({ db, fetch: busy as unknown as typeof fetch, now: () => now });
    expect(o.rows[0]).toMatchObject({ attempts: 2, next_attempt_at: new Date(now.getTime() + 5 * 60_000) });
    // A merge into a row in backoff keeps its wait.
    await enqueueCrm({ db, now: () => now }, { source: "demo_signup", external_id: "d1", stage: "demo_started" });
    expect(o.rows[0]!.next_attempt_at).toEqual(new Date(now.getTime() + 5 * 60_000));
    now = new Date(now.getTime() + 5 * 60_000);
    const ok = vi.fn(async () => jsonResponse({ ok: true, contact_id: "c", company_id: "k", stage: "demo_started" }));
    expect(await flushCrmOutbox({ db, fetch: ok as unknown as typeof fetch, now: () => now })).toEqual({ tried: 1, sent: 1, failed: 0 });
    expect(o.rows[0]!.sent_at).toEqual(now);
    expect(JSON.parse(String((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ stage: "demo_started", contact: { name: "Dana" } });
    // After sending, a new push starts a new row.
    await enqueueCrm({ db, now: () => now }, { source: "demo_signup", external_id: "d1", stage: "demo_finished" });
    expect(o.rows).toHaveLength(2);
  });

  it("a row merged into while it was sending stays pending and goes again", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    const deps = { db, now: () => NOW };
    await enqueueCrm(deps, payload);
    const f = vi.fn(async () => {
      await enqueueCrm(deps, { source: "demo_signup", external_id: "d1", stage: "demo_started" });
      return jsonResponse({ ok: true });
    });
    await flushCrmOutbox({ db, fetch: f as unknown as typeof fetch, now: () => NOW });
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]).toMatchObject({ sent_at: null, payload: { stage: "demo_started" } });
    const g = vi.fn(async () => jsonResponse({ ok: true }));
    await flushCrmOutbox({ db, fetch: g as unknown as typeof fetch, now: () => NOW });
    expect(o.rows[0]!.sent_at).toEqual(NOW);
  });

  it("holds a delayed push back (demo progress: at most once a minute)", async () => {
    const o = outbox();
    const db = fakeDb(o.handlers);
    await enqueueCrm({ db, now: () => NOW }, payload, { delayMs: 60_000 });
    expect(o.rows[0]!.next_attempt_at).toEqual(new Date(NOW.getTime() + 60_000));
    // An undelayed push (say the demo finished) brings it forward.
    await enqueueCrm({ db, now: () => NOW }, { source: "demo_signup", external_id: "d1", stage: "demo_finished" });
    expect(o.rows[0]!.next_attempt_at).toEqual(NOW);
  });
});

// ---- triggers ----

const demo = { id: "55555555-5555-4555-8555-555555555555", name: "Dana Prospect", email: "dana@brokerco.example", phone: "+14035550199", company: "BrokerCo", created_at: new Date("2026-10-23T10:00:00Z") };
const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 10, min)).toISOString();
const ev = (min: number, type: string, step: string | null = null, data: Record<string, unknown> = {}): DemoEvent => ({ type, step, data, at: at(min) });

function triggerSetup() {
  const o = outbox();
  const db = fakeDb(o.handlers);
  return { o, db, deps: { db, now: () => NOW } };
}

describe("demo sign-up triggers (item 7)", () => {
  it("sign-up -> lead with contact, company and a signup event", async () => {
    const { o, deps } = triggerSetup();
    await crmDemoSignup(deps, demo);
    expect(o.pendingFor("demo_signup", demo.id)).toEqual({
      source: "demo_signup", external_id: demo.id, stage: "lead",
      contact: { name: "Dana Prospect", email: "dana@brokerco.example", phone: "+14035550199", title: null },
      company: { name: "BrokerCo" },
      events: [{ type: "signup", at: "2026-10-23T10:00:00.000Z", summary: expect.stringContaining("demo") }],
    });
  });

  it("first open -> demo_started + demo_opened", async () => {
    const { o, deps } = triggerSetup();
    await crmDemoOpened(deps, demo, NOW);
    expect(o.pendingFor("demo_signup", demo.id)).toMatchObject({ stage: "demo_started", events: [{ type: "demo_opened", at: NOW.toISOString() }] });
  });

  it("progress -> one demo_step per step reached, timed at the first action on it, held back a minute", async () => {
    const events = [ev(0, "portal_opened"), ev(1, "step_viewed", "welcome"), ev(2, "step_completed", "welcome"), ev(3, "borrower_joined", "borrower", { via: "link" }), ev(5, "click", "borrower")];
    const steps = demoStepEvents(events, digestEvents(events))!;
    expect(steps).toEqual([
      { type: "demo_step", at: at(1), summary: "Reached step 1 of 9: Welcome (completed)." },
      { type: "demo_step", at: at(3), summary: "Reached step 2 of 9: Be the borrower (phone)." },
    ]);
    const { o, deps } = triggerSetup();
    await crmDemoProgress(deps, demo, events);
    expect(o.rows[0]!.next_attempt_at).toEqual(new Date(NOW.getTime() + 60_000));
    expect(o.pendingFor("demo_signup", demo.id)).toMatchObject({ events: steps });
    expect(o.pendingFor("demo_signup", demo.id)!.stage).toBeUndefined();
    // No stepped events: nothing queued.
    const t = triggerSetup();
    await crmDemoProgress(t.deps, demo, [ev(0, "heartbeat")]);
    expect(t.o.rows).toHaveLength(0);
  });

  it("finished -> demo_finished + demo_completed + a note of what they did", async () => {
    const { o, deps } = triggerSetup();
    const d = digestEvents([ev(0, "step_completed", "welcome"), ev(10, "submitted", "submit", { lenders: ["Aspen Ridge Capital"] })]);
    await crmDemoCompleted(deps, { ...demo, completed_at: new Date(at(10)) }, d);
    const p = o.pendingFor("demo_signup", demo.id)!;
    expect(p).toMatchObject({ stage: "demo_finished", events: [{ type: "demo_completed", at: at(10) }] });
    expect(p.note).toContain("finished the Keystone demo");
    expect(p.note).toContain("Lenders picked: Aspen Ridge Capital");
  });

  it("idle or expired unfinished -> a note only, no stage", async () => {
    const { o, deps } = triggerSetup();
    await crmDemoUnfinished(deps, demo, digestEvents([ev(0, "step_completed", "welcome"), ev(1, "step_viewed", "documents")]), "idle", 24);
    const p = o.pendingFor("demo_signup", demo.id)!;
    expect(p.stage).toBeUndefined();
    expect(p.events).toBeUndefined();
    expect(p.note).toContain("did not finish it (no activity for 24 hours)");
    expect(p.note).toContain("Review documents and the fraud check");
  });
});

describe("demo routes queue the CRM pushes", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.KS_DEMO_SERVER_URL = "https://demo-server.example";
    process.env.KS_DEMO_OPS_KEY = "demo-ops-key-0123456789";
    process.env.KS_DEMO_PORTAL_URL = "https://portal.example";
  });
  afterEach(() => {
    for (const k of ["KS_DEMO_SERVER_URL", "KS_DEMO_OPS_KEY", "KS_DEMO_PORTAL_URL"]) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  it("progress events queue the steps; a submitted event queues demo_finished", async () => {
    const o = outbox();
    const row = { ...demo, status: "active", completed_at: null as Date | null, event_count: 0, opened_at: NOW, expires_at: new Date("2026-10-30T00:00:00Z") };
    const stored: DemoEvent[] = [];
    const db = fakeDb([
      ...o.handlers,
      [/FROM demo_signups WHERE id = \$1/, () => [{ ...row }]],
      [/SELECT event_count FROM demo_signups/, () => [{ event_count: stored.length }]],
      [/INSERT INTO demo_events/, (p) => { stored.push(...JSON.parse(String(p[1]))); return []; }],
      [/UPDATE demo_signups SET event_count/, (p) => { if (p[4]) row.completed_at = p[3] as Date; return []; }],
      [/SELECT type, step, data, at FROM demo_events/, () => stored],
    ]);
    const app = createApp(makeDeps({ db, now: () => NOW }));
    const r = await request(app).post(`/api/demo/sessions/${demo.id}/events`).set("X-KS-Ops-Key", "demo-ops-key-0123456789")
      .send({ events: [{ type: "step_completed", step: "welcome", at: at(1) }, { type: "submitted", step: "submit", at: at(9) }] });
    expect(r.status).toBe(202);
    const p = o.pendingFor("demo_signup", demo.id)!;
    expect(p.stage).toBe("demo_finished");
    expect(p.events!.map((e) => e.type)).toEqual(["demo_step", "demo_step", "demo_completed"]);
  });
});

describe("licensee triggers (item 8)", () => {
  it("website sign-up -> website_signup, signed_up, contact and company", async () => {
    const o = outbox();
    const inserted = licenseeRow({ id: "44444444-4444-4444-8444-444444444444", source: "website", status: "pending_payment", website: "https://northwind.example" });
    const db = fakeDb([
      ...o.handlers,
      [/SELECT 1 FROM licensees WHERE company_code/, () => []],
      [/INSERT INTO licensees/, () => [inserted]],
    ]);
    const app = createApp(makeDeps({ db, now: () => NOW }));
    const res = await request(app).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(201);
    expect(o.pendingFor("website_signup", inserted.id)).toEqual({
      source: "website_signup", external_id: inserted.id, stage: "signed_up",
      contact: { name: "Nora North", email: "nora@northwind.example", phone: "+14035550199", title: null },
      company: { name: "Northwind Capital", website: "https://northwind.example", company_code: "northwind", plan: "growth", seats: 3, status: "pending_payment" },
      events: [{ type: "signup", at: expect.any(String), summary: expect.stringContaining("Signed up on the Keystone website") }],
    });
  });

  it("staff-created licensee -> source licensee, signed_up", async () => {
    const o = outbox();
    const deps = { db: fakeDb(o.handlers), now: () => NOW };
    const l = licenseeRow({ source: "staff", status: "trial" }) as any;
    expect(licenseeSource(l)).toBe("licensee");
    await crmLicenseeCreated(deps, l);
    expect(o.pendingFor("licensee", l.id)).toMatchObject({ stage: "signed_up", company: { status: "trial", company_code: "northwind" }, events: [{ type: "signup", summary: expect.stringContaining("staff") }] });
  });

  it("payment -> paying + payment event; status change -> event and company status, never lost", async () => {
    const o = outbox();
    const deps = { db: fakeDb(o.handlers), now: () => NOW };
    const l = licenseeRow({ source: "website" }) as any;
    await crmLicenseePaid(deps, l, "provisioning", NOW, "Paid");
    await crmLicenseeStatus(deps, l, "active", "cancelled", NOW, "Stripe");
    const p = o.pendingFor("website_signup", l.id)!;
    expect(p.stage).toBe("paying");
    expect(p.company!.status).toBe("cancelled");
    expect(p.events!.map((e) => e.type)).toEqual(["payment", "status_change"]);
    await crmLicenseeStatus(deps, l, "active", "active", NOW, "x");
    expect(o.pendingFor("website_signup", l.id)!.events).toHaveLength(2);
  });

  it("an unpaid sign-up that expires is pushed as cancelled with the code it signed up with", async () => {
    const o = outbox();
    const l = licenseeRow({ source: "website", status: "cancelled", company_code: "exp--abc" });
    const db = fakeDb([
      ...o.handlers,
      [/UPDATE licensees SET status = 'cancelled'/, () => [{ id: l.id, released_company_code: "northwind" }]],
      [/SELECT \* FROM licensees WHERE id = \$1/, () => [l]],
    ]);
    expect(await expirePendingSignups({ db, now: () => NOW })).toBe(1);
    expect(o.pendingFor("website_signup", l.id)).toMatchObject({
      company: { status: "cancelled", company_code: "northwind" },
      events: [{ type: "status_change", summary: expect.stringContaining("pending_payment to cancelled") }],
    });
    expect(o.pendingFor("website_signup", l.id)!.stage).toBeUndefined();
  });
});

describe("Stripe webhook queues the CRM pushes", () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });
  afterEach(() => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  function setup(row: Record<string, unknown>) {
    const o = outbox();
    const r = licenseeRow({ source: "website", ...row }) as any;
    const db = fakeDb([
      ...o.handlers,
      [/SELECT 1 FROM stripe_events/, () => []],
      [/SELECT \* FROM licensees WHERE \(\$1::uuid/, () => [{ ...r }]],
      [/SET status = 'provisioning'.*status = 'pending_payment' RETURNING/, () => (r.status === "pending_payment" ? [Object.assign(r, { status: "provisioning" }) && { id: r.id }] : [])],
      [/SET status = 'active'.*status = 'past_due'/, () => (r.status === "past_due" ? [Object.assign(r, { status: "active" }) && { id: r.id }] : [])],
      [/SET status = 'cancelled'/, () => (r.status !== "cancelled" ? [Object.assign(r, { status: "cancelled" }) && { id: r.id }] : [])],
      [/SET status = 'past_due'.*status IN \('active','trial'\)/, () => (["active", "trial"].includes(r.status) ? [Object.assign(r, { status: "past_due" }) && { id: r.id }] : [])],
    ]);
    const stripe = fakeStripe();
    const app = createApp(makeDeps({ db, stripe: () => stripe, mailer: fakeMailer().mailer, now: () => NOW }));
    const send = (type: string, object: unknown) =>
      request(app).post("/api/ops/stripe/webhook").set("Stripe-Signature", "valid").set("Content-Type", "application/json")
        .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
    return { o, r, send };
  }

  it("checkout paid -> paying + payment", async () => {
    const { o, r, send } = setup({ status: "pending_payment", stripe_subscription_id: "sub_1" });
    const res = await send("checkout.session.completed", { id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "paid", metadata: { licensee_id: r.id } });
    expect(res.body.result).toBe("provisioning");
    expect(o.pendingFor("website_signup", r.id)).toMatchObject({ stage: "paying", company: { status: "provisioning" }, events: [{ type: "payment" }] });
  });

  it("checkout not yet paid (bank debit) -> nothing", async () => {
    const { o, r, send } = setup({ status: "pending_payment", stripe_subscription_id: "sub_1" });
    await send("checkout.session.completed", { id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "unpaid", metadata: { licensee_id: r.id } });
    expect(o.rows).toHaveLength(0);
  });

  it("invoice paid for a past-due licensee -> active, paying, payment and status_change", async () => {
    const { o, r, send } = setup({ status: "past_due", stripe_subscription_id: "sub_1" });
    const res = await send("invoice.paid", { id: "in_1", number: "KS-0001", customer: "cus_1", subscription: "sub_1", amount_paid: 12900, currency: "cad", status_transitions: { paid_at: 1792756800 } });
    expect(res.body.result).toBe("paid_reactivated");
    const p = o.pendingFor("website_signup", r.id)!;
    expect(p).toMatchObject({ stage: "paying", company: { status: "active" } });
    expect(p.events!.map((e) => e.type).sort()).toEqual(["payment", "status_change"]);
    expect(p.events!.find((e) => e.type === "payment")!.summary).toBe("Invoice KS-0001 paid: 129.00 CAD");
  });

  it("subscription cancelled / past due -> status_change, stage untouched (never lost)", async () => {
    const a = setup({ status: "active", stripe_subscription_id: "sub_1" });
    await a.send("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled" });
    const p = a.o.pendingFor("website_signup", a.r.id)!;
    expect(p.stage).toBeUndefined();
    expect(p).toMatchObject({ company: { status: "cancelled" }, events: [{ type: "status_change", summary: expect.stringContaining("active to cancelled") }] });
    const b = setup({ status: "active", stripe_subscription_id: "sub_1" });
    await b.send("invoice.payment_failed", { id: "in_2", customer: "cus_1", subscription: "sub_1" });
    expect(b.o.pendingFor("website_signup", b.r.id)).toMatchObject({ company: { status: "past_due" }, events: [{ type: "status_change" }] });
  });
});
