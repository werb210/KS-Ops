// KS_OPS_v13_ADMIN_TRIAL - the free trial only Keystone staff can start (Todd, Oct 24). No payment details up front.
//
//   Days 1-14   free, with every Pro feature
//   Days 15-28  billed at the Starter price (Stripe invoices the contact), still with every Pro feature
//   Day 29 on   Starter features, unless they chose a plan
//
// How it fits what already exists:
// - The licensee's plan in KS-Ops is "starter" (that is what Stripe bills). While the trial runs, the plan pushed to the
//   licensee's server is "pro" (pushPlanFor), so the copy has every Pro feature. When it ends, the next push sends the
//   stored plan again. A plan staff choose during the trial (PATCH plan) is pushed and billed as usual.
// - Stripe: a Starter subscription with trial_end = day 15 and collection_method "send_invoice", so no card or bank
//   account is needed to start; from day 15 Stripe emails an invoice the contact pays online.
// - KS-Ops status is "trial" for the 28 days (overage uses the trial allowance, as for the in-app trial), then "active".
// - Who started it and when is kept on the licensee and in staff_audit; the contact gets an email with the dates.
import type { Deps } from "../deps.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { audit, getLicensee, type LicenseeRow } from "../licensees/repo.js";
import { crmLicenseeStatus } from "../crm/triggers.js";
import { PLAN_NAMES, SEAT_PRICE_CENTS, billableSeats, dollars, monthlyCharge, subscriptionItems, type Plan } from "../pricing.js";
import { queueStatusPush, recordPlanChange } from "../sync/planPush.js";
import { liveSubscriptionStatus, priceIds, requireStripe } from "./billing.js";
import { adminTrialActive, pushPlanFor } from "./adminTrialPlan.js";

export { adminTrialActive, pushPlanFor };

export const ADMIN_TRIAL_FREE_DAYS = 14;
export const ADMIN_TRIAL_PRO_DAYS = 28;
const DAY = 86_400_000;

export type AdminTrialDates = { started_at: Date; billing_starts_at: Date; pro_until: Date };

export function adminTrialDates(start: Date): AdminTrialDates {
  return {
    started_at: start,
    billing_starts_at: new Date(start.getTime() + ADMIN_TRIAL_FREE_DAYS * DAY),
    pro_until: new Date(start.getTime() + ADMIN_TRIAL_PRO_DAYS * DAY),
  };
}

/** "Saturday, October 24, 2026" in Mountain time (where Keystone is run from). */
export function trialDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Edmonton", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

const money = (cents: number) => `$${dollars(cents).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function adminTrialMail(l: LicenseeRow, dates: AdminTrialDates, hasServer: boolean) {
  const first = l.contact_name.trim().split(/\s+/)[0] || l.contact_name;
  const lastFree = new Date(dates.billing_starts_at.getTime() - DAY);
  const lastPro = new Date(dates.pro_until.getTime() - DAY);
  const starter = { ...l, plan: "starter" as Plan, billing_interval: "monthly" as const };
  const charge = monthlyCharge(starter);
  const seats = billableSeats("starter", l.seats);
  return {
    to: [l.contact_email],
    subject: `${l.company_name}: your free Keystone trial has started`,
    ...bodies([
      `Hi ${first},`,
      `We've started a free trial of Keystone for ${l.company_name}. You don't need to enter any payment details to start. Here are your dates:`,
      [
        `${trialDay(dates.started_at)} to ${trialDay(lastFree)}: free, with every Pro feature.`,
        `${trialDay(dates.billing_starts_at)} to ${trialDay(lastPro)}: billed at the Starter price, and you keep every Pro feature. ` +
          `That is ${money(SEAT_PRICE_CENTS.starter.monthly)} per seat a month (${seats} seat${seats === 1 ? "" : "s"}: ${money(charge.recurring_cents)} a month, plus applicable taxes). ` +
          `The first invoice is emailed to you on ${trialDay(dates.billing_starts_at)}, and you can pay it online by bank debit or card.`,
        `From ${trialDay(dates.pro_until)}: you're on Starter, unless you choose another plan before then.`,
      ].join("\n"),
      "To choose a plan, or if you have any questions, just reply to this email.",
      hasServer
        ? "Your team can keep signing in as usual."
        : "We're setting up your copy now and will email your sign-in details within one business day.",
      "The Keystone team",
    ]),
  };
}

