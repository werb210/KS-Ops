import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { digestEvents, minutes, type DemoEvent } from "../../src/demo/digest.js";
import { magicLinkMail, magicLinkUrl, prospectPackageMail, salesCompletedMail, salesUnfinishedMail } from "../../src/demo/emails.js";
import { demoConfigured } from "../../src/demo/config.js";
import { demoSignupSchema } from "../../src/routes/demo.js";
import { makeDeps } from "../helpers.js";

const signup = {
  id: "55555555-5555-4555-8555-555555555555", name: "Dana Prospect", email: "dana@brokerco.example", company: "BrokerCo <Capital>",
  created_at: new Date("2026-10-20T10:00:00Z"), expires_at: new Date("2026-10-27T10:00:00Z"),
  opened_at: new Date("2026-10-20T10:05:00Z"), completed_at: new Date("2026-10-20T10:40:00Z"),
};

const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 10, min)).toISOString();
const ev = (min: number, type: string, step: string | null = null, data: Record<string, unknown> = {}): DemoEvent => ({ type, step, data, at: at(min) });

const fullRun: DemoEvent[] = [
  ev(0, "session_created"), ev(5, "portal_opened"), ev(5, "step_viewed", "welcome"), ev(6, "step_completed", "welcome"),
  ev(7, "borrower_joined", "borrower", { via: "link", device: "iPhone" }),
  ev(8, "document_uploaded", "borrower", { document: "Bank statement - July 2026", fraud_status: "green" }),
  ev(9, "document_uploaded", "borrower", { document: "Bank statement - September 2026", fraud_status: "red" }),
  ev(9, "assistant_question", "borrower"), ev(10, "step_completed", "borrower"), ev(11, "step_skipped", "application"),
  ev(14, "document_decision", "documents", { document: "Bank statement - September 2026", decision: "rejected", fraud_status: "red" }),
  ev(15, "document_decision", "documents", { document: "Bank statement - July 2026", decision: "accepted", fraud_status: "green" }),
  ev(16, "step_completed", "documents"), ev(17, "call_rang", "call"), ev(17, "call_answered", "call"), ev(18, "call_completed", "call"),
  ev(20, "financials_reviewed", "financials"), ev(22, "credit_summary_built", "credit_summary"), ev(23, "click", "lenders", { name: "opened_lender_detail" }),
  ev(24, "lenders_selected", "lenders", { lenders: ["aspen-ridge"] }), ev(25, "submitted", "submit", { lenders: ["Aspen Ridge Capital"] }),
  ev(26, "package_downloaded", "submit"), ev(10, "heartbeat", null, { seconds: 60 }), ev(20, "heartbeat", null, { seconds: 60 }),
];

describe("demo digest", () => {
  it("works out steps, phone use, the doctored-statement decision, the call, lenders and time", () => {
    const d = digestEvents(fullRun);
    expect(d.steps_completed).toEqual(["welcome", "borrower", "documents", "call", "financials", "credit_summary", "lenders", "submit"]);
    expect(d.steps_skipped).toEqual(["application"]);
    expect(d).toMatchObject({ used_phone: true, phone_device: "iPhone", used_screen: false, doctored: "rejected", call: "completed", assistant_questions: 1, submitted: true, package_downloaded: true, last_step: "submit" });
    expect(d.lenders).toEqual(["Aspen Ridge Capital"]);
    expect(d.clicks).toEqual(["opened_lender_detail"]);
    expect(d.active_seconds).toBe(120); // heartbeats win when present
    expect(d.elapsed_seconds).toBe(26 * 60);
    expect(d.documents_uploaded).toHaveLength(2);
  });

  it("an unfinished run: no phone, accepted the doctored statement, stopped at documents; time from gaps capped at 5 min", () => {
    const d = digestEvents([
      ev(0, "portal_opened"), ev(1, "step_completed", "welcome"), ev(2, "borrower_joined", "borrower", { via: "screen" }),
      ev(3, "document_uploaded", "borrower", { document: "S", fraud_status: "red" }), ev(4, "step_viewed", "documents"),
      ev(60, "document_decision", "documents", { document: "S", decision: "accepted", fraud_status: "red" }),
    ]);
    expect(d).toMatchObject({ used_phone: false, used_screen: true, doctored: "accepted", call: "not_reached", submitted: false, last_step: "documents" });
    expect(d.active_seconds).toBe(4 * 60 + 300);
    expect(digestEvents([]).doctored).toBe("not_uploaded");
    expect(minutes(59)).toBe("59 sec");
    expect(minutes(3720)).toBe("1 h 2 min");
  });
});

