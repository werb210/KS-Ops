// KS_OPS_AUTO_PROVISION_v1 - where runs, steps and logs are kept. The state machine only talks to this interface, so
// unit tests use an in-memory copy (tests/unit/provisioningFakes.ts) and production uses Postgres (migration 014).
import type { Q } from "../db.js";
import type { SetupItem } from "./config.js";
import { stepsFor, type RunKind } from "./steps.js";

export type RunStatus = "waiting_for_setup" | "running" | "blocked" | "failed" | "done" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "failed" | "manual" | "blocked";

export type RunRow = {
  id: string;
  licensee_id: string;
  kind: RunKind;
  status: RunStatus;
  trigger: string;
  dry_run: boolean;
  region: string;
  setup_missing: SetupItem[];
  workflow_dispatched_at: Date | null;
  workflow_steps: string[];
  callback_token_hash: string | null;
  callback_expires_at: Date | null;
  next_attempt_at: Date | null;
  last_error: string | null;
  failure_notified_at: Date | null;
  setup_notified_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
};

export type StepRow = {
  run_id: string;
  step: string;
  position: number;
  status: StepStatus;
  attempts: number;
  started_at: Date | null;
  finished_at: Date | null;
  last_error: string | null;
  output: Record<string, unknown>;
  done_by: string | null;
  updated_at: Date;
};

export type LogRow = { id: number; run_id: string; step: string | null; level: "info" | "warn" | "error"; message: string; created_at: Date };

export type NewRun = { licensee_id: string; kind: RunKind; trigger: string; dry_run: boolean; region: string; created_by: string };

export const RUN_PATCHABLE = [
  "status", "setup_missing", "workflow_dispatched_at", "workflow_steps", "callback_token_hash", "callback_expires_at",
  "next_attempt_at", "last_error", "failure_notified_at", "setup_notified_at", "finished_at",
] as const;
export const STEP_PATCHABLE = ["status", "attempts", "started_at", "finished_at", "last_error", "output", "done_by"] as const;
export type RunPatch = Partial<Pick<RunRow, (typeof RUN_PATCHABLE)[number]>>;
export type StepPatch = Partial<Pick<StepRow, (typeof STEP_PATCHABLE)[number]>>;

export interface ProvisioningStore {
  /** Creates the run and its steps; returns the existing live run instead when there is one (created=false). */
  createRun(input: NewRun): Promise<{ run: RunRow; created: boolean }>;
  getRun(id: string): Promise<RunRow | null>;
  liveRun(licenseeId: string, kind: RunKind): Promise<RunRow | null>;
  latestRun(licenseeId: string, kind: RunKind): Promise<RunRow | null>;
  listRuns(limit: number): Promise<RunRow[]>;
  steps(runId: string): Promise<StepRow[]>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  updateStep(runId: string, step: string, patch: StepPatch): Promise<void>;
  log(runId: string, step: string | null, level: LogRow["level"], message: string): Promise<void>;
  logs(runId: string, limit: number): Promise<LogRow[]>;
  /** Runs due for the worker, locked for a few minutes so two instances never work on the same run. */
  claimDue(now: Date, limit: number): Promise<string[]>;
  /** Locks one run for this caller (false when someone else is working on it). */
  tryLock(id: string, now: Date): Promise<boolean>;
  release(id: string): Promise<void>;
}

const JSON_COLS = new Set(["setup_missing", "output"]);

function setClause(patch: Record<string, unknown>, allowed: readonly string[], offset: number) {
  const cols = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  return {
    cols,
    sql: cols.map((c, i) => `${c} = $${i + offset}${JSON_COLS.has(c) ? "::jsonb" : ""}`).join(", "),
    values: cols.map((c) => (JSON_COLS.has(c) ? JSON.stringify(patch[c]) : patch[c])),
  };
}