export type StartTrialResult =
  | { ok: true; licensee: LicenseeRow; dates: AdminTrialDates; subscription_id: string }
  | { ok: false; status: number; error: string; message: string };

/**
 * Starts the staff trial for an existing licensee. Refused when one was started before, when the licensee is cancelled,
 * or when it already has a live Stripe subscription (change its plan instead).
 */
export async function startAdminTrial(deps: Pick<Deps, "db" | "stripe" | "mailer" | "now" | "fetch">, licenseeId: string, actor: string): Promise<StartTrialResult> {
  const stripe = requireStripe(deps);
  const l = await getLicensee(deps.db, licenseeId);
  if (!l) return { ok: false, status: 404, error: "not_found", message: "That licensee does not exist." };
  if (l.admin_trial_started_at) {
    return { ok: false, status: 409, error: "trial_already_used", message: `A free trial was already started on ${trialDay(new Date(l.admin_trial_started_at))} by ${l.admin_trial_started_by ?? "staff"}.` };
  }
  if (l.status === "cancelled" || l.purged_at) {
    return { ok: false, status: 409, error: "licensee_cancelled", message: "This licensee is cancelled. Reopen it before starting a trial." };
  }
  if (l.stripe_subscription_id) {
    const live = await liveSubscriptionStatus(stripe, l.stripe_subscription_id);
    if (live) {
      return { ok: false, status: 409, error: "subscription_exists", message: `This licensee already has a Stripe subscription (${live}). Change its plan instead.` };
    }
  }

  const now = deps.now();
  const dates = adminTrialDates(now);
  const starter: LicenseeRow = { ...l, plan: "starter", billing_interval: "monthly" };
  const items = subscriptionItems(starter);
  const ids = await priceIds(deps.db, items.map((i) => i.price_key));
  const metadata = { licensee_id: l.id, company_code: l.company_code, ks_admin_trial: "1" };

  let customer = l.stripe_customer_id;
  if (!customer) {
    if (!stripe.customers?.create) throw new Error("stripe_customers_unavailable");
    customer = (
      await stripe.customers.create(
        { email: l.contact_email, name: l.legal_name || l.company_name, metadata },
        { idempotencyKey: `ks-admin-trial-customer-${l.id}` },
      )
    ).id;
  }
  if (!stripe.subscriptions.create) throw new Error("stripe_subscriptions_create_unavailable");
  const sub = await stripe.subscriptions.create(
    {
      customer,
      items: items.map((i) => ({ price: ids[i.price_key], quantity: i.quantity })),
      trial_end: Math.floor(dates.billing_starts_at.getTime() / 1000),
      collection_method: "send_invoice",
      days_until_due: 14,
      metadata,
    },
    { idempotencyKey: `ks-admin-trial-sub-${l.id}` },
  );

  const hasServer = Boolean(l.server_url);
  // Not set up yet: provisioning (staff set it to trial once the copy is running). Otherwise it is on trial now.
  const status = hasServer ? "trial" : l.status === "pending_payment" || l.status === "provisioning" ? "provisioning" : "trial";
  const r = await deps.db.query(
    `UPDATE licensees
        SET plan = 'starter', billing_interval = 'monthly', status = $2,
            stripe_customer_id = $3, stripe_subscription_id = $4,
            admin_trial_started_at = $5, admin_trial_started_by = $6, admin_trial_billing_starts_at = $7,
            admin_trial_pro_until = $8, admin_trial_ended_at = NULL, admin_trial_end_reason = NULL, updated_at = now()
      WHERE id = $1 AND admin_trial_started_at IS NULL
      RETURNING id`,
    [l.id, status, customer, sub.id, dates.started_at, actor, dates.billing_starts_at, dates.pro_until],
  );
  if (!(r.rowCount ?? r.rows.length)) {
    return { ok: false, status: 409, error: "trial_already_used", message: "A free trial was started for this licensee a moment ago." };
  }
  await audit(deps.db, actor, "licensee.admin_trial_started", l.id, {
    started_at: dates.started_at.toISOString(),
    billing_starts_at: dates.billing_starts_at.toISOString(),
    pro_until: dates.pro_until.toISOString(),
    plan_before: l.plan,
    status_before: l.status,
    subscription_id: sub.id,
  });
  const fresh = (await getLicensee(deps.db, l.id))!;
  // The licensee's server gets "pro" (and the status) on the next push; the retry worker sends it within 5 minutes.
  await recordPlanChange(deps, l, { plan: pushPlanFor(fresh, now), extra_storage_blocks: fresh.extra_storage_blocks, status: fresh.status }, actor);
  await deps.db.query("UPDATE licensees SET plan_sync_status = 'pending_sync', plan_sync_next_at = NULL WHERE id = $1", [l.id]);
  if (l.status !== fresh.status) await crmLicenseeStatus(deps, fresh, l.status, fresh.status, now, `${actor} (free trial)`);
  await sendQuietly(deps.mailer, adminTrialMail(fresh, dates, hasServer), "admin trial started");
  return { ok: true, licensee: fresh, dates, subscription_id: sub.id };
}

