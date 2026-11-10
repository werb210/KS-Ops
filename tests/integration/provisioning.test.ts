// KS_OPS_AUTO_PROVISION_v1 - the whole automatic setup against a real Postgres: staff start a run, the (faked) GitHub
// workflow reports its steps through the callback routes, KS-Ops checks health, pushes the plan, creates the admin and
// emails the sign-in link. GitHub, Twilio and the brokerage's server are faked through fetch.
// KS_SHARED_HOSTING_v1 - the brokerage's database, role and registry row are REAL: made on this Postgres server by a
// non-superuser admin (tests/integration/sharedPg.ts), exactly as on ks-shared-pg; then the purge removes them.
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { insertLicensee, newSignupToken } from "../../src/licensees/repo.js";
import { machineDeps } from "../../src/provisioning/index.js";
import { advanceRun } from "../../src/provisioning/machine.js";
import { statusTokenFor } from "../../src/provisioning/statusToken.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";
import { FakeTwilio, MASTER_SID, MASTER_TOKEN } from "../unit/twilioFake.js"; // KS_OPS_TWILIO_AUTO_v1
import { adminUrl, controlOwnerUrl, controlReaderUrl, queryOnce, resetSharedLayout, urlAs } from "./sharedPg.js";
import { migrateControlDatabase } from "../../src/tenants/migrate.js";
import { tenantKey } from "../../src/tenants/crypto.js";
import { getTenant, tenantDatabaseUrl, tenantEnv } from "../../src/tenants/repo.js";
import { productionShared } from "../../src/tenants/shared.js";
import { databaseDrop, sitesDelete, tenantDelete } from "../../src/provisioning/sharedSteps.js";
import type { ExecCtx } from "../../src/provisioning/executors.js";

