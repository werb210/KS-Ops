// Stripe webhook events. Each event id is handled once (stripe_events); status changes are conditional updates, so a
// repeated or out-of-order event cannot move a licensee backwards or send the welcome emails twice.
//
// - checkout.session.completed moves a sign-up to provisioning only once the money is in (payment_status "paid" or
//   "no_payment_required"); a delayed payment method (bank debit) waits for checkout.session.async_payment_succeeded.
// - checkout.session.async_payment_failed and checkout.session.expired leave the licensee in pending_payment and email
//   the contact a link to resume payment.
// - A subscription id already on file is never replaced while that subscription is still live in Stripe: the new one
//   is logged, audited and reported to sales instead.
// - invoice.paid only brings a past_due licensee back to active, and only for its own subscription's invoices.
// - Status changes are queued for a push to the licensee's server (see sync/planPush.ts).
import { publicSiteUrl, salesEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { audit, newSignupToken, signupTokenOf, type LicenseeRow } from "../licensees/repo.js";
import { PLAN_NAMES } from "../pricing.js";
import { queueStatusPush } from "../sync/planPush.js";
import { liveSubscriptionStatus } from "./billing.js";

type HookDeps = Pick<Deps, "db" | "mailer"> & Partial<Pick<Deps, "stripe">>;
const ACTOR = "stripe-webhook";
const affected = (r: { rowCount: number | null; rows: unknown[] }) => (r.rowCount ?? r.rows.length) > 0;

type Obj = Record<string, any>;
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? ((v as Obj).id ?? null) : null);
const ts = (v: unknown): Date | null => (typeof v === "number" && v > 0 ? new Date(v * 1000) : null);

async function findLicensee(deps: Pick<Deps, "db">, hints: { id?: unknown; customer?: unknown; subscription?: unknown }): Promise<LicenseeRow | null> {
  const id = typeof hints.id === "string" && /^[0-9a-f-]{36}$/i.test(hints.id) ? hints.id : null;
  const r = await deps.db.query(
    `SELECT * FROM licensees
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
         OR ($2::text IS NOT NULL AND stripe_subscription_id = $2)
         OR ($3::text IS NOT NULL AND stripe_customer_id = $3)
      ORDER BY (id = $1::uuid) DESC NULLS LAST LIMIT 1`,
    [id, idOf(hints.subscription), idOf(hints.customer)],
  );
  return (r.rows[0] as LicenseeRow) ?? null;
}

function invoiceSubscription(inv: Obj): string | null {
  return idOf(inv.parent?.subscription_details?.subscription) ?? idOf(inv.subscription);
}

async function upsertInvoice(deps: Pick<Deps, "db">, inv: Obj, licenseeId: string | null): Promise<void> {
  await deps.db.query(
    `INSERT INTO invoices (licensee_id, stripe_invoice_id, stripe_customer_id, number, status, currency, amount_due,
                           amount_paid, period_start, period_end, due_date, paid_at, hosted_invoice_url, invoice_pdf)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (stripe_invoice_id) DO UPDATE SET
       licensee_id = COALESCE(EXCLUDED.licensee_id, invoices.licensee_id), number = EXCLUDED.number,
       status = EXCLUDED.status, currency = EXCLUDED.currency, amount_due = EXCLUDED.amount_due,
       amount_paid = EXCLUDED.amount_paid, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
       due_date = EXCLUDED.due_date, paid_at = COALESCE(EXCLUDED.paid_at, invoices.paid_at),
       hosted_invoice_url = EXCLUDED.hosted_invoice_url, invoice_pdf = EXCLUDED.invoice_pdf, updated_at = now()`,
    [
      licenseeId,
      inv.id,
      idOf(inv.customer),
      inv.number ?? null,
      inv.status ?? null,
      inv.currency ?? null,
      Number(inv.amount_due ?? 0),
      Number(inv.amount_paid ?? 0),
      ts(inv.period_start),
      ts(inv.period_end),
      ts(inv.due_date),
      ts(inv.status_transitions?.paid_at),
      inv.hosted_invoice_url ?? null,
      inv.invoice_pdf ?? null,
    ],
  );
}

/**
 * Puts a subscription id on the licensee. An id already on file is replaced only when that subscription has ended in
 * Stripe (cancelled, expired, deleted); otherwise the new one is logged and ignored ("kept_existing").
 */
