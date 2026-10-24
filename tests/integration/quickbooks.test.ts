// Keystone's own QuickBooks: OAuth connect/callback/disconnect, token rotation, and posting Stripe invoices,
// payments, fees and refunds through the outbox. Real Postgres; Stripe and Intuit are fakes (no network).
import type pg from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { decryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { insertLicensee } from "../../src/licensees/repo.js";
import { accessToken } from "../../src/qbo/client.js";
import { qboConfig } from "../../src/qbo/config.js";
import { flushQboOutbox } from "../../src/qbo/outbox.js";
import { fakeMailer, fakeStripe, staffToken } from "../helpers.js";
import { fakeIntuit } from "../qboFake.js";
import { freshPool, seedPrices } from "./db.js";

const QBO_KEY = "b".repeat(64);
const ENV = {
  KS_QBO_CLIENT_ID: "qbo-client-id",
  KS_QBO_CLIENT_SECRET: "qbo-client-secret",
  KS_QBO_TOKEN_ENCRYPTION_KEY: QBO_KEY,
  WEBSITE_HOSTNAME: "ks-ops-test.azurewebsites.net",
};

let pool: pg.Pool;
let intuit: ReturnType<typeof fakeIntuit>;
let stripe: ReturnType<typeof fakeStripe>;
let deps: Deps;
let licenseeId: string;
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const app = () => createApp(deps);
const evt = (type: string, object: unknown) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } });
const sendEvent = (e: unknown) =>
  request(app()).post("/api/ops/stripe/webhook").set("Stripe-Signature", "valid").set("Content-Type", "application/json").send(JSON.stringify(e));

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_1001",
  object: "invoice",
  number: "KS-0001",
  customer: "cus_qbo",
  status: "open",
  currency: "cad",
  created: 1_790_000_000,
  status_transitions: { finalized_at: 1_790_000_000, paid_at: null },
  parent: { subscription_details: { subscription: "sub_qbo", metadata: { licensee_id: licenseeId } } },
  lines: {
    has_more: false,
    data: [
      { id: "il_1", amount: 14700, quantity: 3, description: "3 x Growth seat", pricing: { price_details: { price: "price_seat:growth:monthly" } } },
      { id: "il_2", amount: 9900, quantity: 1, description: "Priority support", pricing: { price_details: { price: "price_support:priority:monthly" } } },
      { id: "il_3", amount: 2000, quantity: 2, description: "2 x Extra storage", pricing: { price_details: { price: "price_storage_block:monthly" } } },
    ],
  },
  total_discount_amounts: [{ amount: 1000, discount: "di_1" }],
  total_taxes: [{ amount: 1280, tax_behavior: "exclusive" }],
  total: 26880,
  amount_due: 26880,
  amount_paid: 0,
  ...over,
});
const paidInvoice = () =>
  invoice({ status: "paid", amount_paid: 26880, status_transitions: { finalized_at: 1_790_000_000, paid_at: 1_790_100_000 } });

beforeAll(async () => {
  pool = await freshPool();
  await seedPrices(pool);
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE qbo_outbox, qbo_links, qbo_connection, qbo_settings, qbo_oauth_states, stripe_events, licensees CASCADE");
  Object.assign(process.env, ENV, { STRIPE_WEBHOOK_SECRET: "whsec_test" });
  intuit = fakeIntuit();
  stripe = fakeStripe({
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => ({ id, latest_charge: { id: "ch_qbo", balance_transaction: { id: "txn_1", fee: 812, created: 1_790_100_000 } } })),
    },
    invoicePayments: { list: vi.fn(async () => ({ data: [{ status: "paid", invoice: "in_1001", payment: { type: "payment_intent", payment_intent: "pi_qbo" } }] })) },
    refunds: { list: vi.fn(async () => ({ data: [{ id: "re_1", amount: 5000, status: "succeeded", payment_intent: "pi_qbo", created: 1_790_200_000, reason: "requested_by_customer" }] })) },
  });
  deps = { db: pool, fetch: intuit.fetch as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => stripe, now: () => new Date() };
  const l = await insertLicensee(pool, {
    company_name: "Northwind Capital", legal_name: "Northwind Capital Ltd.", company_code: "northwind-qbo",
    contact_name: "Nora North", contact_email: "nora@northwind.example", contact_phone: "(403) 555-0199", country: "CA",
    province_state: "AB", status: "active", plan: "growth", billing_interval: "monthly", support_level: "priority", seats: 3,
    source: "staff",
  });
  licenseeId = l.id;
  await pool.query("UPDATE licensees SET stripe_customer_id = 'cus_qbo', stripe_subscription_id = 'sub_qbo' WHERE id = $1", [l.id]);
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), "STRIPE_WEBHOOK_SECRET", "KS_QBO_REDIRECT_URI", "KS_QBO_ENVIRONMENT"]) delete process.env[k];
  vi.restoreAllMocks();
});

