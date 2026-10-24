// KS-Ops v13 (Todd, Oct 24): address in parts, more brand colours, logo upload, demo prefill, demo email wording, and
// the staff-only free trial.
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { adminTrialDates, adminTrialMail, endAdminTrials, pushPlanFor } from "../../src/billing/adminTrial.js";
import { DEMO_INTRO, magicLinkMail, prospectPackageMail } from "../../src/demo/emails.js";
import { prefillKey, prefillKeyMatches, signupLinkFor } from "../../src/demo/prefill.js";
import { checkLogo, sniffLogo } from "../../src/lib/logo.js";
import { composeMailingAddress, normalizePostal, signupSchema } from "../../src/licensees/validation.js";
import { planPushBody } from "../../src/sync/planPush.js";
import { fakeDb, fakeMailer, fakeStripe, licenseeRow, makeDeps, staffToken, validSignup } from "../helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>');

describe("mailing address in parts", () => {
  it("normalises Canadian postal codes and US ZIP codes, and refuses bad ones", () => {
    expect(normalizePostal("CA", "t2p1p6")).toBe("T2P 1P6");
    expect(normalizePostal("CA", "T2P-1P6")).toBe("T2P 1P6");
    expect(normalizePostal("CA", "12345")).toBeNull();
    expect(normalizePostal("CA", "D2P 1P6")).toBeNull();
    expect(normalizePostal("US", "94105")).toBe("94105");
    expect(normalizePostal("US", "94105-1234")).toBe("94105-1234");
    expect(normalizePostal("US", "T2P 1P6")).toBeNull();
  });

  it("writes the one-line mailing_address from the parts, for older readers", () => {
    const r = signupSchema.safeParse({
      ...validSignup(), mailing_address: undefined,
      address_line1: "100 Main Street", address_line2: "Suite 4", city: "Calgary", postal_code: "t2p1a1",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.postal_code).toBe("T2P 1A1");
      expect(r.data.mailing_address).toBe("100 Main Street, Suite 4, Calgary AB T2P 1A1, Canada");
    }
    expect(composeMailingAddress({ address_line1: "1 Market St", city: "San Francisco", province_state: "CA", postal_code: "94105", country: "US" }))
      .toBe("1 Market St, San Francisco CA 94105, United States");
  });

  it("still takes the old single mailing_address", () => {
    expect(signupSchema.safeParse(validSignup()).success).toBe(true);
  });

  it("explains a missing city or a bad postal code per field", async () => {
    const res = await request(createApp(makeDeps())).post("/api/public/signup").send({
      ...validSignup(), mailing_address: undefined, address_line1: "100 Main Street", city: "", postal_code: "99999",
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({ city: "City is required.", postal_code: "Enter a Canadian postal code like T2P 1P6." });
  });
});

describe("logo upload", () => {
  it("knows PNG, JPG and SVG by their bytes, not the declared type", () => {
    expect(sniffLogo(PNG)).toBe("image/png");
    expect(sniffLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("image/jpeg");
    expect(sniffLogo(SVG)).toBe("image/svg+xml");
    expect(sniffLogo(Buffer.from("GIF89a"))).toBeNull();
  });

  it("refuses large files, other formats and SVGs with scripts or links", () => {
    expect(checkLogo({ content_type: "image/png", data_base64: Buffer.alloc(600 * 1024, 1).toString("base64") })).toMatchObject({ ok: false, error: expect.stringContaining("500 KB") });
    expect(checkLogo({ content_type: "image/gif", data_base64: Buffer.from("GIF89a....").toString("base64") })).toMatchObject({ ok: false });
    for (const bad of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><a href="https://evil.example"><text>x</text></a></svg>']) {
      expect(checkLogo({ content_type: "image/svg+xml", data_base64: Buffer.from(bad).toString("base64") })).toMatchObject({ ok: false });
    }
    expect(checkLogo({ content_type: "image/svg+xml", data_base64: SVG.toString("base64") })).toMatchObject({ ok: true });
  });

  it("stores an uploaded logo with the sign-up and points logo_url at it; the logo is served as an image", async () => {
    const stored: unknown[][] = [];
    const db = fakeDb([
      [/SELECT 1 FROM licensees WHERE company_code/, () => []],
      [/INSERT INTO licensees/, () => [licenseeRow({ id: "44444444-4444-4444-8444-444444444444", status: "pending_payment" })]],
      [/INSERT INTO licensee_logos/, (p) => { stored.push(p); return [{ logo_key: p[1] }]; }],
      [/FROM licensee_logos WHERE logo_key/, (p) => (p[0] === stored[0]?.[1] ? [{ content_type: "image/png", data: PNG }] : [])],
    ]);
    const app = createApp(makeDeps({ db }));
    const res = await request(app).post("/api/public/signup").send({
      ...validSignup(), accent_color: "#2563EB", background_color: "#F5F7FA",
      logo_file: { content_type: "image/png", data_base64: PNG.toString("base64"), filename: "logo.png" },
    });
    expect(res.status).toBe(201);
    expect(stored).toHaveLength(1);
    expect(stored[0][2]).toBe("image/png");
    const insert = db.calls.find((c) => /INSERT INTO licensees/.test(c.sql))!;
    expect(insert.sql).toContain("accent_color");
    expect(insert.params).toContain("#2563EB");
    const update = db.calls.find((c) => /UPDATE licensees SET logo_url/.test(c.sql))!;
    expect(String(update.params[1])).toMatch(/\/api\/public\/logos\/[A-Za-z0-9_-]{16,}$/);
    const key = String(update.params[1]).split("/").pop();
    const img = await request(app).get(`/api/public/logos/${key}`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-security-policy"]).toContain("default-src 'none'");
    expect((await request(app).get("/api/public/logos/not-a-real-key-123456")).status).toBe(404);
  });

  it("answers a bad logo as a field error without saving the sign-up", async () => {
    const db = fakeDb();
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send({
      ...validSignup(), logo_file: { content_type: "image/png", data_base64: Buffer.from("not an image").toString("base64") },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors.logo_file).toContain("PNG, JPG or SVG");
    expect(db.calls.some((c) => /INSERT INTO licensees/.test(c.sql))).toBe(false);
  });
});

describe("demo details pre-fill the website's forms", () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const demoRow = { id, name: "Dana Prospect", email: "dana@brokerco.example", phone: "+14035550199", company: "BrokerCo", token_hash: "", created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), status: "active" };

  it("the link carries only the demo id and a key, in the #fragment", () => {
    const link = signupLinkFor(id);
    expect(link).toBe(`https://keystone.example.test/signup#demo=${id}&k=${prefillKey(id)}`);
    expect(link).not.toContain("?");
    expect(link).not.toMatch(/dana|BrokerCo/i);
    expect(prefillKeyMatches(id, prefillKey(id))).toBe(true);
    expect(prefillKeyMatches(id, "x".repeat(32))).toBe(false);
  });

  it("POST /api/public/demo/prefill returns what they typed for the right key only", async () => {
    const db = fakeDb([[/FROM demo_signups WHERE id/, (p) => (p[0] === id ? [demoRow] : [])]]);
    const app = createApp(makeDeps({ db }));
    const ok = await request(app).post("/api/public/demo/prefill").send({ demo_id: id, key: prefillKey(id) });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo", phone: "(403) 555-0199" });
    expect((await request(app).post("/api/public/demo/prefill").send({ demo_id: id, key: "wrong" })).status).toBe(404);
    expect((await request(app).post("/api/public/demo/prefill").send({ demo_id: "nope", key: prefillKey(id) })).status).toBe(404);
  });
});

describe("demo emails", () => {
  const s = { id: "66666666-6666-4666-8666-666666666666", name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo", created_at: new Date(), expires_at: new Date() };

  it("say the demo takes about ten minutes (not that they must wait), and link to sign-up", () => {
    const m = magicLinkMail(s, "https://portal.example/demo#d=1&t=a", 7, "https://site.example/signup#demo=1&k=2");
    expect(DEMO_INTRO).toBe("It takes about ten minutes: you'll see a real deal from both sides.");
    for (const body of [m.text, m.html ?? ""]) {
      expect(body).not.toMatch(/in about ten minutes/i);
      expect(body).not.toMatch(/we text/i);
    }
    expect(m.text).toContain("It takes about ten minutes");
    expect(m.text).toContain("https://site.example/signup#demo=1&k=2");
    expect(m.html).toContain('href="https://site.example/signup#demo=1&amp;k=2"');
  });

  it("the lender-package copy links to sign-up too", () => {
    const lender = { lenderName: null, subject: "S", html: "<p>x</p>", text: "x", attachments: [] };
    const m = prospectPackageMail(s, null, "p.pdf", lender, "https://site.example/signup#demo=1&k=2");
    expect(m.text).toContain("https://site.example/signup#demo=1&k=2");
    const plain = prospectPackageMail(s, null, "p.pdf", null, "https://site.example/signup#demo=1&k=2");
    expect(plain.text).toContain("https://site.example/signup#demo=1&k=2");
  });
});

describe("staff-only free trial", () => {
  const start = new Date("2026-10-24T18:00:00Z");
  const dates = adminTrialDates(start);

  it("is free for 14 days, billed at Starter to day 28, with Pro features for 28 days", () => {
    expect(dates.billing_starts_at.toISOString()).toBe("2026-11-07T18:00:00.000Z");
    expect(dates.pro_until.toISOString()).toBe("2026-11-21T18:00:00.000Z");
    const l = { plan: "starter" as const, admin_trial_started_at: start, admin_trial_pro_until: dates.pro_until, admin_trial_ended_at: null };
    expect(pushPlanFor(l, new Date("2026-11-10T00:00:00Z"))).toBe("pro");
    expect(pushPlanFor(l, new Date("2026-11-21T18:00:01Z"))).toBe("starter");
    expect(pushPlanFor({ ...l, plan: "growth" }, new Date("2026-11-10T00:00:00Z"))).toBe("growth");
    expect(planPushBody({ ...l, extra_storage_blocks: 0, status: "trial" }, new Date("2026-11-01T00:00:00Z")).plan).toBe("pro");
  });

  it("emails the dates in plain words", () => {
    const m = adminTrialMail(licenseeRow({ seats: 2, plan: "starter" }) as never, dates, true);
    expect(m.to).toEqual(["nora@northwind.example"]);
    expect(m.text).toContain("Saturday, October 24, 2026 to Friday, November 6, 2026: free, with every Pro feature.");
    expect(m.text).toContain("Saturday, November 7, 2026 to Friday, November 20, 2026: billed at the Starter price");
    expect(m.text).toContain("$59.00 per seat a month (2 seats: $118.00 a month");
    expect(m.text).toContain("From Saturday, November 21, 2026: you're on Starter, unless you choose another plan");
  });

  function trialDb(row: Record<string, unknown>) {
    let current: Record<string, unknown> = { ...row };
    const db = fakeDb([
      [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
      [/INSERT INTO plan_changes/, () => [{ id: "pc1" }]],
      [/SELECT \* FROM licensees WHERE id = \$1/, () => [current]],
      [/UPDATE licensees SET plan = 'starter', billing_interval = 'monthly', status = \$2/, (p) => {
        if (current.admin_trial_started_at) return [];
        current = { ...current, plan: "starter", billing_interval: "monthly", status: p[1], stripe_customer_id: p[2], stripe_subscription_id: p[3], admin_trial_started_at: p[4], admin_trial_started_by: p[5], admin_trial_billing_starts_at: p[6], admin_trial_pro_until: p[7] };
        return [{ id: current.id }];
      }],
    ]);
    return { db, get: () => current };
  }

  it("POST /api/ops/trials starts it: Starter subscription with no payment until day 15, audited, emailed", async () => {
    const { db, get } = trialDb(licenseeRow({ status: "pending_payment", plan: "growth", billing_interval: "annual", server_url: null }));
    const create = vi.fn(async () => ({ id: "sub_trial_1", status: "trialing" }));
    const customers = { update: vi.fn(), create: vi.fn(async () => ({ id: "cus_trial_1" })) };
    const stripe = fakeStripe({ customers });
    (stripe.subscriptions as Record<string, unknown>).create = create;
    const { mailer, sent } = fakeMailer();
    const app = createApp(makeDeps({ db, mailer, stripe: () => stripe, now: () => start }));
    const res = await request(app).post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({ licensee_id: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(201);
    expect(res.body.trial).toMatchObject({ started_by: "admin@example.test" });
    const [params, opts] = create.mock.calls[0] as unknown as [Record<string, any>, Record<string, string>];
    expect(params).toMatchObject({
      customer: "cus_trial_1",
      trial_end: Math.floor(dates.billing_starts_at.getTime() / 1000),
      collection_method: "send_invoice",
      metadata: { ks_admin_trial: "1" },
    });
    expect(params.items).toEqual([{ price: "price_seat:starter:monthly", quantity: 3 }]);
    expect(opts.idempotencyKey).toContain("ks-admin-trial-sub-");
    expect(get()).toMatchObject({ plan: "starter", status: "provisioning", stripe_subscription_id: "sub_trial_1" });
    const auditCall = db.calls.find((c) => /INSERT INTO staff_audit/.test(c.sql) && c.params[1] === "licensee.admin_trial_started");
    expect(auditCall?.params[0]).toBe("admin@example.test");
    expect(sent.some((m) => /free Keystone trial has started/.test(m.subject))).toBe(true);

    const again = await request(app).post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({ licensee_id: "22222222-2222-4222-8222-222222222222" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("trial_already_used");
  });

  it("is for staff only, and needs Stripe", async () => {
    const app = createApp(makeDeps());
    expect((await request(app).post("/api/ops/trials").send({ licensee_id: "22222222-2222-4222-8222-222222222222" })).status).toBe(401);
    const res = await request(app).post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({ licensee_id: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(503);
  });

  it("refuses a licensee that already pays through a live subscription", async () => {
    const { db } = trialDb(licenseeRow({ stripe_subscription_id: "sub_live" }));
    const stripe = fakeStripe();
    stripe.subscriptions.retrieve = vi.fn(async (id: string) => ({ id, status: "active", items: { data: [] } })) as never;
    const res = await request(createApp(makeDeps({ db, stripe: () => stripe })))
      .post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({ licensee_id: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("subscription_exists");
  });

  it("ends after 28 days: back to the stored plan, trial -> active, contact told", async () => {
    const row = licenseeRow({ status: "trial", plan: "starter", admin_trial_started_at: start, admin_trial_pro_until: dates.pro_until, admin_trial_end_reason: "ended" });
    const db = fakeDb([
      [/UPDATE licensees SET admin_trial_ended_at/, () => [{ id: row.id }]],
      [/SELECT \* FROM licensees WHERE id = \$1/, () => [row]],
      [/UPDATE licensees SET status = 'active'/, () => [{ id: row.id }]],
      [/INSERT INTO plan_changes/, () => [{ id: "pc1" }]],
    ]);
    const { mailer, sent } = fakeMailer();
    const n = await endAdminTrials({ db, mailer, now: () => new Date("2026-11-22T00:00:00Z") });
    expect(n).toBe(1);
    expect(db.calls.some((c) => /admin_trial_pro_until <= \$1/.test(c.sql.replace(/\s+/g, " ")))).toBe(true);
    expect(db.calls.some((c) => /INSERT INTO plan_changes/.test(c.sql))).toBe(true);
    expect(sent[0].subject).toContain("your Keystone trial has ended");
    expect(sent[0].text).toContain("now on Starter");
  });

  it("the ops page is plain HTML that asks for a token", async () => {
    const res = await request(createApp(makeDeps())).get("/ops/trials");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Free trials");
    expect(res.text).toContain("Days 1 to 14: free, with every Pro feature.");
  });
});
