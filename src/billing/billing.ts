// Stripe billing: Checkout for new subscriptions, keeping the subscription in step with the licensee's plan and seats,
// overage invoices for finished months, and an invoice preview worked out from the pricing module.
import { env, publicSiteUrl } from "../config.js";
import { statusTokenFor } from "../provisioning/statusToken.js";
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { periodOf } from "../lib/http.js";
import { newSignupToken, type LicenseeRow } from "../licensees/repo.js";
import {
  CURRENCY, OVERAGE_CENTS, PLAN_NAMES, SUPPORT, computeOverage, dollars, monthlyCharge, onboardingFeeCents, priceKey,
  subscriptionItems, trialOverlapsPeriod, type Plan, type TrialInfo,
} from "../pricing.js";
import { isFinal } from "../sync/usage.js";
import { BillingNotConfigured, type StripeLike } from "./stripeClient.js";
import { checkoutPaymentParams } from "./paymentMethods.js";

type Obj = Record<string, any>;

export function requireStripe(deps: Pick<Deps, "stripe">): StripeLike {
  const s = deps.stripe();
  if (!s) throw new BillingNotConfigured("stripe_not_configured");
  return s;
}

/** Stripe price ids for the given keys, from the stripe_prices table (written by scripts/stripe-setup.ts). */
export async function priceIds(db: Q, keys: string[]): Promise<Record<string, string>> {
  const r = await db.query("SELECT key, stripe_price_id FROM stripe_prices WHERE key = ANY($1::text[])", [keys]);
  const map: Record<string, string> = Object.fromEntries(r.rows.map((x) => [x.key as string, x.stripe_price_id as string]));
  const missing = keys.filter((k) => !map[k]);
  if (missing.length) {
    console.error(`[billing] Stripe prices missing (run scripts/stripe-setup.ts): ${missing.join(", ")}`);
    throw new BillingNotConfigured("stripe_prices_missing");
  }
  return map;
}

/** Subscription statuses after which a subscription will never bill again. */
export const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * The status of a Stripe subscription that is still live (could still bill or be revived), or null when it has ended
 * or no longer exists. Other Stripe errors are thrown.
 */
export async function liveSubscriptionStatus(stripe: StripeLike, subscriptionId: string): Promise<string | null> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const status = String(sub?.status ?? "");
    if (ENDED_SUBSCRIPTION_STATUSES.has(status)) return null;
    return status || "unknown";
  } catch (err) {
    const e = err as { code?: string; statusCode?: number } | null;
    if (e?.code === "resource_missing" || e?.statusCode === 404) return null;
    throw err;
  }
}

/** Whether KS-Ops bills a period with the trial allowance: the licensee is in trial now, or its reported trial overlaps. */
export function trialApplies(status: string, trial: TrialInfo, period: string): boolean {
  return status === "trial" || trialOverlapsPeriod(trial, period);
}

export function checkoutUrls(licenseeId: string, token: string): { success_url: string; cancel_url: string } {
  const site = publicSiteUrl();
  if (!site) throw new BillingNotConfigured("public_site_url_missing");
  const q = `l=${encodeURIComponent(licenseeId)}&t=${encodeURIComponent(token)}`;
  // KS_OPS_AUTO_PROVISION_v1 - p: the opaque token for the "We're setting up your system" progress (statusToken.ts).
  const p = statusTokenFor(licenseeId);
  return { success_url: `${site}/signup/success?${q}${p ? `&p=${p}` : ""}`, cancel_url: `${site}/signup/cancelled?${q}` };
}

/**
 * A Stripe Checkout session for the licensee's subscription, plus the onboarding fee when it has not been paid.
 * Pass the signup token when the caller already has one (public sign-up); otherwise a new one is made so the
 * success and cancel pages work.
 */
export async function createCheckout(
  deps: Pick<Deps, "db" | "stripe">,
  l: LicenseeRow,
  token?: string,
): Promise<{ id: string; url: string }> {
  const stripe = requireStripe(deps);
  const items = subscriptionItems(l);
  const fee = l.onboarding_fee_paid ? 0 : onboardingFeeCents(l.plan);
  const keys = [...items.map((i) => i.price_key), ...(fee > 0 ? [priceKey("onboarding", l.plan)] : [])];
  const ids = await priceIds(deps.db, keys);
  const urls = checkoutUrls(l.id, token ?? (await newSignupToken(deps.db, l.id)));
  const lineItems = items.map((i) => ({ price: ids[i.price_key], quantity: i.quantity }));
  if (fee > 0) lineItems.push({ price: ids[priceKey("onboarding", l.plan)], quantity: 1 });
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: lineItems,
    ...(l.stripe_customer_id ? { customer: l.stripe_customer_id } : { customer_email: l.contact_email }),
    client_reference_id: l.id,
    metadata: { licensee_id: l.id, company_code: l.company_code },
    subscription_data: { metadata: { licensee_id: l.id, company_code: l.company_code } },
    // Bank debit (Canadian PAD, with its mandate) by default; card when the licensee chose it.
    ...checkoutPaymentParams(l.payment_method),
    ...urls,
  });
  if (!session.url) throw new Error("stripe_checkout_without_url");
  await deps.db.query("UPDATE licensees SET stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1", [l.id, session.id]);
  return { id: session.id, url: session.url };
}

