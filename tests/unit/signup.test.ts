import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { codeProblem, signupSchema } from "../../src/licensees/validation.js";
import { NO_STRIPE_MESSAGE, SIGNUP_NOT_CONFIGURED_MESSAGE } from "../../src/routes/public.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { fakeDb, fakeMailer, fakeStripe, jsonResponse, licenseeRow, makeDeps, validSignup } from "../helpers.js";

function signupDb(taken: string[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const db = fakeDb([
    [/SELECT 1 FROM licensees WHERE company_code/, (p) => (taken.includes(String(p[0])) ? [{ "?column?": 1 }] : [])],
    [/INSERT INTO licensees/, (p) => {
      const cols = /INSERT INTO licensees \(([^)]+)\)/.exec(db.calls.at(-1)!.sql.replace(/\s+/g, " "))![1].split(", ");
      const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
      inserted.push(row);
      return [licenseeRow({ ...row, id: "44444444-4444-4444-8444-444444444444" })];
    }],
    [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
  ]);
  return { db, inserted };
}

afterEach(() => {
  delete process.env.TURNSTILE_SECRET;
  delete process.env.SIGNUP_TURNSTILE_OPTIONAL;
  process.env.NODE_ENV = "test";
});

describe("signup validation", () => {
  it("accepts a valid form and normalises it", () => {
    const r = signupSchema.safeParse(validSignup());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.contact_email).toBe("nora@northwind.example");
      expect(r.data.website).toBe("https://northwind.example");
    }
  });

  it("explains problems in plain English, per field", async () => {
    const app = createApp(makeDeps({ db: signupDb().db }));
    const res = await request(app).post("/api/public/signup").send({
      ...validSignup(), plan: "pro", seats: 1, company_code: "No Spaces!", province_state: "TX",
      contact_email: "not-an-email", accept_terms: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({
      seats: "The Pro plan needs at least 2 seats.",
      company_code: expect.stringContaining("lowercase letters"),
      province_state: "Choose a Canadian province or territory.",
      contact_email: "Enter a valid email address.",
      accept_terms: "Please accept the terms of service.",
    });
  });

  it("checks company codes", () => {
    expect(codeProblem("keystone-demo")).toBeNull();
    expect(codeProblem("ab")).toBe("invalid");
    expect(codeProblem("-abc")).toBe("invalid");
    expect(codeProblem("a--b")).toBe("invalid");
    expect(codeProblem("x".repeat(33))).toBe("invalid");
    expect(codeProblem("admin")).toBe("reserved");
  });
});

describe("GET /api/public/company-code-available", () => {
  it("reports available, taken, reserved and invalid", async () => {
    const app = createApp(makeDeps({ db: signupDb(["taken-co"]).db }));
    expect((await request(app).get("/api/public/company-code-available?code=fresh-co")).body).toEqual({ available: true });
    expect((await request(app).get("/api/public/company-code-available?code=Taken-Co")).body).toMatchObject({ available: false, reason: "taken" });
    expect((await request(app).get("/api/public/company-code-available?code=support")).body).toMatchObject({ available: false, reason: "reserved" });
    expect((await request(app).get("/api/public/company-code-available?code=a")).body).toMatchObject({ available: false, reason: "invalid" });
  });
});

describe("POST /api/public/signup", () => {
  it("rejects a filled honeypot without saving anything", async () => {
    const { db, inserted } = signupDb();
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send({ ...validSignup(), website_url: "http://spam" });
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("answers 409 when the code is taken", async () => {
    const { db, inserted } = signupDb(["northwind"]);
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ errors: { company_code: "taken" } });
    expect(inserted).toHaveLength(0);
  });

  it("answers 409 when the insert loses a race on the code", async () => {
    const db = fakeDb([[/INSERT INTO licensees/, () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); }]]);
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(409);
  });

  it("without Stripe: saves the licensee, returns no checkout link and tells sales", async () => {
    const { db, inserted } = signupDb();
    const { mailer, sent } = fakeMailer();
    const res = await request(createApp(makeDeps({ db, mailer }))).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ licensee_id: "44444444-4444-4444-8444-444444444444", checkout_url: null, message: NO_STRIPE_MESSAGE });
    expect(res.body.signup_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(inserted[0]).toMatchObject({ status: "pending_payment", source: "website", company_code: "northwind", plan: "growth", seats: 3 });
    expect(inserted[0].signup_token_hash).not.toBe(res.body.signup_token);
    expect(sent.map((m) => m.to[0])).toEqual(["sales@example.test"]);
  });

  it("with Stripe: opens Checkout with the subscription and onboarding fee", async () => {
    const { db } = signupDb();
    const stripe = fakeStripe();
    const res = await request(createApp(makeDeps({ db, stripe: () => stripe }))).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(res.body.message).toBeUndefined();
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([
      { price: "price_seat:growth:annual", quantity: 3 },
      { price: "price_support:priority:annual", quantity: 1 },
      { price: "price_onboarding:growth", quantity: 1 },
    ]);
    const q = `l=44444444-4444-4444-8444-444444444444&t=${res.body.signup_token}`;
    // KS_OPS_AUTO_PROVISION_v1 - p is the opaque setup-progress token for the thank-you page.
    expect(params.success_url).toMatch(new RegExp(`^https://keystone\\.example\\.test/signup/success\\?${q}&p=[A-Za-z0-9_-]{43}$`));
    expect(params.cancel_url).toBe(`https://keystone.example.test/signup/cancelled?${q}`);
    expect(params.metadata.licensee_id).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("takes extra storage blocks at sign-up, saves them and bills them in Checkout", async () => {
    const { db, inserted } = signupDb();
    const stripe = fakeStripe();
    const res = await request(createApp(makeDeps({ db, stripe: () => stripe })))
      .post("/api/public/signup")
      .send({ ...validSignup(), billing_interval: "monthly", extra_storage_blocks: 2 });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ extra_storage_blocks: 2 });
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.line_items).toContainEqual({ price: "price_storage_block:monthly", quantity: 2 });
  });

  it("defaults to Canadian pre-authorized debit with the PAD mandate, card as the fallback", async () => {
    const { db, inserted } = signupDb();
    const stripe = fakeStripe();
    const res = await request(createApp(makeDeps({ db, stripe: () => stripe }))).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ payment_method: "acss_debit" });
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.allowed_payment_method_types).toEqual(["acss_debit", "card"]);
    expect(params.payment_method_options.acss_debit).toMatchObject({
      mandate_options: { payment_schedule: "combined", transaction_type: "business" },
      verification_method: "automatic",
    });
    expect(params.payment_method_options.acss_debit.mandate_options.interval_description).toMatch(/monthly or yearly/);
  });

  it("offers card only when the licensee chose card, and refuses unknown methods", async () => {
    const { db, inserted } = signupDb();
    const stripe = fakeStripe();
    const app = createApp(makeDeps({ db, stripe: () => stripe }));
    const res = await request(app).post("/api/public/signup").send({ ...validSignup(), payment_method: "card" });
    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ payment_method: "card" });
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params.payment_method_options).toBeUndefined();
    const bad = await request(app).post("/api/public/signup").send({ ...validSignup(), payment_method: "cheque" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.payment_method).toBe("Choose bank debit or credit card.");
  });

  it("defaults extra storage to none and rejects bad amounts", async () => {
    const ok = signupSchema.safeParse(validSignup());
    expect(ok.success && ok.data.extra_storage_blocks).toBe(0);
    const app = createApp(makeDeps({ db: signupDb().db }));
    for (const [v, msg] of [
      [-1, "Extra storage cannot be negative."],
      [1.5, "Extra storage must be a whole number of 50 GB blocks."],
      [1001, "Extra storage is limited to 1,000 blocks."],
    ] as const) {
      const res = await request(app).post("/api/public/signup").send({ ...validSignup(), extra_storage_blocks: v });
      expect(res.status).toBe(400);
      expect(res.body.errors.extra_storage_blocks).toBe(msg);
    }
    const tooMany = await request(app).post("/api/public/signup").send({ ...validSignup(), seats: 1001 });
    expect(tooMany.body.errors.seats).toBe("For more than 1,000 seats, please contact us.");
  });

  it("requires Turnstile when TURNSTILE_SECRET is set", async () => {
    process.env.TURNSTILE_SECRET = "ts-secret";
    const f = vi.fn(async (_url: string, init: RequestInit) =>
      jsonResponse({ success: String((init.body as URLSearchParams).get("response")) === "good" }));
    const { db } = signupDb();
    const app = createApp(makeDeps({ db, fetch: f as unknown as typeof fetch }));
    expect((await request(app).post("/api/public/signup").send(validSignup())).status).toBe(400);
    expect((await request(app).post("/api/public/signup").send({ ...validSignup(), turnstile_token: "bad" })).body.errors).toHaveProperty("turnstile_token");
    expect((await request(app).post("/api/public/signup").send({ ...validSignup(), turnstile_token: "good" })).status).toBe(201);
  });

  it("allows the public site origin", async () => {
    const res = await request(createApp(makeDeps())).get("/api/public/plans").set("Origin", "https://keystone.example.test");
    expect(res.headers["access-control-allow-origin"]).toBe("https://keystone.example.test");
    expect(res.body.currency).toBe("CAD");
  });

  it("lists the lender portal on every plan and the broker portal from growth", async () => {
    const res = await request(createApp(makeDeps())).get("/api/public/plans");
    const keys = (plan: string) => res.body.plans.find((p: { key: string }) => p.key === plan).features.map((f: { key: string }) => f.key);
    expect(keys("starter")).toContain("lender_portal");
    expect(keys("starter")).toContain("pgi_referrals"); // every plan
    expect(keys("starter")).not.toContain("broker_portal");
    expect(keys("starter")).not.toContain("referrer_portal");
    expect(keys("growth")).toEqual(expect.arrayContaining(["referrer_portal", "broker_portal"]));
    const lender = res.body.plans[0].features.find((f: { key: string }) => f.key === "lender_portal");
    expect(lender.label).toBe("Lender portal (lenders can send you deals they can't place)");
  });

  // KS_OPS_BANK_CONNECT_ADDON - bank connect is a hidden per-licensee add-on: never on a public plan.
  it("does not list bank connect or fraud check 3 on any plan", async () => {
    const res = await request(createApp(makeDeps())).get("/api/public/plans");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/bank_connect|fraud_3|flinks|bank connect/i);
  });

  it("checks Turnstile only after the form and the code pass, so a 400 or 409 does not use up the token", async () => {
    process.env.TURNSTILE_SECRET = "ts-secret";
    const f = vi.fn(async () => jsonResponse({ success: true }));
    const { db } = signupDb(["northwind"]);
    const app = createApp(makeDeps({ db, fetch: f as unknown as typeof fetch }));
    expect((await request(app).post("/api/public/signup").send({ ...validSignup(), seats: 0, turnstile_token: "t" })).status).toBe(400);
    expect((await request(app).post("/api/public/signup").send({ ...validSignup(), turnstile_token: "t" })).status).toBe(409);
    expect(f).not.toHaveBeenCalled();
    expect((await request(app).post("/api/public/signup").send({ ...validSignup(), company_code: "fresh-co", turnstile_token: "t" })).status).toBe(201);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("in production refuses sign-ups without TURNSTILE_SECRET unless SIGNUP_TURNSTILE_OPTIONAL=true", async () => {
    process.env.NODE_ENV = "production";
    const { db, inserted } = signupDb();
    const app = createApp(makeDeps({ db }));
    const res = await request(app).post("/api/public/signup").send(validSignup());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "signup_not_configured", message: SIGNUP_NOT_CONFIGURED_MESSAGE });
    expect(inserted).toHaveLength(0);
    process.env.SIGNUP_TURNSTILE_OPTIONAL = "true";
    expect((await request(app).post("/api/public/signup").send(validSignup())).status).toBe(201);
    delete process.env.SIGNUP_TURNSTILE_OPTIONAL;
    process.env.TURNSTILE_SECRET = "ts-secret";
    const ok = createApp(makeDeps({ db: signupDb().db, fetch: (async () => jsonResponse({ success: true })) as unknown as typeof fetch }));
    expect((await request(ok).post("/api/public/signup").send({ ...validSignup(), turnstile_token: "t" })).status).toBe(201);
  });

  it("keeps an encrypted copy of the signup token", async () => {
    const { db, inserted } = signupDb();
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send(validSignup());
    expect(inserted[0].signup_token_hash).toBe(sha256Hex(res.body.signup_token));
    expect(String(inserted[0].signup_token_encrypted)).not.toContain(res.body.signup_token);
    expect(inserted[0].signup_token_encrypted).toBeTruthy();
  });
});

