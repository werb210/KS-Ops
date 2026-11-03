// KS_OPS_AUTO_PROVISION_v1 - in-memory store and a licensee-aware fake database for the state machine tests.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { LicenseeRow } from "../../src/licensees/repo.js";
import type { MachineDeps } from "../../src/provisioning/machine.js";
import { stepsFor } from "../../src/provisioning/steps.js";
import type { LogRow, ProvisioningStore, RunRow, StepRow } from "../../src/provisioning/store.js";
import { fakeDb, fakeMailer } from "../helpers.js";
import type { SharedDeps } from "../../src/tenants/shared.js";
import type { TenantRow } from "../../src/tenants/repo.js";

/**
 * KS_SHARED_HOSTING_v1 - the shared layout faked: ks_tenants in memory (answered by SQL content), the ks-shared-pg
 * admin connection (roles and databases in sets, every statement recorded) and the sites container.
 */
export function fakeShared() {
  const tenants = new Map<string, TenantRow>();
  const roles = new Set<string>();
  const databases = new Set<string>();
  const blobs = new Set<string>();
  const now = () => new Date("2026-10-25T12:00:00Z");
  const control = fakeDb([
    [/^SELECT \* FROM ks_tenants WHERE code = \$1/, (p) => (tenants.has(String(p[0])) ? [{ ...tenants.get(String(p[0])) }] : [])],
    [/^INSERT INTO ks_tenants \(code, licensee_id, database_name, database_url_enc\)/, (p) => {
      const code = String(p[0]);
      const prev = tenants.get(code);
      tenants.set(code, {
        code, licensee_id: String(p[1]), status: prev?.status ?? "provisioning", api_hosts: prev?.api_hosts ?? [], portal_hosts: prev?.portal_hosts ?? [],
        client_hosts: prev?.client_hosts ?? [], database_name: String(p[2]), database_url_enc: String(p[3]), env_enc: prev?.env_enc ?? "", updated_at: now(),
      });
      return [];
    }],
    [/^UPDATE ks_tenants SET api_hosts = \$2, portal_hosts = \$3, client_hosts = \$4/, (p) => {
      const t = tenants.get(String(p[0]));
      if (!t) return [];
      Object.assign(t, { api_hosts: p[1], portal_hosts: p[2], client_hosts: p[3] });
      return { rows: [], rowCount: 1 };
    }],
    [/^UPDATE ks_tenants SET env_enc = \$2/, (p) => {
      const t = tenants.get(String(p[0]));
      if (t) t.env_enc = String(p[1]);
      return { rows: [], rowCount: t ? 1 : 0 };
    }],
    [/^UPDATE ks_tenants SET status = \$2/, (p) => {
      const t = tenants.get(String(p[0]));
      if (!t || t.status === p[1]) return [];
      t.status = p[1] as TenantRow["status"];
      return [{ code: t.code }];
    }],
    [/^DELETE FROM ks_tenants WHERE code = \$1/, (p) => (tenants.delete(String(p[0])) ? [{ code: p[0] }] : [])],
    [/^SELECT code, licensee_id, status FROM ks_tenants/, () => [...tenants.values()].map((t) => ({ code: t.code, licensee_id: t.licensee_id, status: t.status }))],
  ]);
  const name = (sql: string) => /"([a-z0-9_]+)"/.exec(sql)?.[1] ?? "";
  const admin = fakeDb([
    [/^SELECT 1 FROM pg_roles WHERE rolname = \$1/, (p) => (roles.has(String(p[0])) ? [{ "?column?": 1 }] : [])],
    [/^SELECT 1 FROM pg_database WHERE datname = \$1/, (p) => (databases.has(String(p[0])) ? [{ "?column?": 1 }] : [])],
    [/^CREATE ROLE /, (_p) => []],
    [/^CREATE DATABASE /, () => []],
    [/^DROP DATABASE /, () => []],
    [/^DROP ROLE /, () => []],
  ]);
  const origQuery = admin.query.bind(admin);
  admin.query = async (sql: string, params: unknown[] = []) => {
    const r = await origQuery(sql, params);
    const flat = sql.replace(/\s+/g, " ");
    if (/^CREATE ROLE /.test(flat)) roles.add(name(flat));
    if (/^CREATE DATABASE /.test(flat)) databases.add(name(flat));
    if (/^DROP DATABASE /.test(flat)) databases.delete(name(flat));
    if (/^DROP ROLE /.test(flat)) roles.delete(name(flat));
    return r;
  };
  const onDb: Array<{ database: string; db: ReturnType<typeof fakeDb>; ended: boolean }> = [];
  const shared: SharedDeps = {
    control: () => control,
    admin: () => admin,
    adminOn: async (database: string) => {
      const db = fakeDb();
      const entry = { database, db, ended: false };
      onDb.push(entry);
      return Object.assign(db, { end: async () => { entry.ended = true; } });
    },
    sites: () => ({
      async deletePrefix(prefix: string) {
        const gone = [...blobs].filter((b) => b.startsWith(prefix));
        gone.forEach((b) => blobs.delete(b));
        return gone.length;
      },
    }),
  };
  return { shared, tenants, roles, databases, blobs, control, admin, onDb };
}

