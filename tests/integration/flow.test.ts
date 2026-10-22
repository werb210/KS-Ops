import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { billOverage } from "../../src/billing/billing.js";
import { runMigrations } from "../../src/migrate.js";
import { retryPendingPlanPushes } from "../../src/sync/planPush.js";
import { claimDailyJob, expiredCode, expirePendingSignups, pullUsageForAll, sendPastDueReminders } from "../../src/workers.js";
import { fakeMailer, fakeStripe, jsonResponse, staffToken, validSignup } from "../helpers.js";
import { freshPool, seedPrices } from "./db.js";

let pool: pg.Pool;
let now = new Date("2026-10-22T12:00:00Z");
const remote = { up: true, puts: [] as Array<{ url: string; body: any; key: string }>, report: null as any };

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (url.endsWith("/api/plan") && init.method === "PUT") {
    if (!remote.up) return new Response("unavailable", { status: 503 });
    remote.puts.push({ url, body: JSON.parse(String(init.body)), key: headers["X-KS-Ops-Key"] });
    return jsonResponse({ ok: true });
  }
  if (url.includes("/api/plan/usage-report")) {
    return remote.report ? jsonResponse(remote.report) : new Response("no", { status: 404 });
  }
  return new Response("unexpected", { status: 500 });
});

const mail = fakeMailer();
let stripe: ReturnType<typeof fakeStripe> | null = null;
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

beforeAll(async () => {
  pool = await freshPool();
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => stripe, now: () => now };
});
afterAll(async () => {
  await pool.end();
});

describe("migrations", () => {
  it("run again without changes", async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });
});

describe("public sign-up to directory", () => {
  let id = "";
  let token = "";

  it("signs up without Stripe", async () => {
    const res = await request(app()).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toBeNull();
    id = res.body.licensee_id;
    token = res.body.signup_token;
    const row = (await pool.query("SELECT * FROM licensees WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "pending_payment", company_code: "northwind", contact_email: "nora@northwind.example", source: "website" });
    expect(row.accepted_terms_at).not.toBeNull();
  });

  it("refuses the same code again", async () => {
    const res = await request(app()).post("/api/public/signup").send({ ...validSignup(), company_code: "NORTHWIND" });
    expect(res.status).toBe(409);
    expect((await request(app()).get("/api/public/company-code-available?code=northwind")).body.available).toBe(false);
  });

  it("reports status only with the right token", async () => {
    expect((await request(app()).get(`/api/public/signup/${id}/status?token=${token}`)).body).toEqual({ status: "pending_payment", company_name: "Northwind Capital" });
    expect((await request(app()).get(`/api/public/signup/${id}/status?token=nope`)).status).toBe(404);
  });

  it("does not resolve in the directory until live with a server", async () => {
    expect((await request(app()).get("/api/directory/northwind")).status).toBe(404);
    const patch = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "active", server_url: "https://ks-northwind.azurewebsites.net" });
    expect(patch.status).toBe(200);
    const res = await request(app()).get("/api/directory/northwind");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company_code: "northwind", server_url: "https://ks-northwind.azurewebsites.net" });
    await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "suspended" });
    expect((await request(app()).get("/api/directory/northwind")).status).toBe(404);
    // Both live status changes were recorded for the push to the licensee's server.
    const changes = (await pool.query("SELECT from_status, to_status FROM plan_changes WHERE licensee_id = $1 ORDER BY created_at", [id])).rows;
    expect(changes).toEqual([{ from_status: "pending_payment", to_status: "active" }, { from_status: "active", to_status: "suspended" }]);
    const row = (await pool.query("SELECT plan_sync_status, plan_sync_error FROM licensees WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ plan_sync_status: "pending_sync", plan_sync_error: "no_ops_key" });
  });
});

