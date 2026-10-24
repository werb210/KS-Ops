import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { encryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { fakeDb, fakeMailer, fakeStripe, licenseeRow, makeDeps, staffToken } from "../helpers.js";

const L = licenseeRow({ status: "pending_payment", stripe_customer_id: null });
type Row = Omit<ReturnType<typeof licenseeRow>, "stripe_subscription_id" | "stripe_checkout_session_id" | "stripe_customer_id"> & {
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  [k: string]: unknown;
};

/** A fake database holding one licensee row that the webhook's conditional updates really change. */
function webhookDb(opts: { seen?: boolean; row?: Record<string, unknown> } = {}) {
  const row: Row = { ...L, ...(opts.row ?? {}) } as Row;
  const set = (patch: Partial<Row>) => [Object.assign(row, patch) && { id: row.id }];
  const db = fakeDb([
    [/SELECT 1 FROM stripe_events/, () => (opts.seen ? [{ "?column?": 1 }] : [])],
    [/SELECT \* FROM licensees WHERE \(\$1::uuid/, () => [{ ...row }]],
    [/SELECT stripe_subscription_id FROM licensees/, () => [{ stripe_subscription_id: row.stripe_subscription_id }]],
    [/SET stripe_subscription_id = \$2.*stripe_subscription_id IS NULL RETURNING/, (p) =>
      row.stripe_subscription_id === null ? set({ stripe_subscription_id: p[1] as any }) : []],
    [/SET stripe_subscription_id = \$2.*stripe_subscription_id = \$3 RETURNING/, (p) =>
      row.stripe_subscription_id === p[2] ? set({ stripe_subscription_id: p[1] as any }) : []],
    [/SET status = 'provisioning'.*status = 'pending_payment' RETURNING/, () => (row.status === "pending_payment" ? set({ status: "provisioning" }) : [])],
    [/SET status = 'active'.*status = 'past_due'/, () => (row.status === "past_due" ? set({ status: "active" }) : [])],
    [/SET status = 'past_due'.*status IN \('active','trial'\)/, () => (["active", "trial"].includes(row.status) ? set({ status: "past_due" }) : [])],
    [/SET status = 'cancelled'/, () => (row.status !== "cancelled" ? set({ status: "cancelled" }) : [])],
    [/INSERT INTO plan_changes/, () => (row.server_url ? [{ id: "pc1" }] : [])],
  ]);
  return Object.assign(db, { row });
}

const send = (app: ReturnType<typeof createApp>, event: unknown, sig = "valid") =>
  request(app).post("/api/ops/stripe/webhook").set("Stripe-Signature", sig).set("Content-Type", "application/json").send(JSON.stringify(event));

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "paid", client_reference_id: L.id,
  metadata: { licensee_id: L.id }, ...over,
});
const evt = (type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2)}`) => ({ id, type, data: { object } });
const completed = evt("checkout.session.completed", session(), "evt_1");

function setup(opts: Parameters<typeof webhookDb>[0] = {}, stripeOver: Record<string, any> = {}) {
  const stripe = fakeStripe(stripeOver);
  const db = webhookDb(opts);
  const { mailer, sent } = fakeMailer();
  const app = createApp(makeDeps({ db, stripe: () => stripe, mailer }));
  return { stripe, db, sent, app };
}

const queuedPush = (db: ReturnType<typeof webhookDb>, to: string) =>
  db.calls.some((c) => /INSERT INTO plan_changes/.test(c.sql) && c.params[2] === to) &&
  db.calls.some((c) => /plan_sync_status = 'pending_sync'/.test(c.sql));

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});
afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("Stripe webhook", () => {
  it("answers 503 when billing is not configured", async () => {
    expect((await send(createApp(makeDeps()), completed)).status).toBe(503);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = fakeStripe();
    expect((await send(createApp(makeDeps({ stripe: () => stripe })), completed)).status).toBe(503);
  });

  it("rejects a bad signature", async () => {
    const { db, stripe, app } = setup();
    const res = await send(app, completed, "forged");
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
    // The raw body reached constructEvent untouched.
    expect(Buffer.isBuffer((stripe.webhooks.constructEvent as any).mock.calls[0][0])).toBe(true);
  });

  it("checkout.session.completed (paid): provisioning, onboarding paid, emails to sales and the contact", async () => {
    const { db, sent, app } = setup();
    const res = await send(app, completed);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, result: "provisioning" });
    const ids = db.calls.find((c) => /stripe_customer_id = COALESCE\(stripe_customer_id/.test(c.sql))!;
    expect(ids.params).toEqual([L.id, "cus_1", "cs_1", true]);
    expect(db.row).toMatchObject({ status: "provisioning", stripe_subscription_id: "sub_1" });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["nora@northwind.example", "sales@example.test"]);
    expect(db.calls.some((c) => /INSERT INTO stripe_events/.test(c.sql))).toBe(true);
  });

  it("no_payment_required counts as paid", async () => {
    const { db, app } = setup();
    expect((await send(app, evt("checkout.session.completed", session({ payment_status: "no_payment_required" })))).body.result).toBe("provisioning");
    expect(db.row.status).toBe("provisioning");
  });

  it("a delayed payment waits for async_payment_succeeded before provisioning and emailing", async () => {
    const { db, sent, app } = setup();
    const first = await send(app, evt("checkout.session.completed", session({ payment_status: "unpaid" })));
    expect(first.body.result).toBe("awaiting_payment");
    expect(db.row.status).toBe("pending_payment");
    expect(db.calls.find((c) => /onboarding_fee_paid = onboarding_fee_paid OR/.test(c.sql))!.params[3]).toBe(false);
    expect(sent).toHaveLength(0);
    const later = await send(app, evt("checkout.session.async_payment_succeeded", session({ payment_status: "paid" })));
    expect(later.body.result).toBe("provisioning");
    expect(db.row.status).toBe("provisioning");
    expect(sent).toHaveLength(2);
  });

  it("async_payment_failed keeps pending_payment and emails the contact a resume link with their token", async () => {
    const { db, sent, app } = setup({ row: { stripe_checkout_session_id: "cs_1", signup_token_encrypted: encryptSecret("tok-held", encryptionKey()!) } });
    const res = await send(app, evt("checkout.session.async_payment_failed", session({ payment_status: "unpaid" })));
    expect(res.body.result).toBe("resume_link_sent");
    expect(db.row.status).toBe("pending_payment");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["nora@northwind.example"]);
    expect(sent[0].text).toContain(`https://keystone.example.test/signup/cancelled?l=${L.id}&t=tok-held`);
    // The token the person's browser holds stays valid.
    expect(db.calls.some((c) => /signup_token_hash = \$2/.test(c.sql))).toBe(false);
  });

  it("checkout.session.expired emails a new resume link when no token copy is stored", async () => {
    const { db, sent, app } = setup({ row: { stripe_checkout_session_id: "cs_1" } });
    const res = await send(app, evt("checkout.session.expired", session({ payment_status: "unpaid", subscription: null })));
    expect(res.body.result).toBe("resume_link_sent");
    const tokenWrite = db.calls.find((c) => /signup_token_hash = \$2/.test(c.sql))!;
    expect(tokenWrite).toBeDefined();
    expect(sent[0].text).toMatch(/signup\/cancelled\?l=[0-9a-f-]+&t=[A-Za-z0-9_-]{20,}/);
  });

  it("an expired session is ignored when a newer checkout is open or the licensee has moved on", async () => {
    const stale = setup({ row: { stripe_checkout_session_id: "cs_newer" } });
    expect((await send(stale.app, evt("checkout.session.expired", session()))).body.result).toBe("stale_session");
    expect(stale.sent).toHaveLength(0);
    const paid = setup({ row: { status: "provisioning", stripe_checkout_session_id: "cs_1" } });
    expect((await send(paid.app, evt("checkout.session.expired", session()))).body.result).toBe("unchanged");
    expect(paid.sent).toHaveLength(0);
  });

  it("does not email again when the licensee had already moved on", async () => {
    const { sent, app } = setup({ row: { status: "trial", stripe_subscription_id: "sub_1" } });
    const res = await send(app, completed);
    expect(res.body.result).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("never replaces a live subscription on file: logs, audits and tells sales", async () => {
    const { db, sent, app, stripe } = setup(
      { row: { status: "active", stripe_subscription_id: "sub_old", stripe_customer_id: "cus_1" } },
      { subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, status: "active" })), update: vi.fn() } },
    );
    await send(app, evt("checkout.session.completed", session({ subscription: "sub_new" })));
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_old");
    expect(db.row.stripe_subscription_id).toBe("sub_old");
    expect(db.calls.some((c) => /INSERT INTO staff_audit/.test(c.sql) && c.params[1] === "stripe.subscription_ignored")).toBe(true);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining("second subscription")]);
    // subscription.created for the new one is ignored too.
    const r = await send(app, evt("customer.subscription.created", { id: "sub_new", customer: "cus_1", status: "active", metadata: { licensee_id: L.id } }));
    expect(r.body.result).toBe("other_subscription");
    expect(db.row.stripe_subscription_id).toBe("sub_old");
  });

  it("keeps the subscription on file when Stripe cannot say whether it is live", async () => {
    const { db, app } = setup(
      { row: { stripe_subscription_id: "sub_old" } },
      { subscriptions: { retrieve: vi.fn(async () => { throw new Error("stripe down"); }), update: vi.fn() } },
    );
    await send(app, evt("checkout.session.completed", session({ subscription: "sub_new" })));
    expect(db.row.stripe_subscription_id).toBe("sub_old");
  });

  it("replaces a subscription that has ended", async () => {
    const { db, app } = setup(
      { row: { status: "pending_payment", stripe_subscription_id: "sub_old" } },
      { subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, status: "canceled" })), update: vi.fn() } },
    );
    expect((await send(app, evt("checkout.session.completed", session({ subscription: "sub_new" })))).body.result).toBe("provisioning");
    expect(db.row.stripe_subscription_id).toBe("sub_new");
    expect(db.calls.some((c) => /INSERT INTO staff_audit/.test(c.sql) && c.params[1] === "stripe.subscription_replaced")).toBe(true);
  });

  it("skips an event it has already handled", async () => {
    const { db, app } = setup({ seen: true });
    const res = await send(app, completed);
    expect(res.body).toMatchObject({ duplicate: true });
    expect(db.calls.some((c) => /UPDATE licensees/.test(c.sql))).toBe(false);
  });

  const inv = (sub: string | null, extra: object = {}) => ({
    id: "in_1", customer: "cus_1", status: "paid", amount_due: 5000, amount_paid: 5000, currency: "cad",
    ...(sub ? { parent: { subscription_details: { subscription: sub, metadata: { licensee_id: L.id } } } } : { metadata: { licensee_id: L.id } }),
    status_transitions: { paid_at: 1760000000 }, ...extra,
  });

  it("invoice.paid brings a past_due licensee back to active for its own subscription and pushes the status", async () => {
    const { db, app } = setup({ row: { status: "past_due", stripe_subscription_id: "sub_1" } });
    const res = await send(app, evt("invoice.paid", inv("sub_1")));
    expect(res.body.result).toBe("paid_reactivated");
    expect(db.calls.find((c) => /INSERT INTO invoices/.test(c.sql))!.params.slice(0, 3)).toEqual([L.id, "in_1", "cus_1"]);
    expect(db.row.status).toBe("active");
    expect(queuedPush(db, "active")).toBe(true);
  });

  it("invoice.paid leaves every other case alone", async () => {
    // Another subscription's invoice, or a one-off (overage) invoice.
    for (const sub of ["sub_other", null]) {
      const { db, app } = setup({ row: { status: "past_due", stripe_subscription_id: "sub_1" } });
      await send(app, evt("invoice.paid", inv(sub)));
      expect(db.row.status).toBe("past_due");
    }
    for (const status of ["suspended", "cancelled", "provisioning", "pending_payment", "trial", "active"]) {
      const { db, app } = setup({ row: { status, stripe_subscription_id: "sub_1" } });
      await send(app, evt("invoice.paid", inv("sub_1")));
      expect(db.row.status).toBe(status);
      expect(db.calls.some((c) => /INSERT INTO plan_changes/.test(c.sql))).toBe(false);
    }
  });

  it("invoice.payment_failed makes an active licensee past due and pushes the status", async () => {
    const { db, app } = setup({ row: { status: "active", stripe_subscription_id: "sub_1" } });
    await send(app, evt("invoice.payment_failed", { id: "in_2", customer: "cus_1" }));
    expect(db.row.status).toBe("past_due");
    expect(queuedPush(db, "past_due")).toBe(true);
  });

  it("subscription deleted cancels the licensee and pushes the status", async () => {
    const { db, app } = setup({ row: { status: "active", stripe_subscription_id: "sub_1" } });
    const res = await send(app, evt("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { licensee_id: L.id } }));
    expect(res.body.result).toBe("cancelled");
    expect(db.row.status).toBe("cancelled");
    expect(queuedPush(db, "cancelled")).toBe(true);
  });

  it("an old subscription ending does not cancel a licensee that moved to a new one", async () => {
    const { db, app } = setup({ row: { status: "active", stripe_subscription_id: "sub_new" } });
    const res = await send(app, evt("customer.subscription.deleted", { id: "sub_old", customer: "cus_1", status: "canceled", metadata: { licensee_id: L.id } }));
    expect(res.body.result).toBe("other_subscription");
    expect(db.row.status).toBe("active");
  });
});