async function adoptSubscription(deps: HookDeps, l: LicenseeRow, subId: string | null, source: string): Promise<"none" | "same" | "set" | "replaced" | "kept_existing"> {
  if (!subId) return "none";
  if (l.stripe_subscription_id === subId) return "same";
  if (!l.stripe_subscription_id) {
    const r = await deps.db.query(
      "UPDATE licensees SET stripe_subscription_id = $2, updated_at = now() WHERE id = $1 AND stripe_subscription_id IS NULL RETURNING id",
      [l.id, subId],
    );
    if (affected(r)) return "set";
    // Another event got there first: compare against what is stored now.
    const now = await deps.db.query("SELECT stripe_subscription_id FROM licensees WHERE id = $1", [l.id]);
    const stored = now.rows[0]?.stripe_subscription_id ?? null;
    if (stored === subId) return "same";
    if (!stored) {
      console.warn(`[stripe] ${source}: could not save subscription ${subId} on licensee ${l.id}`);
      return "kept_existing";
    }
    return adoptSubscription(deps, { ...l, stripe_subscription_id: stored }, subId, source);
  }
  const stripe = deps.stripe?.() ?? null;
  let live: string | null = "unknown";
  if (stripe) {
    try {
      live = await liveSubscriptionStatus(stripe, l.stripe_subscription_id);
    } catch (err) {
      console.warn(`[stripe] could not check subscription ${l.stripe_subscription_id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (live) {
    console.warn(
      `[stripe] ${source}: licensee ${l.company_code} already has subscription ${l.stripe_subscription_id} (${live}); ignoring ${subId}`,
    );
    await audit(deps.db, ACTOR, "stripe.subscription_ignored", l.id, { source, existing: l.stripe_subscription_id, existing_status: live, ignored: subId });
    return "kept_existing";
  }
  const r = await deps.db.query(
    "UPDATE licensees SET stripe_subscription_id = $2, updated_at = now() WHERE id = $1 AND stripe_subscription_id = $3 RETURNING id",
    [l.id, subId, l.stripe_subscription_id],
  );
  if (!affected(r)) return "kept_existing";
  await audit(deps.db, ACTOR, "stripe.subscription_replaced", l.id, { source, previous: l.stripe_subscription_id, current: subId });
  return "replaced";
}

function licenseeSummary(l: LicenseeRow): string {
  return [
    `Company: ${l.company_name} (${l.legal_name})`,
    `Company code: ${l.company_code}`,
    `Plan: ${PLAN_NAMES[l.plan]}, ${l.seats} seat(s), ${l.billing_interval} billing, ${l.support_level} support`,
    `Contact: ${l.contact_name}, ${l.contact_email}, ${l.contact_phone}`,
    `Country: ${l.country}${l.province_state ? `, ${l.province_state}` : ""}`,
  ].join("\n");
}

export const isPaidSession = (s: Obj) => s.payment_status === "paid" || s.payment_status === "no_payment_required";

/** checkout.session.completed (paid now, or waiting for a delayed payment) and async_payment_succeeded (paid). */
async function checkoutCompleted(deps: HookDeps, s: Obj, paidNow: boolean): Promise<string> {
  const l = await findLicensee(deps, { id: s.metadata?.licensee_id ?? s.client_reference_id, customer: s.customer });
  if (!l) return "licensee_not_found";
  const paid = paidNow || isPaidSession(s);
  await deps.db.query(
    `UPDATE licensees SET
        stripe_customer_id = COALESCE(stripe_customer_id, $2),
        stripe_checkout_session_id = COALESCE($3, stripe_checkout_session_id),
        onboarding_fee_paid = onboarding_fee_paid OR $4,
        updated_at = now()
      WHERE id = $1`,
    [l.id, idOf(s.customer), s.id ?? null, paid],
  );
  const sub = await adoptSubscription(deps, l, idOf(s.subscription), "checkout");
  if (sub === "kept_existing" && paid) {
    await sendQuietly(
      deps.mailer,
      {
        to: [salesEmail()],
        subject: `Check Keystone billing: ${l.company_name} paid a second subscription`,
        ...bodies([
          `${l.company_name} completed a Stripe Checkout (${s.id ?? "unknown session"}) that created subscription ${idOf(s.subscription)}, but subscription ${l.stripe_subscription_id} is still live, so KS-Ops kept the existing one.`,
          "Cancel and refund whichever subscription should not exist, in Stripe.",
          licenseeSummary(l),
        ]),
      },
      "duplicate subscription notice",
    );
  }
  // A delayed payment method (for example a bank debit) has not settled yet: wait for async_payment_succeeded.
  if (!paid) return "awaiting_payment";
  // Only the delivery that actually moves the licensee out of pending_payment sends the emails.
  const r = await deps.db.query(
    "UPDATE licensees SET status = 'provisioning', updated_at = now() WHERE id = $1 AND status = 'pending_payment' RETURNING id",
    [l.id],
  );
  const moved = affected(r);
  if (moved) {
    const sales = bodies([
      `${l.company_name} has paid and is ready to be set up.`,
      licenseeSummary(l),
      `Next step: run scripts/provision-licensee.sh ${l.company_code} and then set the server, portal and client addresses in Keystone operations.`,
    ]);
    await sendQuietly(deps.mailer, { to: [salesEmail()], subject: `New Keystone licensee paid: ${l.company_name}`, ...sales }, "sales signup notice");
    const welcome = bodies([
      `Hi ${l.contact_name},`,
      `Thank you for choosing Keystone. Your payment went through and we have started setting up ${l.company_name}'s copy.`,
      `We will email you within one business day with your sign-in details. Your company code is "${l.company_code}" - your team will enter it the first time they open the Keystone apps.`,
      `If you have questions in the meantime, reply to this email or write to ${salesEmail()}.`,
    ]);
    await sendQuietly(deps.mailer, { to: [l.contact_email], subject: "Welcome to Keystone - we are setting things up", ...welcome }, "welcome email");
  } else if (l.status === "cancelled") {
    await sendQuietly(
      deps.mailer,
      {
        to: [salesEmail()],
        subject: `Keystone payment for a cancelled sign-up: ${l.company_name}`,
        ...bodies([
          `${l.company_name} paid (Checkout ${s.id ?? "unknown"}) but its sign-up had already been cancelled${l.released_company_code ? ` and its company code "${l.released_company_code}" released` : ""}.`,
          "Restore the licensee in Keystone operations, or refund the payment in Stripe.",
          licenseeSummary(l),
        ]),
      },
      "paid after cancel notice",
    );
  }
  return moved ? "provisioning" : "unchanged";
}

