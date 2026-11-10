// KS_SHARED_HOSTING_v1 - KS-Ops's part of the shared server: the registry's encryption, the tenants module, the
// database and role (safe quoting), the registry entry and env, the shared server's reload and migrate, the custom
// domains, the purge, and what /ops/provisioning shows. The databases, blob store and servers are all faked.
import { createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptEnv, decryptTenant, encryptEnv, encryptTenant, tenantKey } from "../../src/tenants/crypto.js";
import { databaseNames, defaultHosts, ksDomain, normalHost } from "../../src/tenants/config.js";
import { brokerageDatabaseUrl, ensureBrokerageDatabase, quoteIdent, quoteLiteral } from "../../src/tenants/database.js";
import { mergeHosts, saveTenantDatabase, syncTenantStatuses, tenantDatabaseUrl, tenantEnv } from "../../src/tenants/repo.js";
import { azCommands, bindingsFor, dnsRecords } from "../../src/tenants/domains.js";
import { customDomains, database, databaseDrop, NO_DOMAIN_MESSAGE, sharedServer, sitesDelete, tenantDelete, tenantRegistry } from "../../src/provisioning/sharedSteps.js";
import { health, type ExecCtx } from "../../src/provisioning/executors.js";
import { runView, startRun } from "../../src/provisioning/machine.js";
import { stepPlainWords } from "../../src/provisioning/sharedView.js";
import { encryptionKey, encryptSecret } from "../../src/lib/crypto.js";
import { configuredEnv, fakeShared, licensee, LICENSEE_ID, machine } from "./provisioningFakes.js";
import { fakeDb } from "../helpers.js";
import express from "express";
import request from "supertest";
import { opsProvisioningRouter } from "../../src/routes/opsProvisioning.js";
import type { Deps } from "../../src/deps.js";

const KEY = tenantKey("test-tenant-key")!;

function ctxFor(m: ReturnType<typeof machine>, step: string, l = m.state.l): ExecCtx {
  const logs: Array<{ m: string; level?: string }> = [];
  const c = {
    deps: m.deps,
    run: { id: "44444444-4444-4444-8444-444444444444" } as ExecCtx["run"],
    step: { step, started_at: new Date("2026-10-25T12:00:00Z") } as ExecCtx["step"],
    licensee: l,
    outputs: {},
    log: async (msg: string, level?: string) => { logs.push({ m: msg, level }); },
  } as ExecCtx;
  return Object.assign(c, { logs });
}