export function trialEndedMail(l: LicenseeRow) {
  const first = l.contact_name.trim().split(/\s+/)[0] || l.contact_name;
  return {
    to: [l.contact_email],
    subject: `${l.company_name}: your Keystone trial has ended`,
    ...bodies([
      `Hi ${first},`,
      l.plan === "starter"
        ? "Your free trial has ended, and your account is now on Starter. Everything you added is still there; Pro and Growth features are switched off."
        : `Your free trial has ended, and your account is now on ${PLAN_NAMES[l.plan]}.`,
      "To change your plan, just reply to this email.",
      "The Keystone team",
    ]),
  };
}

/**
 * Ends staff trials whose 28 days are up: status trial -> active, the stored plan is pushed again (starter, or the plan
 * they chose), audited, and the contact is told. Safe to run often; each trial ends once.
 */
export async function endAdminTrials(deps: Pick<Deps, "db" | "mailer" | "now">): Promise<number> {
  const now = deps.now();
  const r = await deps.db.query(
    `UPDATE licensees
        SET admin_trial_ended_at = $1,
            admin_trial_end_reason = CASE WHEN plan = 'starter' THEN 'ended' ELSE 'plan_chosen' END,
            updated_at = now()
      WHERE admin_trial_started_at IS NOT NULL AND admin_trial_ended_at IS NULL AND admin_trial_pro_until <= $1
      RETURNING id`,
    [now],
  );
  for (const row of r.rows) {
    const l = await getLicensee(deps.db, row.id as string);
    if (!l) continue;
    await audit(deps.db, "ks-ops", "licensee.admin_trial_ended", l.id, { plan: l.plan, reason: l.admin_trial_end_reason });
    const moved = await deps.db.query("UPDATE licensees SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'trial' RETURNING id", [l.id]);
    if (moved.rows.length) {
      await queueStatusPush(deps.db, l.id, "trial", "active", "ks-ops (trial ended)");
      await crmLicenseeStatus(deps, { ...l, status: "active" }, "trial", "active", now, "ks-ops (trial ended)");
    } else if (l.server_url) {
      // Still the same status: push the stored plan so the server drops the trial's Pro features.
      await recordPlanChange(deps, { ...l, plan: "pro" }, { plan: l.plan, extra_storage_blocks: l.extra_storage_blocks }, "ks-ops (trial ended)");
      await deps.db.query("UPDATE licensees SET plan_sync_status = 'pending_sync', plan_sync_next_at = NULL WHERE id = $1", [l.id]);
    }
    if (l.status !== "cancelled") await sendQuietly(deps.mailer, trialEndedMail(l), "admin trial ended");
  }
  return r.rows.length;
}