/** checkout.session.async_payment_failed and checkout.session.expired: stay pending_payment, email a resume link. */
async function checkoutNotPaid(deps: HookDeps, s: Obj, reason: "payment_failed" | "expired"): Promise<string> {
  const l = await findLicensee(deps, { id: s.metadata?.licensee_id ?? s.client_reference_id, customer: s.customer });
  if (!l) return "licensee_not_found";
  if (l.status !== "pending_payment") return "unchanged";
  // A newer Checkout is open (the person resumed payment): this old session does not matter any more.
  if (s.id && l.stripe_checkout_session_id && l.stripe_checkout_session_id !== s.id) return "stale_session";
  const site = publicSiteUrl();
  let link: string | null = null;
  if (site) {
    const token = signupTokenOf(l) ?? (await newSignupToken(deps.db, l.id));
    link = `${site}/signup/cancelled?l=${encodeURIComponent(l.id)}&t=${encodeURIComponent(token)}`;
  }
  const opening =
    reason === "payment_failed"
      ? `Your payment for ${l.company_name}'s Keystone sign-up did not go through, so nothing has been set up yet.`
      : `Your Keystone sign-up for ${l.company_name} is saved, but the payment was not finished.`;
  await sendQuietly(
    deps.mailer,
    {
      to: [l.contact_email],
      subject: reason === "payment_failed" ? "Your Keystone payment did not go through" : "Finish your Keystone sign-up",
      ...bodies([
        `Hi ${l.contact_name},`,
        opening,
        link
          ? `You can finish paying here: ${link}`
          : `Reply to this email and we will send you a secure payment link.`,
        `Your company code "${l.company_code}" is held for you for a few days. If you have questions, write to ${salesEmail()}.`,
      ]),
    },
    "resume payment email",
  );
  await audit(deps.db, ACTOR, `signup.checkout_${reason}`, l.id, { session_id: s.id ?? null });
  return "resume_link_sent";
}

async function setStatus(deps: HookDeps, l: LicenseeRow, sql: string, to: string): Promise<boolean> {
  const r = await deps.db.query(sql, [l.id]);
  if (!affected(r)) return false;
  await queueStatusPush(deps.db, l.id, l.status, to, ACTOR);
  return true;
}

