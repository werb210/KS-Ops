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

let pool: pg.Pool;
const dispatches: Array<{ url: string; inputs: Record<string, string> }> = [];
const server = { planPuts: 0, admins: [] as any[] };

const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
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
  return new Response("unexpected", { status: 500 });
});

const mail = fakeMailer();
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

beforeAll(async () => {
  process.env.KS_PROVISION_GITHUB_TOKEN = "github_pat_test";
  process.env.KS_OPS_PUBLIC_URL = "https://ks-ops.example.test";
  pool = await freshPool();
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => {
  delete process.env.KS_PROVISION_GITHUB_TOKEN;
  delete process.env.KS_OPS_PUBLIC_URL;
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
      status: "provisioning", plan: "growth", billing_interval: "monthly", support_level: "email", seats: 2,
      extra_storage_blocks: 0, source: "staff",
    });
    licenseeId = l.id;
    const res = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: l.id });
    expect(res.status).toBe(201);
    runId = res.body.run.id;
    expect(res.body.run.steps.map((s: any) => s.step)).toEqual(["azure_resources", "secrets", "github_environments", "deploy_registry", "deploy", "health", "configure", "admin_user", "welcome_email"]);
    await until(async () => dispatches.length > 0, "the dispatch");
    expect(dispatches[0].url).toBe("https://api.github.com/repos/werb210/KS-Ops/actions/workflows/provision-licensee.yml/dispatches");
    expect(dispatches[0].inputs).toMatchObject({ run_id: runId, code: "acme", steps: "azure_resources,secrets,github_environments,deploy_registry,deploy" });
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
    for (const step of ["secrets", "github_environments", "deploy_registry", "deploy"]) expect((await cb({ step, status: "done" })).status).toBe(200);
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
  });

  it("teardown waits for setup and is refused for a licensee that is not cancelled", async () => {
    const res = await request(app()).post("/api/ops/provisioning").set(staff()).send({ licensee_id: licenseeId, kind: "teardown" });
    expect(res.status).toBe(409);
  });
});