export function pgStore(db: Q): ProvisioningStore {
  const store: ProvisioningStore = {
    async createRun(input) {
      const existing = input.dry_run ? null : await store.liveRun(input.licensee_id, input.kind);
      if (existing) return { run: existing, created: false };
      let run: RunRow;
      try {
        const r = await db.query(
          `INSERT INTO provisioning_runs (licensee_id, kind, trigger, dry_run, region, created_by, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
          [input.licensee_id, input.kind, input.trigger, input.dry_run, input.region, input.created_by],
        );
        run = r.rows[0] as RunRow;
      } catch (err) {
        // Two triggers at once (webhook redelivery): the unique index keeps one; return it.
        if ((err as { code?: string })?.code === "23505") {
          const again = await store.liveRun(input.licensee_id, input.kind);
          if (again) return { run: again, created: false };
        }
        throw err;
      }
      const defs = stepsFor(input.kind);
      for (const [i, d] of defs.entries()) {
        await db.query("INSERT INTO provisioning_steps (run_id, step, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [run.id, d.key, i]);
      }
      return { run, created: true };
    },
    async getRun(id) {
      const r = await db.query("SELECT * FROM provisioning_runs WHERE id = $1", [id]);
      return (r.rows[0] as RunRow) ?? null;
    },
    async liveRun(licenseeId, kind) {
      const r = await db.query(
        `SELECT * FROM provisioning_runs WHERE licensee_id = $1 AND kind = $2 AND NOT dry_run
            AND status NOT IN ('done', 'cancelled') ORDER BY created_at DESC LIMIT 1`,
        [licenseeId, kind],
      );
      return (r.rows[0] as RunRow) ?? null;
    },
    async latestRun(licenseeId, kind) {
      const r = await db.query(
        "SELECT * FROM provisioning_runs WHERE licensee_id = $1 AND kind = $2 AND NOT dry_run ORDER BY created_at DESC LIMIT 1",
        [licenseeId, kind],
      );
      return (r.rows[0] as RunRow) ?? null;
    },
    async listRuns(limit) {
      const r = await db.query("SELECT * FROM provisioning_runs ORDER BY created_at DESC LIMIT $1", [limit]);
      return r.rows as RunRow[];
    },
    async steps(runId) {
      const r = await db.query("SELECT * FROM provisioning_steps WHERE run_id = $1 ORDER BY position", [runId]);
      return r.rows as StepRow[];
    },
    async updateRun(id, patch) {
      const s = setClause(patch, RUN_PATCHABLE, 2);
      if (!s.cols.length) return;
      await db.query(`UPDATE provisioning_runs SET ${s.sql}, updated_at = now() WHERE id = $1`, [id, ...s.values]);
    },
    async updateStep(runId, step, patch) {
      const s = setClause(patch, STEP_PATCHABLE, 3);
      if (!s.cols.length) return;
      await db.query(`UPDATE provisioning_steps SET ${s.sql}, updated_at = now() WHERE run_id = $1 AND step = $2`, [runId, step, ...s.values]);
    },
    async log(runId, step, level, message) {
      await db.query("INSERT INTO provisioning_logs (run_id, step, level, message) VALUES ($1, $2, $3, $4)", [
        runId, step, level, message.slice(0, 4000),
      ]);
    },
    async logs(runId, limit) {
      const r = await db.query(
        "SELECT * FROM (SELECT * FROM provisioning_logs WHERE run_id = $1 ORDER BY id DESC LIMIT $2) x ORDER BY id",
        [runId, limit],
      );
      return r.rows as LogRow[];
    },
    async claimDue(now, limit) {
      const r = await db.query(
        `UPDATE provisioning_runs SET locked_until = $1::timestamptz + interval '5 minutes'
          WHERE id IN (
            SELECT id FROM provisioning_runs
             WHERE status IN ('running', 'blocked', 'waiting_for_setup')
               AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
               AND (locked_until IS NULL OR locked_until < $1)
             ORDER BY next_attempt_at NULLS FIRST
             LIMIT $2
             FOR UPDATE SKIP LOCKED)
          RETURNING id`,
        [now, limit],
      );
      return r.rows.map((x) => String(x.id));
    },
    async tryLock(id, now) {
      const r = await db.query(
        `UPDATE provisioning_runs SET locked_until = $2::timestamptz + interval '5 minutes'
          WHERE id = $1 AND (locked_until IS NULL OR locked_until < $2) RETURNING id`,
        [id, now],
      );
      return r.rows.length > 0;
    },
    async release(id) {
      await db.query("UPDATE provisioning_runs SET locked_until = NULL WHERE id = $1", [id]);
    },
  };
  return store;
}
