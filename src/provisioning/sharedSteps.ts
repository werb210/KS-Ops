// KS_SHARED_HOSTING_v1 - the provisioning and teardown steps of the shared layout, run here in KS-Ops:
//   database         ks_<code> and role ks_<code>_app on ks-shared-pg (KS_SHARED_PG_ADMIN_URL)
//   tenant_registry  the ks_tenants row: host names, and the encrypted env (what used to be the brokerage's own App
//                    Service settings: its secrets, ops key, addresses, plan)
//   twilio_settings  the Twilio sub-account's settings, into the same env
//   workspace_apps   Keystone's Microsoft 365 / Google app keys, into the same env
//   shared_server    POST /api/ops/tenants/reload and /api/ops/tenants/:code/migrate on the shared KS-server
//   custom_domains   the host names on ks-shared-server / ks-shared-web (commands shown, then checked)
//   database_drop, sites_delete, tenant_delete   the purge after the retention hold
// Every step is safe to run again. Secrets never leave KS-Ops except encrypted into ks_tenants.
import { randomBytes } from "node:crypto";
import type { ExecCtx, Executor, StepOutcome } from "./executors.js";
import { audit, opsKeyOf, rotateOpsKey } from "../licensees/repo.js";
import { callbackBaseUrl } from "./config.js";
import { serverSettings } from "../twilio/account.js";
import { workspaceAppSettings } from "../workspace/apps.js";
import { databaseNames, defaultHosts, ksDomain, sharedAgentUrl, sharedPgAdminUrl, sharedServerUrl, TENANT_CODE_RE, tenantKeySetting } from "../tenants/config.js";
import { tenantKey } from "../tenants/crypto.js";
import { brokerageDatabaseUrl, dropBrokerageDatabase, ensureBrokerageDatabase } from "../tenants/database.js";
import { bindingsFor, hostsNotReady } from "../tenants/domains.js";
import { deleteTenant, getTenant, mergeHosts, mergeTenantEnv, saveTenantDatabase, saveTenantHosts, tenantDatabaseUrl, type TenantRow } from "../tenants/repo.js";
import { defaultShared, type SharedDeps } from "../tenants/shared.js";
import { migrateTenant, reloadTenants } from "../tenants/sharedServer.js";
import { GENERATED_SECRETS } from "./steps.js";

const MIN = 60_000;
const CALL_LIMIT_MS = 30 * MIN;

export const envOf = (ctx: Pick<ExecCtx, "deps">): NodeJS.ProcessEnv => ctx.deps.env ?? process.env;
export const sharedOf = (ctx: Pick<ExecCtx, "deps">): SharedDeps => ctx.deps.shared ?? defaultShared();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 800);

function waitOrFail(ctx: ExecCtx, limitMs: number, retryMs: number, message: string): StepOutcome {
  const started = ctx.step.started_at ? new Date(ctx.step.started_at).getTime() : ctx.deps.now().getTime();
  if (ctx.deps.now().getTime() - started > limitMs) return { kind: "failed", error: `${message} (gave up after ${Math.round(limitMs / MIN)} minutes)` };
  return { kind: "wait", retryMs, message };
}

/** A database or storage error: logged (never hidden), then tried again for a while before the step fails. */
async function trouble(ctx: ExecCtx, what: string, err: unknown): Promise<StepOutcome> {
  const message = `${what}: ${errText(err)}`;
  console.error(`[provisioning] ${ctx.step.step} failed`, { licensee: ctx.licensee.id, code: ctx.licensee.company_code, message });
  await ctx.log(message, "warn");
  return waitOrFail(ctx, CALL_LIMIT_MS, 2 * MIN, message);
}

function keyOrFail(ctx: ExecCtx): Buffer | StepOutcome {
  const key = tenantKey(tenantKeySetting(envOf(ctx)));
  return key ?? { kind: "failed", error: "KS_TENANT_KEY is not set on KS-Ops." };
}

