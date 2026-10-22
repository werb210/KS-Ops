import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { exchangeBfToken, verifyStaffToken } from "../../src/auth/staff.js";
import { clientIpFromRequest, rateLimitKey, stripPort } from "../../src/lib/clientIp.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { hostAllowed, staffCreateSchema, staffPatchSchema } from "../../src/licensees/validation.js";
import { billingAllowance, computeOverage, trialOverlapsPeriod } from "../../src/pricing.js";
import { futureGeneratedAt } from "../../src/sync/usage.js";
import { fakeDb, jsonResponse, licenseeRow, makeDeps, staffToken } from "../helpers.js";

afterEach(() => {
  delete process.env.OPS_ADMIN_EMAILS;
  delete process.env.OPS_ALLOWED_SERVER_HOST_SUFFIXES;
  process.env.NODE_ENV = "test";
});

const req = (headers: Record<string, string> = {}, ip?: string) => ({ headers, ip }) as never;

describe("client address behind Azure (ip:port in X-Forwarded-For)", () => {
  it("strips the port Azure appends", () => {
    expect(clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.5:51234" }))).toBe("203.0.113.5");
    expect(rateLimitKey(req({ "x-forwarded-for": "203.0.113.5:51234" }))).toBe(rateLimitKey(req({ "x-forwarded-for": "203.0.113.5:60001" })));
  });

  it("keys on the right-most public hop, so a forged left-most entry changes nothing", () => {
    const real = clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.5:51234" }));
    expect(clientIpFromRequest(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.5:51234" }))).toBe(real);
    expect(clientIpFromRequest(req({ "x-forwarded-for": "203.0.113.5:51234, 10.0.0.4" }))).toBe(real);
  });

  it("handles IPv6, IPv4-mapped and the req.ip fallback", () => {
    expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(stripPort("2001:db8::1")).toBe("2001:db8::1");
    expect(stripPort("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientIpFromRequest(req({}, "203.0.113.9:5000"))).toBe("203.0.113.9");
    expect(clientIpFromRequest(req({}))).toBe("unknown");
    // IPv6 collapses to its /64.
    expect(rateLimitKey(req({ "x-forwarded-for": "2001:db8:1:2::1" }))).toBe(rateLimitKey(req({ "x-forwarded-for": "2001:db8:1:2::ffff" })));
  });

  it("limits one client across connections (directory: 30 a minute)", async () => {
    const app = createApp(makeDeps());
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await request(app).get("/api/directory/nobody").set("X-Forwarded-For", `203.0.113.5:${51234 + i}`)).status;
    }
    expect(last).toBe(429);
    // Another client still gets through.
    expect((await request(app).get("/api/directory/nobody").set("X-Forwarded-For", "198.51.100.7:40000")).status).toBe(404);
  });

  it("limits sign-ups and the staff token exchange the same way", async () => {
    const app = createApp(makeDeps({ db: fakeDb([[/INSERT INTO licensees/, () => { throw Object.assign(new Error("dup"), { code: "23505" }); }]]) }));
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await request(app).post("/api/public/signup").set("X-Forwarded-For", `203.0.113.5:${50000 + i}`).send({})).status;
    }
    expect(last).toBe(429);
    for (let i = 0; i < 21; i++) {
      last = (await request(app).post("/api/ops/auth/exchange").set("X-Forwarded-For", `203.0.113.5:${50000 + i}`).send({})).status;
    }
    expect(last).toBe(429);
  });

  it("no rate limiter anywhere is built without the key generator", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk("src");
    const offenders = files.filter((f) => !f.endsWith(join("lib", "clientIp.ts")) && /express-rate-limit|rateLimit\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    expect(readFileSync("src/lib/clientIp.ts", "utf8")).toMatch(/keyGenerator: rateLimitKey/);
  });
});

const bfMe = (email: string | null) => ({ data: { user: { id: "33333333-3333-4333-8333-333333333333", role: "Admin", email, first_name: "Ada" } } });
const exchange = (email: string | null) => exchangeBfToken("bf-token-1234567890", (async () => jsonResponse(bfMe(email))) as unknown as typeof fetch);

describe("OPS_ADMIN_EMAILS", () => {
  it("when set, only those emails get in (case-insensitive)", async () => {
    process.env.OPS_ADMIN_EMAILS = " Todd.W@Boreal.Financial , andrew@boreal.financial";
    const ok = await exchange("todd.w@boreal.FINANCIAL");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.user.email).toBe("todd.w@boreal.financial");
    expect(await exchange("someone@boreal.financial")).toMatchObject({ ok: false, status: 403, error: "not_allowed" });
  });

  it("when unset, any BF Admin gets in, in production too", async () => {
    process.env.NODE_ENV = "production";
    expect((await exchange("anyone@boreal.financial")).ok).toBe(true);
  });

  it("refuses service principals (no email)", async () => {
    expect(await exchange(null)).toMatchObject({ ok: false, status: 403, error: "email_required" });
    expect(await exchange("not-an-email")).toMatchObject({ ok: false, status: 403, error: "email_required" });
  });

  it("is checked on every request, so removing someone takes effect at once", async () => {
    const token = staffToken(); // admin@example.test
    expect(verifyStaffToken(token)).not.toBeNull();
    process.env.OPS_ADMIN_EMAILS = "todd.w@boreal.financial";
    expect(verifyStaffToken(token)).toBeNull();
    process.env.OPS_ADMIN_EMAILS = "ADMIN@example.test";
    expect(verifyStaffToken(token)).not.toBeNull();
  });
});