/**
 * Brings the Stripe subscription in line with the licensee's plan, billing interval, seats, support level and extra
 * storage: changes quantities, removes items no longer wanted and adds new ones. Stripe prorates the difference.
 * Returns "skipped" when there is no subscription or Stripe is not configured.
 */
export async function syncSubscription(deps: Pick<Deps, "db" | "stripe">, l: LicenseeRow): Promise<"updated" | "skipped"> {
  const stripe = deps.stripe();
  if (!stripe || !l.stripe_subscription_id) return "skipped";
  const wanted = subscriptionItems(l);
  const ids = await priceIds(deps.db, wanted.map((w) => w.price_key));
  const sub = await stripe.subscriptions.retrieve(l.stripe_subscription_id);
  const existing: Array<{ id: string; price: { id: string }; quantity?: number }> = sub?.items?.data ?? [];
  const items: Array<Record<string, unknown>> = [];
  const wantedByPrice = new Map(wanted.map((w) => [ids[w.price_key], w.quantity]));
  for (const item of existing) {
    const qty = wantedByPrice.get(item.price?.id);
    if (qty === undefined) items.push({ id: item.id, deleted: true });
    else {
      if (item.quantity !== qty) items.push({ id: item.id, quantity: qty });
      wantedByPrice.delete(item.price.id);
    }
  }
  for (const [price, quantity] of wantedByPrice) items.push({ price, quantity });
  if (!items.length) return "updated";
  await stripe.subscriptions.update(l.stripe_subscription_id, {
    items,
    proration_behavior: "create_prorations",
    metadata: { licensee_id: l.id, company_code: l.company_code },
  });
  return "updated";
}

export type PreviewLine = { description: string; quantity: number; unit_amount: number; amount: number };

/** What a month would cost, from the pricing module and the stored usage report for that month (if any). Overage is
 *  worked out from KS-Ops's own plan and seats, as billing does; the overage the licensee's server reported is shown
 *  alongside for comparison. */
export async function invoicePreview(db: Q, l: LicenseeRow, period: string) {
  const r = await db.query(
    `SELECT minutes, texts, trial, overage_minutes, overage_texts, generated_at
       FROM usage_reports WHERE licensee_id = $1 AND period = $2`,
    [l.id, period],
  );
  const usage = r.rows[0] as
    | { minutes: number; texts: number; trial: TrialInfo; overage_minutes: number; overage_texts: number; generated_at: Date }
    | undefined;
  const overage = usage
    ? computeOverage(
        { plan: l.plan, seats: l.seats, trial: trialApplies(l.status, usage.trial, period) },
        { minutes: Number(usage.minutes), texts: Number(usage.texts) },
      )
    : null;
  const c = monthlyCharge({
    ...l,
    overage_minutes: overage?.minutes ?? 0,
    overage_texts: overage?.texts ?? 0,
  });
  const lines: PreviewLine[] = [];
  const add = (description: string, quantity: number, unitCents: number) => {
    if (quantity > 0 && unitCents > 0) {
      lines.push({ description, quantity, unit_amount: dollars(unitCents), amount: dollars(quantity * unitCents) });
    }
  };
  add(`${PLAN_NAMES[l.plan]} seats (${l.billing_interval} rate)`, c.billable_seats, c.seat_price_cents);
  const support = SUPPORT[l.support_level];
  add(`${support.name} support`, 1, support.price_cents);
  add(`${support.name} support - seats over ${support.covered_seats ?? 0}`, c.support_extra_seats, support.extra_seat_cents);
  add("Extra storage (50 GB blocks)", l.extra_storage_blocks, 1000);
  add("Extra call minutes", overage?.minutes ?? 0, OVERAGE_CENTS.minute);
  add("Extra texts", overage?.texts ?? 0, OVERAGE_CENTS.text);
  return {
    period,
    currency: CURRENCY,
    billing_interval: l.billing_interval,
    lines,
    recurring: dollars(c.recurring_cents),
    overage: dollars(c.overage_cents),
    total: dollars(c.total_cents),
    usage_report: usage
      ? {
          generated_at: usage.generated_at,
          final: isFinal(period, usage.generated_at),
          allowance: overage!.allowance,
          overage: { minutes: overage!.minutes, texts: overage!.texts },
          reported_overage: { minutes: Number(usage.overage_minutes) || 0, texts: Number(usage.overage_texts) || 0 },
        }
      : null,
    note:
      l.billing_interval === "annual"
        ? "Annual plans are billed once a year at 12 times the monthly amount shown. Overage is billed after each month ends."
        : "Overage is billed after each month ends.",
  };
}

