// KS_SHARED_HOSTING_v1 - the settings KS-Ops needs for the shared layout, and the names everything gets.
//
// Keystone runs one shared KS-server, KS-Agent and web host (resource group ks-shared) with a separate Postgres
// database per brokerage on ks-shared-pg. KS-Ops owns the registry (ks_tenants in ks_control). Every value is read
// when needed, never at import time.
import { env } from "../config.js";

export const SHARED = {
  resourceGroup: "ks-shared",
  region: "canadacentral",
  plan: "ks-shared-plan",
  serverApp: "ks-shared-server",
  agentApp: "ks-shared-agent",
  webApp: "ks-shared-web",
  postgres: "ks-shared-pg",
  controlDatabase: "ks_control",
  sitesContainer: "sites",
} as const;

/** The registry's code rule (ks_tenants CHECK). KS-Ops company codes allow 32 characters; the registry 31. */
export const TENANT_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** KS_CONTROL_OWNER_DATABASE_URL: ks_control as ks_control_owner (KS-Ops writes the registry with it). */
export function controlOwnerUrl(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_CONTROL_OWNER_DATABASE_URL", e);
}

/** KS_TENANT_KEY: any length; the AES key is its SHA-256. Shared with the shared server, agent and web host. */
export function tenantKeySetting(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_TENANT_KEY", e);
}

/** KS_SHARED_PG_ADMIN_URL: an admin role on ks-shared-pg (CREATEDB, CREATEROLE), database postgres. */
export function sharedPgAdminUrl(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_SHARED_PG_ADMIN_URL", e);
}

/** KS_SHARED_SERVER_URL: the shared KS-server's own address (https://ks-shared-server.azurewebsites.net). */
export function sharedServerUrl(e: NodeJS.ProcessEnv = process.env): string {
  const v = env("KS_SHARED_SERVER_URL", e).replace(/\/+$/, "");
  return /^https:\/\//.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v) ? v : "";
}

/** KS_SHARED_AGENT_URL: the shared KS-Agent (MAYA_URL for every brokerage). Optional. */
export function sharedAgentUrl(e: NodeJS.ProcessEnv = process.env): string {
  const v = env("KS_SHARED_AGENT_URL", e).replace(/\/+$/, "");
  return /^https:\/\//.test(v) ? v : "";
}

/** KS_OPS_SERVICE_KEY: sent as X-KS-Ops-Service-Key to the shared server's /api/ops/tenants routes. */
export function opsServiceKey(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_OPS_SERVICE_KEY", e);
}

/** KS_DOMAIN: Keystone's own domain for brokerage host names (e.g. keystone.example). Optional. */
export function ksDomain(e: NodeJS.ProcessEnv = process.env): string {
  const v = env("KS_DOMAIN", e).toLowerCase().replace(/^\.+|\.+$/g, "");
  return /^(?=.{3,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) ? v : "";
}

/** KS_SITES_STORAGE_CONNECTION_STRING: the storage account holding sites/<code>/portal and sites/<code>/client. */
export function sitesConnectionString(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_SITES_STORAGE_CONNECTION_STRING", e);
}

/** Database and role for one brokerage: ks_<code with - replaced by _> and ks_<...>_app. */
export function databaseNames(code: string): { database: string; role: string } {
  if (!TENANT_CODE_RE.test(code)) throw new Error(`invalid_tenant_code: ${code}`);
  const database = `ks_${code.replace(/-/g, "_")}`;
  return { database, role: `${database}_app` };
}

export type TenantHosts = { api: string[]; portal: string[]; client: string[] };

/** The brokerage's host names under KS_DOMAIN, or none without a domain. */
export function defaultHosts(code: string, domain: string): TenantHosts {
  if (!domain) return { api: [], portal: [], client: [] };
  return { api: [`${code}.api.${domain}`], portal: [`${code}.portal.${domain}`], client: [`${code}.app.${domain}`] };
}

/** A host as the registry stores it: lowercase, no scheme, no port, no path. Empty when it is not a host name. */
export function normalHost(raw: string): string {
  const h = String(raw ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  return /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(h) ? h : "";
}