let pool: pg.Pool;
const dispatches: Array<{ url: string; inputs: Record<string, string> }> = [];
const server = { planPuts: 0, admins: [] as any[], users: [] as any[], phone: [] as any[], texting: [] as any[], tenantCalls: [] as string[], tenantHeaders: [] as string[] };
const API = "https://acme.api.keystone.test";
const twilio = new FakeTwilio();

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (/^https:\/\/[a-z]+\.twilio\.com\//.test(url)) return twilio.fetch(url, init); // KS_OPS_TWILIO_AUTO_v1
  // KS_SHARED_HOSTING_v1 - the shared server's service routes, and the brokerage's own host names.
  if (url.startsWith("https://ks-shared-server.azurewebsites.net/api/ops/tenants/")) {
    if (new Headers(init.headers).get("X-KS-Ops-Service-Key") !== "it-service-key") return jsonResponse({ error: "unauthorized" }, 401);
    server.tenantCalls.push(url.replace("https://ks-shared-server.azurewebsites.net", ""));
    return jsonResponse({ ok: true });
  }
  // The custom-domain check asks the bare host on purpose (it proves the Host name is bound); the rest name the brokerage.
  if (url.startsWith(`${API}/api/`)) server.tenantHeaders.push(String(new Headers(init.headers).get("X-KS-Tenant")));
  if (url === "https://ks-shared-agent.azurewebsites.net/health") return jsonResponse({ status: "ok" });
  if (url === "https://acme.portal.keystone.test/" || url === "https://acme.app.keystone.test/") return new Response('<!doctype html><div id="root"></div>', { status: 200 });
  if (url === `${API}/api/provision/texting`) {
    server.texting.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true });
  }
  if (url.startsWith("https://api.github.com/") && url.endsWith("/dispatches")) {
    dispatches.push({ url, inputs: JSON.parse(String(init.body)).inputs });
    return new Response(null, { status: 204 });
  }
  if (url === `${API}/health`) return jsonResponse({ status: "ok" });
  if (url === `${API}/api/plan` && init.method === "PUT") {
    server.planPuts += 1;
    return jsonResponse({ ok: true });
  }
  if (url === `${API}/api/provision/admin`) {
    server.admins.push(JSON.parse(String(init.body)));
    return jsonResponse({ ok: true, created: true, user_id: "u1" }, 201);
  }
  if (url === `${API}/api/provision/users`) { // KS_OPS_ONBOARDING_v1
    const users = JSON.parse(String(init.body)).users as Array<{ email: string }>;
    server.users.push(...users);
    return jsonResponse({ ok: true, results: users.map((u, i) => ({ email: u.email, status: "created", user_id: `team-${i}` })) });
  }
  if (url === `${API}/api/provision/phone-numbers`) { // KS_OPS_PHONE_PROVISIONING
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

const SHARED_ENV: Record<string, string> = {
  KS_TENANT_KEY: "it-tenant-key",
  KS_SHARED_SERVER_URL: "https://ks-shared-server.azurewebsites.net",
  KS_SHARED_AGENT_URL: "https://ks-shared-agent.azurewebsites.net",
  KS_OPS_SERVICE_KEY: "it-service-key",
  KS_DOMAIN: "keystone.test",
};
const KEY = tenantKey("it-tenant-key")!;
let control: pg.Pool;

beforeAll(async () => {
  // KS_SHARED_HOSTING_v1 - the shared layout on this server, and the registry migrated as ks_control_owner.
  await resetSharedLayout(["acme"]);
  Object.assign(process.env, SHARED_ENV, { KS_CONTROL_OWNER_DATABASE_URL: controlOwnerUrl(), KS_SHARED_PG_ADMIN_URL: adminUrl() });
  expect(await migrateControlDatabase()).toEqual(["001_ks_tenants.sql"]);
  expect(await migrateControlDatabase()).toEqual([]);
  control = new pg.Pool({ connectionString: controlOwnerUrl(), max: 2 });
  process.env.KS_PROVISION_GITHUB_TOKEN = "github_pat_test";
  process.env.KS_OPS_PUBLIC_URL = "https://ks-ops.example.test";
  process.env.KS_TWILIO_ACCOUNT_SID = MASTER_SID;
  process.env.KS_TWILIO_AUTH_TOKEN = MASTER_TOKEN;
  pool = await freshPool();
  await pool.query("TRUNCATE licensee_twilio, texting_registrations");
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => {
  for (const k of [...Object.keys(SHARED_ENV), "KS_CONTROL_OWNER_DATABASE_URL", "KS_SHARED_PG_ADMIN_URL"]) delete process.env[k];
  await control.end();
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

  it("staff start a run: the database, registry and shared server first, then the GitHub workflow once", async () => {
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
    expect(res.body.run.steps.map((s: any) => s.step)).toEqual(["twilio_account", "twilio_address", "database", "tenant_registry", "twilio_settings", "workspace_apps", "shared_server", "github_environments", "deploy_registry", "deploy", "custom_domains", "health", "configure", "admin_user", "welcome_email", "licence_agreement", "team_users", "onboarding_email", "twilio_voice", "twilio_bundle", "phone_numbers", "texting_registration"]);
    await until(async () => dispatches.length > 0, "the dispatch");
    expect(dispatches[0].url).toBe("https://api.github.com/repos/werb210/KS-Ops/actions/workflows/provision-licensee.yml/dispatches");
    expect(dispatches[0].inputs).toMatchObject({ run_id: runId, code: "acme", steps: "github_environments,deploy_registry,deploy" });
    expect(server.tenantCalls).toEqual(["/api/ops/tenants/reload", "/api/ops/tenants/acme/migrate"]);
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
    expect(ok.body).toMatchObject({ code: "acme", company_name: "Acme Lending", region: "canadacentral", plan: "growth", server_url: API, portal_url: "https://acme.portal.keystone.test", client_url: "https://acme.app.keystone.test" });
    // No secret is handed to the workflow any more.
    for (const p of ["ops-key", "twilio-settings", "workspace-settings"]) {
      expect((await request(app()).post(`/api/provisioning/callback/${runId}/${p}`).set("Authorization", `Bearer ${token}`)).status).toBe(404);
    }
  });

  it("the brokerage has its own database that only its role can open, and an encrypted registry row", async () => {
    const row = (await getTenant(control, "acme"))!;
    expect(row).toMatchObject({ licensee_id: licenseeId, status: "provisioning", database_name: "ks_acme", api_hosts: ["acme.api.keystone.test"], portal_hosts: ["acme.portal.keystone.test"], client_hosts: ["acme.app.keystone.test"] });
    expect(row.database_url_enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const raw = (await control.query("SELECT env_enc, database_url_enc FROM ks_tenants WHERE code = 'acme'")).rows[0];
    expect(JSON.stringify(raw)).not.toMatch(/JWT_SECRET|ks_acme_app|TWILIO/);
    const env = tenantEnv(row, KEY);
    const sub = [...twilio.accounts.values()].find((a) => a.parent === MASTER_SID)!;
    expect(env).toMatchObject({ KS_LICENSEE_ID: licenseeId, KS_SERVER_URL: API, KS_PORTAL_URL: "https://acme.portal.keystone.test", MAYA_URL: "https://ks-shared-agent.azurewebsites.net", TWILIO_ACCOUNT_SID: sub.sid, TWILIO_AUTH_TOKEN: sub.auth_token, KS_PLAN: "growth" });
    expect(env.KS_OPS_KEY).toMatch(/^ksops_/);
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    const l = (await pool.query("SELECT server_url, portal_url, client_url, ops_key_hash FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    expect(l).toMatchObject({ server_url: API, portal_url: "https://acme.portal.keystone.test", client_url: "https://acme.app.keystone.test" });

    // The brokerage's role connects to its own database and can make tables there (its migrations run as it).
    const url = tenantDatabaseUrl(row, KEY);
    const own = new pg.Client({ connectionString: url });
    await own.connect();
    const who = await own.query("SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user");
    expect(who.rows[0]).toMatchObject({ current_user: "ks_acme_app", rolsuper: false });
    await own.query("CREATE TABLE IF NOT EXISTS it_probe (id int)");
    await own.end();
    // Nobody else can connect to it, and it cannot connect to the registry.
    await expect(queryOnce(urlAs("ks_it_intruder", "it-password", "ks_acme"), "SELECT 1")).rejects.toThrow(/permission denied/);
    const pw = decodeURIComponent(new URL(url).password);
    await expect(queryOnce(urlAs("ks_acme_app", pw, "ks_control_it"), "SELECT 1")).rejects.toThrow(/permission denied/);
    // The readers can read the registry and nothing else.
    expect((await queryOnce(controlReaderUrl(), "SELECT count(*)::int AS n FROM ks_tenants")).rows[0].n).toBe(1);
    await expect(queryOnce(controlReaderUrl(), "DELETE FROM ks_tenants")).rejects.toThrow(/permission denied/);
  });

  it("the workflow reports its web build steps", async () => {
    const cb = (body: object) => request(app()).post(`/api/provisioning/callback/${runId}`).set("Authorization", `Bearer ${token}`).send(body);
    expect((await cb({ step: "github_environments", status: "running" })).status).toBe(200);
    expect((await cb({ step: "github_environments", status: "done", output: { secret: "never stored", pull_requests: [] } })).status).toBe(200);
    const out = (await pool.query("SELECT output FROM provisioning_steps WHERE run_id = $1 AND step = 'github_environments'", [runId])).rows[0].output;
    expect(out).toEqual({ pull_requests: [] });
    expect((await cb({ step: "health", status: "done" })).status).toBe(400); // not a workflow step
    for (const step of ["deploy_registry", "deploy"]) expect((await cb({ step, status: "done" })).status).toBe(200);
  });

  // KS_OPS_ONBOARDING_v1 - the run waits for the licence agreement; the team is saved, then the owner signs.
  it("waits for the licence agreement before inviting the team, and the roster can still be changed", async () => {
    const md = machineDeps(deps);
    await until(async () => {
      await advanceRun(md, runId);
      const steps = (await pool.query("SELECT step, status FROM provisioning_steps WHERE run_id = $1", [runId])).rows;
      return steps.find((x) => x.step === "licence_agreement")?.status === "running";
    }, "the agreement gate");
    const l = (await pool.query("SELECT agreement_link_sent_at FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    expect(l.agreement_link_sent_at).toBeTruthy();
    expect(mail.sent.find((m) => /^Please sign the Keystone Software Licence Agreement/.test(m.subject))?.to).toEqual(["ana@acme.example"]);
    expect(server.users).toEqual([]);
    const team = [
      { full_name: "Bob Broker", email: "bob@acme.example", phone: "587 555 0101", role: "Broker" },
      { full_name: "Mia Market", email: "mia@acme.example", phone: "15875550102", role: "Marketing" },
    ];
    await pool.query("UPDATE licensees SET seats = 3 WHERE id = $1", [licenseeId]); // the owner and two more
    // Saved twice: the replace keeps one row per person (the unique indexes hold inside the one statement).
    for (let i = 0; i < 2; i++) expect((await request(app()).put(`/api/ops/licensees/${licenseeId}/team`).set(staff()).send({ team })).status).toBe(200);
    const rows = (await pool.query("SELECT position, email, phone_e164, role, is_owner FROM licensee_team WHERE licensee_id = $1 ORDER BY position", [licenseeId])).rows;
    expect(rows).toEqual([
      { position: 0, email: "ana@acme.example", phone_e164: "+14035550123", role: "Admin", is_owner: true },
      { position: 1, email: "bob@acme.example", phone_e164: "+15875550101", role: "Broker", is_owner: false },
      { position: 2, email: "mia@acme.example", phone_e164: "+15875550102", role: "Marketing", is_owner: false },
    ]);
    const tooMany = await request(app()).put(`/api/ops/licensees/${licenseeId}/team`).set(staff()).send({ team: [...team, { full_name: "Ex Tra", email: "x@acme.example", phone: "5875550103", role: "Broker" }] });
    expect(tooMany.status).toBe(400);
    // The owner signs on the website.
    const token = await newSignupToken(pool, licenseeId);
    const shown = (await request(app()).get(`/api/public/signup/${licenseeId}/agreement?token=${token}`)).body;
    expect(shown.text).toContain("Acme Lending Inc.");
    const signed = await request(app()).post(`/api/public/signup/${licenseeId}/agreement?token=${token}`).send({ signer_name: "Ana Acme", signer_title: "President", agree: true, sha256: shown.sha256 });
    expect(signed.status).toBe(201);
    const a = (await pool.query("SELECT signer_name, signer_title, signer_email, text_sha256, emailed_at FROM licence_agreements WHERE licensee_id = $1", [licenseeId])).rows[0];
    expect(a).toMatchObject({ signer_name: "Ana Acme", signer_title: "President", signer_email: "ana@acme.example", text_sha256: shown.sha256 });
    expect(a.emailed_at).toBeTruthy();
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
    expect([...twilio.apps.values()][0].voice_url).toBe(`${API}/api/webhooks/twilio/voice/twiml`);
    // Every call to the brokerage named it.
    expect(server.tenantHeaders.length).toBeGreaterThan(3);
    expect(new Set(server.tenantHeaders)).toEqual(new Set(["acme"]));
    // The registry follows the licensee's status.
    expect((await getTenant(control, "acme"))!.status).toBe("active");
    const regs = (await pool.query("SELECT kind, status, phone_number, verification_sid, pushed_status FROM texting_registrations WHERE licensee_id = $1 ORDER BY kind", [licenseeId])).rows;
    expect(regs).toEqual([
      { kind: "a2p_10dlc", status: "not_needed", phone_number: "+14035550111", verification_sid: null, pushed_status: "not_needed" },
      { kind: "toll_free", status: "pending", phone_number: "+18885550111", verification_sid: expect.stringMatching(/^HH/), pushed_status: "pending" },
    ]);
    expect(server.texting[0].registrations.find((r: any) => r.kind === "toll_free").message).toMatch(/approval pending with carriers/);
    expect(mail.sent.find((m) => /your Keystone system is ready/.test(m.subject))?.to).toEqual(["ana@acme.example"]);
    // KS_OPS_ONBOARDING_v1 - the team made on the server and invited (not the owner), and the owner's onboarding email.
    expect(server.users.map((u) => [u.email, u.role, u.phone])).toEqual([["bob@acme.example", "Broker", "+15875550101"], ["mia@acme.example", "Marketing", "+15875550102"]]);
    expect(mail.sent.filter((m) => /invited you to Keystone/.test(m.subject)).map((m) => m.to[0])).toEqual(["bob@acme.example", "mia@acme.example"]);
    const onboarding = mail.sent.filter((m) => /meet your onboarding contact/.test(m.subject));
    expect(onboarding).toHaveLength(1);
    expect(onboarding[0].text).toContain("one 30-minute kickoff call");
    const invited = (await pool.query("SELECT count(*)::int AS n FROM licensee_team WHERE licensee_id = $1 AND invite_sent_at IS NOT NULL AND provisioned_at IS NOT NULL", [licenseeId])).rows[0];
    expect(invited.n).toBe(2);
    // Locked now: changes go through the brokerage's own portal.
    expect((await request(app()).put(`/api/ops/licensees/${licenseeId}/team`).set(staff()).send({ team: [] })).status).toBe(409);
    const l = (await pool.query("SELECT status FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    expect(l.status).toBe("active");
    // The token stops working once the run is done.
    const res = await request(app()).get(`/api/provisioning/callback/${runId}/context`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("the website's status page shows the portal once ready; a bad token shows nothing", async () => {
    const res = await request(app()).get(`/api/public/provisioning/${statusTokenFor(licenseeId)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "ready", company_name: "Acme Lending", portal_url: "https://acme.portal.keystone.test", email_sent: true });
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
    // KS_SHARED_HOSTING_v1 - the database, registry entry and custom domains, in plain words, with the commands.
    expect(one.body.run.steps.find((x: any) => x.step === "database").plain).toBe("Done.");
    expect(one.body.run.shared).toMatchObject({ database: { database: "ks_acme", role: "ks_acme_app" }, registry: { state: "present", status: "active" }, custom_domains: { configured: true, domain: "keystone.test" } });
    expect(one.body.run.shared.custom_domains.commands[0]).toBe("gh api repos/werb210/KS-Ops/contents/scripts/bind-brokerage-domains.sh -q .content | base64 -d > ~/bind.sh && bash ~/bind.sh acme");
    expect(one.body.run.shared.custom_domains.commands[1]).toBe("az webapp config hostname add -g ks-shared --webapp-name ks-shared-server --hostname acme.api.keystone.test");
    const env = tenantEnv((await getTenant(control, "acme"))!, KEY);
    const shown = JSON.stringify(one.body.run);
    for (const k of ["JWT_SECRET", "OTP_HASH_SALT", "KS_OPS_KEY", "TWILIO_AUTH_TOKEN"]) expect(shown).not.toContain(env[k]);
    expect(shown).not.toMatch(/ks_acme_app:|it-password|v1:[A-Za-z0-9+/=]{8,}:/);
    expect(page.text).toContain("Custom domains");
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
    // KS_SHARED_HOSTING_v1 - and the registry's status follows on the worker's sync.
    const { syncTenantStatuses } = await import("../../src/tenants/repo.js");
    await pool.query("UPDATE licensees SET status = 'suspended' WHERE id = $1", [licenseeId]);
    expect(await syncTenantStatuses(control, pool)).toEqual({ changed: 1, failed: 0 });
    expect((await getTenant(control, "acme"))!.status).toBe("suspended");
    await pool.query("UPDATE licensees SET status = 'active' WHERE id = $1", [licenseeId]);
    await syncTenantStatuses(control, pool);
  });

  it("teardown waits for setup and is refused for a licensee that is not cancelled", async () => {
    const res = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: licenseeId, kind: "teardown" });
    expect(res.status).toBe(409);
  });

  it("the purge drops the database and role, deletes the published apps and the registry row", async () => {
    const l = (await pool.query("SELECT * FROM licensees WHERE id = $1", [licenseeId])).rows[0];
    const blobs = new Set(["acme/portal/index.html", "acme/client/index.html", "acme-two/portal/index.html"]);
    const shared = { ...productionShared(), sites: () => ({ async deletePrefix(p: string) { const gone = [...blobs].filter((b) => b.startsWith(p)); gone.forEach((b) => blobs.delete(b)); return gone.length; } }) };
    const ctx = (step: string) => ({
      deps: { ...machineDeps(deps), shared }, run: { id: runId }, step: { step, started_at: new Date() }, licensee: { ...l, status: "cancelled" }, outputs: {}, log: async () => {},
    }) as unknown as ExecCtx;
    expect(await databaseDrop(ctx("database_drop"))).toMatchObject({ kind: "done", output: { database_dropped: true, role_dropped: true } });
    expect((await pool.query("SELECT 1 FROM pg_database WHERE datname = 'ks_acme'")).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ks_acme_app'")).rows).toHaveLength(0);
    expect(await sitesDelete(ctx("sites_delete"))).toMatchObject({ kind: "done", output: { deleted: 2 } });
    expect([...blobs]).toEqual(["acme-two/portal/index.html"]);
    expect(await tenantDelete(ctx("tenant_delete"))).toMatchObject({ kind: "done", output: { deleted: true } });
    expect(await getTenant(control, "acme")).toBeNull();
    expect(server.tenantCalls.at(-1)).toBe("/api/ops/tenants/reload");
  });
});
