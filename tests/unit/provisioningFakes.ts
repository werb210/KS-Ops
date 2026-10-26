// KS_OPS_AUTO_PROVISION_v1 - in-memory store and a licensee-aware fake database for the state machine tests.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { LicenseeRow } from "../../src/licensees/repo.js";
import type { MachineDeps } from "../../src/provisioning/machine.js";
import { stepsFor } from "../../src/provisioning/steps.js";
import type { LogRow, ProvisioningStore, RunRow, StepRow } from "../../src/provisioning/store.js";
import { fakeDb, fakeMailer } from "../helpers.js";

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
    ...over,
  };
  return { deps, store, db, state, sent, dispatch, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

export function configuredEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KS_PROVISION_GITHUB_TOKEN: "github_pat_test",
    KS_OPS_PUBLIC_URL: "https://ks-ops.example.test",
    OPS_ENCRYPTION_KEY: "a".repeat(64),
    KS_TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, // KS_OPS_TWILIO_AUTO_v1 - Keystone's master account (faked)
    KS_TWILIO_AUTH_TOKEN: "master-token",
    ...extra,
  };
}