async function connect(): Promise<void> {
  const c = await request(app()).post("/api/ops/quickbooks/connect").set(staff());
  expect(c.status).toBe(200);
  const state = new URL(c.body.authorize_url).searchParams.get("state")!;
  const cb = await request(app()).get("/api/ops/quickbooks/oauth/callback").query({ code: "good-code", state, realmId: "9130350000000001" });
  expect(cb.status).toBe(200);
}

describe("QuickBooks off (env vars unset)", () => {
  it("queues nothing, answers 503 on connect and says what is missing", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    expect((await sendEvent(evt("invoice.paid", paidInvoice()))).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM qbo_outbox")).rows[0].n).toBe(0);
    const s = await request(app()).get("/api/ops/quickbooks/status").set(staff());
    expect(s.body).toMatchObject({ configured: false, connected: false });
    expect(s.body.missing).toContain("KS_QBO_CLIENT_ID");
    expect((await request(app()).post("/api/ops/quickbooks/connect").set(staff())).status).toBe(503);
    expect(await flushQboOutbox(deps)).toMatchObject({ tried: 0 });
  });
});

describe("QuickBooks connection", () => {
  it("needs a staff token for every route except Intuit's callback", async () => {
    expect((await request(app()).get("/api/ops/quickbooks/status")).status).toBe(401);
    expect((await request(app()).post("/api/ops/quickbooks/connect")).status).toBe(401);
    expect((await request(app()).post("/api/ops/quickbooks/disconnect")).status).toBe(401);
    expect((await request(app()).patch("/api/ops/quickbooks/settings").send({})).status).toBe(401);
    expect((await request(app()).get("/api/ops/quickbooks/oauth/callback").query({ state: "nope", code: "x", realmId: "1" })).status).toBe(400);
    const page = await request(app()).get("/ops/quickbooks");
    expect(page.status).toBe(200);
    expect(page.text).toContain("QuickBooks for Keystone");
  });

  it("connects with a single-use state, stores the tokens encrypted and uses the default redirect address", async () => {
    const c = await request(app()).post("/api/ops/quickbooks/connect").set(staff());
    const url = new URL(c.body.authorize_url);
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("client_id")).toBe("qbo-client-id");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ks-ops-test.azurewebsites.net/api/ops/quickbooks/oauth/callback");
    const state = url.searchParams.get("state")!;
    const stored = await pool.query("SELECT state_hash FROM qbo_oauth_states");
    expect(stored.rows[0].state_hash).not.toBe(state);

    const cb = await request(app()).get("/api/ops/quickbooks/oauth/callback").query({ code: "good-code", state, realmId: "9130350000000001" });
    expect(cb.status).toBe(200);
    expect(cb.text).toContain("QuickBooks is connected");
    expect(cb.text).toContain("Keystone Software Inc.");
    expect(intuit.state.tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code", code: "good-code",
      redirect_uri: "https://ks-ops-test.azurewebsites.net/api/ops/quickbooks/oauth/callback",
    });
    const row = (await pool.query("SELECT * FROM qbo_connection")).rows[0];
    expect(row.realm_id).toBe("9130350000000001");
    expect(row.environment).toBe("sandbox");
    expect(row.refresh_token_encrypted).not.toContain(intuit.state.refreshToken);
    expect(decryptSecret(row.refresh_token_encrypted, encryptionKey(QBO_KEY)!)).toBe(intuit.state.refreshToken);

    // The same state again is refused.
    const again = await request(app()).get("/api/ops/quickbooks/oauth/callback").query({ code: "good-code", state, realmId: "9130350000000001" });
    expect(again.status).toBe(400);

    const s = await request(app()).get("/api/ops/quickbooks/status").set(staff());
    expect(s.body).toMatchObject({ configured: true, connected: true, connection: { company_name: "Keystone Software Inc.", environment_matches: true } });
    expect(JSON.stringify(s.body)).not.toContain(intuit.state.refreshToken);
  });

  it("uses KS_QBO_REDIRECT_URI when set", async () => {
    process.env.KS_QBO_REDIRECT_URI = "https://ops.keystone.example/api/ops/quickbooks/oauth/callback";
    const c = await request(app()).post("/api/ops/quickbooks/connect").set(staff());
    expect(new URL(c.body.authorize_url).searchParams.get("redirect_uri")).toBe(process.env.KS_QBO_REDIRECT_URI);
  });

  it("refreshes an expiring access token and stores the rotated refresh token", async () => {
    await connect();
    await pool.query("UPDATE qbo_connection SET access_expires_at = now() - interval '1 minute'");
    const before = (await pool.query("SELECT version FROM qbo_connection")).rows[0].version;
    const t = await accessToken(deps, qboConfig()!);
    expect(t.token).toBe(intuit.state.accessToken);
    expect(intuit.state.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-0-authorization_code" });
    const row = (await pool.query("SELECT * FROM qbo_connection")).rows[0];
    expect(decryptSecret(row.refresh_token_encrypted, encryptionKey(QBO_KEY)!)).toBe("refresh-1-refresh_token");
    expect(row.version).toBe(before + 1);
    // Still fresh: no second refresh.
    await accessToken(deps, qboConfig()!);
    expect(intuit.state.refreshCount).toBe(1);
  });

  it("disconnects by revoking the refresh token at Intuit", async () => {
    await connect();
    const refresh = intuit.state.refreshToken;
    const r = await request(app()).post("/api/ops/quickbooks/disconnect").set(staff());
    expect(r.body).toMatchObject({ disconnected: true, revoked: true });
    expect(intuit.state.revoked).toEqual([refresh]);
    expect((await pool.query("SELECT count(*)::int AS n FROM qbo_connection")).rows[0].n).toBe(0);
  });
});