describe("POST /api/public/signup/:id/checkout (resume payment)", () => {
  const token = "tok-resume-1234567890";
  const row = (over: Record<string, unknown> = {}) =>
    licenseeRow({ status: "pending_payment", source: "website", signup_token_hash: sha256Hex(token), ...over });
  const db = (r: ReturnType<typeof row>) =>
    fakeDb([
      [/SELECT \* FROM licensees WHERE id/, () => [r]],
      [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
    ]);
  const url = (id = row().id, t = token) => `/api/public/signup/${id}/checkout?token=${t}`;

  it("gives a new Checkout link that keeps the person's token", async () => {
    const stripe = fakeStripe();
    const d = db(row());
    const res = await request(createApp(makeDeps({ db: d, stripe: () => stripe }))).post(url());
    expect(res.status).toBe(200);
    expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    expect(res.headers["cache-control"]).toBe("no-store");
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.success_url).toContain(`t=${token}`);
    // The token was not replaced.
    expect(d.calls.some((c) => /signup_token_hash = \$2/.test(c.sql))).toBe(false);
  });

  it("answers 404 for a wrong token or id, 409 unless pending_payment, 503 without Stripe", async () => {
    const stripe = fakeStripe();
    const app = createApp(makeDeps({ db: db(row()), stripe: () => stripe }));
    expect((await request(app).post(url(row().id, "wrong"))).status).toBe(404);
    expect((await request(app).post(url("not-a-uuid"))).status).toBe(404);
    expect((await request(app).post(`/api/public/signup/${row().id}/checkout`)).status).toBe(404);
    const paid = await request(createApp(makeDeps({ db: db(row({ status: "provisioning" })), stripe: () => stripe }))).post(url());
    expect(paid.status).toBe(409);
    expect(paid.body).toMatchObject({ error: "not_pending_payment", status: "provisioning" });
    const none = await request(createApp(makeDeps({ db: db(row()) }))).post(url());
    expect(none.status).toBe(503);
    expect(none.body).toMatchObject({ error: "billing_not_configured", checkout_url: null });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("answers 503 when Stripe prices are missing and 502 when Stripe fails", async () => {
    const stripe = fakeStripe();
    const noPrices = await request(createApp(makeDeps({ db: fakeDb([[/SELECT \* FROM licensees WHERE id/, () => [row()]]]), stripe: () => stripe }))).post(url());
    expect(noPrices.status).toBe(503);
    const failing = fakeStripe({ checkout: { sessions: { create: vi.fn(async () => { throw new Error("card_declined"); }) } } });
    const res = await request(createApp(makeDeps({ db: db(row()), stripe: () => failing }))).post(url());
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("checkout_failed");
  });

  it("is rate limited", async () => {
    const app = createApp(makeDeps({ db: db(row()) }));
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(app).post(url(row().id, "wrong"))).status;
    expect(last).toBe(429);
  });
});
