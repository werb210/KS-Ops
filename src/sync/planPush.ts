// Pushes a licensee's plan and extra storage to its own server (PUT {server_url}/api/plan with X-KS-Ops-Key). When the
// push fails, or the server address or ops key is not known yet, the licensee is marked pending_sync and the retry
// worker tries again every 5 minutes. The push always sends the licensee's current values, so the latest change wins.
import type { Deps } from "../deps.js";
import { getLicensee, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";

export const RETRY_MINUTES = 5;

export type PushResult = { ok: true } | { ok: false; error: string };

export async function recordPlanChange(
  deps: Pick<Deps, "db">,
  before: Pick<LicenseeRow, "id" | "plan" | "extra_storage_blocks">,
  after: { plan: string; extra_storage_blocks: number },
  by: string,
): Promise<string> {
  const r = await deps.db.query(
    `INSERT INTO plan_changes (licensee_id, from_plan, to_plan, from_extra_storage_blocks, to_extra_storage_blocks, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [before.id, before.plan, after.plan, before.extra_storage_blocks, after.extra_storage_blocks, by],
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
  try {
    const res = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/plan`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": by.slice(0, 120) },
      body: JSON.stringify({ plan: l.plan, extra_storage_blocks: l.extra_storage_blocks }),
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
