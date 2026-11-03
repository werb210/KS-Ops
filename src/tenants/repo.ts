// KS_SHARED_HOSTING_v1 - the tenants module: reads and writes ks_tenants in ks_control (as ks_control_owner).
// Secrets are encrypted here, in the shared format (crypto.ts), before anything reaches the database.
import type { Q } from "../db.js";
import { decryptEnv, decryptTenant, encryptEnv, encryptTenant } from "./crypto.js";
import { normalHost, TENANT_CODE_RE, type TenantHosts } from "./config.js";

export const TENANT_STATUSES = ["provisioning", "trial", "active", "past_due", "suspended", "cancelled"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export type TenantRow = {
  code: string;
  licensee_id: string | null;
  status: TenantStatus;
  api_hosts: string[];
  portal_hosts: string[];
  client_hosts: string[];
  database_name: string;
  database_url_enc: string;
  env_enc: string;
  updated_at: Date;
};

function checkCode(code: string): void {
  if (!TENANT_CODE_RE.test(code)) {
    throw new Error(`The company code "${code}" cannot be used on the shared server: it must be 2 to 31 lowercase letters, numbers or hyphens, starting with a letter or number.`);
  }
}

export async function getTenant(q: Q, code: string): Promise<TenantRow | null> {
  const r = await q.query("SELECT * FROM ks_tenants WHERE code = $1", [code]);
  return (r.rows[0] as TenantRow | undefined) ?? null;
}

/** Creates the row (status provisioning) or updates its database columns. Hosts and env are kept. */
export async function saveTenantDatabase(
  q: Q,
  key: Buffer,
  input: { code: string; licensee_id: string; database_name: string; database_url: string },
): Promise<void> {
  checkCode(input.code);
  await q.query(
    `INSERT INTO ks_tenants (code, licensee_id, database_name, database_url_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE
       SET licensee_id = EXCLUDED.licensee_id, database_name = EXCLUDED.database_name,
           database_url_enc = EXCLUDED.database_url_enc, updated_at = now()`,
    [input.code, input.licensee_id, input.database_name, encryptTenant(input.database_url, key)],
  );
}

export function tenantDatabaseUrl(row: Pick<TenantRow, "database_url_enc">, key: Buffer): string {
  return decryptTenant(row.database_url_enc, key);
}

export function tenantEnv(row: Pick<TenantRow, "env_enc">, key: Buffer): Record<string, string> {
  return decryptEnv(row.env_enc, key);
}

const hostList = (list: string[]) => [...new Set(list.map(normalHost).filter(Boolean))].sort();

/** Hosts already on the row are kept (a brokerage's own apply.<their domain> added later survives a re-run). */
export function mergeHosts(row: Pick<TenantRow, "api_hosts" | "portal_hosts" | "client_hosts"> | null, add: TenantHosts): TenantHosts {
  return {
    api: hostList([...(row?.api_hosts ?? []), ...add.api]),
    portal: hostList([...(row?.portal_hosts ?? []), ...add.portal]),
    client: hostList([...(row?.client_hosts ?? []), ...add.client]),
  };
}

export async function saveTenantHosts(q: Q, code: string, hosts: TenantHosts): Promise<void> {
  const r = await q.query(
    "UPDATE ks_tenants SET api_hosts = $2, portal_hosts = $3, client_hosts = $4, updated_at = now() WHERE code = $1",
    [code, hostList(hosts.api), hostList(hosts.portal), hostList(hosts.client)],
  );
  if (!(r.rowCount ?? r.rows.length)) throw new Error(`no ks_tenants row for ${code} (run the database step first)`);
}

/**
 * Merges values into the brokerage's encrypted env and returns the whole env. Empty values are not written. With
 * `keep` the existing value wins (generated secrets are made once and kept).
 */
export async function mergeTenantEnv(
  q: Q,
  key: Buffer,
  code: string,
  patch: Record<string, string>,
  opts: { keep?: boolean } = {},
): Promise<Record<string, string>> {
  const row = await getTenant(q, code);
  if (!row) throw new Error(`no ks_tenants row for ${code} (run the database step first)`);
  const current = tenantEnv(row, key);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string" || !v) continue;
    if (opts.keep && current[k]) continue;
    next[k] = v;
  }
  await q.query("UPDATE ks_tenants SET env_enc = $2, updated_at = now() WHERE code = $1", [code, encryptEnv(next, key)]);
  return next;
}

export async function setTenantStatus(q: Q, code: string, status: TenantStatus): Promise<boolean> {
  const r = await q.query(
    "UPDATE ks_tenants SET status = $2, updated_at = now() WHERE code = $1 AND status IS DISTINCT FROM $2 RETURNING code",
    [code, status],
  );
  return Boolean(r.rowCount ?? r.rows.length);
}

export async function deleteTenant(q: Q, code: string): Promise<boolean> {
  const r = await q.query("DELETE FROM ks_tenants WHERE code = $1 RETURNING code", [code]);
  return Boolean(r.rowCount ?? r.rows.length);
}

/** The registry status for a KS-Ops licensee status (pending_payment never reaches the registry). */
export function tenantStatusFor(licenseeStatus: string): TenantStatus | null {
  return (TENANT_STATUSES as readonly string[]).includes(licenseeStatus) ? (licenseeStatus as TenantStatus) : null;
}

/**
 * Keeps ks_tenants.status equal to each licensee's KS-Ops status (the shared server answers 410 for cancelled, and
 * suspends as it does today). Runs on a timer; one row failing is logged and the others carry on.
 */
export async function syncTenantStatuses(control: Q, db: Q): Promise<{ changed: number; failed: number }> {
  const tenants = (await control.query("SELECT code, licensee_id, status FROM ks_tenants WHERE licensee_id IS NOT NULL", [])).rows as Array<Pick<TenantRow, "code" | "licensee_id" | "status">>;
  if (!tenants.length) return { changed: 0, failed: 0 };
  const ids = tenants.map((t) => t.licensee_id);
  const statuses = new Map(
    ((await db.query("SELECT id, status FROM licensees WHERE id = ANY($1::uuid[])", [ids])).rows as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
  );
  let changed = 0;
  let failed = 0;
  for (const t of tenants) {
    const want = tenantStatusFor(statuses.get(String(t.licensee_id)) ?? "");
    if (!want || want === t.status) continue;
    try {
      if (await setTenantStatus(control, t.code, want)) changed++;
    } catch (err) {
      failed++;
      console.error("[tenants] status not synced", { code: t.code, want, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { changed, failed };
}