type OverageRow = {
  id: string;
  licensee_id: string;
  period: string;
  generated_at: Date;
  minutes: number;
  texts: number;
  trial: TrialInfo;
  plan: Plan;
  seats: number;
  status: string;
  stripe_customer_id: string | null;
  company_name: string;
};

type Progress = {
  status: string;
  stripe_customer_id: string;
  minutes: number;
  texts: number;
  minutes_amount: number;
  texts_amount: number;
  minutes_invoice_item_id: string | null;
  texts_invoice_item_id: string | null;
  invoice_id: string | null;
};

const OVERAGE_KINDS = ["minutes", "texts"] as const;

async function markReportBilled(db: Q, reportId: string, invoiceId: string | null): Promise<void> {
  await db.query(
    "UPDATE usage_reports SET overage_billed_at = now(), overage_invoice_id = $2 WHERE id = $1 AND overage_billed_at IS NULL",
    [reportId, invoiceId],
  );
}

/**
 * Bills one licensee's overage for one finished month. Progress lives in overage_billing (one row per licensee and
 * month): the amounts are fixed when the row is made, each Stripe object's id is saved as soon as it exists, and
 * before creating anything Stripe is searched for an item or invoice already made for this licensee and month (by
 * metadata). So a rerun - even days later, past Stripe's 24-hour idempotency window - never charges twice.
 */
