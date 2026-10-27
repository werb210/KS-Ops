// KS_OPS_WORKSPACE_APPS - Keystone's one Microsoft 365 app and one Google client: the settings KS-Ops pushes to each
// licensee server (only while the workspace_apps step runs, masked in the workflow), the redirect broker that forwards
// Microsoft's and Google's callbacks to the right licensee server, and what /ops/provisioning shows.
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokerBaseUrl, workspaceAppSettings } from "../../src/workspace/apps.js";
import { brokerTarget, FLOW_PATHS, parseBrokerState } from "../../src/workspace/broker.js";
import { workspaceSummary } from "../../src/workspace/status.js";
import { oauthBrokerRouter } from "../../src/routes/oauthBroker.js";
import { advanceRun, handleCallback, startRun, workspaceSettingsForWorkflow } from "../../src/provisioning/machine.js";
import { PROVISION_STEPS, describePlan } from "../../src/provisioning/steps.js";
import { workspaceApps, type RunnerConfig, type RunnerDeps } from "../../src/provisioning/runner/runner.js";
import { encryptionKey, encryptSecret } from "../../src/lib/crypto.js";
import { configuredEnv, licensee, LICENSEE_ID, machine } from "./provisioningFakes.js";
import type { Deps } from "../../src/deps.js";

const KEY_HEX = "a".repeat(64);
const OPS_KEY = "ksops_secret_key_for_prairie";
const SERVER = "https://ks-prairie-server.azurewebsites.net";
const NOW = Date.parse("2026-10-26T12:00:00Z");
const INNER = "n".repeat(43);

/** Exactly what KS-server's src/licensee/oauthBroker.ts wrapState produces. */
function serverState(flow: string, opts: { id?: string; key?: string; exp?: number; inner?: string } = {}) {
  const body = `ks1.${opts.id ?? LICENSEE_ID}.${flow}.${opts.exp ?? Math.floor(NOW / 1000) + 600}.${opts.inner ?? INNER}`;
  return `${body}.${createHmac("sha256", opts.key ?? OPS_KEY).update(body, "utf8").digest("base64url")}`;
}

beforeEach(() => { vi.stubEnv("OPS_ENCRYPTION_KEY", KEY_HEX); });
afterEach(() => { vi.unstubAllEnvs(); });

const withKey = () => licensee({ server_url: SERVER, status: "active", ops_key_encrypted: encryptSecret(OPS_KEY, encryptionKey(KEY_HEX)!) });

