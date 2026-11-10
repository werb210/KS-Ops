// KS_OPS_PROSPECT_MARKETING_v1 - consent gating, suppression, unsubscribe, sequence stop rules, the CASL footer and
// the SendGrid webhook check. No database or network: the fake database answers by SQL content.
import { generateKeyPairSync, sign } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import {
  addMonths, eligibility, mergeConsent, nextStatus, statusFromCrmStage, statusFromLicensee, stopReason,
} from "../../src/marketing/consent.js";
import { deliver } from "../../src/marketing/engine.js";
import { readUnsubscribeToken, renderEmail, unsubscribeToken } from "../../src/marketing/render.js";
import { webhookAuthentic } from "../../src/marketing/sendgrid.js";
import { DEFAULT_ADDRESS, marketingStatus, resetDomainCache, sendingProblem } from "../../src/marketing/settings.js";
import { fakeDb, makeDeps } from "../helpers.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const ENV_KEYS = ["SENDGRID_API_KEY", "SENDGRID_FROM", "KS_MARKETING_FROM", "KS_OPS_PUBLIC_URL", "KS_MARKETING_ADDRESS", "KS_MARKETING_WEBHOOK_PUBLIC_KEY", "KS_MARKETING_WEBHOOK_TOKEN"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SENDGRID_API_KEY = "SG.test-key";
  process.env.KS_MARKETING_FROM = "hello@keystone.example";
  process.env.KS_OPS_PUBLIC_URL = "https://ops.keystone.example";
  delete process.env.KS_MARKETING_ADDRESS;
  delete process.env.KS_MARKETING_WEBHOOK_PUBLIC_KEY;
  delete process.env.KS_MARKETING_WEBHOOK_TOKEN;
  resetDomainCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("consent gating", () => {
  const base = { email: "jo@brokerage.example", country: "CA" };

  it("blocks anyone with no consent, and says why", () => {
    const r = eligibility({ ...base, consent_type: "none" }, NOW);
    expect(r).toEqual({ ok: false, reason: "no_consent", message: expect.stringContaining("No consent") });
  });

  it("allows express consent with no expiry", () => {
    expect(eligibility({ ...base, consent_type: "express", consent_at: "2020-01-01T00:00:00Z" }, NOW).ok).toBe(true);
  });

  it("implied consent from an inquiry lasts 6 months", () => {
    const inside = eligibility({ ...base, consent_type: "implied_inquiry", consent_at: addMonths(NOW, -5) }, NOW);
    const outside = eligibility({ ...base, consent_type: "implied_inquiry", consent_at: addMonths(NOW, -7) }, NOW);
    expect(inside.ok).toBe(true);
    expect(outside).toMatchObject({ ok: false, reason: "consent_expired" });
  });

  it("a stored expiry date wins over the default", () => {
    const r = eligibility({ ...base, consent_type: "implied_business", consent_at: "2024-01-01T00:00:00Z", consent_expires_at: "2026-10-31T00:00:00Z" }, NOW);
    expect(r).toMatchObject({ ok: false, reason: "consent_expired" });
    expect(eligibility({ ...base, consent_type: "implied_business", consent_at: "2024-01-01T00:00:00Z", consent_expires_at: null }, NOW).ok).toBe(true);
  });

  it("implied consent with no date is blocked", () => {
    expect(eligibility({ ...base, consent_type: "implied_inquiry" }, NOW)).toMatchObject({ ok: false, reason: "consent_missing_date" });
  });

  it("CAN-SPAM opt-out only for prospects in the US", () => {
    expect(eligibility({ email: "a@b.example", country: "US", consent_type: "us_opt_out" }, NOW).ok).toBe(true);
    expect(eligibility({ email: "a@b.example", country: "CA", consent_type: "us_opt_out" }, NOW)).toMatchObject({ ok: false, reason: "us_opt_out_not_us" });
    expect(eligibility({ email: "a@b.example", country: null, consent_type: "us_opt_out" }, NOW)).toMatchObject({ ok: false, reason: "us_opt_out_not_us" });
  });

  it("the suppression list beats even express consent", () => {
    for (const s of ["unsubscribed", "hard_bounce", "spam_report", "crm_opt_out", "manual"]) {
      expect(eligibility({ ...base, consent_type: "express", suppressed: s }, NOW)).toMatchObject({ ok: false, reason: `suppressed_${s}` });
    }
  });

  it("rejects an invalid email", () => {
    expect(eligibility({ email: "not-an-email", consent_type: "express" }, NOW)).toMatchObject({ ok: false, reason: "invalid_email" });
  });

  it("never replaces express consent with implied, and keeps the longer implied consent", () => {
    const express = { consent_type: "express", consent_at: "2026-01-01T00:00:00Z" };
    const inquiry = { consent_type: "implied_inquiry", consent_at: NOW.toISOString() };
    expect(mergeConsent(express, inquiry, NOW)).toBe(express);
    const old = { consent_type: "implied_inquiry", consent_at: addMonths(NOW, -4).toISOString() };
    expect(mergeConsent(old, inquiry, NOW)).toBe(inquiry);
    const customer = { consent_type: "implied_business", consent_at: NOW.toISOString(), consent_expires_at: null };
    expect(mergeConsent(inquiry, customer, NOW)).toBe(customer);
    expect(mergeConsent({ consent_type: "none" }, inquiry, NOW)).toBe(inquiry);
  });
});

