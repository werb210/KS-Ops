// Background jobs. The plan-push retry runs every 5 minutes; the daily jobs (usage pull, overage billing, past-due
// reminders) are checked hourly and claimed in job_runs, so they run once a day across instances and restarts.
import type { Deps } from "./deps.js";
import { pendingSignupDays } from "./config.js";
import { billOverage } from "./billing/billing.js";
import { bodies, sendQuietly } from "./lib/email.js";
import { periodOf, previousPeriod } from "./lib/http.js";
import { audit } from "./licensees/repo.js";
import { retryPendingPlanPushes } from "./sync/planPush.js";
import { endAdminTrials } from "./billing/adminTrial.js";
import { syncPgiLinks } from "./sync/pgiLink.js";
import { isFinal, pullUsageReport } from "./sync/usage.js";
import { runDemoJobs } from "./demo/jobs.js";
import { getLicensee } from "./licensees/repo.js";
import { crmLicenseeStatus } from "./crm/triggers.js";
import { flushCrmOutbox } from "./crm/outbox.js";
import { flushQboOutbox } from "./qbo/outbox.js";

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

/**
 * The company code an expired sign-up is given in place of its own: "exp--" and 27 characters of its id. It fits the
 * 32-character code rule, is unique, and can never be chosen by anyone (codes may not contain "--").
 */
export function expiredCode(id: string): string {
  return `exp--${id.replace(/-/g, "").slice(0, 27)}`;
}

/**
 * Website sign-ups still in pending_payment after PENDING_SIGNUP_DAYS (default 7) are cancelled and their company
 * code is released for someone else (the old code is kept in released_company_code). Staff-created licensees are left
 * alone.
 */
export async function expirePendingSignups(deps: Pick<Deps, "db" | "now">): Promise<number> {
  const days = pendingSignupDays();
  const cutoff = new Date(deps.now().getTime() - days * 86_400_000);
  const r = await deps.db.query(
    `UPDATE licensees
        SET status = 'cancelled',
            released_company_code = company_code,
            company_code = 'exp--' || substr(replace(id::text, '-', ''), 1, 27),
            updated_at = now()
      WHERE status = 'pending_payment' AND source = 'website' AND created_at < $1
      RETURNING id, released_company_code`,
    [cutoff],
  );
  for (const row of r.rows) {
    await audit(deps.db, "ks-ops", "signup.expired", row.id, { released_company_code: row.released_company_code, days });
    // Keystone CRM: the company keeps the code it signed up with (the stored one is now a placeholder).
    const l = await getLicensee(deps.db, row.id);
    if (l) {
      await crmLicenseeStatus(deps, { ...l, company_code: row.released_company_code ?? l.company_code }, "pending_payment", "cancelled", deps.now(), `unpaid after ${days} days`);
    }
  }
  return r.rows.length;
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
    ["expire_pending_signups", () => expirePendingSignups(deps)],
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
      // KS_OPS_v13_ADMIN_TRIAL - trials whose 28 days are up go back to their stored plan before the push runs.
      const ended = await endAdminTrials(deps).catch((err) => {
        console.error("[workers] ending free trials failed", err instanceof Error ? err.message : String(err));
        return 0;
      });
      if (ended) console.log(`[workers] free trials ended: ${ended}`);
      const r = await retryPendingPlanPushes(deps);
      if (r.tried) console.log(`[workers] plan push retry: ${r.pushed}/${r.tried} pushed`);
    } catch (err) {
      console.error("[workers] plan push retry failed", err instanceof Error ? err.message : String(err));
    } finally {
      pushing = false;
    }
  };
  // PGI referrals: link live licensees to the insurance partner (and switch stopped ones off) every 5 minutes.
  let pgiBusy = false;
  const pgi = async () => {
    if (pgiBusy) return;
    pgiBusy = true;
    try {
      const r = await syncPgiLinks(deps);
      if (r.tried) console.log(`[workers] pgi link: ${r.linked} linked, ${r.disabled} switched off, of ${r.tried}`);
    } catch (err) {
      console.error("[workers] pgi link failed", err instanceof Error ? err.message : String(err));
    } finally {
      pgiBusy = false;
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
  let demoBusy = false;
  const demo = async () => {
    if (demoBusy) return;
    demoBusy = true;
    try {
      const r = await runDemoJobs(deps);
      if (r.mails || r.unfinished || r.wiped || r.deleted) console.log("[workers] demo jobs", JSON.stringify(r));
    } catch (err) {
      console.error("[workers] demo jobs failed", err instanceof Error ? err.message : String(err));
    } finally {
      demoBusy = false;
    }
  };
  // Keystone CRM pushes (src/crm/outbox.ts): due ones go every 30 seconds.
  let crmBusy = false;
  const crm = async () => {
    if (crmBusy) return;
    crmBusy = true;
    try {
      const r = await flushCrmOutbox(deps);
      if (r.tried) console.log(`[workers] crm push: ${r.sent}/${r.tried} sent`);
    } catch (err) {
      console.error("[workers] crm push failed", err instanceof Error ? err.message : String(err));
    } finally {
      crmBusy = false;
    }
  };
  // Keystone's QuickBooks (src/qbo/outbox.ts): due postings every minute.
  let qboBusy = false;
  const qbo = async () => {
    if (qboBusy) return;
    qboBusy = true;
    try {
      const r = await flushQboOutbox(deps);
      if (r.tried) console.log(`[workers] quickbooks: ${r.done} posted, ${r.skipped} skipped, ${r.failed} failed of ${r.tried}`);
    } catch (err) {
      console.error("[workers] quickbooks posting failed", err instanceof Error ? err.message : String(err));
    } finally {
      qboBusy = false;
    }
  };
  const timers = [
    setInterval(qbo, 60_000),
    setTimeout(qbo, 45_000),
    setInterval(crm, 30_000),
    setTimeout(crm, 20_000),
    setInterval(demo, 10 * 60_000),
    setTimeout(demo, 60_000),
    setInterval(push, 5 * 60_000),
    setInterval(runDaily, 60 * 60_000),
    setTimeout(runDaily, 2 * 60_000),
    setTimeout(push, 30_000),
    setInterval(pgi, 5 * 60_000),
    setTimeout(pgi, 90_000),
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach((t) => clearInterval(t as NodeJS.Timeout));
}
