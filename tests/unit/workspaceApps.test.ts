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
import { PROVISION_STEPS, describePlan } from "../../src/provisioning/steps.js";
import { workspaceApps } from "../../src/provisioning/sharedSteps.js";
import type { ExecCtx } from "../../src/provisioning/executors.js";
import { saveTenantDatabase, tenantEnv } from "../../src/tenants/repo.js";
import { tenantKey } from "../../src/tenants/crypto.js";
import { encryptionKey, encryptSecret } from "../../src/lib/crypto.js";
import { configuredEnv, fakeShared, licensee, LICENSEE_ID, machine } from "./provisioningFakes.js";
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

  it("hands over the Gmail inbox reading switch with the Google keys (off unless set to true)", () => {
    expect(workspaceAppSettings(all).settings.KS_GOOGLE_GMAIL_READ_ENABLED).toBeUndefined();
    expect(workspaceAppSettings({ ...all, KS_GOOGLE_GMAIL_READ_ENABLED: "true" }).settings.KS_GOOGLE_GMAIL_READ_ENABLED).toBe("true");
    expect(workspaceAppSettings({ ...all, KS_GOOGLE_GMAIL_READ_ENABLED: "no" }).settings.KS_GOOGLE_GMAIL_READ_ENABLED).toBe("false");
    const noGoogle = { KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret", KS_OPS_PUBLIC_URL: "https://ops.keystone.example", KS_GOOGLE_GMAIL_READ_ENABLED: "true" };
    expect(workspaceAppSettings(noGoogle).settings.KS_GOOGLE_GMAIL_READ_ENABLED).toBeUndefined();
  });

  it("an explicit broker address wins; without an https address there is none", () => {
    expect(brokerBaseUrl({ KS_OAUTH_BROKER_URL: "https://login.keystone.example/cb/", KS_OPS_PUBLIC_URL: "https://ops.keystone.example" })).toBe("https://login.keystone.example/cb");
    expect(brokerBaseUrl({ KS_OPS_PUBLIC_URL: "http://localhost:8080" })).toBe("");
  });

  // KS_SHARED_HOSTING_v1 - a KS-Ops step now: the keys go into the brokerage's encrypted env in the registry.
  it("is a KS-Ops step right after the Twilio settings, in the dry-run plan too", () => {
    const keys = PROVISION_STEPS.map((s) => s.key);
    expect(keys.indexOf("workspace_apps")).toBe(keys.indexOf("twilio_settings") + 1);
    expect(PROVISION_STEPS.find((s) => s.key === "workspace_apps")!.where).toBe("service");
    expect(describePlan("provision", "prairie").find((l) => l.startsWith("workspace_apps:"))).toMatch(/KS_M365_CLIENT_ID.*encrypted env/);
  });

  async function stepCtx(env: NodeJS.ProcessEnv) {
    const m = machine(licensee(), {}, env);
    const key = tenantKey("test-tenant-key")!;
    await saveTenantDatabase(m.sh.control, key, { code: "prairie", licensee_id: LICENSEE_ID, database_name: "ks_prairie", database_url: "postgresql://ks_prairie_app:pw@h/ks_prairie" });
    const logs: string[] = [];
    const ctx = { deps: m.deps, run: { id: "r1" }, step: { step: "workspace_apps" }, licensee: licensee(), outputs: {}, log: async (x: string) => { logs.push(x); } } as unknown as ExecCtx;
    return { m, key, ctx, logs };
  }

  it("saves the keys KS-Ops has, encrypted; what it lacks is logged, never a failure", async () => {
    const { m, key, ctx, logs } = await stepCtx(configuredEnv({ KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret" }));
    const out = await workspaceApps(ctx);
    expect(out).toMatchObject({ kind: "done", output: { written: ["KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "KS_OAUTH_BROKER_URL"], not_set_up: [expect.stringMatching(/^Google Workspace/)] } });
    expect(tenantEnv(m.sh.tenants.get("prairie")!, key)).toMatchObject({ KS_M365_CLIENT_ID: "ms-id", KS_M365_CLIENT_SECRET: "ms-secret", KS_OAUTH_BROKER_URL: "https://ks-ops.example.test/api/oauth/callback" });
    expect(logs.join("\n")).toMatch(/Google Workspace.*Retry this step/);
    expect(m.sh.control.calls.map((c) => JSON.stringify(c.params)).join("\n")).not.toContain("ms-secret");
  });

  it("nothing to save: the registry is not written, and the step still finishes", async () => {
    const { m, ctx } = await stepCtx(configuredEnv());
    const before = m.sh.control.calls.length;
    expect(await workspaceApps(ctx)).toMatchObject({ kind: "done", output: { written: [], not_set_up: [expect.stringMatching(/^Microsoft 365/), expect.stringMatching(/^Google Workspace/)] } });
    expect(m.sh.control.calls.length).toBe(before);
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