describe("registry encryption (the shared format)", () => {
  it("is v1:<iv>:<tag>:<ciphertext> in base64, AES-256-GCM with SHA-256(KS_TENANT_KEY), 12-byte IV", () => {
    const enc = encryptTenant("postgresql://x", KEY);
    const [v, iv, tag, ct] = enc.split(":");
    expect(v).toBe("v1");
    expect(Buffer.from(iv, "base64")).toHaveLength(12);
    expect(Buffer.from(tag, "base64")).toHaveLength(16);
    // Decrypted here by hand, exactly as the other repositories do it.
    const d = createDecipheriv("aes-256-gcm", createHash("sha256").update("test-tenant-key").digest(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    expect(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8")).toBe("postgresql://x");
    expect(decryptTenant(enc, KEY)).toBe("postgresql://x");
    expect(encryptTenant("same", KEY)).not.toBe(encryptTenant("same", KEY)); // random IV
  });

  it("refuses another key, a changed ciphertext and other formats", () => {
    const enc = encryptTenant("secret", KEY);
    expect(() => decryptTenant(enc, tenantKey("other")!)).toThrow();
    const parts = enc.split(":");
    expect(() => decryptTenant([...parts.slice(0, 3), Buffer.from("tampered").toString("base64")].join(":"), KEY)).toThrow();
    expect(() => decryptTenant("v1:" + Buffer.alloc(40).toString("base64"), KEY)).toThrow(/format/);
    expect(tenantKey("")).toBeNull();
  });

  it("env_enc is a JSON object of strings; empty is an empty object", () => {
    const enc = encryptEnv({ JWT_SECRET: "j", KS_PLAN: "growth" }, KEY);
    expect(JSON.parse(decryptTenant(enc, KEY))).toEqual({ JWT_SECRET: "j", KS_PLAN: "growth" });
    expect(decryptEnv(enc, KEY)).toEqual({ JWT_SECRET: "j", KS_PLAN: "growth" });
    expect(decryptEnv("", KEY)).toEqual({});
    expect(() => decryptEnv(encryptTenant("[1]", KEY), KEY)).toThrow(/object/);
  });
});

describe("names and hosts", () => {
  it("database ks_<code with - as _> and role ks_<...>_app; codes the registry cannot hold are refused", () => {
    expect(databaseNames("north-wind")).toEqual({ database: "ks_north_wind", role: "ks_north_wind_app" });
    expect(() => databaseNames("a".repeat(32))).toThrow(/invalid_tenant_code/);
    expect(() => databaseNames("x\"; DROP")).toThrow();
  });

  it("host names are lowercase with no scheme or port; KS_DOMAIN gives api, portal and app hosts", () => {
    expect(normalHost("HTTPS://Apply.NorthwindCapital.ca:443/x")).toBe("apply.northwindcapital.ca");
    expect(normalHost("not a host")).toBe("");
    expect(ksDomain({ KS_DOMAIN: ".Keystone.Example." })).toBe("keystone.example");
    expect(ksDomain({ KS_DOMAIN: "bad domain" })).toBe("");
    expect(defaultHosts("northwind", "keystone.example")).toEqual({ api: ["northwind.api.keystone.example"], portal: ["northwind.portal.keystone.example"], client: ["northwind.app.keystone.example"] });
    expect(defaultHosts("northwind", "")).toEqual({ api: [], portal: [], client: [] });
    expect(mergeHosts({ api_hosts: [], portal_hosts: [], client_hosts: ["apply.northwindcapital.ca"] }, defaultHosts("northwind", "keystone.example")).client)
      .toEqual(["apply.northwindcapital.ca", "northwind.app.keystone.example"]);
  });
});

describe("database and role (safe quoting)", () => {
  it("quotes identifiers and literals, and refuses anything outside the ks_ naming rule", () => {
    expect(quoteIdent("ks_north_wind")).toBe('"ks_north_wind"');
    for (const bad of ['ks_x"; DROP DATABASE postgres; --', "postgres", "KS_X", "ks_", "ks-x"]) expect(() => quoteIdent(bad)).toThrow(/unexpected/);
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(() => quoteLiteral("a\\b")).toThrow();
  });

  it("makes the role and database, revokes CONNECT from PUBLIC and grants it to the role only", async () => {
    const admin = fakeDb();
    const onDb = fakeDb();
    const end = vi.fn(async () => {});
    const r = await ensureBrokerageDatabase(admin, async () => Object.assign(onDb, { end }), databaseNames("north-wind"), "pw'1");
    const sql = admin.calls.map((c) => c.sql);
    expect(sql).toContain(`CREATE ROLE "ks_north_wind_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'pw''1'`);
    expect(sql).toContain(`CREATE DATABASE "ks_north_wind"`);
    expect(sql).toContain(`REVOKE ALL ON DATABASE "ks_north_wind" FROM PUBLIC`);
    expect(sql).toContain(`GRANT CONNECT, TEMPORARY ON DATABASE "ks_north_wind" TO "ks_north_wind_app"`);
    expect(admin.calls.find((c) => /pg_roles/.test(c.sql))!.params).toEqual(["ks_north_wind_app"]);
    expect(onDb.calls.map((c) => c.sql)).toEqual([
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      'GRANT USAGE, CREATE ON SCHEMA public TO "ks_north_wind_app"',
      "CREATE EXTENSION IF NOT EXISTS vector",
    ]);
    expect(onDb.calls.some((c) => /CREATE EXTENSION (?!IF NOT EXISTS vector)/.test(c.sql))).toBe(false);
    expect(end).toHaveBeenCalled();
    expect(r).toEqual({ role_created: true, database_created: true, vector: "ok" });
  });

  it("again: keeps the database, resets the role's password, and a missing vector is logged, not fatal", async () => {
    const admin = fakeDb([[/FROM pg_roles/, () => [{ x: 1 }]], [/FROM pg_database/, () => [{ x: 1 }]]]);
    const onDb = fakeDb([[/CREATE EXTENSION/, () => { throw new Error('extension "vector" is not allow-listed'); }]]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs: string[] = [];
    const r = await ensureBrokerageDatabase(admin, async () => onDb, databaseNames("prairie"), "pw", (m) => { logs.push(m); });
    expect(admin.calls.some((c) => /^CREATE/.test(c.sql))).toBe(false);
    expect(admin.calls.map((c) => c.sql)).toContain(`ALTER ROLE "ks_prairie_app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'pw'`);
    expect(r.vector).toBe("not_available");
    expect(err).toHaveBeenCalledWith("[tenants] CREATE EXTENSION vector failed", expect.objectContaining({ database: "ks_prairie" }));
    expect(logs.join("\n")).toMatch(/azure.extensions = VECTOR/);
    err.mockRestore();
  });

  it("the role's connection string keeps the admin's host, port and TLS", () => {
    expect(brokerageDatabaseUrl("postgresql://ksadmin:x@ks-shared-pg.postgres.database.azure.com:5432/postgres?sslmode=require", "ks_prairie", "ks_prairie_app", "p@ss/1"))
      .toBe("postgresql://ks_prairie_app:p%40ss%2F1@ks-shared-pg.postgres.database.azure.com:5432/ks_prairie?sslmode=require");
    expect(brokerageDatabaseUrl("postgres://postgres:postgres@localhost:5432/postgres", "ks_a1", "ks_a1_app", "p")).toBe("postgres://ks_a1_app:p@localhost:5432/ks_a1");
  });
});

describe("provisioning steps on the shared server", () => {
  it("database: makes ks_<code>, stores the role's address encrypted, and keeps the password on a re-run", async () => {
    const m = machine(licensee());
    const first = await database(ctxFor(m, "database"));
    expect(first).toMatchObject({ kind: "done", output: { database: "ks_prairie", role: "ks_prairie_app", role_created: true, database_created: true } });
    const row = m.sh.tenants.get("prairie")!;
    expect(row).toMatchObject({ licensee_id: LICENSEE_ID, database_name: "ks_prairie", status: "provisioning" });
    expect(row.database_url_enc).toMatch(/^v1:/);
    const url = new URL(tenantDatabaseUrl(row, KEY));
    expect(url.username).toBe("ks_prairie_app");
    expect(url.pathname).toBe("/ks_prairie");
    expect(url.password).toMatch(/^[0-9a-f]{48}$/);
    // The plain password never reaches the control database.
    expect(JSON.stringify(m.sh.control.calls)).not.toContain(url.password);

    const again = await database(ctxFor(m, "database"));
    expect(again).toMatchObject({ kind: "done", output: { role_created: false, database_created: false } });
    expect(new URL(tenantDatabaseUrl(m.sh.tenants.get("prairie")!, KEY)).password).toBe(url.password);
    expect(m.sh.admin.calls.filter((c) => /^ALTER ROLE/.test(c.sql)).at(-1)!.sql).toContain(`PASSWORD '${url.password}'`);
  });

  it("database: refuses a row that belongs to another licensee, and a code the registry cannot hold", async () => {
    const m = machine(licensee());
    await saveTenantDatabase(m.sh.control, KEY, { code: "prairie", licensee_id: "99999999-9999-4999-8999-999999999999", database_name: "ks_prairie", database_url: "postgresql://a:b@h/ks_prairie" });
    expect(await database(ctxFor(m, "database"))).toMatchObject({ kind: "failed", error: expect.stringMatching(/another licensee/) });
    expect(m.sh.admin.calls).toHaveLength(0);
    const long = machine(licensee({ company_code: "a".repeat(32) }));
    expect(await database(ctxFor(long, "database"))).toMatchObject({ kind: "failed", error: expect.stringMatching(/2 to 31/) });
  });

  it("database: a connection problem is logged and retried, then fails after 30 minutes", async () => {
    const m = machine(licensee());
    m.sh.admin.on(/FROM pg_roles/, () => { throw new Error("connect ECONNREFUSED"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = ctxFor(m, "database");
    expect(await database(c)).toMatchObject({ kind: "wait", message: expect.stringMatching(/ECONNREFUSED/) });
    expect(err).toHaveBeenCalledWith("[provisioning] database failed", expect.objectContaining({ code: "prairie" }));
    m.tick(31 * 60_000);
    expect(await database(c)).toMatchObject({ kind: "failed", error: expect.stringMatching(/gave up after 30 minutes/) });
    err.mockRestore();
  });

  it("tenant_registry: hosts, addresses and the brokerage's env (secrets made once and kept), all encrypted", async () => {
    const opsKey = "ksops_existing_key";
    const m = machine(licensee({ ops_key_encrypted: encryptSecret(opsKey, encryptionKey("a".repeat(64))!) }));
    await database(ctxFor(m, "database"));
    m.sh.tenants.get("prairie")!.client_hosts = ["apply.prairie.example"]; // added later by hand: kept
    const out = await tenantRegistry(ctxFor(m, "tenant_registry"));
    expect(out).toMatchObject({ kind: "done", output: { server_url: "https://prairie.api.keystone.test", portal_url: "https://prairie.portal.keystone.test", client_url: "https://prairie.app.keystone.test" } });
    const row = m.sh.tenants.get("prairie")!;
    expect(row.api_hosts).toEqual(["prairie.api.keystone.test"]);
    expect(row.portal_hosts).toEqual(["prairie.portal.keystone.test"]);
    expect(row.client_hosts).toEqual(["apply.prairie.example", "prairie.app.keystone.test"]);
    const env = tenantEnv(row, KEY);
    expect(env).toMatchObject({
      KS_LICENSEE_ID: LICENSEE_ID, KS_OPS_KEY: opsKey, KS_OPS_URL: "https://ks-ops.example.test", KS_PLAN: "growth",
      KS_SERVER_URL: "https://prairie.api.keystone.test", PUBLIC_BASE_URL: "https://prairie.api.keystone.test", PUBLIC_SERVER_URL: "https://prairie.api.keystone.test",
      KS_PORTAL_URL: "https://prairie.portal.keystone.test", KS_CLIENT_URL: "https://prairie.app.keystone.test", CLIENT_URL: "https://prairie.app.keystone.test",
      MAYA_URL: "https://ks-shared-agent.azurewebsites.net", QBO_ENVIRONMENT: "sandbox",
    });
    for (const k of ["JWT_SECRET", "JWT_REFRESH_SECRET", "OTP_HASH_SALT", "QBO_TOKEN_ENCRYPTION_KEY", "GOOGLE_TOKEN_ENCRYPTION_KEY"]) expect(env[k]).toMatch(/^[0-9a-f]{64}$/);
    for (const k of ["WATCH_PUSH_ENCRYPTION_KEY", "LENDER_CREDENTIALS_ENCRYPTION_KEY"]) expect(Buffer.from(env[k], "base64")).toHaveLength(32);
    expect(JSON.stringify(m.sh.control.calls)).not.toContain(env.JWT_SECRET);
    expect(m.state.l).toMatchObject({ server_url: "https://prairie.api.keystone.test", portal_url: "https://prairie.portal.keystone.test" });

    // Again (and with a plan change): the generated secrets and the starting plan are kept.
    m.state.l = { ...m.state.l, plan: "pro" };
    await tenantRegistry(ctxFor(m, "tenant_registry"));
    const env2 = tenantEnv(m.sh.tenants.get("prairie")!, KEY);
    expect(env2.JWT_SECRET).toBe(env.JWT_SECRET);
    expect(env2.KS_PLAN).toBe("growth");
  });

  it("tenant_registry: without KS_DOMAIN the brokerage has no host names and the shared server's address", async () => {
    const m = machine(licensee(), {}, configuredEnv({ KS_DOMAIN: "" }));
    await database(ctxFor(m, "database"));
    const c = ctxFor(m, "tenant_registry");
    expect(await tenantRegistry(c)).toMatchObject({ kind: "done", output: { server_url: "https://ks-shared-server.azurewebsites.net", portal_url: null } });
    expect(m.sh.tenants.get("prairie")!.api_hosts).toEqual([]);
    expect((c as unknown as { logs: Array<{ m: string }> }).logs.map((l) => l.m).join("\n")).toMatch(/KS_DOMAIN is not set/);
    // A new ops key is made (the licensee had none) and audited.
    expect(m.db.calls.some((c2) => /^UPDATE licensees SET ops_key_hash/.test(c2.sql.trim()))).toBe(true);
    expect(tenantEnv(m.sh.tenants.get("prairie")!, KEY).KS_OPS_KEY).toMatch(/^ksops_/);
  });

  it("shared_server: reload then migrate with the service key; a wrong key fails, a missing route waits", async () => {
    const calls: Array<{ url: string; key: string | null; tenant?: string }> = [];
    const ok = machine(licensee(), { fetch: vi.fn(async (u: string, i: RequestInit) => { calls.push({ url: String(u), key: new Headers(i.headers).get("X-KS-Ops-Service-Key") }); return new Response(JSON.stringify({ ok: true, applied: 3 })); }) as unknown as typeof fetch });
    expect(await sharedServer(ctxFor(ok, "shared_server"))).toMatchObject({ kind: "done", output: { migrate: { ok: true, applied: 3 } } });
    expect(calls.map((c) => c.url)).toEqual(["https://ks-shared-server.azurewebsites.net/api/ops/tenants/reload", "https://ks-shared-server.azurewebsites.net/api/ops/tenants/prairie/migrate"]);
    expect(calls.every((c) => c.key === "test-service-key")).toBe(true);

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = machine(licensee(), { fetch: vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as unknown as typeof fetch });
    expect(await sharedServer(ctxFor(denied, "shared_server"))).toMatchObject({ kind: "failed", error: expect.stringMatching(/KS_OPS_SERVICE_KEY must be the same/) });
    const old = machine(licensee(), { fetch: vi.fn(async () => new Response("Cannot POST", { status: 404 })) as unknown as typeof fetch });
    expect(await sharedServer(ctxFor(old, "shared_server"))).toMatchObject({ kind: "wait", message: expect.stringMatching(/no \/api\/ops\/tenants routes yet/) });
    err.mockRestore();
  });

  it("custom_domains: shows the DNS records and az commands, waits until every host answers over https", async () => {
    const bound = new Set<string>();
    const m = machine(licensee(), {
      fetch: vi.fn(async (u: string) => {
        const host = new URL(String(u)).hostname;
        if (!bound.has(host)) throw new Error("certificate does not match");
        return new Response(JSON.stringify({ status: "ok" }));
      }) as unknown as typeof fetch,
    });
    await database(ctxFor(m, "database"));
    await tenantRegistry(ctxFor(m, "tenant_registry"));
    const blocked = await customDomains(ctxFor(m, "custom_domains"));
    expect(blocked).toMatchObject({ kind: "blocked", retryMs: 15 * 60_000, message: expect.stringMatching(/Waiting for 3 custom domains .*prairie\.api\.keystone\.test/) });
    ["prairie.api.keystone.test", "prairie.portal.keystone.test", "prairie.app.keystone.test"].forEach((h) => bound.add(h));
    expect(await customDomains(ctxFor(m, "custom_domains"))).toMatchObject({ kind: "done" });

    const b = bindingsFor(defaultHosts("prairie", "keystone.test"));
    expect(b.map((x) => `${x.host}@${x.app}`)).toEqual(["prairie.api.keystone.test@ks-shared-server", "prairie.portal.keystone.test@ks-shared-web", "prairie.app.keystone.test@ks-shared-web"]);
    const cmds = azCommands(b);
    expect(cmds[0]).toBe("az webapp config hostname add -g ks-shared --webapp-name ks-shared-server --hostname prairie.api.keystone.test");
    expect(cmds[1]).toBe("az webapp config ssl create -g ks-shared -n ks-shared-server --hostname prairie.api.keystone.test");
    expect(cmds[2]).toMatch(/^az webapp config ssl bind -g ks-shared -n ks-shared-server --ssl-type SNI --hostname prairie.api.keystone.test --certificate-thumbprint/);
    expect(dnsRecords(b)[0]).toBe("CNAME  prairie.api.keystone.test  ->  ks-shared-server.azurewebsites.net");
  });

  it("custom_domains without KS_DOMAIN: skipped, and health says why in plain words", async () => {
    const m = machine(licensee(), {}, configuredEnv({ KS_DOMAIN: "" }));
    const c = ctxFor(m, "custom_domains");
    expect(await customDomains(c)).toMatchObject({ kind: "done", output: { skipped: true } });
    expect((c as unknown as { logs: Array<{ m: string }> }).logs[0].m).toBe(NO_DOMAIN_MESSAGE);
    expect(await health(ctxFor(m, "health", licensee({ server_url: "https://ks-shared-server.azurewebsites.net" })))).toEqual({ kind: "failed", error: NO_DOMAIN_MESSAGE });
  });

  it("calls to the brokerage name it with X-KS-Tenant", async () => {
    const seen: Array<string | null> = [];
    const m = machine(licensee(), { fetch: vi.fn(async (_u: string, i: RequestInit = {}) => { seen.push(new Headers(i.headers).get("X-KS-Tenant")); return new Response(JSON.stringify({ status: "ok" })); }) as unknown as typeof fetch });
    await health(ctxFor(m, "health", licensee({ server_url: "https://prairie.api.keystone.test", portal_url: "https://prairie.portal.keystone.test", client_url: "https://prairie.app.keystone.test" })));
    expect(seen[0]).toBe("prairie");
  });
});

describe("the purge after the retention hold", () => {
  it("drops the database and role, deletes the blob folder and the registry row, then tells the server", async () => {
    const m = machine(licensee({ status: "cancelled" }));
    await database(ctxFor(m, "database"));
    m.sh.blobs.add("prairie/portal/index.html").add("prairie/client/assets/a.js").add("prairie2/portal/index.html");
    expect(await databaseDrop(ctxFor(m, "database_drop"))).toMatchObject({ kind: "done", output: { database_dropped: true, role_dropped: true } });
    expect(m.sh.admin.calls.map((c) => c.sql)).toEqual(expect.arrayContaining(['DROP DATABASE IF EXISTS "ks_prairie" WITH (FORCE)', 'DROP ROLE IF EXISTS "ks_prairie_app"']));
    expect(m.sh.databases.has("ks_prairie")).toBe(false);
    expect(await sitesDelete(ctxFor(m, "sites_delete"))).toMatchObject({ kind: "done", output: { deleted: 2 } });
    expect([...m.sh.blobs]).toEqual(["prairie2/portal/index.html"]);
    expect(await tenantDelete(ctxFor(m, "tenant_delete"))).toMatchObject({ kind: "done", output: { deleted: true } });
    expect(m.sh.tenants.has("prairie")).toBe(false);
    expect((m.deps.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((c) => String(c[0]))).toContain("https://ks-shared-server.azurewebsites.net/api/ops/tenants/reload");
    // Again: nothing left, nothing fails.
    expect(await databaseDrop(ctxFor(m, "database_drop"))).toMatchObject({ kind: "done", output: { database_dropped: false, role_dropped: false } });
    expect(await tenantDelete(ctxFor(m, "tenant_delete"))).toMatchObject({ kind: "done", output: { deleted: false } });
  });

  it("refuses to drop a database the registry names differently", async () => {
    const m = machine(licensee({ status: "cancelled" }));
    await saveTenantDatabase(m.sh.control, KEY, { code: "prairie", licensee_id: LICENSEE_ID, database_name: "ks_other", database_url: "postgresql://a:b@h/ks_other" });
    expect(await databaseDrop(ctxFor(m, "database_drop"))).toMatchObject({ kind: "failed", error: expect.stringMatching(/ks_other/) });
    expect(m.sh.admin.calls.some((c) => /^DROP/.test(c.sql))).toBe(false);
  });
});

describe("registry status", () => {
  it("follows the licensee's KS-Ops status; a failure is logged and the rest carry on", async () => {
    const sh = fakeShared();
    for (const [code, id] of [["a1", "a"], ["b1", "b"], ["c1", "c"]]) await saveTenantDatabase(sh.control, KEY, { code, licensee_id: id, database_name: `ks_${code}`, database_url: "postgresql://x" });
    const db = fakeDb([[/FROM licensees WHERE id = ANY/, () => [{ id: "a", status: "active" }, { id: "b", status: "cancelled" }, { id: "c", status: "pending_payment" }]]]);
    expect(await syncTenantStatuses(sh.control, db)).toEqual({ changed: 2, failed: 0 });
    expect(sh.tenants.get("a1")!.status).toBe("active");
    expect(sh.tenants.get("b1")!.status).toBe("cancelled");
    expect(sh.tenants.get("c1")!.status).toBe("provisioning");
    expect(await syncTenantStatuses(sh.control, db)).toEqual({ changed: 0, failed: 0 });
  });
});

describe("what /ops/provisioning shows", () => {
  it("each step in plain words", () => {
    expect(stepPlainWords({ status: "pending", last_error: null, done_by: null })).toBe("Not started yet.");
    expect(stepPlainWords({ status: "blocked", last_error: "Waiting for 3 custom domains", done_by: null })).toBe("Waiting. Waiting for 3 custom domains.");
    expect(stepPlainWords({ status: "failed", last_error: "KS_TENANT_KEY is not set on KS-Ops.", done_by: null })).toBe("Stopped. KS_TENANT_KEY is not set on KS-Ops. Fix the cause, then press Retry step.");
    expect(stepPlainWords({ status: "manual", last_error: null, done_by: "todd@example.test" })).toBe("Done by hand by todd@example.test.");
  });

  it("the opened run shows the database, the registry entry and the custom-domain commands", async () => {
    const m = machine(licensee());
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "staff");
    await database(ctxFor(m, "database"));
    await tenantRegistry(ctxFor(m, "tenant_registry"));
    const v = await runView(m.deps, run);
    expect(v.steps.every((s) => typeof s.plain === "string")).toBe(true);
    expect(v.shared).toMatchObject({
      database: { database: "ks_prairie", role: "ks_prairie_app" },
      registry: { state: "present", api_hosts: ["prairie.api.keystone.test"] },
      custom_domains: { configured: true, domain: "keystone.test" },
    });
    expect(v.shared!.custom_domains.commands).toHaveLength(10);
    expect(JSON.stringify(v)).not.toMatch(/v1:[A-Za-z0-9+/=]+:/); // nothing encrypted (or decrypted) is shown

    const none = machine(licensee(), {}, configuredEnv({ KS_DOMAIN: "" }));
    const r2 = await startRun(none.deps, LICENSEE_ID, "provision", "staff");
    expect((await runView(none.deps, r2.run)).shared!.custom_domains).toEqual({ configured: false, domain: "", message: NO_DOMAIN_MESSAGE, dns: [], commands: [] });
  });
});

describe("refreshing a brokerage's settings after a key is renewed", () => {
  it("writes the Microsoft 365 / Google keys into the registry entry again and reloads the shared server", async () => {
    const m = machine(licensee({ status: "active" }), {}, configuredEnv({ KS_M365_CLIENT_ID: "ms-new", KS_M365_CLIENT_SECRET: "ms-secret-new" }));
    await database(ctxFor(m, "database"));
    const a = express();
    a.use(express.json());
    a.use("/api/ops", opsProvisioningRouter({ db: m.deps.db } as unknown as Deps, m.deps));
    const r = await request(a).post(`/api/ops/provisioning/tenants/${LICENSEE_ID}/refresh-settings`);
    expect(r.status).toBe(200);
    expect(r.body.results.workspace_apps).toMatchObject({ ok: true });
    expect(r.body.results.twilio_settings).toMatchObject({ ok: false, message: expect.stringMatching(/twilio_account/) });
    expect(r.body.reloaded).toBe(true);
    expect(tenantEnv(m.sh.tenants.get("prairie")!, KEY)).toMatchObject({ KS_M365_CLIENT_ID: "ms-new", KS_M365_CLIENT_SECRET: "ms-secret-new" });
    expect(JSON.stringify(r.body)).not.toContain("ms-secret-new");
    expect((await request(a).post("/api/ops/provisioning/tenants/not-a-uuid/refresh-settings")).status).toBe(404);
  });
});