describe("staff-created licensee, ops key, usage and plan pushes", () => {
  let id = "";
  let opsKey = "";

  it("creates a licensee and returns the ops key once", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Keystone Demo", legal_name: "Keystone Demo Inc.", company_code: "keystone-demo",
      contact_name: "Dee Demo", contact_email: "dee@demo.example", contact_phone: "403-555-0123",
      plan: "starter", billing: "monthly", support_level: "email", seats: 2, country: "CA",
      server_url: "https://ks-demo.azurewebsites.net", status: "trial",
    });
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    id = res.body.licensee.id;
    opsKey = res.body.ops_key;
    expect(opsKey).toMatch(/^ksops_/);
    expect(res.body.licensee).not.toHaveProperty("ops_key_hash");
    expect(res.body.licensee).toMatchObject({ has_ops_key: true, billing_interval: "monthly", plan_sync_status: "pending_sync" });
    const detail = await request(app()).get(`/api/ops/licensees/${id}`).set(staff());
    expect(JSON.stringify(detail.body)).not.toContain(opsKey);
  });

  it("validates staff input", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({ company_name: "X", plan: "pro", seats: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errors.seats).toBe("The Pro plan needs at least 2 seats.");
    const bad = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ nonsense: 1 });
    expect(bad.status).toBe(400);
  });

  it("the retry worker pushes the first plan once the server answers", async () => {
    const r = await retryPendingPlanPushes(deps);
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    expect(remote.puts.at(-1)).toMatchObject({ url: "https://ks-demo.azurewebsites.net/api/plan", key: opsKey, body: { plan: "starter", extra_storage_blocks: 0, status: "trial" } });
  });

  it("stores usage reports idempotently, latest wins", async () => {
    const send = (body: object, key = opsKey) =>
      request(app()).post(`/api/licensees/${id}/usage-reports`).set("X-KS-Ops-Key", key).send(body);
    const base = { licensee_id: id, period: "2026-09", plan: "starter", effective_plan: "starter", seats: 2, texts: 10,
      assistant_chats: 3, storage_bytes: 5, extra_storage_blocks: 0 };
    expect((await send({ ...base, generated_at: "2026-09-30T10:00:00Z", minutes: 50, overage: { minutes: 0, texts: 0 } })).body.stored).toBe(true);
    expect((await send({ ...base, generated_at: "2026-10-01T00:10:00Z", minutes: 180, overage: { minutes: 80, texts: 0 } })).body.stored).toBe(true);
    const older = await send({ ...base, generated_at: "2026-09-29T00:00:00Z", minutes: 1, overage: { minutes: 0, texts: 0 } });
    expect(older.status).toBe(200);
    expect(older.body.stored).toBe(false);
    expect((await send({ ...base, generated_at: "2026-10-01T00:10:00Z", minutes: 180 }, "wrong")).status).toBe(401);
    expect((await send({ ...base, licensee_id: "00000000-0000-4000-8000-000000000000", generated_at: "2026-10-02T00:00:00Z" })).status).toBe(400);
    const rows = (await pool.query("SELECT * FROM usage_reports WHERE licensee_id = $1", [id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minutes: 180, overage_minutes: 80 });
  });

  it("PATCH plan pushes to the licensee and records the change; failures retry", async () => {
    const ok = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ plan: "growth", extra_storage_blocks: 1 });
    expect(ok.body.plan_push).toEqual({ ok: true });
    expect(remote.puts.at(-1)!.body).toEqual({ plan: "growth", extra_storage_blocks: 1, status: "trial", addons: { bank_connect: false } });

    remote.up = false;
    const fail = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ plan: "pro" });
    expect(fail.body.plan_push.ok).toBe(false);
    expect(fail.body.licensee.plan_sync_status).toBe("pending_sync");

    // Not due yet.
    expect((await retryPendingPlanPushes(deps)).tried).toBe(0);
    remote.up = true;
    now = new Date(now.getTime() + 6 * 60_000);
    // Northwind (from the sign-up tests) is also waiting: its status changes are queued but it has no ops key yet.
    expect(await retryPendingPlanPushes(deps)).toEqual({ tried: 2, pushed: 1 });
    expect(remote.puts.at(-1)!.body).toEqual({ plan: "pro", extra_storage_blocks: 1, status: "trial", addons: { bank_connect: false } });
    const changes = (await pool.query("SELECT status FROM plan_changes WHERE licensee_id = $1", [id])).rows;
    expect(changes.map((c) => c.status)).toEqual(["pushed", "pushed"]);
  });

  it("rotating the ops key invalidates the old one", async () => {
    const res = await request(app()).post(`/api/ops/licensees/${id}/ops-key`).set(staff());
    expect(res.body.ops_key).toMatch(/^ksops_/);
    expect(res.body.message).toContain("Copy this key now");
    const old = await request(app()).post(`/api/licensees/${id}/requests`).set("X-KS-Ops-Key", opsKey).send({ plan: "pro" });
    expect(old.status).toBe(401);
    opsKey = res.body.ops_key;
  });

  it("takes upgrade requests and tickets from the licensee", async () => {
    const r = await request(app()).post(`/api/licensees/${id}/requests`).set("X-KS-Ops-Key", opsKey).send({ plan: "pro", extra_storage_blocks: 2, requested_by: "dee@demo.example" });
    expect(r.status).toBe(201);
    const t = await request(app()).post(`/api/licensees/${id}/tickets`).set("X-KS-Ops-Key", opsKey).send({ subject: "Calls drop", body: "Calls drop after 10 minutes.", requester_email: "dee@demo.example" });
    expect(t.status).toBe(201);
    expect(mail.sent.some((m) => m.subject.includes("Calls drop"))).toBe(true);

    const reqs = await request(app()).get("/api/ops/requests").set(staff());
    expect(reqs.body.requests[0]).toMatchObject({ kind: "upgrade", requested_plan: "pro", requested_extra_storage_blocks: 2, company_code: "keystone-demo" });
    const done = await request(app()).patch(`/api/ops/requests/${r.body.request_id}`).set(staff()).send({ status: "done" });
    expect(done.body.request.handled_by).toBe("admin@example.test");

    const list = await request(app()).get("/api/ops/tickets?status=open").set(staff());
    expect(list.body.tickets).toHaveLength(1);
    const reply = await request(app()).post(`/api/ops/tickets/${t.body.ticket_id}/messages`).set(staff()).send({ body: "We are looking into it.", status: "waiting" });
    expect(reply.status).toBe(201);
    expect(reply.body.emailed).toBe(true);
    const patched = await request(app()).patch(`/api/ops/tickets/${t.body.ticket_id}`).set(staff()).send({ status: "resolved", assigned_to: "Ada" });
    expect(patched.body.ticket).toMatchObject({ status: "resolved", assigned_to: "Ada" });
    const detail = await request(app()).get(`/api/ops/tickets/${t.body.ticket_id}`).set(staff());
    expect(detail.body.messages).toHaveLength(2);
    const staffTicket = await request(app()).post("/api/ops/tickets").set(staff()).send({ licensee_id: id, subject: "Follow up", body: "Call Dee on Monday." });
    expect(staffTicket.status).toBe(201);
  });

  it("pulls usage as a fallback and previews invoices", async () => {
    remote.report = { licensee_id: id, period: "2026-10", generated_at: now.toISOString(), seats: 2, minutes: 10, texts: 2, overage: { minutes: 0, texts: 0 } };
    const res = await request(app()).post(`/api/ops/licensees/${id}/sync-usage?period=2026-10`).set(staff());
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(true);
    const pulled = await pullUsageForAll(deps);
    expect(pulled.pulled).toBeGreaterThanOrEqual(1);

    const preview = await request(app()).post(`/api/ops/licensees/${id}/invoices/preview?period=2026-09`).set(staff());
    expect(preview.status).toBe(200);
    // pro, monthly, 2 seats, 1 storage block. The server reported 80 extra minutes, but KS-Ops works overage out from
    // its own plan and seats: 180 minutes is well inside Pro's 3,000 pooled minutes.
    expect(preview.body).toMatchObject({ recurring: 2 * 229 + 10, overage: 0, total: 2 * 229 + 10, currency: "CAD" });
    expect(preview.body.usage_report).toMatchObject({
      final: true, allowance: { minutes: 3000, texts: 3000 }, overage: { minutes: 0, texts: 0 }, reported_overage: { minutes: 80, texts: 0 },
    });
  });

  it("lists, shows detail, adds notes and totals the dashboard", async () => {
    await request(app()).post(`/api/ops/licensees/${id}/notes`).set(staff()).send({ body: "Pilot customer." });
    const detail = await request(app()).get(`/api/ops/licensees/${id}`).set(staff());
    expect(detail.body.notes[0].body).toBe("Pilot customer.");
    expect(detail.body.usage.length).toBeGreaterThanOrEqual(2);
    expect(detail.body.plan_changes.length).toBe(2);
    expect(detail.body.pricing).toMatchObject({ billable_seats: 2, mrr: 468 });
    const list = await request(app()).get("/api/ops/licensees").set(staff());
    const row = list.body.licensees.find((l: any) => l.id === id);
    expect(row).toMatchObject({ company_code: "keystone-demo", plan: "pro", status: "trial", mrr: 468 });
    expect(row.last_report.period).toBe("2026-10");
    const dash = await request(app()).get("/api/ops/dashboard").set(staff());
    expect(dash.body).toMatchObject({ licensees: 2, trials_active: 1, open_requests: 0 });
  });
});

