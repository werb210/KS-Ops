// The demo link by text message: phone parsing, the Twilio call, and the sign-up texting and emailing the link.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { magicLinkMail, magicLinkSms } from "../../src/demo/emails.js";
import { normalizeNaPhone, prettyNaPhone, sendSms, smsConfigured } from "../../src/lib/sms.js";
import { fakeDb, fakeMailer, makeDeps } from "../helpers.js";

const SMS_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "KS_SMS_FROM", "TWILIO_MESSAGING_SERVICE_SID", "KS_DEMO_SERVER_URL", "KS_DEMO_OPS_KEY", "KS_DEMO_PORTAL_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SMS_KEYS) saved[k] = process.env[k];
  for (const k of SMS_KEYS) delete process.env[k];
  process.env.KS_DEMO_SERVER_URL = "https://demo-server.example";
  process.env.KS_DEMO_OPS_KEY = "demo-ops-key-0123456789";
  process.env.KS_DEMO_PORTAL_URL = "https://portal.example";
});
afterEach(() => {
  for (const k of SMS_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const twilioOn = () => {
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "auth_test";
  process.env.KS_SMS_FROM = "+15875550100";
};

describe("phone numbers", () => {
  it("accepts the usual ways people type a North American number", () => {
    for (const raw of ["(403) 555-0199", "403.555.0199", "403-555-0199", "1 403 555 0199", "+1 403 555 0199", "4035550199"]) {
      expect(normalizeNaPhone(raw)).toBe("+14035550199");
    }
    expect(prettyNaPhone("+14035550199")).toBe("(403) 555-0199");
  });

  it("rejects numbers that are too short, overseas, or not a number", () => {
    for (const raw of ["555-0199", "+44 20 7946 0958", "abc", "403 555 019x", "(103) 555-0199", "", 4035550199]) {
      expect(normalizeNaPhone(raw)).toBeNull();
    }
  });
});

describe("sending a text", () => {
  it("does nothing when Twilio is not set up", async () => {
    const f = vi.fn();
    expect(smsConfigured()).toBe(false);
    expect(await sendSms(f as unknown as typeof fetch, "+14035550199", "hi")).toEqual({ ok: false, error: "sms_not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("posts To, From and Body to Twilio with basic auth", async () => {
    twilioOn();
    const f = vi.fn(async () => new Response("{}", { status: 201 }));
    expect(await sendSms(f as unknown as typeof fetch, "+14035550199", "hello")).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json");
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("AC_test:auth_test").toString("base64"));
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({ To: "+14035550199", Body: "hello", From: "+15875550100" });
  });

  it("uses a messaging service when one is set, and reports Twilio's error code", async () => {
    twilioOn();
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG_test";
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 21211 }), { status: 400 }));
    expect(await sendSms(f as unknown as typeof fetch, "+14035550199", "x")).toEqual({ ok: false, error: "twilio_send_failed status=400 code=21211" });
    const body = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get("MessagingServiceSid")).toBe("MG_test");
    expect(body.get("From")).toBeNull();
  });
});

describe("the demo link messages", () => {
  const s = { id: "55555555-5555-4555-8555-555555555555", name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo <Capital>", created_at: new Date(), expires_at: new Date() };

  it("the email has a button, the steps, the plain link and a reply line, and escapes what was typed", () => {
    const m = magicLinkMail(s, "https://portal.example/demo#d=1&t=a&b", 7);
    expect(m.subject).toBe("Dana, your Keystone demo is ready");
    expect(m.html).toContain(">Start my demo</a>");
    expect(m.html).toContain('href="https://portal.example/demo#d=1&amp;t=a&amp;b"');
    expect(m.html).toContain("BrokerCo &lt;Capital&gt;");
    expect(m.html).not.toContain("<Capital>");
    for (const t of ["Catch the fraud", "Take the call", "real person reads every email", "works for 7 days"]) expect(m.text).toContain(t);
    expect(m.text).toContain("https://portal.example/demo#d=1&t=a&b");
  });

  it("the text is short and has the link and an opt-out", () => {
    const t = magicLinkSms(s, "https://portal.example/demo#d=1&t=abc");
    expect(t).toContain("https://portal.example/demo#d=1&t=abc");
    expect(t).toMatch(/^Keystone: Hi Dana,/);
    expect(t).toMatch(/Reply STOP to opt out\.$/);
    expect(t.length).toBeLessThan(320);
  });
});

describe("POST /api/public/demo/signup with a phone", () => {
  const row = (params: unknown[]) => [{
    id: "66666666-6666-4666-8666-666666666666", name: params[0], email: params[1], phone: params[2], company: params[3],
    created_at: new Date(), expires_at: new Date(Date.now() + 7 * 86_400_000), link_sends: 1,
  }];

  it("texts and emails the link and says so", async () => {
    twilioOn();
    const db = fakeDb([[/INSERT INTO demo_signups/, row]]);
    const { mailer, sent } = fakeMailer();
    const f = vi.fn(async () => new Response("{}", { status: 201 }));
    const r = await request(createApp(makeDeps({ db, mailer, fetch: f as unknown as typeof fetch })))
      .post("/api/public/demo/signup")
      .send({ name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo", phone: "(403) 555-0199" });
    expect(r.status).toBe(201);
    expect(r.body.message).toBe("Your demo is ready - we've texted the link to (403) 555-0199 and emailed it too.");
    const insert = db.calls.find((c) => /INSERT INTO demo_signups/.test(c.sql));
    expect(insert?.params[2]).toBe("+14035550199");
    const twilio = f.mock.calls.find((c) => String((c as unknown[])[0]).includes("api.twilio.com")) as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(twilio[1].body)).get("To")).toBe("+14035550199");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["dana@brokerco.example"]);
  });

  it("still emails the link when texting is not set up", async () => {
    const db = fakeDb([[/INSERT INTO demo_signups/, row]]);
    const { mailer, sent } = fakeMailer();
    const r = await request(createApp(makeDeps({ db, mailer })))
      .post("/api/public/demo/signup")
      .send({ name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo", phone: "403 555 0199" });
    expect(r.status).toBe(201);
    expect(r.body.message).toBe("Your demo is ready - we couldn't text (403) 555-0199 just now, so we've emailed you the link.");
    expect(sent).toHaveLength(1);
  });

  it("asks for a proper number when the phone is not a North American one", async () => {
    const r = await request(createApp(makeDeps()))
      .post("/api/public/demo/signup")
      .send({ name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo", phone: "+44 20 7946 0958" });
    expect(r.status).toBe(400);
    expect(r.body.errors.phone).toMatch(/Canadian or US mobile/);
  });
});