async function billOverageFor(deps: Pick<Deps, "db">, stripe: StripeLike, row: OverageRow): Promise<"invoiced" | "nothing" | "skipped"> {
  const key = [row.licensee_id, row.period];
  let p = (await deps.db.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = $2", key)).rows[0] as Progress | undefined;
  if (!p) {
    const trial = trialApplies(row.status, row.trial, row.period);
    const o = computeOverage({ plan: row.plan, seats: row.seats, trial }, { minutes: Number(row.minutes), texts: Number(row.texts) });
    const details = { plan: row.plan, seats: row.seats, trial, allowance: o.allowance, used: { minutes: row.minutes, texts: row.texts } };
    if (o.minutes === 0 && o.texts === 0) {
      await deps.db.query(
        `INSERT INTO overage_billing (licensee_id, period, status, details) VALUES ($1, $2, 'nothing_to_bill', $3)
         ON CONFLICT (licensee_id, period) DO NOTHING`,
        [...key, JSON.stringify(details)],
      );
      await markReportBilled(deps.db, row.id, null);
      return "nothing";
    }
    if (!row.stripe_customer_id) {
      console.warn(`[overage] ${row.company_name} has overage for ${row.period} but no Stripe customer yet`);
      return "skipped";
    }
    await deps.db.query(
      `INSERT INTO overage_billing (licensee_id, period, status, stripe_customer_id, minutes, texts, minutes_amount,
                                    texts_amount, details)
       VALUES ($1, $2, 'started', $3, $4, $5, $6, $7, $8) ON CONFLICT (licensee_id, period) DO NOTHING`,
      [
        ...key, row.stripe_customer_id, o.minutes, o.texts, o.minutes * OVERAGE_CENTS.minute, o.texts * OVERAGE_CENTS.text,
        JSON.stringify(details),
      ],
    );
    p = (await deps.db.query("SELECT * FROM overage_billing WHERE licensee_id = $1 AND period = $2", key)).rows[0] as Progress;
  }
  if (p.status === "nothing_to_bill") {
    await markReportBilled(deps.db, row.id, null);
    return "nothing";
  }
  if (p.status === "invoiced") {
    await markReportBilled(deps.db, row.id, p.invoice_id);
    return "nothing";
  }

  const customer = p.stripe_customer_id;
  const metadata = { licensee_id: row.licensee_id, period: row.period, ks_overage: "1" };
  const ours = (o: Obj) => o?.metadata?.licensee_id === row.licensee_id && o?.metadata?.period === row.period;
  const idOf = (v: unknown): string | null => (typeof v === "string" ? v : (v as Obj | null)?.id ?? null);
  let stripeItems: Obj[] | null = null;
  let invoiceFromItems: string | null = null;
  const base = `ks-overage-${row.licensee_id}-${row.period}`;

  for (const kind of OVERAGE_KINDS) {
    const amount = Number(p[`${kind}_amount`]) || 0;
    if (amount <= 0) continue;
    const saved = p[`${kind}_invoice_item_id`];
    if (saved) continue;
    stripeItems ??= (await stripe.invoiceItems.list({ customer, limit: 100 })).data ?? [];
    const found = stripeItems.find((it) => ours(it) && it.metadata?.overage === kind);
    let itemId: string;
    if (found) {
      itemId = found.id;
      invoiceFromItems ??= idOf(found.invoice);
    } else {
      const qty = Number(p[kind]) || 0;
      const unit = kind === "minutes" ? OVERAGE_CENTS.minute : OVERAGE_CENTS.text;
      const label = kind === "minutes" ? "Extra call minutes" : "Extra texts";
      itemId = (
        await stripe.invoiceItems.create(
          {
            customer,
            currency: CURRENCY.toLowerCase(),
            amount,
            description: `${label} for ${row.period}: ${qty} at $${dollars(unit).toFixed(2)}`,
            metadata: { ...metadata, overage: kind },
          },
          { idempotencyKey: `${base}-${kind}` },
        )
      ).id;
    }
    await deps.db.query(
      `UPDATE overage_billing SET ${kind}_invoice_item_id = $3, updated_at = now() WHERE licensee_id = $1 AND period = $2`,
      [...key, itemId],
    );
    p[`${kind}_invoice_item_id`] = itemId;
  }
  await deps.db.query(
    "UPDATE overage_billing SET status = 'items_created', updated_at = now() WHERE licensee_id = $1 AND period = $2 AND status = 'started'",
    key,
  );

  let invoiceId = p.invoice_id ?? invoiceFromItems;
  if (!invoiceId) {
    const existing = (await stripe.invoices.list({ customer, limit: 100 })).data ?? [];
    invoiceId = existing.find((inv) => ours(inv) && inv.metadata?.ks_overage === "1")?.id ?? null;
  }
  if (!invoiceId) {
    invoiceId = (
      await stripe.invoices.create(
        {
          customer,
          pending_invoice_items_behavior: "include",
          auto_advance: true,
          collection_method: "charge_automatically",
          description: `Usage over your plan's allowance for ${row.period}`,
          metadata,
        },
        { idempotencyKey: `${base}-invoice` },
      )
    ).id;
  }
  await deps.db.query(
    `UPDATE overage_billing SET invoice_id = $3, status = 'invoiced', last_error = NULL, updated_at = now()
      WHERE licensee_id = $1 AND period = $2`,
    [...key, invoiceId],
  );
  await markReportBilled(deps.db, row.id, invoiceId);
  return "invoiced";
}

/**
 * Bills overage for every finished month whose final usage report has not been billed yet (see billOverageFor).
 * Overage is worked out from KS-Ops's own plan and seats, never taken from the report.
 */
export async function billOverage(deps: Pick<Deps, "db" | "stripe" | "now">): Promise<{ billed: number; skipped: number }> {
  const stripe = deps.stripe();
  if (!stripe) return { billed: 0, skipped: 0 };
  const current = periodOf(deps.now());
  const r = await deps.db.query(
    `SELECT ur.id, ur.licensee_id, ur.period, ur.generated_at, ur.minutes, ur.texts, ur.trial,
            l.plan, l.seats, l.status, l.stripe_customer_id, l.company_name
       FROM usage_reports ur JOIN licensees l ON l.id = ur.licensee_id
      WHERE ur.overage_billed_at IS NULL AND ur.period < $1
      ORDER BY ur.period LIMIT 200`,
    [current],
  );
  let billed = 0;
  let skipped = 0;
  for (const row of r.rows as OverageRow[]) {
    if (!isFinal(row.period, row.generated_at)) {
      skipped += 1;
      continue;
    }
    try {
      const res = await billOverageFor(deps, stripe, row);
      if (res === "invoiced") billed += 1;
      else if (res === "skipped") skipped += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[overage] billing ${row.company_name} for ${row.period} failed: ${msg}`);
      await deps.db
        .query(
          `UPDATE overage_billing SET last_error = $3, attempts = attempts + 1, updated_at = now()
            WHERE licensee_id = $1 AND period = $2`,
          [row.licensee_id, row.period, msg.slice(0, 500)],
        )
        .catch((e) => console.error(`[overage] could not record the failure: ${e instanceof Error ? e.message : e}`));
      skipped += 1;
    }
  }
  return { billed, skipped };
}

export function stripeWebhookSecret(): string {
  return env("STRIPE_WEBHOOK_SECRET");
}
