// KS_OPS_TWILIO_AUTO_v1 - the licensee's Twilio sub-account follows the licensee, and pending texting registrations
// are checked. Run by the worker every 30 minutes.
//   trial, active, past_due, provisioning  -> active (reactivated if it was suspended)
//   suspended                              -> suspended (numbers kept, calls and texts stop)
//   cancelled                              -> stays active CANCELLED_ACTIVE_DAYS (KS-server releases the numbers after
//                                             its 30-day grace period), then suspended; closed only after the
//                                             cancellation retention period (cancelled_at + DATA_RETENTION_DAYS),
//                                             and only CLOSE_NOTICE_DAYS after sales was emailed that it will be.
// Closing is the only irreversible step and is never silent: notice email, audit, then the closing email.
import { audit, DATA_RETENTION_DAYS, getLicensee, type LicenseeRow } from "../licensees/repo.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { salesEmail } from "../config.js";
import { CANCELLED_ACTIVE_DAYS, CLOSE_NOTICE_DAYS, masterCreds } from "./config.js";
import { API, logTwilioError, plainTwilioError } from "./http.js";
import { twilioOf, type TwilioDeps } from "./account.js";
import type { AccountStatus, TwilioRow } from "./store.js";
import { pushTexting, refreshRegistration } from "./texting.js";

const DAY = 86_400_000;

/** What the sub-account should be now, or null to leave it alone. */
export function desiredStatus(l: Pick<LicenseeRow, "status" | "cancelled_at">, now: Date): AccountStatus | null {
  if (["trial", "active", "past_due", "provisioning"].includes(l.status)) return "active";
  if (l.status === "suspended") return "suspended";
  if (l.status === "cancelled") {
    const since = l.cancelled_at ? now.getTime() - new Date(l.cancelled_at).getTime() : 0;
    if (!l.cancelled_at) return "suspended";
    if (since >= DATA_RETENTION_DAYS * DAY) return "closed";
    return since >= CANCELLED_ACTIVE_DAYS * DAY ? "suspended" : "active";
  }
  return null;
}

export type LifecycleResult = { changed: string[]; noticed: string[]; failed: string[] };

async function setStatus(deps: TwilioDeps, row: TwilioRow, status: AccountStatus): Promise<void> {
  const { http, store, env } = twilioOf(deps);
  const master = masterCreds(env)!;
  await http.post(master, `${API}/Accounts/${row.subaccount_sid}.json`, { Status: status }, `${status === "active" ? "reactivate" : status === "suspended" ? "suspend" : "close"} the sub-account`);
  await store.update(row.licensee_id, { account_status: status, status_changed_at: deps.now(), ...(status === "closed" ? { closed_at: deps.now() } : {}) });
}

export async function syncAccountStatuses(deps: TwilioDeps): Promise<LifecycleResult> {
  const { store, env } = twilioOf(deps);
  const out: LifecycleResult = { changed: [], noticed: [], failed: [] };
  if (!masterCreds(env)) return out;
  const now = deps.now();
  for (const row of await store.listOpen()) {
    const l = await getLicensee(deps.db, row.licensee_id);
    if (!l) {
      console.warn("[twilio] sub-account without a licensee; left alone", { subaccount: row.subaccount_sid });
      continue;
    }
    const want = desiredStatus(l, now);
    if (!want || want === row.account_status) continue;
    const who = `${l.company_name} (${l.company_code})`;
    try {
      if (want === "closed") {
        if (!row.close_notice_sent_at) {
          const closeOn = new Date(now.getTime() + CLOSE_NOTICE_DAYS * DAY).toISOString().slice(0, 10);
          await sendQuietly(deps.mailer, {
            to: [salesEmail(env)],
            subject: `Twilio sub-account for ${who} will be closed on ${closeOn}`,
            ...bodies([
              `${who} was cancelled more than ${DATA_RETENTION_DAYS} days ago, so its Twilio sub-account ${row.subaccount_sid} will be closed on ${closeOn}. Closing gives up any numbers still in it and cannot be undone.`,
              "To keep it, reopen the licensee in KS-Ops before then.",
            ]),
          }, "twilio close notice");
          await store.update(l.id, { close_notice_sent_at: now });
          await audit(deps.db, "ks-ops twilio", "licensee.twilio_close_scheduled", l.id, { subaccount_sid: row.subaccount_sid, close_on: closeOn });
          out.noticed.push(l.company_code);
          continue;
        }
        if (now.getTime() - new Date(row.close_notice_sent_at).getTime() < CLOSE_NOTICE_DAYS * DAY) continue;
        await setStatus(deps, row, "closed");
        await audit(deps.db, "ks-ops twilio", "licensee.twilio_subaccount_closed", l.id, { subaccount_sid: row.subaccount_sid });
        await sendQuietly(deps.mailer, {
          to: [salesEmail(env)],
          subject: `Twilio sub-account for ${who} closed`,
          ...bodies([`The Twilio sub-account ${row.subaccount_sid} of ${who} was closed today, after the cancellation retention period.`]),
        }, "twilio closed notice");
      } else {
        await setStatus(deps, row, want);
        if (want === "active" && row.close_notice_sent_at) await store.update(l.id, { close_notice_sent_at: null });
        await audit(deps.db, "ks-ops twilio", want === "active" ? "licensee.twilio_subaccount_reactivated" : "licensee.twilio_subaccount_suspended", l.id, {
          subaccount_sid: row.subaccount_sid, licensee_status: l.status,
        });
      }
      console.log(`[twilio] ${l.company_code}: sub-account ${row.subaccount_sid} ${row.account_status} -> ${want}`);
      out.changed.push(`${l.company_code}:${want}`);
    } catch (err) {
      logTwilioError("sub-account status change", err, { licensee: l.id, to: want });
      await audit(deps.db, "ks-ops twilio", "licensee.twilio_status_failed", l.id, { to: want, error: plainTwilioError(err) });
      out.failed.push(l.company_code);
    }
  }
  return out;
}

/** Checks registrations that are due, then pushes any changed status to the licensees' servers. */
export async function refreshTexting(deps: TwilioDeps, limit = 20): Promise<{ checked: number; pushed: number }> {
  const { store } = twilioOf(deps);
  let checked = 0;
  for (const reg of await store.dueRegistrations(deps.now(), limit)) {
    const l = await getLicensee(deps.db, reg.licensee_id);
    if (!l) continue;
    await refreshRegistration(deps, l, reg);
    checked += 1;
  }
  let pushed = 0;
  const seen = new Set<string>();
  for (const reg of await store.unpushedRegistrations(50)) {
    if (seen.has(reg.licensee_id)) continue;
    seen.add(reg.licensee_id);
    const l = await getLicensee(deps.db, reg.licensee_id);
    if (!l || !l.server_url) continue;
    const r = await pushTexting(deps, l);
    if (r.ok) pushed += 1;
    else console.warn("[twilio] texting status not pushed", { licensee: l.company_code, error: r.error });
  }
  return { checked, pushed };
}
