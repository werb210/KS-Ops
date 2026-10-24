// KS_OPS_BETA_v1 - the beta features programme end to end against real Postgres: staff create and open a beta, a
// licensee joins and leaves it through its server's ops key, private betas need staff, feedback is recorded, the flags
// reach the licensee's server with the plan push, and a website sign-up is stored and queued for the CRM.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
const pushes: Array<{ url: string; body: any }> = [];
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
let lic: { id: string; key: string };
let starter: { id: string; key: string };

async function makeLicensee(code: string, plan: string): Promise<{ id: string; key: string }> {
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: `Co ${code}`, legal_name: `Co ${code} Inc.`, company_code: code, contact_name: "A B", contact_email: `${code}@x.example`,
    contact_phone: "403-555-0123", plan, billing: "monthly", support_level: "email", seats: 2, country: "CA", status: "active",
    server_url: `https://${code}.azurewebsites.net`,
  });
  expect(res.status).toBe(201);
  return { id: res.body.licensee.id, key: res.body.ops_key };
}

const fromServer = (l: { id: string; key: string }) => ({
  enrolment: (body: object) => request(app()).post(`/api/licensees/${l.id}/beta/enrolment`).set("X-KS-Ops-Key", l.key).send(body),
  feedback: (body: object) => request(app()).post(`/api/licensees/${l.id}/beta/feedback`).set("X-KS-Ops-Key", l.key).send(body),
  list: () => request(app()).get(`/api/licensees/${l.id}/beta`).set("X-KS-Ops-Key", l.key),
});

