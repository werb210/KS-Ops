// KS_OPS_AUTO_PROVISION_v1 - the whole automatic setup against a real Postgres: staff start a run, the (faked) GitHub
// workflow reports its steps through the callback routes, KS-Ops checks health, pushes the plan, creates the admin and
// emails the sign-in link. GitHub, Azure and the licensee's servers are faked through fetch.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { insertLicensee } from "../../src/licensees/repo.js";
import { machineDeps } from "../../src/provisioning/index.js";
import { advanceRun } from "../../src/provisioning/machine.js";
import { statusTokenFor } from "../../src/provisioning/statusToken.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";
import { FakeTwilio, MASTER_SID, MASTER_TOKEN } from "../unit/twilioFake.js"; // KS_OPS_TWILIO_AUTO_v1

let pool: pg.Pool;
const dispatches: Array<{ url: string; inputs: Record<string, string> }> = [];
const server = { planPuts: 0, admins: [] as any[], phone: [] as any[], texting: [] as any[] };
const twilio = new FakeTwilio();

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (/^https:\/\/[a-z]+\.twilio\.com\//.test(url)) return twilio.fetch(url, init); // KS_OPS_TWILIO_AUTO_v1
  if (url === "https://ks-acme-server.azurewebsites.net/api/provision/texting") {
    server.texting.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true });
  }
  if (url.startsWith("https://api.github.com/") && url.endsWith("/dispatches")) {
    dispatches.push({ url, inputs: JSON.parse(String(init.body)).inputs });
    return new Response(null, { status: 204 });
  }
  if (url === "https://ks-acme-server.azurewebsites.net/health") return jsonResponse({ status: "ok" });
  if (url === "https://ks-acme-agent.azurewebsites.net/health") return jsonResponse({ status: "ok" });
  if (url.endsWith(".azurestaticapps.net/")) return new Response('<!doctype html><div id="root"></div>', { status: 200 });
  if (url === "https://ks-acme-server.azurewebsites.net/api/plan" && init.method === "PUT") {
    server.planPuts += 1;
    return jsonResponse({ ok: true });
  }
  if (url === "https://ks-acme-server.azurewebsites.net/api/provision/admin") {
    server.admins.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true, created: true, user_id: "u1" }, 201);
  }
  if (url === "https://ks-acme-server.azurewebsites.net/api/provision/phone-numbers") { // KS_OPS_PHONE_PROVISIONING
    server.phone.push(JSON.parse(String(init.body)));
    // The licensee's server bought them into its sub-account (the fake Twilio gets them too).
    const sub = [...twilio.accounts.values()].find((a) => a.parent === MASTER_SID)!.sid;
    twilio.addNumber(sub, "+14035550111");
    twilio.addNumber(sub, "+18885550111");
    return jsonResponse({ ok: true, results: [{ kind: "main", status: "bought", number: "+14035550111" }, { kind: "toll_free", status: "bought", number: "+18885550111" }] });
  }
  return new Response("unexpected", { status: 500 });
});

const mail = fakeMailer();
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