describe("licensee app addresses", () => {
  const base = {
    company_name: "Keystone Demo", legal_name: "Keystone Demo Inc.", company_code: "keystone-demo", contact_name: "Dee",
    contact_email: "dee@demo.example", contact_phone: "403-555-0123", plan: "starter", seats: 1,
  };
  const errs = (v: object) => {
    const r = staffCreateSchema.safeParse({ ...base, ...v });
    return r.success ? null : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
  };

  it("must be https", () => {
    expect(errs({ server_url: "http://ks-demo.azurewebsites.net" })).toEqual({ server_url: "Server address must start with https://." });
    expect(errs({ client_url: "http://apply.demo.example" })).toEqual({ client_url: "Client app address must start with https://." });
    expect(errs({ portal_url: "ftp://staff.demo.example" })).toEqual({ portal_url: "Staff portal address must start with https://." });
    expect(errs({ server_url: "ks-demo.azurewebsites.net", client_url: "https://apply.demo.example/", portal_url: "https://staff.demo.example" })).toBeNull();
    expect(staffPatchSchema.safeParse({ portal_url: "http://staff.demo.example" }).success).toBe(false);
    expect(staffPatchSchema.parse({ server_url: "" })).toEqual({ server_url: null });
  });

  it("server_url must be on an allowed host suffix (default Azure App Service / Static Web Apps)", () => {
    expect(errs({ server_url: "https://evil.example.com" })?.server_url).toContain(".azurewebsites.net");
    expect(errs({ server_url: "https://azurewebsites.net.evil.com" })?.server_url).toBeDefined();
    expect(errs({ server_url: "https://ks.azurestaticapps.net" })).toBeNull();
    process.env.OPS_ALLOWED_SERVER_HOST_SUFFIXES = ".keystone.example";
    expect(errs({ server_url: "https://api.keystone.example" })).toBeNull();
    expect(errs({ server_url: "https://ks.azurewebsites.net" })?.server_url).toBeDefined();
    process.env.OPS_ALLOWED_SERVER_HOST_SUFFIXES = "*";
    expect(errs({ server_url: "https://anything.example.org" })).toBeNull();
    expect(errs({ server_url: "http://anything.example.org" })).not.toBeNull();
  });

  it("matches suffixes on label boundaries", () => {
    expect(hostAllowed("a.azurewebsites.net", [".azurewebsites.net"])).toBe(true);
    expect(hostAllowed("evilazurewebsites.net", [".azurewebsites.net"])).toBe(false);
    expect(hostAllowed("azurewebsites.net", [".azurewebsites.net"])).toBe(false);
    expect(hostAllowed("keystone.example", ["keystone.example"])).toBe(true);
  });
});

