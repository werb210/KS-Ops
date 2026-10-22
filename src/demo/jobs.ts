// The demo's background jobs (every 10 minutes):
//   1. emails still owed for finished demos (the prospect's package, the note to sales) - retried until sent
//   2. "started but didn't finish" to sales: opened, not finished, and idle DEMO_IDLE_HOURS (or expired)
//   3. expiry: wipe the session on the demo server, then drop the events and package here (the lead is kept);
//      sign-ups whose link was never opened are deleted outright.
import type { Deps } from "../deps.js";
import { salesEmail } from "../config.js";
import { sendQuietly } from "../lib/email.js";
import { demoConfigured, demoIdleHours } from "./config.js";
import { digestEvents } from "./digest.js";
import { prospectPackageMail, salesCompletedMail, salesUnfinishedMail } from "./emails.js";
import * as repo from "./repo.js";
import { wipeServerSession } from "./server.js";

const MAX_MAIL_ATTEMPTS = 20;

/** Sends what is owed for one finished demo. Each email is claimed first, so two runs never send it twice. */
export async function sendCompletionMails(deps: Pick<Deps, "db" | "mailer">, id: string): Promise<{ prospect: boolean; sales: boolean }> {
  const s = await repo.getSignup(deps.db, id);
  const out = { prospect: false, sales: false };
  if (!s || s.status === "wiped" || s.mail_attempts >= MAX_MAIL_ATTEMPTS) return out;
  const pkg = await repo.packageOf(deps.db, id);
  if (pkg && !s.prospect_package_sent_at && (await repo.claimMail(deps.db, id, "prospect_package_sent_at"))) {
    out.prospect = await sendQuietly(deps.mailer, prospectPackageMail(s, pkg.pdf.toString("base64"), pkg.filename), "demo package");
    if (!out.prospect) await repo.releaseMail(deps.db, id, "prospect_package_sent_at");
  }
  if (s.completed_at && !s.sales_completed_sent_at && (await repo.claimMail(deps.db, id, "sales_completed_sent_at"))) {
    const digest = digestEvents(await repo.eventsFor(deps.db, id));
    await repo.setDigest(deps.db, id, digest);
    out.sales = await sendQuietly(deps.mailer, salesCompletedMail(salesEmail(), s, digest), "demo finished (sales)");
    if (!out.sales) await repo.releaseMail(deps.db, id, "sales_completed_sent_at");
  }
  return out;
}

export async function sendUnfinishedMail(deps: Pick<Deps, "db" | "mailer">, id: string, reason: "idle" | "expired"): Promise<boolean> {
  const s = await repo.getSignup(deps.db, id);
  if (!s || s.completed_at || s.sales_unfinished_sent_at || s.mail_attempts >= MAX_MAIL_ATTEMPTS) return false;
  if (!(await repo.claimMail(deps.db, id, "sales_unfinished_sent_at"))) return false;
  const digest = digestEvents(await repo.eventsFor(deps.db, id));
  await repo.setDigest(deps.db, id, digest);
  const ok = await sendQuietly(deps.mailer, salesUnfinishedMail(salesEmail(), s, digest, reason, demoIdleHours()), "demo unfinished (sales)");
  if (!ok) await repo.releaseMail(deps.db, id, "sales_unfinished_sent_at");
  return ok;
}

export async function runDemoJobs(deps: Pick<Deps, "db" | "mailer" | "fetch" | "now">): Promise<{ mails: number; unfinished: number; wiped: number; deleted: number }> {
  const now = deps.now();
  let mails = 0, unfinished = 0, wiped = 0, deleted = 0;

  const owed = await deps.db.query(
    `SELECT id FROM demo_signups
      WHERE status = 'completed' AND mail_attempts < $1
        AND ((package_pdf IS NOT NULL AND prospect_package_sent_at IS NULL) OR sales_completed_sent_at IS NULL)
      LIMIT 50`,
    [MAX_MAIL_ATTEMPTS],
  );
  for (const r of owed.rows) {
    const res = await sendCompletionMails(deps, r.id);
    mails += Number(res.prospect) + Number(res.sales);
  }

  const idleCutoff = new Date(now.getTime() - demoIdleHours() * 3_600_000);
  const idle = await deps.db.query(
    `SELECT id, expires_at FROM demo_signups
      WHERE status = 'active' AND completed_at IS NULL AND sales_unfinished_sent_at IS NULL AND mail_attempts < $3
        AND (COALESCE(last_activity_at, opened_at) < $1 OR expires_at < $2)
      LIMIT 50`,
    [idleCutoff, now, MAX_MAIL_ATTEMPTS],
  );
  for (const r of idle.rows) {
    if (await sendUnfinishedMail(deps, r.id, new Date(r.expires_at) < now ? "expired" : "idle")) unfinished++;
  }

  const expired = await deps.db.query(
    `SELECT id, status, server_session_id, completed_at, sales_unfinished_sent_at FROM demo_signups
      WHERE status <> 'wiped' AND expires_at < $1 LIMIT 100`,
    [now],
  );
  for (const r of expired.rows) {
    if (r.status === "pending" && !r.server_session_id) {
      await repo.deleteSignup(deps.db, r.id);
      deleted++;
      continue;
    }
    // Make sure sales heard about an unfinished demo before its events go.
    if (!r.completed_at && !r.sales_unfinished_sent_at) await sendUnfinishedMail(deps, r.id, "expired");
    if (!r.server_session_id || !demoConfigured() || (await wipeServerSession(deps.fetch, r.id))) {
      const digest = digestEvents(await repo.eventsFor(deps.db, r.id));
      if (digest.events) await repo.setDigest(deps.db, r.id, digest);
      await repo.markWiped(deps.db, r.id);
      wiped++;
    }
  }
  return { mails, unfinished, wiped, deleted };
}