beforeAll(async () => {
  process.env.KS_PROVISION_GITHUB_TOKEN = "github_pat_test";
  process.env.KS_OPS_PUBLIC_URL = "https://ks-ops.example.test";
  process.env.KS_TWILIO_ACCOUNT_SID = MASTER_SID;
  process.env.KS_TWILIO_AUTH_TOKEN = MASTER_TOKEN;
  pool = await freshPool();
  await pool.query("TRUNCATE licensee_twilio, texting_registrations");
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => {
  delete process.env.KS_PROVISION_GITHUB_TOKEN;
  delete process.env.KS_OPS_PUBLIC_URL;
  delete process.env.KS_TWILIO_ACCOUNT_SID;
  delete process.env.KS_TWILIO_AUTH_TOKEN;
  await pool.end();
});

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("automatic provisioning", () => {
  let licenseeId = "";
  let runId = "";
  let token = "";

  it("staff start a run and the GitHub workflow is started once", async () => {
    const l = await insertLicensee(pool, {
      company_name: "Acme Lending", legal_name: "Acme Lending Inc.", company_code: "acme", contact_name: "Ana Acme",
      contact_email: "ana@acme.example", contact_phone: "+14035550123", country: "CA", province_state: "AB",
      address_line1: "200 Centre St", city: "Calgary", postal_code: "T2G 2B3", website: "https://acme.example",
      business_number: "123456789", business_type: "corporation", contact_title: "President",
      status: "provisioning", plan: "growth", billing_interval: "monthly", support_level: "email", seats: 2,
      extra_storage_blocks: 0, source: "staff",
    });
    licenseeId = l.id;
    const res = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: l.id });
    expect(res.status).toBe(201);
    runId = res.body.run.id;
    expect(res.body.run.steps.map((s: any) => s.step)).toEqual(["twilio_account", "twilio_address", "azure_resources", "twilio_settings", "secrets", "github_environments", "deploy_registry", "deploy", "health", "configure", "admin_user", "welcome_email", "twilio_voice", "twilio_bundle", "phone_numbers", "texting_registration"]);
    await until(async () => dispatches.length > 0, "the dispatch");
    expect(dispatches[0].url).toBe("https://api.github.com/repos/werb210/KS-Ops/actions/workflows/provision-licensee.yml/dispatches");
    expect(dispatches[0].inputs).toMatchObject({ run_id: runId, code: "acme", steps: "azure_resources,twilio_settings,secrets,github_environments,deploy_registry,deploy" });
    // KS_OPS_TWILIO_AUTO_v1 - the sub-account and address were made before the workflow started, and kept in Postgres.
    const tw = (await pool.query("SELECT * FROM licensee_twilio WHERE licensee_id = $1", [l.id])).rows[0];
    expect(tw).toMatchObject({ account_status: "active", friendly_name: "Keystone - Acme Lending (acme)" });
    expect(tw.auth_token_encrypted).toMatch(/^v1:/);
    expect(tw.api_key_sid).toMatch(/^SK/);
    expect(tw.verify_service_sid).toMatch(/^VA/);
    expect(tw.address_sid).toMatch(/^AD/);
    token = dispatches[0].inputs.callback_token;

    // Starting again shows the same run.
    const again = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: l.id });
    expect(again.status).toBe(200);
    expect(again.body.run.id).toBe(runId);
  });

  it("the workflow needs the run's token", async () => {
    const res = await request(app()).get(`/api/provisioning/callback/${runId}/context`).set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
    const ok = await request(app()).get(`/api/provisioning/callback/${runId}/context`).set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code: "acme", company_name: "Acme Lending", region: "canadacentral", plan: "growth" });
  });

  it("the workflow gets an ops key only while the Azure step runs, and reports its steps", async () => {
    const cb = (body: object) => request(app()).post(`/api/provisioning/callback/${runId}`).set("Authorization", `Bearer ${token}`).send(body);
    expect((await cb({ step: "azure_resources", status: "running" })).status).toBe(200);
    const key = await request(app()).post(`/api/provisioning/callback/${runId}/ops-key`).set("Authorization", `Bearer ${token}`);
    expect(key.status).toBe(200);
    expect(key.body.ops_key).toMatch(/^ksops_/);
    expect((await cb({
      step: "azure_resources", status: "done",
      output: { server_url: "https://ks-acme-server.azurewebsites.net", agent_url: "https://ks-acme-agent.azurewebsites.net", portal_url: "https://ks-acme-portal.azurestaticapps.net", client_url: "https://ks-acme-client.azurestaticapps.net", secret: "never stored" },
    })).status).toBe(200);
    const late = await request(app()).post(`/api/provisioning/callback/${runId}/ops-key`).set("Authorization", `Bearer ${token}`);
    expect(late.status).toBe(409);
    const l = (await pool.query("SELECT server_url, portal_url, client_url, ops_key_hash FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    expect(l).toMatchObject({ server_url: "https://ks-acme-server.azurewebsites.net", portal_url: "https://ks-acme-portal.azurestaticapps.net" });
    expect(l.ops_key_hash).toBeTruthy();
    const out = (await pool.query("SELECT output FROM provisioning_steps WHERE run_id = $1 AND step = 'azure_resources'", [runId])).rows[0].output;
    expect(out.secret).toBeUndefined();
    // KS_OPS_TWILIO_AUTO_v1 - the Twilio settings, only while twilio_settings runs.
    const early = await request(app()).post(`/api/provisioning/callback/${runId}/twilio-settings`).set("Authorization", `Bearer ${token}`);
    expect(early.status).toBe(409);
    expect((await cb({ step: "twilio_settings", status: "running" })).status).toBe(200);
    const tws = await request(app()).post(`/api/provisioning/callback/${runId}/twilio-settings`).set("Authorization", `Bearer ${token}`);
    expect(tws.status).toBe(200);
    expect(tws.body.settings).toMatchObject({ TWILIO_ACCOUNT_SID: expect.stringMatching(/^AC/), TWILIO_API_KEY: expect.stringMatching(/^SK/), TWILIO_VOICE_APP_SID: expect.stringMatching(/^AP/), TWILIO_VERIFY_SERVICE_SID: expect.stringMatching(/^VA/), KS_SERVER_URL: "https://ks-acme-server.azurewebsites.net" });
    expect(tws.body.settings.TWILIO_AUTH_TOKEN).toBe(twilio.accounts.get(tws.body.settings.TWILIO_ACCOUNT_SID)!.auth_token);
    const bad = await request(app()).post(`/api/provisioning/callback/${runId}/twilio-settings`).set("Authorization", "Bearer nope");
    expect(bad.status).toBe(401);
    for (const step of ["twilio_settings", "secrets", "github_environments", "deploy_registry", "deploy"]) expect((await cb({ step, status: "done" })).status).toBe(200);
  });

  it("KS-Ops finishes: health, plan push, admin user, sign-in email", async () => {
    const md = machineDeps(deps);
    const run = await until(async () => {
      const r = await advanceRun(md, runId);
      return r?.status === "done" ? r : null;
    }, "the run to finish");
    expect(run.status).toBe("done");
    expect(server.planPuts).toBeGreaterThan(0);
    expect(server.admins).toEqual([{ name: "Ana Acme", email: "ana@acme.example", phone: "+14035550123" }]);
    expect(server.phone).toEqual([expect.objectContaining({ area_code: "403", country: "CA", address_sid: expect.stringMatching(/^AD/) })]); // KS_OPS_PHONE_PROVISIONING
    // KS_OPS_TWILIO_AUTO_v1 - the dialler app points at the server, toll-free verification is submitted and the server told.
    expect([...twilio.apps.values()][0].voice_url).toBe("https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/voice/twiml");
    const regs = (await pool.query("SELECT kind, status, phone_number, verification_sid, pushed_status FROM texting_registrations WHERE licensee_id = $1 ORDER BY kind", [licenseeId])).rows;
    expect(regs).toEqual([
      { kind: "a2p_10dlc", status: "not_needed", phone_number: "+14035550111", verification_sid: null, pushed_status: "not_needed" },
      { kind: "toll_free", status: "pending", phone_number: "+18885550111", verification_sid: expect.stringMatching(/^HH/), pushed_status: "pending" },
    ]);
    expect(server.texting[0].registrations.find((r: any) => r.kind === "toll_free").message).toMatch(/approval pending with carriers/);
    expect(mail.sent.find((m) => /your Keystone system is ready/.test(m.subject))?.to).toEqual(["ana@acme.example"]);
    const l = (await pool.query("SELECT status FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    expect(l.status).toBe("active");
    // The token stops working once the run is done.
    const res = await request(app()).get(`/api/provisioning/callback/${runId}/context`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("the website's status page shows the portal once ready; a bad token shows nothing", async () => {
    const res = await request(app()).get(`/api/public/provisioning/${statusTokenFor(licenseeId)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "ready", company_name: "Acme Lending", portal_url: "https://ks-acme-portal.azurestaticapps.net", email_sent: true });
    const bad = await request(app()).get(`/api/public/provisioning/${"A".repeat(43)}`);
    expect(bad.status).toBe(404);
  });

  it("staff see the run with its steps and log", async () => {
    const list = await request(app()).get("/api/ops/provisioning").set(staff());
    expect(list.status).toBe(200);
    expect(list.body.runs[0]).toMatchObject({ id: runId, status: "done" });
    expect(list.body.runs[0].callback_token_hash).toBeUndefined();
    const one = await request(app()).get(`/api/ops/provisioning/runs/${runId}`).set(staff());
    expect(one.body.run.logs.length).toBeGreaterThan(5);
    expect(one.body.status_page).toMatch(/\/signup\/success\?p=[A-Za-z0-9_-]{43}$/);
    const page = await request(app()).get("/ops/provisioning");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Mark done manually");
    expect(one.body.run.twilio.account).toMatchObject({ status: "active", sign_in_codes: true, bundle: "Not needed for this country" });
    expect(JSON.stringify(one.body.run.twilio)).not.toMatch(/auth_token|secret|v1:/);
    expect(one.body.run.twilio.texting.find((t: any) => t.kind === "toll_free")).toMatchObject({ status: "pending", on_server: true });
  });

  it("the texting status follows Twilio and staff can resubmit; the opt-in page is public", async () => {
    // KS_OPS_TWILIO_AUTO_v1
    const { refreshTexting } = await import("../../src/twilio/lifecycle.js");
    [...twilio.tfv.values()][0].status = "TWILIO_APPROVED";
    await pool.query("UPDATE texting_registrations SET next_check_at = now() - interval '1 minute'");
    expect(await refreshTexting(deps)).toMatchObject({ checked: 1, pushed: 1 });
    expect(server.texting.at(-1).registrations.find((r: any) => r.kind === "toll_free")).toMatchObject({ status: "approved" });
    const again = await request(app()).post(`/api/ops/provisioning/twilio/${licenseeId}/texting/resubmit`).set(staff());
    expect(again.status).toBe(200);
    expect(again.body.texting.find((t: any) => t.kind === "toll_free").status).toBe("approved");
    expect(twilio.tfv.size).toBe(1);
    const page = await request(app()).get("/api/public/texting-opt-in/acme");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Text me updates about my application");
    expect((await request(app()).get("/api/public/texting-opt-in/nobody")).status).toBe(404);
  });

  it("the sub-account is suspended with the licensee, and its row cannot be deleted silently", async () => {
    const { syncAccountStatuses } = await import("../../src/twilio/lifecycle.js");
    await pool.query("UPDATE licensees SET status = 'suspended' WHERE id = $1", [licenseeId]);
    expect((await syncAccountStatuses(deps)).changed).toEqual(["acme:suspended"]);
    expect((await pool.query("SELECT account_status FROM licensee_twilio WHERE licensee_id = $1", [licenseeId])).rows[0].account_status).toBe("suspended");
    await expect(pool.query("DELETE FROM licensees WHERE id = $1", [licenseeId])).rejects.toThrow(/licensee_twilio/);
    await pool.query("UPDATE licensees SET status = 'active' WHERE id = $1", [licenseeId]);
    await syncAccountStatuses(deps);
  });

  it("teardown waits for setup and is refused for a licensee that is not cancelled", async () => {
    const res = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: licenseeId, kind: "teardown" });
    expect(res.status).toBe(409);
  });
});