describe("usage reports from the future", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("allow 5 minutes of clock drift, no more", () => {
    expect(futureGeneratedAt({ generated_at: "2026-10-22T12:04:59Z" }, now)).toBe(false);
    expect(futureGeneratedAt({ generated_at: "2026-10-22T12:05:01Z" }, now)).toBe(true);
  });

  it("the licensee API refuses them", async () => {
    const key = "ksops_the-right-key";
    const db = fakeDb([[/SELECT \* FROM licensees WHERE id/, () => [licenseeRow({ ops_key_hash: sha256Hex(key) })]]]);
    const app = createApp(makeDeps({ db, now: () => now }));
    const res = await request(app).post(`/api/licensees/${licenseeRow().id}/usage-reports`).set("X-KS-Ops-Key", key)
      .send({ period: "2026-10", generated_at: "2027-01-01T00:00:00Z", seats: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errors.generated_at).toContain("future");
    expect(db.calls.some((c) => /INSERT INTO usage_reports/.test(c.sql))).toBe(false);
  });
});

describe("overage worked out by KS-Ops", () => {
  it("pools allowances over billable seats", () => {
    expect(billingAllowance("starter", 3, false)).toEqual({ minutes: 150, texts: 300 });
    // Pro bills at least 2 seats.
    expect(billingAllowance("pro", 1, false)).toEqual({ minutes: 3000, texts: 3000 });
  });

  it("adds the trial bonus (starter minutes/texts + 100 per seat)", () => {
    expect(billingAllowance("starter", 2, true)).toEqual({ minutes: 300, texts: 400 });
    // A bigger plan's allowance is never reduced by the trial rule.
    expect(billingAllowance("growth", 2, true)).toEqual({ minutes: 1000, texts: 1000 });
  });

  it("ignores the reported overage and uses KS-Ops's plan and seats", () => {
    expect(computeOverage({ plan: "starter", seats: 2, trial: false }, { minutes: 180, texts: 150 })).toMatchObject({ minutes: 80, texts: 0 });
    expect(computeOverage({ plan: "starter", seats: 2, trial: true }, { minutes: 180, texts: 150 })).toMatchObject({ minutes: 0, texts: 0 });
  });

  it("knows when a reported trial overlaps a month", () => {
    expect(trialOverlapsPeriod({ started_at: "2026-09-25T00:00:00Z", ends_at: "2026-10-09T00:00:00Z" }, "2026-10")).toBe(true);
    expect(trialOverlapsPeriod({ started_at: "2026-09-01T00:00:00Z", ends_at: "2026-09-15T00:00:00Z" }, "2026-10")).toBe(false);
    expect(trialOverlapsPeriod({ status: "not_offered", started_at: null, ends_at: null }, "2026-10")).toBe(false);
    expect(trialOverlapsPeriod(null, "2026-10")).toBe(false);
  });
});

describe("POST /api/ops/licensees", () => {
  it("is never cached (the body carries the ops key)", async () => {
    const created = licenseeRow({ id: "55555555-5555-4555-8555-555555555555", status: "pending_payment" });
    const db = fakeDb([
      [/INSERT INTO licensees/, () => [created]],
      [/SELECT \* FROM licensees WHERE id/, () => [created]],
    ]);
    const res = await request(createApp(makeDeps({ db }))).post("/api/ops/licensees").set("Authorization", `Bearer ${staffToken()}`).send({
      company_name: "Keystone Demo", legal_name: "Keystone Demo Inc.", company_code: "keystone-demo", contact_name: "Dee",
      contact_email: "dee@demo.example", contact_phone: "403-555-0123", plan: "starter", seats: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.ops_key).toMatch(/^ksops_/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