export function memoryStore(): ProvisioningStore & { runs: Map<string, RunRow>; stepRows: Map<string, StepRow[]>; logRows: LogRow[] } {
  const runs = new Map<string, RunRow>();
  const stepRows = new Map<string, StepRow[]>();
  const logRows: LogRow[] = [];
  const live = (r: RunRow) => !["done", "cancelled"].includes(r.status) && !r.dry_run;
  const store = {
    runs,
    stepRows,
    logRows,
    async createRun(input: Parameters<ProvisioningStore["createRun"]>[0]) {
      const existing = [...runs.values()].find((r) => r.licensee_id === input.licensee_id && r.kind === input.kind && live(r));
      if (existing && !input.dry_run) return { run: { ...existing }, created: false };
      const now = new Date();
      const run: RunRow = {
        id: randomUUID(), licensee_id: input.licensee_id, kind: input.kind, status: "running", trigger: input.trigger,
        dry_run: input.dry_run, region: input.region, setup_missing: [], workflow_dispatched_at: null, workflow_steps: [],
        callback_token_hash: null, callback_expires_at: null, next_attempt_at: null, last_error: null,
        failure_notified_at: null, setup_notified_at: null, created_by: input.created_by, created_at: now, updated_at: now,
        finished_at: null,
      };
      runs.set(run.id, run);
      stepRows.set(run.id, stepsFor(input.kind).map((d, i) => ({
        run_id: run.id, step: d.key, position: i, status: "pending", attempts: 0, started_at: null, finished_at: null,
        last_error: null, output: {}, done_by: null, updated_at: now,
      })));
      return { run: { ...run }, created: true };
    },
    async getRun(id: string) {
      const r = runs.get(id);
      return r ? { ...r } : null;
    },
    async liveRun(licenseeId: string, kind: string) {
      const r = [...runs.values()].find((x) => x.licensee_id === licenseeId && x.kind === kind && live(x));
      return r ? { ...r } : null;
    },
    async latestRun(licenseeId: string, kind: string) {
      const r = [...runs.values()].filter((x) => x.licensee_id === licenseeId && x.kind === kind && !x.dry_run).pop();
      return r ? { ...r } : null;
    },
    async listRuns() {
      return [...runs.values()].reverse();
    },
    async steps(runId: string) {
      return (stepRows.get(runId) ?? []).map((s) => ({ ...s }));
    },
    async updateRun(id: string, patch: Partial<RunRow>) {
      const r = runs.get(id);
      if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    async updateStep(runId: string, step: string, patch: Partial<StepRow>) {
      const s = stepRows.get(runId)?.find((x) => x.step === step);
      if (s) Object.assign(s, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    async log(runId: string, step: string | null, level: LogRow["level"], message: string) {
      logRows.push({ id: logRows.length + 1, run_id: runId, step, level, message, created_at: new Date() });
    },
    async logs(runId: string) {
      return logRows.filter((l) => l.run_id === runId);
    },
    async claimDue(now: Date) {
      return [...runs.values()]
        .filter((r) => ["running", "blocked", "waiting_for_setup"].includes(r.status) && (!r.next_attempt_at || r.next_attempt_at <= now))
        .map((r) => r.id);
    },
    locked: new Set<string>(),
    async tryLock(id: string) {
      if (store.locked.has(id)) return false;
      store.locked.add(id);
      return true;
    },
    async release(id: string) {
      store.locked.delete(id);
    },
  };
  return store as ProvisioningStore & { runs: Map<string, RunRow>; stepRows: Map<string, StepRow[]>; logRows: LogRow[] };
}

export const LICENSEE_ID = "11111111-1111-4111-8111-111111111111";

export function licensee(over: Partial<LicenseeRow> = {}): LicenseeRow {
  return {
    id: LICENSEE_ID, company_name: "Prairie Capital", legal_name: "Prairie Capital Ltd.", company_code: "prairie",
    contact_name: "Dana Smith", contact_email: "dana@prairie.example", contact_phone: "+14035550199", country: "CA",
    province_state: "AB", mailing_address: null, website: "https://prairie.example", status: "provisioning",
    plan: "growth", billing_interval: "monthly", support_level: "email", seats: 3, extra_storage_blocks: 0,
    server_url: null, client_url: null, portal_url: null, logo_url: null, primary_color: null, assistant_name: "Maya",
    ops_key_hash: null, ops_key_encrypted: null, ops_key_rotated_at: null, signup_token_hash: null, source: "website",
    stripe_customer_id: null, stripe_subscription_id: null, stripe_checkout_session_id: null, onboarding_fee_paid: true,
    plan_sync_status: "synced", plan_sync_error: null, plan_sync_attempts: 0, plan_sync_next_at: null, plan_synced_at: null,
    past_due_since: null, past_due_reminder_sent_at: null, created_at: new Date(), updated_at: new Date(),
    ...over,
  } as LicenseeRow;
}

/** A fake database holding one licensee; UPDATEs of addresses and status change it. */
export function licenseeDb(l: LicenseeRow) {
  const state = { l };
  const db = fakeDb([
    [/^SELECT \* FROM licensees WHERE id = \$1/, () => [state.l]],
    [/^UPDATE licensees SET server_url = \$2, portal_url = \$3, client_url = \$4/, (p) => {
      state.l = { ...state.l, server_url: String(p[1]), portal_url: String(p[2]), client_url: String(p[3]) };
      return [{ id: state.l.id }];
    }],
    // KS_SHARED_HOSTING_v1 - the tenant_registry step's addresses (portal and client only when there is a domain).
    [/^UPDATE licensees SET server_url = \$2, portal_url = COALESCE\(NULLIF\(\$3, ''\), portal_url\)/, (p) => {
      state.l = { ...state.l, server_url: String(p[1]), portal_url: String(p[2]) || state.l.portal_url, client_url: String(p[3]) || state.l.client_url };
      return { rows: [], rowCount: 1 };
    }],
    [/^UPDATE licensees SET status = \$2, updated_at = now\(\) WHERE id = \$1 AND status = 'provisioning'/, (p) => {
      if (state.l.status !== "provisioning") return [];
      state.l = { ...state.l, status: String(p[1]) };
      return [{ id: state.l.id }];
    }],
  ]);
  return { db, state };
}

export function machine(l: LicenseeRow, over: Partial<MachineDeps> = {}, env: NodeJS.ProcessEnv = configuredEnv()) {
  const { db, state } = licenseeDb(l);
  const { mailer, sent } = fakeMailer();
  const store = memoryStore();
  const sh = fakeShared();
  let now = new Date("2026-10-25T12:00:00Z");
  const dispatch = vi.fn(async (_file: string, _inputs: Record<string, string>) => {});
  const deps: MachineDeps = {
    db,
    fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    mailer,
    now: () => now,
    store,
    dispatch,
    env,
    shared: sh.shared,
    ...over,
  };
  return { deps, store, db, state, sent, dispatch, sh, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

export function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KS_PROVISION_GITHUB_TOKEN: "github_pat_test",
    KS_OPS_PUBLIC_URL: "https://ks-ops.example.test",
    OPS_ENCRYPTION_KEY: "a".repeat(64),
    KS_TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, // KS_OPS_TWILIO_AUTO_v1 - Keystone's master account (faked)
    KS_TWILIO_AUTH_TOKEN: "master-token",
    // KS_SHARED_HOSTING_v1 - the shared layout (connections are faked by fakeShared)
    KS_CONTROL_OWNER_DATABASE_URL: "postgresql://ks_control_owner:pw@ks-shared-pg.test:5432/ks_control?sslmode=require",
    KS_TENANT_KEY: "test-tenant-key",
    KS_SHARED_PG_ADMIN_URL: "postgresql://ksadmin:pw@ks-shared-pg.test:5432/postgres?sslmode=require",
    KS_SHARED_SERVER_URL: "https://ks-shared-server.azurewebsites.net",
    KS_SHARED_AGENT_URL: "https://ks-shared-agent.azurewebsites.net",
    KS_OPS_SERVICE_KEY: "test-service-key",
    KS_DOMAIN: "keystone.test",
    ...extra,
  };
}