describe("statuses", () => {
  it("only move forward automatically; lost holds until they actually sign up", () => {
    expect(nextStatus("demo_booked", "lead")).toBe("demo_booked");
    expect(nextStatus("lead", "trial")).toBe("trial");
    expect(nextStatus("lost", "demo_booked")).toBe("lost");
    expect(nextStatus("lost", "customer")).toBe("customer");
    expect(nextStatus("customer", "lost")).toBe("lost");
  });
  it("map licensee statuses and CRM stages", () => {
    expect(statusFromLicensee("active")).toBe("customer");
    expect(statusFromLicensee("pending_payment")).toBe("trial");
    expect(statusFromLicensee("cancelled")).toBe("lost");
    expect(statusFromCrmStage("demo_finished")).toBe("demo_booked");
    expect(statusFromCrmStage("paying")).toBe("customer");
    expect(statusFromCrmStage(null)).toBeNull();
  });
});

describe("sequence stop rules", () => {
  const enrolled_at = "2026-10-20T00:00:00Z";
  it("stops on a reply, a sign-up or a demo booking after the enrolment", () => {
    expect(stopReason({ enrolled_at, last_replied_at: "2026-10-21T00:00:00Z" })).toBe("replied");
    expect(stopReason({ enrolled_at, signed_up_at: "2026-10-22T00:00:00Z" })).toBe("signed_up");
    expect(stopReason({ enrolled_at, demo_booked_at: "2026-10-23T00:00:00Z" })).toBe("demo_booked");
  });
  it("ignores things that happened before the enrolment", () => {
    expect(stopReason({ enrolled_at, last_replied_at: "2026-10-01T00:00:00Z", demo_booked_at: "2026-10-02T00:00:00Z", signed_up_at: null })).toBeNull();
  });
});

describe("unsubscribe links", () => {
  it("round-trip the email and refuse a tampered token", () => {
    const t = unsubscribeToken("Jo@Brokerage.example");
    expect(readUnsubscribeToken(t)).toBe("jo@brokerage.example");
    const [p, sig] = t.split(".");
    const other = Buffer.from("victim@x.example").toString("base64url");
    expect(readUnsubscribeToken(`${other}.${sig}`)).toBeNull();
    expect(readUnsubscribeToken(`${p}.AAAA${sig!.slice(4)}`)).toBeNull();
    expect(readUnsubscribeToken("garbage")).toBeNull();
  });
});