describe("posting Stripe activity to QuickBooks", () => {
  beforeEach(async () => {
    await connect();
    const s = await request(app())
      .patch("/api/ops/quickbooks/settings")
      .set(staff())
      .send({ tax_code_id: "5", exempt_tax_code_id: "4", deposit_account_id: "35", fee_account_id: "80" });
    expect(s.status).toBe(200);
  });

  it("posts the invoice with seats, support, storage, discount and tax; then the payment, fee and refund, once each", async () => {
    expect((await sendEvent(evt("invoice.finalized", invoice()))).status).toBe(200);
    expect((await sendEvent(evt("invoice.paid", paidInvoice()))).status).toBe(200);
    expect((await sendEvent(evt("charge.refunded", { id: "ch_qbo", customer: "cus_qbo", payment_intent: "pi_qbo", amount_refunded: 5000 }))).status).toBe(200);
    const rows = (await pool.query("SELECT kind, stripe_id, licensee_id FROM qbo_outbox ORDER BY id")).rows;
    expect(rows.map((r) => `${r.kind}:${r.stripe_id}`)).toEqual(["invoice:in_1001", "payment:in_1001", "fee:in_1001", "refund:re_1"]);
    expect(rows.every((r) => r.licensee_id === licenseeId)).toBe(true);

    const r = await flushQboOutbox(deps);
    expect(r).toMatchObject({ tried: 4, done: 4, failed: 0 });

    const inv = intuit.store.Invoice;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ DocNumber: "KS-0001", GlobalTaxCalculation: "TaxExcluded", TxnTaxDetail: { TotalTax: 12.8 }, TotalAmt: 268.8 });
    const lines = inv[0].Line as any[];
    const items = Object.fromEntries(intuit.store.Item.map((i: any) => [i.Id, i.Name]));
    const sales = lines.filter((l) => l.DetailType === "SalesItemLineDetail");
    expect(sales.map((l) => [items[l.SalesItemLineDetail.ItemRef.value], l.Amount, l.SalesItemLineDetail.Qty, l.SalesItemLineDetail.UnitPrice])).toEqual([
      ["Keystone seats", 147, 3, 49],
      ["Keystone support", 99, 1, 99],
      ["Keystone extra storage", 20, 2, 10],
    ]);
    expect(sales.every((l) => l.SalesItemLineDetail.TaxCodeRef.value === "5")).toBe(true);
    expect(lines.find((l) => l.DetailType === "DiscountLineDetail")).toMatchObject({ Amount: 10 });
    expect(intuit.store.Customer).toHaveLength(1);
    expect(intuit.store.Customer[0]).toMatchObject({ DisplayName: "Northwind Capital", PrimaryEmailAddr: { Address: "nora@northwind.example" } });
    expect(intuit.store.Item.every((i: any) => i.IncomeAccountRef.value === "79")).toBe(true);

    expect(intuit.store.Payment).toHaveLength(1);
    expect(intuit.store.Payment[0]).toMatchObject({
      TotalAmt: 268.8, PaymentRefNum: "pi_qbo", DepositToAccountRef: { value: "35" },
      Line: [{ Amount: 268.8, LinkedTxn: [{ TxnId: inv[0].Id, TxnType: "Invoice" }] }],
    });
    expect(intuit.store.Purchase).toHaveLength(1);
    expect(intuit.store.Purchase[0]).toMatchObject({
      AccountRef: { value: "35" }, Line: [{ Amount: 8.12, AccountBasedExpenseLineDetail: { AccountRef: { value: "80" } } }],
    });
    expect(intuit.store.Vendor[0].DisplayName).toBe("Stripe");
    expect(intuit.store.RefundReceipt).toHaveLength(1);
    expect(intuit.store.RefundReceipt[0]).toMatchObject({
      PaymentRefNum: "re_1", DepositToAccountRef: { value: "35" }, GlobalTaxCalculation: "TaxInclusive",
      Line: [{ Amount: 50, SalesItemLineDetail: { TaxCodeRef: { value: "5" } } }],
    });
    // Every create carried a requestid.
    expect(intuit.state.creates.every((c) => /^[0-9a-f-]{36}$/.test(String(c.requestId)))).toBe(true);

    // Replays: new event ids for the same invoice and refund change nothing.
    await sendEvent(evt("invoice.paid", paidInvoice()));
    await sendEvent(evt("charge.refunded", { id: "ch_qbo", customer: "cus_qbo", payment_intent: "pi_qbo" }));
    expect(await flushQboOutbox(deps)).toMatchObject({ tried: 0 });
    expect(intuit.store.Invoice).toHaveLength(1);
    expect(intuit.store.Payment).toHaveLength(1);
    expect(intuit.store.RefundReceipt).toHaveLength(1);
    const statuses = (await pool.query("SELECT status, count(*)::int AS n FROM qbo_outbox GROUP BY 1")).rows;
    expect(statuses).toEqual([{ status: "done", n: 4 }]);
  });

  it("does not make a second invoice when one with the same number is already in QuickBooks", async () => {
    intuit.store.Invoice = [{ Id: "555", DocNumber: "KS-0001" }];
    await sendEvent(evt("invoice.finalized", invoice()));
    await flushQboOutbox(deps);
    expect(intuit.store.Invoice).toHaveLength(1);
    const row = (await pool.query("SELECT status, qbo_id FROM qbo_outbox WHERE kind = 'invoice'")).rows[0];
    expect(row).toEqual({ status: "done", qbo_id: "555" });
  });

  it("skips invoices with nothing charged, and fees when fee posting is not set up", async () => {
    await request(app()).patch("/api/ops/quickbooks/settings").set(staff()).send({ fee_account_id: "" });
    await sendEvent(evt("invoice.paid", invoice({ id: "in_zero", number: "KS-0002", total: 0, amount_paid: 0, lines: { data: [{ amount: 0 }] }, total_taxes: [], total_discount_amounts: [] })));
    await sendEvent(evt("invoice.paid", paidInvoice()));
    await flushQboOutbox(deps);
    const rows = (await pool.query("SELECT kind, stripe_id, status, note FROM qbo_outbox ORDER BY id")).rows;
    expect(rows.filter((r) => r.stripe_id === "in_zero").map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(rows.find((r) => r.kind === "fee" && r.stripe_id === "in_1001")).toMatchObject({ status: "skipped", note: expect.stringMatching(/fee_account_id/) });
    expect(intuit.store.Purchase).toBeUndefined();
  });

  it("refuses to guess the tax: a taxed invoice waits until a tax code is set", async () => {
    await request(app()).patch("/api/ops/quickbooks/settings").set(staff()).send({ tax_code_id: null });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendEvent(evt("invoice.finalized", invoice()));
    expect(await flushQboOutbox(deps)).toMatchObject({ failed: 1 });
    expect(err.mock.calls.some((c) => /posting invoice in_1001 failed .*tax_code_id/.test(String(c[0])))).toBe(true);
  });

  it("logs a failure, backs off, and posts on the retry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    intuit.state.failNext = { entity: "Invoice", status: 500, body: { Fault: { Error: [{ Message: "Service unavailable", code: "3100" }] } } };
    await sendEvent(evt("invoice.finalized", invoice()));
    expect(await flushQboOutbox(deps)).toMatchObject({ tried: 1, failed: 1 });
    let row = (await pool.query("SELECT status, attempts, last_error, next_attempt_at FROM qbo_outbox")).rows[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/Service unavailable/);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(err).toHaveBeenCalled();
    // Not due yet: nothing happens.
    expect(await flushQboOutbox(deps)).toMatchObject({ tried: 0 });
    // Staff "Retry now".
    const ids = (await pool.query("SELECT id FROM qbo_outbox")).rows;
    expect((await request(app()).post(`/api/ops/quickbooks/outbox/${ids[0].id}/retry`).set(staff())).status).toBe(200);
    expect(await flushQboOutbox(deps)).toMatchObject({ done: 1 });
    row = (await pool.query("SELECT status, last_error FROM qbo_outbox")).rows[0];
    expect(row).toEqual({ status: "done", last_error: null });
    expect(intuit.store.Invoice).toHaveLength(1);
  });

  it("refreshes once on a 401 and carries on", async () => {
    intuit.state.unauthorizedOnce = true;
    await sendEvent(evt("invoice.finalized", invoice()));
    expect(await flushQboOutbox(deps)).toMatchObject({ done: 1 });
    expect(intuit.state.refreshCount).toBe(1);
  });

  it("uses a credit memo for a refund when no deposit account is set", async () => {
    await request(app()).patch("/api/ops/quickbooks/settings").set(staff()).send({ deposit_account_id: null });
    await sendEvent(evt("charge.refunded", { id: "ch_qbo", customer: "cus_qbo", payment_intent: "pi_qbo" }));
    await flushQboOutbox(deps);
    expect(intuit.store.CreditMemo).toHaveLength(1);
    expect(intuit.store.RefundReceipt).toBeUndefined();
  });

  it("waits, untouched, while QuickBooks is not connected", async () => {
    await request(app()).post("/api/ops/quickbooks/disconnect").set(staff());
    await sendEvent(evt("invoice.finalized", invoice()));
    expect(await flushQboOutbox(deps)).toMatchObject({ tried: 0, waiting: true });
    expect((await pool.query("SELECT attempts FROM qbo_outbox")).rows[0].attempts).toBe(0);
  });
});