describe("settings pushed to every licensee server", () => {
  const all = {
    KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret",
    KS_GOOGLE_OAUTH_CLIENT_ID: "g-id", KS_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret",
    KS_OPS_PUBLIC_URL: "https://ops.keystone.example",
  };

  it("hands over both apps' keys and the broker address", () => {
    expect(workspaceAppSettings(all)).toEqual({
      settings: { ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== "KS_OPS_PUBLIC_URL")), KS_OAUTH_BROKER_URL: "https://ops.keystone.example/api/oauth/callback" },
      missing: [],
    });
  });

  it("leaves out an app KS-Ops does not have yet and says so (never a failure)", () => {
    const r = workspaceAppSettings({ KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret", KS_OPS_PUBLIC_URL: "https://ops.keystone.example" });
    expect(Object.keys(r.settings)).toEqual(["KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "KS_OAUTH_BROKER_URL"]);
    expect(r.missing).toEqual([expect.stringMatching(/^Google Workspace/)]);
    expect(workspaceAppSettings({})).toEqual({ settings: {}, missing: [expect.stringMatching(/^Microsoft 365/), expect.stringMatching(/^Google Workspace/)] });
  });

  it("an explicit broker address wins; without an https address there is none", () => {
    expect(brokerBaseUrl({ KS_OAUTH_BROKER_URL: "https://login.keystone.example/cb/", KS_OPS_PUBLIC_URL: "https://ops.keystone.example" })).toBe("https://login.keystone.example/cb");
    expect(brokerBaseUrl({ KS_OPS_PUBLIC_URL: "http://localhost:8080" })).toBe("");
  });

  it("is a workflow step right after the Twilio settings, in the dry-run plan too", () => {
    const keys = PROVISION_STEPS.map((s) => s.key);
    expect(keys.indexOf("workspace_apps")).toBe(keys.indexOf("twilio_settings") + 1);
    expect(PROVISION_STEPS.find((s) => s.key === "workspace_apps")!.where).toBe("workflow");
    expect(describePlan("provision", "prairie").find((l) => l.startsWith("workspace_apps:"))).toMatch(/KS_M365_CLIENT_ID.*ks-prairie-server/);
  });

  it("the workflow gets them only while workspace_apps runs", async () => {
    const env = configuredEnv({ KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret" });
    const m = machine(licensee(), { executors: Object.fromEntries(["twilio_account", "twilio_address"].map((k) => [k, vi.fn(async () => ({ kind: "done" as const }))])) }, env);
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    let r = (await m.store.getRun(run.id))!;
    expect(r.workflow_steps).toContain("workspace_apps");
    expect(await workspaceSettingsForWorkflow(m.deps, r)).toEqual({ ok: false, status: 409, error: "not_now" });
    for (const step of ["azure_resources", "twilio_settings"]) await handleCallback(m.deps, r, { step, status: "done", output: {} });
    await handleCallback(m.deps, r, { step: "workspace_apps", status: "running" });
    r = (await m.store.getRun(run.id))!;
    const got = await workspaceSettingsForWorkflow(m.deps, r);
    expect(got).toMatchObject({ ok: true, settings: { KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret", KS_OAUTH_BROKER_URL: "https://ks-ops.example.test/api/oauth/callback" } });
    expect(m.store.logRows.map((l) => l.message).join("\n")).toMatch(/Google Workspace.*Retry this step/);
    expect(m.store.logRows.map((l) => l.message).join("\n")).not.toContain("ms-secret");
    await handleCallback(m.deps, r, { step: "workspace_apps", status: "done", output: { written: ["KS_M365_CLIENT_ID"], not_set_up: ["Google"], secret: "x" } });
    const out = (await m.store.steps(run.id)).find((s) => s.step === "workspace_apps")!.output;
    expect(out).toEqual({ written: ["KS_M365_CLIENT_ID"], not_set_up: ["Google"] });
  });

  it("the workflow writes only the known names to the licensee's KS-server and masks the secrets", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const logs: string[] = [];
    const settings = { KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret", KS_GOOGLE_OAUTH_CLIENT_ID: "g-id", KS_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret", KS_OAUTH_BROKER_URL: "https://ops.example/api/oauth/callback", DATABASE_URL: "postgres://evil" };
    const deps = {
      exec, log: (x: string) => logs.push(x), env: {}, sleep: async () => {}, now: () => new Date(), readFile: async () => "", tempFile: (n: string) => n,
      fetch: vi.fn(async () => new Response(JSON.stringify({ settings, missing: [] }), { status: 200 })),
    } as unknown as RunnerDeps;
    const cfg = { opsUrl: "https://ks-ops.example.test", runId: LICENSEE_ID, token: "t", steps: [], dryRun: false, owner: "werb210", ghToken: "g", mode: "provision" } as RunnerConfig;
    const out = await workspaceApps(deps, cfg, { code: "prairie" } as never);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(0, 7)).toEqual(["webapp", "config", "appsettings", "set", "-g", "ks-prairie", "-n"]);
    expect(args).toContain("KS_M365_CLIENT_SECRET=ms-secret");
    expect(args.some((a) => a.startsWith("DATABASE_URL"))).toBe(false);
    expect(logs).toContain("::add-mask::ms-secret");
    expect(logs).toContain("::add-mask::g-secret");
    expect(out).toEqual({ written: ["KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "KS_GOOGLE_OAUTH_CLIENT_ID", "KS_GOOGLE_OAUTH_CLIENT_SECRET", "KS_OAUTH_BROKER_URL"], not_set_up: [] });
  });

  it("nothing to write: no az call, and the step still finishes", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const deps = {
      exec, log: () => {}, env: {}, sleep: async () => {}, now: () => new Date(), readFile: async () => "", tempFile: (n: string) => n,
      fetch: vi.fn(async () => new Response(JSON.stringify({ settings: {}, missing: ["Microsoft 365", "Google Workspace"] }), { status: 200 })),
    } as unknown as RunnerDeps;
    const out = await workspaceApps(deps, { opsUrl: "https://x.test", runId: LICENSEE_ID, token: "t" } as RunnerConfig, { code: "prairie" } as never);
    expect(exec).not.toHaveBeenCalled();
    expect(out).toEqual({ written: [], not_set_up: ["Microsoft 365", "Google Workspace"] });
  });
});

describe("redirect broker", () => {
  const rec = { server_url: SERVER, ops_key: OPS_KEY };

  it("forwards each flow to the licensee's own callback with every parameter unchanged", () => {
    for (const [provider, flows] of Object.entries(FLOW_PATHS) as Array<["microsoft" | "google", Record<string, string>]>) {
      for (const [flow, path] of Object.entries(flows)) {
        const state = serverState(flow);
        const t = brokerTarget(provider, parseBrokerState(state), rec, { code: "CODE", state, session_state: "s" }, NOW);
        expect(t.ok).toBe(true);
        const u = new URL((t as { url: string }).url);
        expect(u.origin + u.pathname).toBe(SERVER + path);
        expect(u.searchParams.get("code")).toBe("CODE");
        expect(u.searchParams.get("state")).toBe(state);
        expect(u.searchParams.get("session_state")).toBe("s");
      }
    }
  });

  it("forwards Microsoft's admin consent answer and its errors (tenant, admin_consent, error_description)", () => {
    const state = serverState("consent");
    const ok = brokerTarget("microsoft", parseBrokerState(state), rec, { admin_consent: "True", tenant: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", state }, NOW);
    expect((ok as { url: string }).url).toContain("/api/o365-oauth/admin-consent/callback?admin_consent=True&tenant=aaaaaaaa");
    const no = brokerTarget("microsoft", parseBrokerState(state), rec, { error: "access_denied", error_description: "AADSTS65004: declined", state }, NOW);
    expect(new URL((no as { url: string }).url).searchParams.get("error_description")).toBe("AADSTS65004: declined");
  });

  it("refuses a tampered, expired, foreign or misrouted state", () => {
    const good = serverState("o365");
    expect(brokerTarget("microsoft", parseBrokerState(good.slice(0, -2) + "xx"), rec, {}, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(brokerTarget("microsoft", parseBrokerState(serverState("o365", { key: "another licensee's key" })), rec, {}, NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(brokerTarget("microsoft", parseBrokerState(serverState("o365", { exp: Math.floor(NOW / 1000) - 1 })), rec, {}, NOW)).toEqual({ ok: false, reason: "expired" });
    expect(brokerTarget("google", parseBrokerState(serverState("o365")), rec, {}, NOW)).toEqual({ ok: false, reason: "unknown_flow" });
    expect(brokerTarget("microsoft", parseBrokerState("just-a-nonce"), rec, {}, NOW)).toEqual({ ok: false, reason: "bad_state" });
    expect(brokerTarget("microsoft", parseBrokerState(good), null, {}, NOW)).toEqual({ ok: false, reason: "unknown_licensee" });
    expect(brokerTarget("microsoft", parseBrokerState(good), { server_url: "http://ks-prairie-server.azurewebsites.net", ops_key: OPS_KEY }, {}, NOW)).toEqual({ ok: false, reason: "no_server" });
  });

  describe("GET /api/oauth/callback/:provider", () => {
    function app(l = withKey()) {
      const db = { query: vi.fn(async (sql: string, p: unknown[] = []) => ({ rows: /FROM licensees WHERE id = \$1/.test(sql) && p[0] === l.id ? [l] : [] })) };
      const deps = { db, now: () => new Date(NOW) } as unknown as Deps;
      const a = express();
      a.use("/api/oauth/callback", oauthBrokerRouter(deps));
      return a;
    }

    it("redirects to the licensee server from KS-Ops's records, never leaking the code onward", async () => {
      const state = serverState("o365");
      const r = await request(app()).get(`/api/oauth/callback/microsoft?code=abc&state=${encodeURIComponent(state)}`);
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe(`${SERVER}/api/o365-oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["cache-control"]).toBe("no-store");
    });

    it("shows a readable page instead of forwarding a bad state", async () => {
      const r = await request(app()).get(`/api/oauth/callback/google?code=abc&state=${encodeURIComponent(serverState("google", { key: "wrong" }))}`);
      expect(r.status).toBe(400);
      expect(r.text).toContain("Sign-in could not continue");
      expect(r.text).toContain("This sign-in link is not valid.");
      expect(r.headers.location).toBeUndefined();
    });

    it("an unknown provider is a 404", async () => {
      expect((await request(app()).get("/api/oauth/callback/github?state=x")).status).toBe(404);
    });
  });
});

describe("what /ops/provisioning shows", () => {
  it("asks the licensee's server with the ops key and keeps only plain status (no names)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      ok: true,
      microsoft: { state: "connected", headline: "Connected to prairie.example on 2026-10-26.", domain: "prairie.example", staff_connected: 3, last_sync_at: "2026-10-26T11:00:00.000Z", missing_permissions: [] },
      google: { state: "not_connected", headline: "Nobody has connected Google yet.", domains: [], staff_connected: 0, last_sync_at: null },
      broker: true,
    }), { status: 200 }));
    const s = await workspaceSummary({ fetch: fetchImpl as unknown as typeof fetch }, withKey());
    expect(fetchImpl.mock.calls[0][0]).toBe(`${SERVER}/api/provision/connections`);
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>)["X-KS-Ops-Key"]).toBe(OPS_KEY);
    expect(s).toMatchObject({ ok: true, microsoft: { connected: true, staff_connected: 3, domain: "prairie.example" }, google: { connected: false }, broker: true });
  });

  it("explains an older server, a missing address or key, and an unreachable server", async () => {
    const f404 = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await workspaceSummary({ fetch: f404 }, withKey())).toEqual({ ok: false, message: expect.stringMatching(/older version/) });
    expect(await workspaceSummary({ fetch: f404 }, licensee())).toEqual({ ok: false, message: expect.stringMatching(/not set up yet/) });
    expect(await workspaceSummary({ fetch: f404 }, licensee({ server_url: SERVER }))).toEqual({ ok: false, message: expect.stringMatching(/No ops key/) });
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await workspaceSummary({ fetch: down }, withKey())).toEqual({ ok: false, message: expect.stringMatching(/Could not reach.*ECONNREFUSED/) });
  });
});
