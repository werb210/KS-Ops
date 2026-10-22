// Background jobs. The plan-push retry runs every 5 minutes; the daily jobs (usage pull, overage billing, past-due
// reminders) are checked hourly and claimed in job_runs, so they run once a day across instances and restarts.
import type { Deps } from "./deps.js";
import { billOverage } from "./billing/billing.js";
import { bodies, sendQuietly } from "./lib/email.js";
import { periodOf, previousPeriod } from "./lib/http.js";
import { retryPendingPlanPushes } from "./sync/planPush.js";
import { isFinal, pullUsageReport } from "./sync/usage.js";

export async function claimDailyJob(deps: Pick<Deps, "db">, job: string): Promise<boolean> {
  await deps.db.query("INSERT INTO job_runs (job) VALUES ($1) ON CONFLICT (job) DO NOTHING", [job]);
  const r = await deps.db.query(
    "UPDATE job_runs SET last_run_at = now() WHERE job = $1 AND last_run_at < now() - interval '23 hours' RETURNING job",
    [job],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

/**
 * Fallback for licensees whose server did not send its reports: pulls this month's report, and last month's when the
 * stored one is missing or was made before the month ended.
 */
export async function pullUsageForAll(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ pulled: number; failed: number }> {
  const current = periodOf(deps.now());
  const previous = previousPeriod(current);
  const r = await deps.db.query(
    `SELECT l.id, l.company_code, prev.generated_at AS prev_generated_at
       FROM licensees l
       LEFT JOIN usage_reports prev ON prev.licensee_id = l.id AND prev.period = $1
      WHERE l.status IN ('trial','active','past_due') AND l.server_url IS NOT NULL AND l.ops_key_encrypted IS NOT NULL`,
    [previous],
  );
  let pulled = 0;
  let failed = 0;
  for (const row of r.rows) {
    const periods = [current];
    if (!row.prev_generated_at || !isFinal(previous, row.prev_generated_at)) periods.unshift(previous);
    for (const period of periods) {
      const res = await pullUsageReport(deps, row.id, period);
      if (res.ok) pulled += 1;
      else {
        failed += 1;
        console.warn(`[usage-pull] ${row.company_code} ${period}: ${res.error}`);
      }
    }
  }
  return { pulled, failed };
}

/** Reminds past-due licensees every 3 days until they pay. */
export async function sendPastDueReminders(deps: Pick<Deps, "db" | "mailer">): Promise<number> {
  const r = await deps.db.query(
    `UPDATE licensees SET past_due_reminder_sent_at = now()
      WHERE status = 'past_due'
        AND (past_due_reminder_sent_at IS NULL OR past_due_reminder_sent_at < now() - interval '3 days')
      RETURNING id, company_name, contact_name, contact_email`,
  );
  for (const l of r.rows) {
    await sendQuietly(
      deps.mailer,
      {
        to: [l.contact_email],
        subject: `${l.company_name}: your Keystone payment did not go through`,
        ...bodies([
          `Hi ${l.contact_name},`,
          `We could not collect your latest Keystone payment. Your team can keep working for now, but please update your card or pay the open invoice soon so your service is not interrupted.`,
          `You can pay using the link in the invoice email from Stripe, or reply to this email and we will send a new link.`,
        ]),
      },
      "past-due reminder",
    );
  }
  return r.rows.length;
}

export async function runDailyJobs(deps: Deps): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ["usage_pull", () => pullUsageForAll(deps)],
    ["overage_billing", () => billOverage(deps)],
    ["past_due_reminders", () => sendPastDueReminders(deps)],
  ];
  for (const [name, fn] of jobs) {
    try {
      if (!(await claimDailyJob(deps, name))) continue;
      const result = await fn();
      console.log(`[workers] ${name} done`, JSON.stringify(result));
    } catch (err) {
      console.error(`[workers] ${name} failed`, err instanceof Error ? err.message : String(err));
    }
  }
}

export function startWorkers(deps: Deps): () => void {
  let pushing = false;
  let daily = false;
  const push = async () => {
    if (pushing) return;
    pushing = true;
    try {
      const r = await retryPendingPlanPushes(deps);
      if (r.tried) console.log(`[workers] plan push retry: ${r.pushed}/${r.tried} pushed`);
    } catch (err) {
      console.error("[workers] plan push retry failed", err instanceof Error ? err.message : String(err));
    } finally {
      pushing = false;
    }
  };
  const runDaily = async () => {
    if (daily) return;
    daily = true;
    try {
      await runDailyJobs(deps);
    } finally {
      daily = false;
    }
  };
  const timers = [
    setInterval(push, 5 * 60_000),
    setInterval(runDaily, 60 * 60_000),
    setTimeout(runDaily, 2 * 60_000),
    setTimeout(push, 30_000),
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach((t) => clearInterval(t as NodeJS.Timeout));
}