describe("Stripe billing", () => {
  let id = "";

  beforeAll(async () => {
    await seedPrices(pool);
    stripe = fakeStripe();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });
  afterAll(() => {
    stripe = null;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  const hook = (event: object) =>
    request(app()).post("/api/ops/stripe/webhook").set("Stripe-Signature", "valid").set("Content-Type", "application/json").send(JSON.stringify(event));

  it("signs up with a Checkout link", async () => {
    const res = await request(app()).post("/api/public/signup").send({ ...validSignup(), company_code: "acme-loans", plan: "pro", seats: 2, support_level: "email", billing_interval: "monthly" });
    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test/);
    id = res.body.licensee_id;
    const params = (stripe!.checkout.sessions.create as any).mock.calls.at(-1)[0];
    expect(params.line_items).toEqual([
      { price: "price_seat:pro:monthly", quantity: 2 },
      { price: "price_onboarding:pro", quantity: 1 },
    ]);
  });

  it("checkout completed -> provisioning once, with emails", async () => {
    mail.sent.length = 0;
    const event = { id: "evt_c1", type: "checkout.session.completed", data: { object: { id: "cs_x", customer: "cus_acme", subscription: "sub_acme", payment_status: "paid", client_reference_id: id, metadata: { licensee_id: id } } } };
    expect((await hook(event)).body.result).toBe("provisioning");
    expect((await hook(event)).body.duplicate).toBe(true);
    expect((await hook({ ...event, id: "evt_c2" })).body.result).toBe("unchanged");
    expect(mail.sent).toHaveLength(2);
    const row = (await pool.query("SELECT * FROM licensees WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "provisioning", onboarding_fee_paid: true, stripe_customer_id: "cus_acme", stripe_subscription_id: "sub_acme" });
  });

  it("invoice.paid keeps provisioning, then activates; payment_failed makes past due", async () => {
    const inv = (n: string, extra: object = {}) => ({ id: n, customer: "cus_acme", status: "paid", amount_due: 45800, amount_paid: 45800, currency: "cad",
      due_date: Math.floor(now.getTime() / 1000) - 86400, parent: { subscription_details: { subscription: "sub_acme" } }, ...extra });
    await hook({ id: "evt_i1", type: "invoice.paid", data: { object: inv("in_1") } });
    expect((await pool.query("SELECT status FROM licensees WHERE id = $1", [id])).rows[0].status).toBe("provisioning");
    await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "trial" });
    await hook({ id: "evt_i2", type: "invoice.payment_failed", data: { object: inv("in_2", { status: "open", amount_paid: 0 }) } });
    expect((await pool.query("SELECT status FROM licensees WHERE id = $1", [id])).rows[0].status).toBe("past_due");
    mail.sent.length = 0;
    expect(await sendPastDueReminders(deps)).toBe(1);
    expect(await sendPastDueReminders(deps)).toBe(0);
    expect(mail.sent[0].to).toEqual(["nora@northwind.example"]);
    const dash = await request(app()).get("/api/ops/dashboard").set(staff());
    expect(dash.body.overdue_invoices).toBe(1);
    await hook({ id: "evt_i3", type: "invoice.paid", data: { object: inv("in_2") } });
    expect((await pool.query("SELECT status FROM licensees WHERE id = $1", [id])).rows[0].status).toBe("active");
    const invoices = await request(app()).get(`/api/ops/licensees/${id}/invoices`).set(staff());
    expect(invoices.body.invoices).toHaveLength(2);
  });

  it("seat changes update the subscription", async () => {
    (stripe!.subscriptions.retrieve as any).mockResolvedValueOnce({ id: "sub_acme", items: { data: [{ id: "si_1", price: { id: "price_seat:pro:monthly" }, quantity: 2 }] } });
    const res = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ seats: 12, support_level: "priority" });
    expect(res.body.billing_sync).toBe("updated");
    const [, params] = (stripe!.subscriptions.update as any).mock.calls.at(-1);
    expect(params.items).toEqual([
      { id: "si_1", quantity: 12 },
      { price: "price_support:priority:monthly", quantity: 1 },
      { price: "price_support_extra_seat:priority:monthly", quantity: 2 },
    ]);
  });

  it("staff can open a Checkout link only once the old subscription has ended", async () => {
    (stripe!.subscriptions.retrieve as any).mockResolvedValueOnce({ id: "sub_acme", status: "active" });
    const live = await request(app()).post(`/api/ops/licensees/${id}/billing/checkout`).set(staff());
    expect(live.status).toBe(409);
    expect(live.body.error).toBe("subscription_exists");
    (stripe!.subscriptions.retrieve as any).mockResolvedValueOnce({ id: "sub_acme", status: "canceled" });
    const res = await request(app()).post(`/api/ops/licensees/${id}/billing/checkout`).set(staff());
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.test/);
    const params = (stripe!.checkout.sessions.create as any).mock.calls.at(-1)[0];
    expect(params.customer).toBe("cus_acme");
    // Onboarding was paid at sign-up.
    expect(params.line_items.some((i: any) => i.price === "price_onboarding:pro")).toBe(false);
  });

  it("bills overage for finished months once, from KS-Ops's own plan and seats", async () => {
    // acme: pro, 12 seats -> 18,000 pooled minutes and texts. The reported overage (1 and 1) is ignored.
    await pool.query(
      `INSERT INTO usage_reports (licensee_id, period, generated_at, minutes, texts, overage_minutes, overage_texts, report)
       VALUES ($1, '2026-09', '2026-10-01T00:05:00Z', 18100, 18050, 1, 1, '{}'),
              ($1, '2026-10', $2, 10, 10, 5, 0, '{}')`,
      [id, now],
    );
    const first = await billOverage(deps);
    expect(first.billed).toBe(1);
    const items = (stripe!.invoiceItems.create as any).mock.calls.filter((c: any) => c[0].customer === "cus_acme");
    expect(items.map((c: any) => [c[0].amount, c[0].metadata.overage, c[1].idempotencyKey])).toEqual([
      [400, "minutes", `ks-overage-${id}-2026-09-minutes`],
      [150, "texts", `ks-overage-${id}-2026-09-texts`],
    ]);
    const again = await billOverage(deps);
    expect(again.billed).toBe(0);
    const row = (await pool.query("SELECT overage_billed_at, overage_invoice_id FROM usage_reports WHERE licensee_id = $1 AND period = '2026-09'", [id])).rows[0];
    expect(row.overage_invoice_id).toMatch(/^in_/);
    const progress = (await pool.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = '2026-09'", [id])).rows[0];
    expect(progress).toMatchObject({ status: "invoiced", minutes: 100, texts: 50, minutes_amount: 400, texts_amount: 150, invoice_id: row.overage_invoice_id });
    expect(progress.minutes_invoice_item_id).toMatch(/^ii_/);
    expect(progress.details).toMatchObject({ plan: "pro", seats: 12, allowance: { minutes: 18000, texts: 18000 } });
  });

  it("a rerun days later (past Stripe's 24-hour key window) finds what was made instead of charging again", async () => {
    // A crash after the minutes item was created in Stripe, before anything was saved.
    await pool.query(
      `INSERT INTO usage_reports (licensee_id, period, generated_at, minutes, texts, report)
       VALUES ($1, '2026-08', '2026-09-01T00:05:00Z', 18200, 18000, '{}')`,
      [id],
    );
    (stripe!.invoiceItems.list as any).mockResolvedValueOnce({
      data: [{ id: "ii_made_earlier", invoice: null, metadata: { licensee_id: id, period: "2026-08", overage: "minutes" } }],
    });
    const before = (stripe!.invoiceItems.create as any).mock.calls.length;
    expect((await billOverage(deps)).billed).toBe(1);
    expect((stripe!.invoiceItems.create as any).mock.calls.length).toBe(before);
    const progress = (await pool.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = '2026-08'", [id])).rows[0];
    expect(progress).toMatchObject({ status: "invoiced", minutes: 200, texts: 0, minutes_invoice_item_id: "ii_made_earlier" });

    // Items saved but the invoice step failed; the invoice turns out to exist already in Stripe.
    await pool.query(
      `INSERT INTO usage_reports (licensee_id, period, generated_at, minutes, texts, report)
       VALUES ($1, '2026-07', '2026-08-01T00:05:00Z', 18010, 18000, '{}')`,
      [id],
    );
    (stripe!.invoices.create as any).mockRejectedValueOnce(new Error("network"));
    expect((await billOverage(deps)).billed).toBe(0);
    let p7 = (await pool.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = '2026-07'", [id])).rows[0];
    expect(p7).toMatchObject({ status: "items_created", attempts: 1, last_error: "network" });
    const itemCalls = (stripe!.invoiceItems.create as any).mock.calls.length;
    (stripe!.invoices.list as any).mockResolvedValueOnce({ data: [{ id: "in_found", metadata: { licensee_id: id, period: "2026-07", ks_overage: "1" } }] });
    const invoiceCalls = (stripe!.invoices.create as any).mock.calls.length;
    expect((await billOverage(deps)).billed).toBe(1);
    expect((stripe!.invoiceItems.create as any).mock.calls.length).toBe(itemCalls);
    expect((stripe!.invoices.create as any).mock.calls.length).toBe(invoiceCalls);
    p7 = (await pool.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = '2026-07'", [id])).rows[0];
    expect(p7).toMatchObject({ status: "invoiced", invoice_id: "in_found" });
  });

  it("daily jobs run once a day", async () => {
    expect(await claimDailyJob(deps, "test_job")).toBe(true);
    expect(await claimDailyJob(deps, "test_job")).toBe(false);
  });
});

describe("status pushes, cancellation and data purge", () => {
  let id = "";
  let opsKey = "";

  it("suspending and cancelling are pushed to the licensee's server", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Purge Test", legal_name: "Purge Test Inc.", company_code: "purge-test", contact_name: "Pat",
      contact_email: "pat@purge.example", contact_phone: "403-555-0100", plan: "growth", seats: 1,
      server_url: "https://ks-purge.azurewebsites.net", status: "active",
    });
    id = res.body.licensee.id;
    opsKey = res.body.ops_key;
    const suspended = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "suspended" });
    expect(suspended.body.plan_push).toEqual({ ok: true });
    expect(remote.puts.at(-1)).toMatchObject({ url: "https://ks-purge.azurewebsites.net/api/plan", body: { plan: "growth", extra_storage_blocks: 0, status: "suspended" } });
    const cancelled = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "cancelled" });
    expect(remote.puts.at(-1)!.body.status).toBe("cancelled");
    // Purge date: cancelled_at (set by the database) + 180 days.
    const l = cancelled.body.licensee;
    expect(l.cancelled_at).toBeTruthy();
    const expected = new Date(new Date(l.cancelled_at).getTime() + 180 * 86_400_000).toISOString().slice(0, 10);
    expect(l.data_purge_on).toBe(expected);
    const list = await request(app()).get("/api/ops/licensees").set(staff());
    expect(list.body.licensees.find((x: any) => x.id === id)).toMatchObject({ status: "cancelled", data_purge_on: expected, purged_at: null });
    const dash = await request(app()).get("/api/ops/dashboard").set(staff());
    expect(dash.body.data_purges.find((p: any) => p.id === id)).toMatchObject({ company_code: "purge-test", data_purge_on: expected, due: false });
  });

  it("cannot be marked purged before the purge date", async () => {
    const early = await request(app()).post(`/api/ops/licensees/${id}/purged`).set(staff());
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("not_due");
    const fromServer = await request(app()).post(`/api/licensees/${id}/purged`).set("X-KS-Ops-Key", opsKey);
    expect(fromServer.status).toBe(409);
  });

  it("the server reports the purge after the date; status stays cancelled and it cannot be reopened", async () => {
    await pool.query("UPDATE licensees SET cancelled_at = $2 WHERE id = $1", [id, new Date(now.getTime() - 181 * 86_400_000)]);
    const dash = await request(app()).get("/api/ops/dashboard").set(staff());
    expect(dash.body.data_purges_due).toBeGreaterThanOrEqual(1);
    const res = await request(app()).post(`/api/licensees/${id}/purged`).set("X-KS-Ops-Key", opsKey);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("purged");
    const row = (await pool.query("SELECT status, purged_at FROM licensees WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("cancelled");
    expect(row.purged_at).not.toBeNull();
    expect((await request(app()).post(`/api/ops/licensees/${id}/purged`).set(staff())).body.result).toBe("already_purged");
    const reopen = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ status: "active" });
    expect(reopen.status).toBe(409);
    const after = await request(app()).get("/api/ops/dashboard").set(staff());
    expect(after.body.data_purges.some((p: any) => p.id === id)).toBe(false);
  });

  it("staff can mark the purge by hand after the date", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Manual Purge", legal_name: "Manual Purge Inc.", company_code: "manual-purge", contact_name: "Max",
      contact_email: "max@purge.example", contact_phone: "403-555-0101", plan: "starter", seats: 1, status: "cancelled",
    });
    const mid = res.body.licensee.id;
    expect(res.body.licensee.cancelled_at).toBeTruthy();
    await pool.query("UPDATE licensees SET cancelled_at = now() - interval '200 days' WHERE id = $1", [mid]);
    const done = await request(app()).post(`/api/ops/licensees/${mid}/purged`).set(staff());
    expect(done.status).toBe(200);
    expect(done.body.licensee.purged_at).toBeTruthy();
    const active = (await request(app()).get("/api/ops/licensees").set(staff())).body.licensees.find((x: any) => x.company_code === "keystone-demo");
    expect((await request(app()).post(`/api/ops/licensees/${active.id}/purged`).set(staff())).body.error).toBe("not_cancelled");
  });

  it("restoring a cancelled licensee clears cancelled_at", async () => {
    await pool.query("UPDATE licensees SET status = 'cancelled' WHERE company_code = 'keystone-demo'");
    expect((await pool.query("SELECT cancelled_at FROM licensees WHERE company_code = 'keystone-demo'")).rows[0].cancelled_at).not.toBeNull();
    await pool.query("UPDATE licensees SET status = 'active' WHERE company_code = 'keystone-demo'");
    expect((await pool.query("SELECT cancelled_at FROM licensees WHERE company_code = 'keystone-demo'")).rows[0].cancelled_at).toBeNull();
  });
});