beforeAll(async () => {
  process.env.BF_CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
  pool = await freshPool();
  await pool.query("TRUNCATE beta_features, beta_enrolments, beta_feedback, beta_signups, crm_outbox CASCADE");
  deps = {
    db: pool,
    fetch: (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/api/plan")) pushes.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch,
    mailer: fakeMailer().mailer,
    stripe: () => null,
    now: () => new Date(),
  };
  lic = await makeLicensee("beta-pro", "pro");
  starter = await makeLicensee("beta-starter", "starter");
});

afterAll(async () => {
  delete process.env.BF_CRM_KEY;
  await pool.end();
});

describe("beta features programme", () => {
  it("staff create a public beta for Pro and it is listed with counts", async () => {
    const r = await request(app()).post("/api/ops/beta/features").set(staff()).send({
      key: "ai_call_notes", name: "AI call notes", description: "Writes the call note for you.", status: "public_beta", plans: ["pro"],
      feedback_url: "https://keystone.example/feedback",
    });
    expect(r.status).toBe(201);
    expect(r.body.pushes_queued).toBeGreaterThanOrEqual(2);
    expect((await request(app()).post("/api/ops/beta/features").set(staff()).send({ key: "ai_call_notes", name: "Again" })).status).toBe(409);
    const list = await request(app()).get("/api/ops/beta/features").set(staff());
    expect(list.body.features).toEqual([expect.objectContaining({ key: "ai_call_notes", enrolled_count: 0, feedback_count: 0, plans: ["pro"] })]);
  });

  it("an eligible licensee sees it and joins (auto-approved); another plan does not see it", async () => {
    expect((await fromServer(lic).list()).body.beta_features).toEqual([expect.objectContaining({ key: "ai_call_notes", enabled: false, can_join: true })]);
    expect((await fromServer(starter).list()).body.beta_features).toEqual([]);
    const join = await fromServer(lic).enrolment({ feature_key: "ai_call_notes", action: "join", requested_by: "admin@beta-pro.example" });
    expect(join.status).toBe(200);
    expect(join.body.status).toBe("joined");
    expect(join.body.beta_features[0]).toMatchObject({ enabled: true, enrolled: true, can_leave: true });
    expect((await fromServer(starter).enrolment({ feature_key: "ai_call_notes", action: "join" })).status).toBe(403);
    const audit = await pool.query("SELECT action FROM staff_audit WHERE licensee_id = $1 AND action LIKE 'beta.%'", [lic.id]);
    expect(audit.rows.map((r) => r.action)).toContain("beta.join");
  });

  it("feedback is stored and shown to staff with who is in", async () => {
    expect((await fromServer(lic).feedback({ feature_key: "ai_call_notes", message: "Saves me ten minutes a call.", rating: 5, author_name: "Ann" })).status).toBe(201);
    expect((await fromServer(lic).feedback({ feature_key: "ai_call_notes", message: "" })).status).toBe(400);
    const d = await request(app()).get("/api/ops/beta/features/ai_call_notes").set(staff());
    expect(d.body.enrolments).toEqual([expect.objectContaining({ licensee_id: lic.id, source: "licensee", company_code: "beta-pro" })]);
    expect(d.body.feedback).toEqual([expect.objectContaining({ message: "Saves me ten minutes a call.", rating: 5, company_code: "beta-pro" })]);
  });

  it("closing a beta turns new joins into requests; leaving switches it off", async () => {
    const close = await request(app()).patch("/api/ops/beta/features/ai_call_notes").set(staff()).send({ open: false, plans: [] });
    expect(close.body.changed.sort()).toEqual(["open", "plans"]);
    const req = await fromServer(starter).enrolment({ feature_key: "ai_call_notes", action: "join" });
    expect(req.status).toBe(202);
    expect(req.body.status).toBe("requested");
    expect((await pool.query("SELECT kind FROM requests WHERE licensee_id = $1", [starter.id])).rows).toEqual([{ kind: "other" }]);
    const leave = await fromServer(lic).enrolment({ feature_key: "ai_call_notes", action: "leave" });
    expect(leave.body.status).toBe("left");
    expect(leave.body.beta_features[0]).toMatchObject({ enabled: false, can_join: false });
  });

  it("a private beta needs staff to enrol, and the flag reaches the server with the plan push", async () => {
    await request(app()).post("/api/ops/beta/features").set(staff()).send({ key: "lender_ai", name: "Lender AI", status: "private_beta" });
    expect((await fromServer(starter).enrolment({ feature_key: "lender_ai", action: "join" })).status).toBe(404);
    pushes.length = 0;
    const en = await request(app()).post("/api/ops/beta/features/lender_ai/enrolments").set(staff()).send({ licensee_id: starter.id });
    expect(en.status).toBe(201);
    const push = pushes.find((p) => p.url.startsWith("https://beta-starter.azurewebsites.net"));
    expect(push?.body.beta_features).toEqual(expect.arrayContaining([expect.objectContaining({ key: "lender_ai", enabled: true })]));
    const del = await request(app()).delete(`/api/ops/beta/features/lender_ai/enrolments/${starter.id}`).set(staff());
    expect(del.body).toMatchObject({ ok: true, removed: true });
  });

  it("GA cannot be left; retired disappears", async () => {
    await request(app()).patch("/api/ops/beta/features/ai_call_notes").set(staff()).send({ status: "ga" });
    expect((await fromServer(lic).list()).body.beta_features[0]).toMatchObject({ key: "ai_call_notes", enabled: true, can_leave: false });
    expect((await fromServer(lic).enrolment({ feature_key: "ai_call_notes", action: "leave" })).status).toBe(409);
    await request(app()).patch("/api/ops/beta/features/ai_call_notes").set(staff()).send({ status: "retired" });
    expect((await fromServer(lic).list()).body.beta_features).toEqual([]);
  });

  it("stores a website sign-up and queues it for the Keystone CRM", async () => {
    const r = await request(app()).post("/api/public/beta-signup").send({
      name: "Dana Diaz", email: "Dana@Example.test", brokerage: "Diaz Funding", interests: ["ai_assistant", "reporting"], message: "Happy to test.",
    });
    expect(r.status).toBe(201);
    const s = (await pool.query("SELECT * FROM beta_signups")).rows;
    expect(s).toEqual([expect.objectContaining({ email: "dana@example.test", brokerage: "Diaz Funding", interests: ["ai_assistant", "reporting"] })]);
    const crm = (await pool.query("SELECT source, external_id, payload FROM crm_outbox WHERE external_id = $1", [s[0].id])).rows[0];
    expect(crm.source).toBe("website_signup");
    expect(crm.payload).toMatchObject({ stage: "lead", contact: { email: "dana@example.test" }, company: { name: "Diaz Funding" } });
    expect(crm.payload.note).toContain("Interests: AI assistant, Reporting.");
    // Again the same day: accepted, not stored twice.
    expect((await request(app()).post("/api/public/beta-signup").send({ name: "Dana Diaz", email: "dana@example.test", brokerage: "Diaz Funding" })).status).toBe(201);
    expect((await pool.query("SELECT count(*)::int AS n FROM beta_signups")).rows[0].n).toBe(1);
    const list = await request(app()).get("/api/ops/beta/signups").set(staff());
    expect(list.body.signups).toHaveLength(1);
  });
});