describe("demo emails", () => {
  it("the magic link opens the portal's /demo with the id and token in the fragment, and escapes what was typed", () => {
    const url = magicLinkUrl("https://portal.example/", signup.id, "tok_abc");
    expect(url).toBe(`https://portal.example/demo#d=${signup.id}&t=tok_abc`);
    const m = magicLinkMail(signup, url, 7);
    expect(m.to).toEqual(["dana@brokerco.example"]);
    expect(m.text).toContain(url);
    expect(m.text).toContain("Hi Dana,");
    expect(m.text).toMatch(/works for 7 days/);
    expect(m.html).toContain("BrokerCo &lt;Capital&gt;");
    expect(m.html).not.toContain("<Capital>");
  });

  it("the prospect gets the package attached", () => {
    const m = prospectPackageMail(signup, Buffer.from("%PDF-1.7 x").toString("base64"), "Pkg.pdf");
    expect(m.to).toEqual(["dana@brokerco.example"]);
    expect(m.attachments).toEqual([{ filename: "Pkg.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.7 x").toString("base64") }]);
    expect(m.text).toMatch(/sample data/);
  });

  it("sales gets who, time spent, phone use, steps, clicks and skips when a demo finishes", () => {
    const m = salesCompletedMail("sales@example.test", signup, digestEvents(fullRun));
    expect(m.to).toEqual(["sales@example.test"]);
    expect(m.subject).toBe("Demo finished: Dana Prospect (BrokerCo <Capital>)");
    for (const s of [
      "Name: Dana Prospect", "Email: dana@brokerco.example", "Company: BrokerCo <Capital>", "Time spent: about 2 min active",
      "Used the phone: Yes - opened the borrower link on an iPhone", "Steps completed (8/9)", "Steps skipped: Application arrives live",
      "Caught it - rejected the doctored September statement", "Client call: Answered and listened to the end",
      "Assistant questions asked as the borrower: 1", "Lenders picked: Aspen Ridge Capital", "Downloaded the package", "Other clicks: opened_lender_detail",
    ]) expect(m.text).toContain(s);
  });

  it("sales gets a 'did not finish' note with where they stopped", () => {
    const d = digestEvents(fullRun.slice(0, 12));
    const idle = salesUnfinishedMail("sales@example.test", { ...signup, completed_at: null }, d, "idle", 24);
    expect(idle.subject).toBe("Demo not finished: Dana Prospect (BrokerCo <Capital>)");
    expect(idle.text).toContain("no activity for 24 hours");
    expect(idle.text).toContain("They got as far as: Review documents and the fraud check");
    expect(idle.text).toContain("link still works");
    const exp = salesUnfinishedMail("sales@example.test", { ...signup, completed_at: null }, d, "expired", 24);
    expect(exp.text).toContain("the demo has expired");
    expect(exp.text).toContain("wiped");
  });
});

describe("demo sign-up and server endpoints without a database", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.KS_DEMO_SERVER_URL = "https://demo-server.example";
    process.env.KS_DEMO_OPS_KEY = "demo-ops-key-0123456789";
    process.env.KS_DEMO_PORTAL_URL = "https://portal.example";
  });
  afterEach(() => {
    for (const k of ["KS_DEMO_SERVER_URL", "KS_DEMO_OPS_KEY", "KS_DEMO_PORTAL_URL"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("validates name, email and company", () => {
    expect(demoSignupSchema.safeParse({ name: " Dana ", email: " Dana@X.Example ", company: "Co" })).toMatchObject({ success: true, data: { name: "Dana", email: "dana@x.example" } });
    expect(demoSignupSchema.safeParse({ name: "", email: "nope", company: "" }).success).toBe(false);
  });

  it("answers 503 when the demo is not set up, and 400 for a filled honeypot or a bad form", async () => {
    delete process.env.KS_DEMO_OPS_KEY;
    expect(demoConfigured()).toBe(false);
    const r = await request(createApp(makeDeps())).post("/api/public/demo/signup").send({ name: "A", email: "a@b.example", company: "C" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("demo_not_configured");
    process.env.KS_DEMO_OPS_KEY = "demo-ops-key-0123456789";
    const hp = await request(createApp(makeDeps())).post("/api/public/demo/signup").send({ name: "A", email: "a@b.example", company: "C", website_url: "http://spam" });
    expect(hp.status).toBe(400);
    const bad = await request(createApp(makeDeps())).post("/api/public/demo/signup").send({ name: "", email: "x", company: "" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.errors).sort()).toEqual(["company", "email", "name"]);
  });

  it("the demo server's endpoints need the demo ops key", async () => {
    const app = createApp(makeDeps());
    expect((await request(app).post(`/api/demo/sessions/${signup.id}/events`).send({ events: [] })).status).toBe(401);
    expect((await request(app).post(`/api/demo/sessions/${signup.id}/events`).set("X-KS-Ops-Key", "wrong").send({ events: [] })).status).toBe(401);
    expect((await request(app).post(`/api/demo/sessions/${signup.id}/complete`).send({})).status).toBe(401);
  });

  it("CORS lets both the website and the demo portal call the public demo endpoints", async () => {
    const app = createApp(makeDeps());
    const site = await request(app).options("/api/public/demo/open").set("Origin", "https://keystone.example.test").set("Access-Control-Request-Method", "POST");
    expect(site.headers["access-control-allow-origin"]).toBe("https://keystone.example.test");
    const portal = await request(app).options("/api/public/demo/open").set("Origin", "https://portal.example").set("Access-Control-Request-Method", "POST");
    expect(portal.headers["access-control-allow-origin"]).toBe("https://portal.example");
    const other = await request(app).options("/api/public/demo/open").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