describe("expiring unpaid website sign-ups", () => {
  it("cancels them after PENDING_SIGNUP_DAYS and frees the company code; staff-created ones stay", async () => {
    const res = await request(app()).post("/api/public/signup").send({ ...validSignup(), company_code: "slow-payer" });
    const id = res.body.licensee_id;
    const staffMade = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Staff Pending", legal_name: "Staff Pending Inc.", company_code: "staff-pending", contact_name: "Sam",
      contact_email: "sam@pending.example", contact_phone: "403-555-0102", plan: "starter", seats: 1,
    });
    expect(staffMade.body.licensee.status).toBe("pending_payment");
    expect(await expirePendingSignups(deps)).toBe(0);
    await pool.query("UPDATE licensees SET created_at = $2 WHERE id = ANY($1::uuid[])", [[id, staffMade.body.licensee.id], new Date(now.getTime() - 8 * 86_400_000)]);
    expect(await expirePendingSignups(deps)).toBe(1);
    const row = (await pool.query("SELECT status, company_code, released_company_code, cancelled_at FROM licensees WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "cancelled", company_code: expiredCode(id), released_company_code: "slow-payer" });
    expect(row.company_code).toHaveLength(32);
    expect(row.cancelled_at).not.toBeNull();
    expect((await pool.query("SELECT status FROM licensees WHERE id = $1", [staffMade.body.licensee.id])).rows[0].status).toBe("pending_payment");
    // The code can be taken again, and the old sign-up can no longer resume payment.
    expect((await request(app()).get("/api/public/company-code-available?code=slow-payer")).body.available).toBe(true);
    const resume = await request(app()).post(`/api/public/signup/${id}/checkout?token=${res.body.signup_token}`);
    expect(resume.status).toBe(409);
    expect((await request(app()).post("/api/public/signup").send({ ...validSignup(), company_code: "slow-payer" })).status).toBe(201);
    expect(await expirePendingSignups(deps)).toBe(0);
  });
});

