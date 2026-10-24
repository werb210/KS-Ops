// KS_OPS_v13_ADMIN_TRIAL - which plan a licensee's server is told about during a staff free trial. Kept apart from
// adminTrial.ts so the plan push can use it without importing billing.
import type { LicenseeRow } from "../licensees/repo.js";
import type { Plan } from "../pricing.js";

export type TrialFields = Pick<LicenseeRow, "plan"> &
  Partial<Pick<LicenseeRow, "admin_trial_started_at" | "admin_trial_pro_until" | "admin_trial_ended_at">>;

/** Whether the staff trial's Pro period is running now. */
export function adminTrialActive(l: TrialFields, now: Date = new Date()): boolean {
  if (!l.admin_trial_started_at || !l.admin_trial_pro_until || l.admin_trial_ended_at) return false;
  return now.getTime() < new Date(l.admin_trial_pro_until).getTime();
}

/** The plan the licensee's server is told about: pro during a staff trial on Starter, else the stored plan. */
export function pushPlanFor(l: TrialFields, now: Date = new Date()): Plan {
  return l.plan === "starter" && adminTrialActive(l, now) ? "pro" : l.plan;
}