function codeProblem(code: string): StepOutcome | null {
  if (TENANT_CODE_RE.test(code)) return null;
  return {
    kind: "failed",
    error: `The company code "${code}" cannot be used on the shared server (2 to 31 lowercase letters, numbers or hyphens). Change the licensee's company code, then Retry step.`,
  };
}

async function tenantRow(ctx: ExecCtx): Promise<TenantRow | null> {
  return getTenant(sharedOf(ctx).control(), ctx.licensee.company_code);
}

/** The brokerage's addresses: its own host names under KS_DOMAIN, or the shared server's address without one. */
export function addressesFor(code: string, e: NodeJS.ProcessEnv) {
  const domain = ksDomain(e);
  const hosts = defaultHosts(code, domain);
  return {
    domain,
    hosts,
    server_url: hosts.api[0] ? `https://${hosts.api[0]}` : sharedServerUrl(e),
    portal_url: hosts.portal[0] ? `https://${hosts.portal[0]}` : "",
    client_url: hosts.client[0] ? `https://${hosts.client[0]}` : "",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Provisioning

export const database: Executor = async (ctx) => {
  const l = ctx.licensee;
  const bad = codeProblem(l.company_code);
  if (bad) return bad;
  const key = keyOrFail(ctx);
  if (!Buffer.isBuffer(key)) return key;
  const adminUrl = sharedPgAdminUrl(envOf(ctx));
  if (!adminUrl) return { kind: "failed", error: "KS_SHARED_PG_ADMIN_URL is not set on KS-Ops." };
  const names = databaseNames(l.company_code);
  const sh = sharedOf(ctx);
  try {
    const row = await getTenant(sh.control(), l.company_code);
    if (row?.licensee_id && row.licensee_id !== l.id) {
      return { kind: "failed", error: `The registry already has a brokerage "${l.company_code}" for another licensee (${row.licensee_id}). Nothing was changed.` };
    }
    // Keep the password already in the registry, so the server's connections keep working on a re-run.
    let password = "";
    if (row?.database_url_enc) {
      try {
        password = decodeURIComponent(new URL(tenantDatabaseUrl(row, key)).password);
      } catch (err) {
        console.error("[provisioning] stored database address could not be read; a new password is set", { code: l.company_code, message: errText(err) });
        await ctx.log(`the stored database address could not be read (${errText(err)}); the role gets a new password`, "warn");
      }
    }
    if (!password) password = randomBytes(24).toString("hex");
    const res = await ensureBrokerageDatabase(sh.admin(), sh.adminOn, names, password, (m, level) => ctx.log(m, level));
    await saveTenantDatabase(sh.control(), key, {
      code: l.company_code,
      licensee_id: l.id,
      database_name: names.database,
      database_url: brokerageDatabaseUrl(adminUrl, names.database, names.role, password),
    });
    return {
      kind: "done",
      output: { database: names.database, role: names.role, ...res },
      message: `database ${names.database} ${res.database_created ? "created" : "already there"}, role ${names.role} ${res.role_created ? "created" : "kept"}; only that role can connect`,
    };
  } catch (err) {
    return trouble(ctx, "the database could not be set up", err);
  }
};

const hex = () => randomBytes(32).toString("hex");
const b64 = () => randomBytes(32).toString("base64");
const SECRET_MAKERS: Record<(typeof GENERATED_SECRETS)[number], () => string> = {
  JWT_SECRET: hex,
  JWT_REFRESH_SECRET: hex,
  OTP_HASH_SALT: hex,
  QBO_TOKEN_ENCRYPTION_KEY: hex,
  GOOGLE_TOKEN_ENCRYPTION_KEY: hex,
  WATCH_PUSH_ENCRYPTION_KEY: b64,
  LENDER_CREDENTIALS_ENCRYPTION_KEY: b64,
};

export const tenantRegistry: Executor = async (ctx) => {
  const l = ctx.licensee;
  const e = envOf(ctx);
  const key = keyOrFail(ctx);
  if (!Buffer.isBuffer(key)) return key;
  const control = sharedOf(ctx).control();
  try {
    const row = await getTenant(control, l.company_code);
    if (!row) return { kind: "failed", error: "No registry entry yet: retry the database step first." };
    const a = addressesFor(l.company_code, e);
    await saveTenantHosts(control, l.company_code, mergeHosts(row, a.hosts));

    // The ops key KS-Ops already has for this licensee, or a new one (KS-Ops keeps it encrypted, as before).
    let opsKey = opsKeyOf(l);
    if (!opsKey) {
      opsKey = await rotateOpsKey(ctx.deps.db, l.id);
      await audit(ctx.deps.db, "ks-ops provisioning", "licensee.ops_key_rotated", l.id, { run_id: ctx.run.id });
      await ctx.log("new ops key made for the brokerage");
    }

    // Made once and kept: the brokerage's own secrets, its starting plan and QuickBooks environment.
    const secrets = Object.fromEntries(GENERATED_SECRETS.map((k) => [k, SECRET_MAKERS[k]()]));
    await mergeTenantEnv(control, key, l.company_code, { ...secrets, KS_PLAN: l.plan, QBO_ENVIRONMENT: "sandbox" }, { keep: true });
    // Always current: who the brokerage is, where KS-Ops is, and its addresses.
    const current: Record<string, string> = {
      KS_LICENSEE_ID: l.id,
      KS_OPS_KEY: opsKey,
      KS_OPS_URL: callbackBaseUrl(e),
      KS_SERVER_URL: a.server_url,
      PUBLIC_BASE_URL: a.server_url,
      PUBLIC_SERVER_URL: a.server_url,
      KS_PORTAL_URL: a.portal_url,
      KS_CLIENT_URL: a.client_url,
      CLIENT_URL: a.client_url,
      MAYA_URL: sharedAgentUrl(e),
    };
    const envNow = await mergeTenantEnv(control, key, l.company_code, current);

    // The addresses KS-Ops calls the brokerage on (plan push, admin user, phone numbers, ...).
    if (a.server_url) {
      await ctx.deps.db.query(
        `UPDATE licensees SET server_url = $2, portal_url = COALESCE(NULLIF($3, ''), portal_url), client_url = COALESCE(NULLIF($4, ''), client_url),
                plan_sync_status = 'pending_sync', plan_sync_next_at = NULL, updated_at = now()
          WHERE id = $1`,
        [l.id, a.server_url, a.portal_url, a.client_url],
      );
      await audit(ctx.deps.db, "ks-ops provisioning", "licensee.addresses_set", l.id, { server_url: a.server_url, portal_url: a.portal_url || null, client_url: a.client_url || null, run_id: ctx.run.id });
    }
    if (!a.domain) await ctx.log("KS_DOMAIN is not set on KS-Ops, so the brokerage has no host names yet: its staff portal and client app cannot be opened until it is set and this step is retried", "warn");
    return {
      kind: "done",
      output: { server_url: a.server_url || null, portal_url: a.portal_url || null, client_url: a.client_url || null, hosts: a.hosts, env_names: Object.keys(envNow).sort() },
      message: `registry entry saved (${Object.keys(envNow).length} settings, encrypted)${a.domain ? `; addresses under ${a.domain}` : "; no host names (KS_DOMAIN not set)"}`,
    };
  } catch (err) {
    return trouble(ctx, "the registry entry could not be written", err);
  }
};

/** KS_OPS_TWILIO_AUTO_v1 - the licensee's Twilio settings, into its encrypted env (they used to go to its App Service). */
export const twilioSettings: Executor = async (ctx) => {
  const key = keyOrFail(ctx);
  if (!Buffer.isBuffer(key)) return key;
  const r = await serverSettings(ctx.deps, ctx.licensee);
  if (!r.ok) {
    return { kind: "failed", error: r.error === "no_subaccount" ? "The licensee has no Twilio sub-account yet: retry twilio_account first." : "The Twilio sub-account is not finished (API key, dialler app or sign-in code service missing): retry twilio_account." };
  }
  try {
    await mergeTenantEnv(sharedOf(ctx).control(), key, ctx.licensee.company_code, r.settings);
  } catch (err) {
    return trouble(ctx, "the Twilio settings could not be saved", err);
  }
  const names = Object.keys(r.settings).sort();
  await audit(ctx.deps.db, "ks-ops provisioning", "licensee.twilio_settings_saved", ctx.licensee.id, { run_id: ctx.run.id, names });
  return { kind: "done", output: { written: names }, message: `Twilio settings saved: ${names.join(", ")}` };
};

/** KS_OPS_WORKSPACE_APPS - Keystone's Microsoft 365 / Google keys, into the env. What KS-Ops lacks is logged, not a failure. */
export const workspaceApps: Executor = async (ctx) => {
  const key = keyOrFail(ctx);
  if (!Buffer.isBuffer(key)) return key;
  const r = workspaceAppSettings(envOf(ctx));
  const names = Object.keys(r.settings).sort();
  if (names.length) {
    try {
      await mergeTenantEnv(sharedOf(ctx).control(), key, ctx.licensee.company_code, r.settings);
    } catch (err) {
      return trouble(ctx, "the Microsoft 365 / Google settings could not be saved", err);
    }
    await audit(ctx.deps.db, "ks-ops provisioning", "licensee.workspace_settings_saved", ctx.licensee.id, { run_id: ctx.run.id, names });
  }
  if (r.missing.length) await ctx.log(`not set up on KS-Ops yet, so not written: ${r.missing.join("; ")}. Set them on KS-Ops, then Retry this step.`, "warn");
  return { kind: "done", output: { written: names, not_set_up: r.missing }, message: names.length ? `saved: ${names.join(", ")}` : "nothing to save yet" };
};

export const sharedServer: Executor = async (ctx) => {
  const e = envOf(ctx);
  const code = ctx.licensee.company_code;
  const reload = await reloadTenants(ctx.deps.fetch, e);
  if (!reload.ok) return serverProblem(ctx, "reload", reload);
  const migrate = await migrateTenant(ctx.deps.fetch, code, e);
  if (!migrate.ok) return serverProblem(ctx, "migrate", migrate);
  return { kind: "done", output: { migrate: migrate.body }, message: `the shared server loaded ${code} and set up its database tables` };
};

function serverProblem(ctx: ExecCtx, what: string, r: { status: number; error: string; message: string }): StepOutcome {
  if (r.error === "not_configured") return { kind: "failed", error: r.message };
  if (r.status === 401 || r.status === 403) return { kind: "failed", error: `The shared server refused KS-Ops's service key (${what}): KS_OPS_SERVICE_KEY must be the same on KS-Ops and ks-shared-server.` };
  if (r.status === 404 && r.error !== "unknown_brokerage") {
    return waitOrFail(ctx, CALL_LIMIT_MS, 2 * MIN, `the shared server has no /api/ops/tenants routes yet (${what}): deploy the multi-brokerage KS-server with KS_CONTROL_DATABASE_URL set`);
  }
  return waitOrFail(ctx, CALL_LIMIT_MS, MIN, `${what}: ${r.message}`);
}

/** The custom-domain bindings for the brokerage (from its registry row), or null without KS_DOMAIN. */
export async function domainPlan(ctx: ExecCtx) {
  const a = addressesFor(ctx.licensee.company_code, envOf(ctx));
  if (!a.domain) return null;
  const row = await tenantRow(ctx);
  return bindingsFor(mergeHosts(row, a.hosts));
}

export const NO_DOMAIN_MESSAGE =
  "No Keystone domain is set (KS_DOMAIN on KS-Ops), so no custom domains were added. The shared web host finds each brokerage by its host name, so this brokerage's staff portal and client app cannot be opened until KS_DOMAIN is set and the tenant_registry step is retried.";

export const customDomains: Executor = async (ctx) => {
  let bindings;
  try {
    bindings = await domainPlan(ctx);
  } catch (err) {
    return trouble(ctx, "the registry entry could not be read", err);
  }
  if (!bindings) {
    await ctx.log(NO_DOMAIN_MESSAGE, "warn");
    return { kind: "done", output: { skipped: true, reason: "no_domain" }, message: "skipped: KS_DOMAIN is not set" };
  }
  const waiting = await hostsNotReady(ctx.deps.fetch, bindings);
  if (!waiting.length) return { kind: "done", output: { hosts: bindings.map((b) => b.host) }, message: `every address answers over https: ${bindings.map((b) => b.host).join(", ")}` };
  return {
    kind: "blocked",
    retryMs: 15 * MIN,
    message: `Waiting for ${waiting.length} custom domain${waiting.length === 1 ? "" : "s"} (${waiting.map((w) => w.host).join(", ")}). Add the DNS records and run the commands shown under "Custom domains" on this page; this step checks again every 15 minutes and finishes by itself.`,
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Teardown (the purge after the retention hold)

export const databaseDrop: Executor = async (ctx) => {
  const code = ctx.licensee.company_code;
  if (!TENANT_CODE_RE.test(code)) return { kind: "done", message: "this company code was never on the shared server; nothing to delete" };
  const sh = sharedOf(ctx);
  try {
    const row = await getTenant(sh.control(), code);
    const names = databaseNames(code);
    if (row && row.database_name !== names.database) {
      return { kind: "failed", error: `The registry says the database is ${row.database_name}, not ${names.database}; check by hand. Nothing was deleted.` };
    }
    const r = await dropBrokerageDatabase(sh.admin(), names);
    await audit(ctx.deps.db, "ks-ops provisioning", "licensee.database_dropped", ctx.licensee.id, { run_id: ctx.run.id, ...names, ...r });
    return { kind: "done", output: { ...names, ...r }, message: `database ${names.database} ${r.database_dropped ? "deleted" : "was not there"}; role ${names.role} ${r.role_dropped ? "deleted" : "was not there"}` };
  } catch (err) {
    return trouble(ctx, "the database could not be deleted", err);
  }
};

export const sitesDelete: Executor = async (ctx) => {
  const code = ctx.licensee.company_code;
  try {
    const n = await sharedOf(ctx).sites().deletePrefix(`${code}/`);
    await audit(ctx.deps.db, "ks-ops provisioning", "licensee.sites_deleted", ctx.licensee.id, { run_id: ctx.run.id, blobs: n });
    return { kind: "done", output: { deleted: n }, message: `${n} published file${n === 1 ? "" : "s"} deleted from sites/${code}/` };
  } catch (err) {
    return trouble(ctx, "the published apps could not be deleted", err);
  }
};

export const tenantDelete: Executor = async (ctx) => {
  const code = ctx.licensee.company_code;
  let deleted = false;
  try {
    deleted = await deleteTenant(sharedOf(ctx).control(), code);
  } catch (err) {
    return trouble(ctx, "the registry entry could not be deleted", err);
  }
  await audit(ctx.deps.db, "ks-ops provisioning", "licensee.tenant_deleted", ctx.licensee.id, { run_id: ctx.run.id, deleted });
  const reload = await reloadTenants(ctx.deps.fetch, envOf(ctx));
  if (!reload.ok) await ctx.log(`the shared server was not told (${reload.message}); it forgets the brokerage within 60 seconds anyway`, "warn");
  return { kind: "done", output: { deleted }, message: deleted ? "registry entry deleted" : "there was no registry entry" };
};

export const SHARED_EXECUTORS: Record<string, Executor> = {
  database,
  tenant_registry: tenantRegistry,
  twilio_settings: twilioSettings,
  workspace_apps: workspaceApps,
  shared_server: sharedServer,
  custom_domains: customDomains,
  database_drop: databaseDrop,
  sites_delete: sitesDelete,
  tenant_delete: tenantDelete,
};
