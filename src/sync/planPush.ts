// Pushes a licensee's plan, extra storage and service status to its own server (PUT {server_url}/api/plan with
// X-KS-Ops-Key). When the push fails, or the server address or ops key is not known yet, the licensee is marked
// pending_sync and the retry worker tries again every 5 minutes. The push always sends the licensee's current values,
// so the latest change wins.
//
// beta_features (KS_OPS_BETA_v1) is the licensee's full view of the beta catalogue (see beta/catalogue.ts); it replaces
// what the server had. Servers that do not know the field ignore it.
//
// status is only sent once the licensee is live (trial, active, past_due, suspended, cancelled). KS-server: suspended =
// the staff portal shows a notice and blocks new applications and calls but data stays readable; cancelled = read-only
// export only. Servers that do not know the field ignore it. addons (KS_OPS_BANK_CONNECT_ADDON) is always sent in full.
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { getLicensee, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";
import { pushPlanFor } from "../billing/adminTrialPlan.js";
import { betaSnapshot, type BetaFlag } from "../beta/catalogue.js";

export const RETRY_MINUTES = 5;

/** Statuses a licensee's server is told about. pending_payment and provisioning are KS-Ops-only. */
export const SERVICE_STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"] as const;
export const isServiceStatus = (s: unknown): boolean => (SERVICE_STATUSES as readonly unknown[]).includes(s);

/** KS_OPS_BANK_CONNECT_ADDON - the add-ons Keystone staff can switch on for one licensee. Not plan features: they are
 *  never listed in /api/public/plans and the licensee cannot change them. */
export const ADDONS = ["bank_connect"] as const;
export type AddonKey = (typeof ADDONS)[number];

/** Every known add-on as an explicit boolean (missing = off), so a push also switches one off. */
export function addonsOf(l: Pick<LicenseeRow, "addons">): Record<AddonKey, boolean> {
  const raw = l.addons && typeof l.addons === "object" ? l.addons : {};
  return Object.fromEntries(ADDONS.map((k) => [k, raw[k] === true])) as Record<AddonKey, boolean>;
}

/**
 * The body of PUT {server_url}/api/plan. During a staff free trial on Starter the plan sent is "pro"
 * (KS_OPS_v13_ADMIN_TRIAL, see billing/adminTrial.ts); KS-Ops itself keeps and bills "starter".
 */
export function planPushBody(
  l: Pick<LicenseeRow, "plan" | "extra_storage_blocks" | "status"> &
    Partial<Pick<LicenseeRow, "addons" | "admin_trial_started_at" | "admin_trial_pro_until" | "admin_trial_ended_at">>,
  now: Date = new Date(),
) {
  return {
    plan: pushPlanFor(l, now),
    extra_storage_blocks: l.extra_storage_blocks,
    ...(isServiceStatus(l.status) ? { status: l.status } : {}),
    addons: addonsOf(l), // KS_OPS_BANK_CONNECT_ADDON - servers that do not know the field ignore it
  };
}

/**
 * Records a status change and marks the licensee for a push, which the retry worker sends within 5 minutes (used where
 * an immediate call would hold up the caller, like the Stripe webhook). Only service statuses are pushed, and only
 * when the licensee has a server.
 */
export async function queueStatusPush(db: Q, licenseeId: string, from: string, to: string, by: string): Promise<boolean> {
  if (from === to || !isServiceStatus(to)) return false;
  const r = await db.query(
    `INSERT INTO plan_changes (licensee_id, from_plan, to_plan, from_extra_storage_blocks, to_extra_storage_blocks,
                               from_status, to_status, changed_by)
     SELECT id, plan, plan, extra_storage_blocks, extra_storage_blocks, $2, $3, $4 FROM licensees
      WHERE id = $1 AND server_url IS NOT NULL
     RETURNING id`,
    [licenseeId, from, to, by],
  );
  if (!(r.rowCount ?? r.rows.length)) return false;
  await db.query(
    "UPDATE licensees SET plan_sync_status = 'pending_sync', plan_sync_next_at = NULL, updated_at = now() WHERE id = $1",
    [licenseeId],
  );
  return true;
}

export type PushResult = { ok: true } | { ok: false; error: string };

/**
 * KS_OPS_BETA_v1 - the licensee's beta features for the push, or undefined when they cannot be read (the push then goes
 * without them, so a beta problem never holds up a plan or status change; the next push sends them).
 */
export async function betaFeaturesFor(deps: Pick<Deps, "db" | "now">, l: LicenseeRow): Promise<BetaFlag[] | undefined> {
  try {
    return await betaSnapshot(deps.db, l, deps.now());
  } catch (err) {
    console.warn(`[plan-push] beta features for ${l.id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function recordPlanChange(
  deps: Pick<Deps, "db">,
  before: Pick<LicenseeRow, "id" | "plan" | "extra_storage_blocks"> & { status?: string },
  after: { plan: string; extra_storage_blocks: number; status?: string },
  by: string,
): Promise<string> {
  const statusChanged = after.status !== undefined && after.status !== before.status;
  const r = await deps.db.query(
    `INSERT INTO plan_changes (licensee_id, from_plan, to_plan, from_extra_storage_blocks, to_extra_storage_blocks,
                               from_status, to_status, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      before.id, before.plan, after.plan, before.extra_storage_blocks, after.extra_storage_blocks,
      statusChanged ? (before.status ?? null) : null, statusChanged ? after.status : null, by,
    ],
  );
  return r.rows[0].id as string;
}

async function markFailed(deps: Pick<Deps, "db" | "now">, id: string, error: string): Promise<void> {
  const next = new Date(deps.now().getTime() + RETRY_MINUTES * 60_000);
  await deps.db.query(
    `UPDATE licensees SET plan_sync_status = 'pending_sync', plan_sync_error = $2,
            plan_sync_attempts = plan_sync_attempts + 1, plan_sync_next_at = $3, updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 500), next],
  );
  await deps.db.query(
    "UPDATE plan_changes SET last_error = $2 WHERE licensee_id = $1 AND status = 'pending_sync'",
    [id, error.slice(0, 500)],
  );
}

export async function pushPlan(deps: Pick<Deps, "db" | "fetch" | "now">, licenseeId: string, by = "ks-ops"): Promise<PushResult> {
  const l = await getLicensee(deps.db, licenseeId);
  if (!l) return { ok: false, error: "licensee_not_found" };
  const fail = async (error: string): Promise<PushResult> => {
    await markFailed(deps, l.id, error);
    return { ok: false, error };
  };
  if (!l.server_url) return fail("no_server_url");
  const key = opsKeyOf(l);
  if (!key) return fail("no_ops_key");
  const beta = await betaFeaturesFor(deps, l);
  try {
    const res = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": by.slice(0, 120) },
      body: JSON.stringify({ ...planPushBody(l, deps.now()), ...(beta ? { beta_features: beta } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return fail(`status ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  await deps.db.query(
    `UPDATE licensees SET plan_sync_status = 'synced', plan_sync_error = NULL, plan_sync_attempts = 0,
            plan_sync_next_at = NULL, plan_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [l.id],
  );
  await deps.db.query(
    "UPDATE plan_changes SET status = 'pushed', pushed_at = now(), last_error = NULL WHERE licensee_id = $1 AND status = 'pending_sync'",
    [l.id],
  );
  return { ok: true };
}

/** The retry worker: every licensee whose push is due again. */
export async function retryPendingPlanPushes(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ tried: number; pushed: number }> {
  const r = await deps.db.query(
    `SELECT id FROM licensees
      WHERE plan_sync_status = 'pending_sync' AND (plan_sync_next_at IS NULL OR plan_sync_next_at <= $1)
      ORDER BY plan_sync_next_at NULLS FIRST LIMIT 100`,
    [deps.now()],
  );
  let pushed = 0;
  for (const row of r.rows) {
    const res = await pushPlan(deps, row.id as string, "ks-ops retry");
    if (res.ok) pushed += 1;
    else console.warn(`[plan-push] licensee ${row.id} still pending: ${res.error}`);
  }
  return { tried: r.rows.length, pushed };
}
