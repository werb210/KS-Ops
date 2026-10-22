import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { codeProblem, signupSchema } from "../../src/licensees/validation.js";
import { NO_STRIPE_MESSAGE } from "../../src/routes/public.js";
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
    expect(params.success_url).toBe(`https://keystone.example.test/signup/success?${q}`);
    expect(params.cancel_url).toBe(`https://keystone.example.test/signup/cancelled?${q}`);
    expect(params.metadata.licensee_id).toBe("44444444-4444-4444-8444-444444444444");
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
});
