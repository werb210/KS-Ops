import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { fakeDb, fakeMailer, fakeStripe, licenseeRow, makeDeps, staffToken } from "../helpers.js";

const L = licenseeRow({ status: "pending_payment", stripe_customer_id: null });

function webhookDb(opts: { seen?: boolean; moved?: boolean } = {}) {
  return fakeDb([
    [/SELECT 1 FROM stripe_events/, () => (opts.seen ? [{ "?column?": 1 }] : [])],
    [/SELECT \* FROM licensees WHERE \(\$1::uuid/, () => [L]],
    [/SET status = 'provisioning'.*status = 'pending_payment' RETURNING/, () => (opts.moved === false ? [] : [{ id: L.id }])],
  ]);
}

const send = (app: ReturnType<typeof createApp>, event: unknown, sig = "valid") =>
  request(app).post("/api/ops/stripe/webhook").set("Stripe-Signature", sig).set("Content-Type", "application/json").send(JSON.stringify(event));

const completed = {
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "paid", client_reference_id: L.id, metadata: { licensee_id: L.id } } },
};

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
    const stripe = fakeStripe();
    const db = webhookDb();
    const res = await send(createApp(makeDeps({ db, stripe: () => stripe })), completed, "forged");
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
    // The raw body reached constructEvent untouched.
    expect(Buffer.isBuffer((stripe.webhooks.constructEvent as any).mock.calls[0][0])).toBe(true);
  });

  it("checkout.session.completed: provisioning, onboarding paid, emails to sales and the contact", async () => {
    const stripe = fakeStripe();
    const db = webhookDb();
    const { mailer, sent } = fakeMailer();
    const res = await send(createApp(makeDeps({ db, stripe: () => stripe, mailer })), completed);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, result: "provisioning" });
    const ids = db.calls.find((c) => /stripe_customer_id = COALESCE/.test(c.sql))!;
    expect(ids.params).toEqual([L.id, "cus_1", "sub_1", "cs_1", true]);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["nora@northwind.example", "sales@example.test"]);
    expect(db.calls.some((c) => /INSERT INTO stripe_events/.test(c.sql))).toBe(true);
  });

  it("does not email again when the licensee had already moved on", async () => {
    const stripe = fakeStripe();
    const { mailer, sent } = fakeMailer();
    const res = await send(createApp(makeDeps({ db: webhookDb({ moved: false }), stripe: () => stripe, mailer })), completed);
    expect(res.body.result).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("skips an event it has already handled", async () => {
    const stripe = fakeStripe();
    const db = webhookDb({ seen: true });
    const res = await send(createApp(makeDeps({ db, stripe: () => stripe })), completed);
    expect(res.body).toMatchObject({ duplicate: true });
    expect(db.calls.some((c) => /UPDATE licensees/.test(c.sql))).toBe(false);
  });

  it("invoice.paid makes the licensee active unless it is still being set up", async () => {
    const stripe = fakeStripe();
    const db = webhookDb();
    const inv = { id: "in_1", customer: "cus_1", status: "paid", amount_due: 5000, amount_paid: 5000, currency: "cad",
      parent: { subscription_details: { subscription: "sub_1", metadata: { licensee_id: L.id } } }, status_transitions: { paid_at: 1760000000 } };
    await send(createApp(makeDeps({ db, stripe: () => stripe })), { id: "evt_2", type: "invoice.paid", data: { object: inv } });
    expect(db.calls.find((c) => /INSERT INTO invoices/.test(c.sql))!.params.slice(0, 3)).toEqual([L.id, "in_1", "cus_1"]);
    const upd = db.calls.find((c) => /SET status = 'active'/.test(c.sql))!;
    expect(upd.sql).toMatch(/status NOT IN \('provisioning','pending_payment','cancelled'\)/);
  });

  it("invoice.payment_failed makes the licensee past due", async () => {
    const stripe = fakeStripe();
    const db = webhookDb();
    await send(createApp(makeDeps({ db, stripe: () => stripe })), { id: "evt_3", type: "invoice.payment_failed", data: { object: { id: "in_2", customer: "cus_1" } } });
    expect(db.calls.find((c) => /SET status = 'past_due'/.test(c.sql))).toBeDefined();
  });

  it("subscription deleted cancels the licensee", async () => {
    const stripe = fakeStripe();
    const db = webhookDb();
    const res = await send(createApp(makeDeps({ db, stripe: () => stripe })), {
      id: "evt_4", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { licensee_id: L.id } } },
    });
    expect(res.body.result).toBe("cancelled");
    expect(db.calls.find((c) => /SET status = 'cancelled'/.test(c.sql))).toBeDefined();
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