async function subscriptionChanged(deps: HookDeps, sub: Obj, deleted: boolean): Promise<string> {
  const l = await findLicensee(deps, { id: sub.metadata?.licensee_id, subscription: sub.id, customer: sub.customer });
  if (!l) return "licensee_not_found";
  const s = String(sub.status ?? "");
  const ended = deleted || s === "canceled" || s === "incomplete_expired";
  await deps.db.query("UPDATE licensees SET stripe_customer_id = COALESCE(stripe_customer_id, $2), updated_at = now() WHERE id = $1", [
    l.id,
    idOf(sub.customer),
  ]);
  // An ended subscription is never adopted; a live one only when nothing live is on file.
  const adopted = ended ? (l.stripe_subscription_id === sub.id ? "same" : "kept_existing") : await adoptSubscription(deps, l, sub.id ?? null, "subscription");
  if (adopted === "kept_existing" || adopted === "none") return "other_subscription";
  if (ended) {
    await setStatus(deps, l, "UPDATE licensees SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status <> 'cancelled' RETURNING id", "cancelled");
    return "cancelled";
  }
  if (s === "past_due" || s === "unpaid") {
    await setStatus(
      deps,
      l,
      `UPDATE licensees SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
        WHERE id = $1 AND status IN ('active','trial') RETURNING id`,
      "past_due",
    );
    return "past_due";
  }
  if (s === "active") {
    await setStatus(
      deps,
      l,
      `UPDATE licensees SET status = 'active', past_due_since = NULL, past_due_reminder_sent_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'past_due' RETURNING id`,
      "active",
    );
  }
  return "recorded";
}

async function invoiceEvent(deps: HookDeps, type: string, inv: Obj): Promise<string> {
  const subscription = invoiceSubscription(inv);
  const l = await findLicensee(deps, {
    id: inv.parent?.subscription_details?.metadata?.licensee_id ?? inv.metadata?.licensee_id,
    subscription,
    customer: inv.customer,
  });
  await upsertInvoice(deps, inv, l?.id ?? null);
  if (!l) return "invoice_recorded_no_licensee";
  if (type === "invoice.paid") {
    // Paid: a past-due licensee is active again, but only when this invoice belongs to its own subscription. Every
    // other status (provisioning, pending_payment, suspended, cancelled, trial, active) is left alone.
    if (!subscription || !l.stripe_subscription_id || subscription !== l.stripe_subscription_id) return "paid_other";
    const moved = await setStatus(
      deps,
      l,
      `UPDATE licensees SET status = 'active', past_due_since = NULL, past_due_reminder_sent_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'past_due' AND stripe_subscription_id IS NOT NULL RETURNING id`,
      "active",
    );
    return moved ? "paid_reactivated" : "paid";
  }
  if (type === "invoice.payment_failed") {
    await setStatus(
      deps,
      l,
      `UPDATE licensees SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
        WHERE id = $1 AND status IN ('active','trial') RETURNING id`,
      "past_due",
    );
    return "past_due";
  }
  return "invoice_recorded";
}

export async function handleStripeEvent(deps: HookDeps, event: Obj): Promise<{ duplicate: boolean; result: string }> {
  const seen = await deps.db.query("SELECT 1 FROM stripe_events WHERE id = $1", [event.id]);
  if (seen.rows.length) return { duplicate: true, result: "duplicate" };
  const obj = event.data?.object ?? {};
  let result = "ignored";
  switch (event.type) {
    case "checkout.session.completed":
      result = await checkoutCompleted(deps, obj, false);
      break;
    case "checkout.session.async_payment_succeeded":
      result = await checkoutCompleted(deps, obj, true);
      break;
    case "checkout.session.async_payment_failed":
      result = await checkoutNotPaid(deps, obj, "payment_failed");
      break;
    case "checkout.session.expired":
      result = await checkoutNotPaid(deps, obj, "expired");
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      result = await subscriptionChanged(deps, obj, false);
      break;
    case "customer.subscription.deleted":
      result = await subscriptionChanged(deps, obj, true);
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.created":
    case "invoice.finalized":
    case "invoice.updated":
    case "invoice.voided":
    case "invoice.marked_uncollectible":
      result = await invoiceEvent(deps, event.type, obj);
      break;
    default:
      break;
  }
  await deps.db.query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [event.id, event.type]);
  return { duplicate: false, result };
}