describe("the email", () => {
  const r = { email: "jo@brokerage.example", name: "Jo <script>alert(1)</script> Smith", company: "Acme", consent_type: "implied_inquiry" };
  let out: ReturnType<typeof renderEmail>;
  beforeEach(() => {
    out = renderEmail("Hi {{first_name}}", { headline: "Hello {{company}}", body: "Line one\n\nLine two", cta_label: "Book a demo", cta_url: "https://keystone.example/demo" }, r);
  });

  it("has the CASL / CAN-SPAM footer: why, who, the mailing address, a contact and the unsubscribe link", () => {
    expect(out.html).toContain(DEFAULT_ADDRESS);
    expect(out.text).toContain(DEFAULT_ADDRESS);
    expect(out.html).toContain("2630108 Alberta Ltd.");
    expect(out.html).toContain("because you recently asked us about Keystone");
    expect(out.html).toContain("https://ops.keystone.example/api/public/marketing/unsubscribe?t=");
    expect(out.text).toContain(`Unsubscribe: ${out.unsubscribe_url}`);
  });

  it("uses the configured address when one is set", () => {
    process.env.KS_MARKETING_ADDRESS = "1 Keystone Way, Calgary, AB T2P 0A1";
    const o = renderEmail("x", { body: "y" }, r);
    expect(o.html).toContain("1 Keystone Way, Calgary, AB T2P 0A1");
    expect(o.html).not.toContain(DEFAULT_ADDRESS);
  });

  it("sends one-click List-Unsubscribe headers", () => {
    expect(out.headers["List-Unsubscribe"]).toBe(`<${out.unsubscribe_url}>`);
    expect(out.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("is Keystone-branded and escapes merge values", () => {
    expect(out.subject).toBe("Hi Jo");
    expect(out.html).toContain("Hello Acme");
    expect(out.html).toContain("#6D28D9");
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toMatch(/Boreal Financial/i);
  });
});

describe("sender settings", () => {
  it("cannot send without SendGrid or without a public address for unsubscribe links", () => {
    expect(sendingProblem()).toBeNull();
    delete process.env.KS_OPS_PUBLIC_URL;
    const host = process.env.WEBSITE_HOSTNAME;
    delete process.env.WEBSITE_HOSTNAME;
    expect(sendingProblem()).toMatch(/KS_OPS_PUBLIC_URL/);
    if (host) process.env.WEBSITE_HOSTNAME = host;
    process.env.KS_OPS_PUBLIC_URL = "https://ops.keystone.example";
    delete process.env.SENDGRID_API_KEY;
    expect(sendingProblem()).toMatch(/SendGrid/);
  });

  it("warns until KS_MARKETING_FROM is set and its domain is authenticated", async () => {
    delete process.env.KS_MARKETING_FROM;
    process.env.SENDGRID_FROM = "keystone@boreal.example";
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ domain: "other.example", valid: true }]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const s = await marketingStatus(fetch, NOW, true);
    expect(s.sender.from).toBe("keystone@boreal.example");
    expect(s.warnings.join(" ")).toMatch(/KS_MARKETING_FROM is not set/);
    expect(s.domain).toMatchObject({ domain: "boreal.example", authenticated: false });
    expect(s.warnings.join(" ")).toMatch(/not authenticated/);
    process.env.KS_MARKETING_FROM = "hello@mail.keystone.example";
    const ok = vi.fn(async () => new Response(JSON.stringify([{ domain: "keystone.example", valid: true }]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const s2 = await marketingStatus(ok, NOW, true);
    expect(s2.domain.authenticated).toBe(true);
    expect(s2.warnings.join(" ")).not.toMatch(/KS_MARKETING_FROM is not set/);
  });
});

describe("deliver: the last check before an email leaves", () => {
  const prospect = (over: Record<string, unknown>) => ({
    id: "11111111-1111-4111-8111-111111111111", email: "jo@brokerage.example", name: "Jo", company: "Acme", country: "CA",
    consent_type: "express", consent_at: "2026-01-01T00:00:00Z", consent_expires_at: null, suppressed: null, ...over,
  });

  function setup(p: Record<string, unknown>) {
    const db = fakeDb([[/FROM ks_prospects p LEFT JOIN ks_mkt_suppressions s/, () => [p]]]);
    const fetch = vi.fn(async () => new Response("", { status: 202, headers: { "x-message-id": "sg-1" } }));
    const deps = makeDeps({ db, fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW });
    return { db, fetch, deps };
  }

  it("does not send to a suppressed prospect, and records why", async () => {
    const { db, fetch, deps } = setup(prospect({ suppressed: "unsubscribed" }));
    const r = await deliver(deps, { id: 7, prospect_id: "p", attempts: 0 }, { subject: "S", fields: { body: "B" }, label: "test" });
    expect(r).toEqual({ outcome: "blocked", reason: "suppressed_unsubscribed" });
    expect(fetch).not.toHaveBeenCalled();
    const upd = db.calls.find((c) => /UPDATE ks_mkt_sends SET status = 'blocked'/.test(c.sql));
    expect(upd?.params).toEqual([7, "suppressed_unsubscribed"]);
  });

  it("does not send when consent has expired", async () => {
    const { fetch, deps } = setup(prospect({ consent_type: "implied_inquiry", consent_at: "2025-01-01T00:00:00Z" }));
    const r = await deliver(deps, { id: 8, prospect_id: "p", attempts: 0 }, { subject: "S", fields: { body: "B" }, label: "test" });
    expect(r).toEqual({ outcome: "blocked", reason: "consent_expired" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends with the send id, tracking on, SendGrid's own footer off and the one-click headers", async () => {
    const { db, fetch, deps } = setup(prospect({}));
    const r = await deliver(deps, { id: 9, prospect_id: "p", attempts: 0 }, { subject: "Hello", fields: { body: "B" }, label: "test" });
    expect(r.outcome).toBe("sent");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    const body = JSON.parse(String(init.body));
    expect(body.from.email).toBe("hello@keystone.example");
    expect(body.personalizations[0].custom_args).toEqual({ ks_mkt: "1", ks_mkt_send_id: "9" });
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(body.tracking_settings.subscription_tracking.enable).toBe(false);
    expect(body.tracking_settings.open_tracking.enable).toBe(true);
    expect(db.calls.some((c) => /UPDATE ks_mkt_sends SET status = 'sent'/.test(c.sql) && c.params[2] === "sg-1")).toBe(true);
  });
});

describe("public unsubscribe and webhook routes", () => {
  it("one-click unsubscribe suppresses the email and stops their sequences", async () => {
    const db = fakeDb([
      [/INSERT INTO ks_mkt_suppressions/, () => [{ email: "jo@brokerage.example" }]],
      [/SELECT id, email FROM ks_prospects WHERE lower\(email\)/, () => [{ id: "p1", email: "jo@brokerage.example" }]],
      [/INSERT INTO ks_prospect_events/, () => [{ id: 1 }]],
    ]);
    const app = createApp(makeDeps({ db, now: () => NOW }));
    const t = unsubscribeToken("jo@brokerage.example");
    const res = await request(app).post(`/api/public/marketing/unsubscribe?t=${encodeURIComponent(t)}`).type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    const ins = db.calls.find((c) => /INSERT INTO ks_mkt_suppressions/.test(c.sql));
    expect(ins?.params.slice(0, 2)).toEqual(["jo@brokerage.example", "unsubscribed"]);
    expect(db.calls.some((c) => /UPDATE ks_mkt_enrollments SET status = 'stopped'/.test(c.sql))).toBe(true);
  });

  it("a GET only shows the button (link scanners unsubscribe nobody)", async () => {
    const db = fakeDb();
    const app = createApp(makeDeps({ db }));
    const res = await request(app).get(`/api/public/marketing/unsubscribe?t=${encodeURIComponent(unsubscribeToken("jo@brokerage.example"))}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("jo@brokerage.example");
    expect(db.calls.some((c) => /ks_mkt_suppressions/.test(c.sql))).toBe(false);
  });

  it("refuses a forged token", async () => {
    const db = fakeDb();
    const app = createApp(makeDeps({ db }));
    const res = await request(app).post("/api/public/marketing/unsubscribe?t=abc.def").type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(400);
    expect(db.calls.length).toBe(0);
  });

  it("refuses webhook posts that are not signed", async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post("/api/public/marketing/sendgrid-events").set("Content-Type", "application/json").send("[]");
    expect(res.status).toBe(403);
  });

  it("checks SendGrid's ECDSA signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.KS_MARKETING_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const raw = Buffer.from('[{"event":"open"}]');
    const ts = "1700000000";
    const sig = sign("sha256", Buffer.concat([Buffer.from(ts), raw]), privateKey).toString("base64");
    expect(webhookAuthentic(raw, { signature: sig, timestamp: ts })).toBe(true);
    expect(webhookAuthentic(Buffer.from('[{"event":"spamreport"}]'), { signature: sig, timestamp: ts })).toBe(false);
  });
});