describe("billing endpoints without Stripe", () => {
  it("answer 503 billing_not_configured", async () => {
    const res = await request(createApp(makeDeps()))
      .post(`/api/ops/licensees/${L.id}/billing/checkout`)
      .set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("billing_not_configured");
  });
});

describe("POST /api/ops/licensees/:id/billing/checkout with a subscription on file", () => {
  const row = licenseeRow({ stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", onboarding_fee_paid: true });
  const db = () =>
    fakeDb([
      [/SELECT \* FROM licensees WHERE id/, () => [row]],
      [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
      [/INSERT INTO licensees|UPDATE licensees/, () => []],
    ]);
  const call = (retrieve: (id: string) => Promise<any>) => {
    const stripe = fakeStripe({ subscriptions: { retrieve: vi.fn(retrieve), update: vi.fn() } });
    const app = createApp(makeDeps({ db: db(), stripe: () => stripe }));
    return { stripe, res: request(app).post(`/api/ops/licensees/${row.id}/billing/checkout`).set("Authorization", `Bearer ${staffToken()}`) };
  };

  it("answers 409 while that subscription is live", async () => {
    for (const status of ["active", "past_due", "trialing", "incomplete", "unpaid"]) {
      const { stripe, res } = call(async (id) => ({ id, status }));
      const r = await res;
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "subscription_exists", subscription_id: "sub_1", subscription_status: status });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    }
  });

  it("opens Checkout once the subscription has ended or no longer exists", async () => {
    for (const retrieve of [
      async (id: string) => ({ id, status: "canceled" }),
      async (id: string) => ({ id, status: "incomplete_expired" }),
      async () => { throw Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 }); },
    ]) {
      const { stripe, res } = call(retrieve);
      const r = await res;
      expect(r.status).toBe(200);
      expect(r.body.url).toMatch(/^https:\/\/checkout\.stripe\.test/);
      expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    }
  });

  it("other Stripe errors are not treated as 'ended'", async () => {
    const { stripe, res } = call(async () => { throw new Error("api down"); });
    expect((await res).status).toBe(500);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("customer default payment method", () => {
  const withCustomers = (pm: string | null, update = vi.fn(async (id: string) => ({ id }))) => ({
    subscriptions: {
      retrieve: vi.fn(async (id: string) => ({ id, status: "active", customer: "cus_1", default_payment_method: pm, items: { data: [] } })),
      update: vi.fn(async (id: string) => ({ id })),
    },
    customers: { update },
  });
  const pmSet = (db: ReturnType<typeof webhookDb>) =>
    db.calls.filter((c) => /SET stripe_default_payment_method/.test(c.sql)).map((c) => c.params[1]);

  it("after Checkout, makes the subscription's bank debit the customer's invoice default", async () => {
    const { stripe, db, app } = setup({}, withCustomers("pm_acss_1"));
    expect((await send(app, completed)).status).toBe(200);
    expect((stripe as any).customers.update).toHaveBeenCalledWith(
      "cus_1",
      { invoice_settings: { default_payment_method: "pm_acss_1" } },
      { idempotencyKey: "ks-default-pm-cus_1-pm_acss_1" },
    );
    expect(pmSet(db)).toEqual(["pm_acss_1"]);
  });

  it("also while a bank debit Checkout is still settling", async () => {
    const { stripe, app } = setup({}, withCustomers("pm_acss_2"));
    await send(app, evt("checkout.session.completed", session({ payment_status: "unpaid" })));
    expect((stripe as any).customers.update).toHaveBeenCalledTimes(1);
  });

  it("follows the subscription's default payment method when it changes, and skips one already set", async () => {
    const { stripe, db, app } = setup({ row: { stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1", stripe_default_payment_method: "pm_old" } }, withCustomers(null));
    const sub = (pm: string | null) => ({ id: "sub_1", customer: "cus_1", status: "active", default_payment_method: pm, metadata: { licensee_id: L.id } });
    await send(app, evt("customer.subscription.updated", sub("pm_old")));
    expect((stripe as any).customers.update).not.toHaveBeenCalled();
    await send(app, evt("customer.subscription.updated", sub("pm_card_9")));
    expect((stripe as any).customers.update).toHaveBeenCalledWith("cus_1", { invoice_settings: { default_payment_method: "pm_card_9" } }, expect.anything());
    expect(pmSet(db)).toEqual(["pm_card_9"]);
    // No payment method on the subscription: nothing to copy.
    await send(app, evt("customer.subscription.updated", sub(null)));
    expect((stripe as any).customers.update).toHaveBeenCalledTimes(1);
  });

  it("not for another subscription that KS-Ops did not adopt, nor for an ended one", async () => {
    const { stripe, app } = setup({ row: { stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1" } }, withCustomers("pm_x"));
    await send(app, evt("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", status: "canceled", default_payment_method: "pm_x", metadata: { licensee_id: L.id } }));
    await send(app, evt("customer.subscription.updated", { id: "sub_other", customer: "cus_1", status: "active", default_payment_method: "pm_x", metadata: { licensee_id: L.id } }));
    expect((stripe as any).customers.update).not.toHaveBeenCalled();
  });

  it("a Stripe failure is logged and audited, and the webhook still succeeds", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, app } = setup({}, withCustomers("pm_acss_1", vi.fn(async () => { throw new Error("stripe down"); })));
    expect((await send(app, completed)).status).toBe(200);
    expect(err.mock.calls.some((c) => /could not make the subscription's payment method the default.*stripe down/.test(String(c[0])))).toBe(true);
    expect(db.calls.some((c) => /INSERT INTO staff_audit/.test(c.sql) && c.params[1] === "stripe.default_payment_method_failed")).toBe(true);
    expect(pmSet(db)).toEqual([]);
    err.mockRestore();
  });
});