// KS_OPS_BANK_CONNECT_ADDON - bank connect is a hidden add-on Keystone staff switch on for one licensee.
describe("bank_connect add-on", () => {
  let id = "";

  it("is off by default, never public, and staff switch it on and off with a push", async () => {
    const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
      company_name: "Addon Test", legal_name: "Addon Test Inc.", company_code: "addon-test", contact_name: "Al",
      contact_email: "al@addon.example", contact_phone: "403-555-0177", plan: "starter", seats: 1,
      server_url: "https://ks-addon.azurewebsites.net", status: "active",
    });
    expect(res.status).toBe(201);
    id = res.body.licensee.id;
    expect(res.body.licensee.addons).toEqual({});

    const plans = await request(app()).get("/api/public/plans");
    expect(JSON.stringify(plans.body)).not.toMatch(/bank_connect|fraud_3|Flinks|Bank connect/i);

    const on = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ addons: { bank_connect: true } });
    expect(on.status).toBe(200);
    expect(on.body.plan_push).toEqual({ ok: true });
    expect(on.body.licensee.addons).toEqual({ bank_connect: true });
    expect(remote.puts.at(-1)).toMatchObject({ url: "https://ks-addon.azurewebsites.net/api/plan", body: { plan: "starter", addons: { bank_connect: true } } });
    const audit = (await pool.query("SELECT details FROM staff_audit WHERE licensee_id = $1 AND action = 'licensee.addons'", [id])).rows;
    expect(audit.map((r) => r.details)).toEqual([{ bank_connect: { from: false, to: true } }]);

    const same = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ addons: { bank_connect: true } });
    expect(same.body.plan_push).toBeNull();

    const bad = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ addons: { bank_connect: "yes" } });
    expect(bad.status).toBe(400);
    const unknown = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ addons: { sso: true } });
    expect(unknown.status).toBe(400);

    const off = await request(app()).patch(`/api/ops/licensees/${id}`).set(staff()).send({ addons: { bank_connect: false } });
    expect(off.body.plan_push).toEqual({ ok: true });
    expect(remote.puts.at(-1)!.body.addons).toEqual({ bank_connect: false });
    expect((await pool.query("SELECT addons FROM licensees WHERE id = $1", [id])).rows[0].addons).toEqual({ bank_connect: false });
  });
});
