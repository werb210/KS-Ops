// Stripe billing: Checkout for new subscriptions, keeping the subscription in step with the licensee's plan and seats,
// overage invoices for finished months, and an invoice preview worked out from the pricing module.
import { env, publicSiteUrl } from "../config.js";
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { periodOf } from "../lib/http.js";
import { newSignupToken, type LicenseeRow } from "../licensees/repo.js";
import {
  CURRENCY, OVERAGE_CENTS, PLAN_NAMES, SUPPORT, dollars, monthlyCharge, onboardingFeeCents, priceKey,
  subscriptionItems,
} from "../pricing.js";
import { isFinal } from "../sync/usage.js";
import { BillingNotConfigured, type StripeLike } from "./stripeClient.js";

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

export function checkoutUrls(licenseeId: string, token: string): { success_url: string; cancel_url: string } {
  const site = publicSiteUrl();
  if (!site) throw new BillingNotConfigured("public_site_url_missing");
  const q = `l=${encodeURIComponent(licenseeId)}&t=${encodeURIComponent(token)}`;
  return { success_url: `${site}/signup/success?${q}`, cancel_url: `${site}/signup/cancelled?${q}` };
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

/** What a month would cost, from the pricing module and the stored usage report for that month (if any). */
export async function invoicePreview(db: Q, l: LicenseeRow, period: string) {
  const r = await db.query(
    "SELECT overage_minutes, overage_texts, generated_at FROM usage_reports WHERE licensee_id = $1 AND period = $2",
    [l.id, period],
  );
  const usage = r.rows[0] as { overage_minutes: number; overage_texts: number; generated_at: Date } | undefined;
  const c = monthlyCharge({
    ...l,
    overage_minutes: usage?.overage_minutes ?? 0,
    overage_texts: usage?.overage_texts ?? 0,
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
  add("Extra call minutes", usage?.overage_minutes ?? 0, OVERAGE_CENTS.minute);
  add("Extra texts", usage?.overage_texts ?? 0, OVERAGE_CENTS.text);
  return {
    period,
    currency: CURRENCY,
    billing_interval: l.billing_interval,
    lines,
    recurring: dollars(c.recurring_cents),
    overage: dollars(c.overage_cents),
    total: dollars(c.total_cents),
    usage_report: usage ? { generated_at: usage.generated_at, final: isFinal(period, usage.generated_at) } : null,
    note:
      l.billing_interval === "annual"
        ? "Annual plans are billed once a year at 12 times the monthly amount shown. Overage is billed after each month ends."
        : "Overage is billed after each month ends.",
  };
}

/**
 * Bills overage for every finished month whose final usage report has not been billed yet. Each invoice item and the
 * invoice carry an idempotency key per licensee and month, and the report is marked billed afterwards, so a rerun
 * never charges twice.
 */
export async function billOverage(deps: Pick<Deps, "db" | "stripe" | "now">): Promise<{ billed: number; skipped: number }> {
  const stripe = deps.stripe();
  if (!stripe) return { billed: 0, skipped: 0 };
  const current = periodOf(deps.now());
  const r = await deps.db.query(
    `SELECT ur.id, ur.licensee_id, ur.period, ur.generated_at, ur.overage_minutes, ur.overage_texts,
            l.stripe_customer_id, l.company_name
       FROM usage_reports ur JOIN licensees l ON l.id = ur.licensee_id
      WHERE ur.overage_billed_at IS NULL AND ur.period < $1
      ORDER BY ur.period LIMIT 200`,
    [current],
  );
  let billed = 0;
  let skipped = 0;
  for (const row of r.rows) {
    if (!isFinal(row.period, row.generated_at)) {
      skipped += 1;
      continue;
    }
    const minutes = Number(row.overage_minutes) || 0;
    const texts = Number(row.overage_texts) || 0;
    if (minutes === 0 && texts === 0) {
      await deps.db.query("UPDATE usage_reports SET overage_billed_at = now() WHERE id = $1 AND overage_billed_at IS NULL", [row.id]);
      continue;
    }
    if (!row.stripe_customer_id) {
      console.warn(`[overage] ${row.company_name} has overage for ${row.period} but no Stripe customer yet`);
      skipped += 1;
      continue;
    }
    const base = `ks-overage-${row.licensee_id}-${row.period}`;
    const metadata = { licensee_id: row.licensee_id, period: row.period };
    try {
      if (minutes > 0) {
        await stripe.invoiceItems.create(
          {
            customer: row.stripe_customer_id,
            currency: CURRENCY.toLowerCase(),
            amount: minutes * OVERAGE_CENTS.minute,
            description: `Extra call minutes for ${row.period}: ${minutes} at $${dollars(OVERAGE_CENTS.minute).toFixed(2)}`,
            metadata,
          },
          { idempotencyKey: `${base}-minutes` },
        );
      }
      if (texts > 0) {
        await stripe.invoiceItems.create(
          {
            customer: row.stripe_customer_id,
            currency: CURRENCY.toLowerCase(),
            amount: texts * OVERAGE_CENTS.text,
            description: `Extra texts for ${row.period}: ${texts} at $${dollars(OVERAGE_CENTS.text).toFixed(2)}`,
            metadata,
          },
          { idempotencyKey: `${base}-texts` },
        );
      }
      const invoice = await stripe.invoices.create(
        {
          customer: row.stripe_customer_id,
          pending_invoice_items_behavior: "include",
          auto_advance: true,
          collection_method: "charge_automatically",
          description: `Usage over your plan's allowance for ${row.period}`,
          metadata,
        },
        { idempotencyKey: `${base}-invoice` },
      );
      await deps.db.query(
        "UPDATE usage_reports SET overage_billed_at = now(), overage_invoice_id = $2 WHERE id = $1 AND overage_billed_at IS NULL",
        [row.id, invoice.id],
      );
      billed += 1;
    } catch (err) {
      console.error(`[overage] billing ${row.company_name} for ${row.period} failed: ${err instanceof Error ? err.message : err}`);
      skipped += 1;
    }
  }
  return { billed, skipped };
}

export function stripeWebhookSecret(): string {
  return env("STRIPE_WEBHOOK_SECRET");
}
