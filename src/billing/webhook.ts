// Stripe webhook events. Each event id is handled once (stripe_events); status changes are conditional updates, so a
// repeated or out-of-order event cannot move a licensee backwards or send the welcome emails twice.
import { salesEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { bodies, sendQuietly } from "../lib/email.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { PLAN_NAMES } from "../pricing.js";

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

async function checkoutCompleted(deps: Pick<Deps, "db" | "mailer">, s: Obj): Promise<string> {
  const l = await findLicensee(deps, { id: s.metadata?.licensee_id ?? s.client_reference_id, customer: s.customer });
  if (!l) return "licensee_not_found";
  const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  await deps.db.query(
    `UPDATE licensees SET
        stripe_customer_id = COALESCE($2, stripe_customer_id),
        stripe_subscription_id = COALESCE($3, stripe_subscription_id),
        stripe_checkout_session_id = COALESCE($4, stripe_checkout_session_id),
        onboarding_fee_paid = onboarding_fee_paid OR $5,
        updated_at = now()
      WHERE id = $1`,
    [l.id, idOf(s.customer), idOf(s.subscription), s.id ?? null, paid],
  );
  // Only the delivery that actually moves the licensee out of pending_payment sends the emails.
  const r = await deps.db.query(
    "UPDATE licensees SET status = 'provisioning', updated_at = now() WHERE id = $1 AND status = 'pending_payment' RETURNING id",
    [l.id],
  );
  const moved = (r.rowCount ?? r.rows.length) > 0;
  if (moved) {
    const sales = bodies([
      `${l.company_name} has paid and is ready to be set up.`,
      [
        `Company: ${l.company_name} (${l.legal_name})`,
        `Company code: ${l.company_code}`,
        `Plan: ${PLAN_NAMES[l.plan]}, ${l.seats} seat(s), ${l.billing_interval} billing, ${l.support_level} support`,
        `Contact: ${l.contact_name}, ${l.contact_email}, ${l.contact_phone}`,
        `Country: ${l.country}${l.province_state ? `, ${l.province_state}` : ""}`,
      ].join("\n"),
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
  }
  return moved ? "provisioning" : "unchanged";
}

async function subscriptionChanged(deps: Pick<Deps, "db">, sub: Obj, deleted: boolean): Promise<string> {
  const l = await findLicensee(deps, { id: sub.metadata?.licensee_id, subscription: sub.id, customer: sub.customer });
  if (!l) return "licensee_not_found";
  await deps.db.query(
    `UPDATE licensees SET stripe_subscription_id = $2, stripe_customer_id = COALESCE(stripe_customer_id, $3), updated_at = now()
      WHERE id = $1 AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2)`,
    [l.id, sub.id, idOf(sub.customer)],
  );
  if (l.stripe_subscription_id && l.stripe_subscription_id !== sub.id) return "other_subscription";
  const s = String(sub.status ?? "");
  if (deleted || s === "canceled") {
    await deps.db.query("UPDATE licensees SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status <> 'cancelled'", [l.id]);
    return "cancelled";
  }
  if (s === "past_due" || s === "unpaid") {
    await deps.db.query(
      `UPDATE licensees SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
        WHERE id = $1 AND status IN ('active','trial')`,
      [l.id],
    );
    return "past_due";
  }
  if (s === "active") {
    await deps.db.query(
      `UPDATE licensees SET status = 'active', past_due_since = NULL, past_due_reminder_sent_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'past_due'`,
      [l.id],
    );
  }
  return "recorded";
}

async function invoiceEvent(deps: Pick<Deps, "db">, type: string, inv: Obj): Promise<string> {
  const l = await findLicensee(deps, {
    id: inv.parent?.subscription_details?.metadata?.licensee_id ?? inv.metadata?.licensee_id,
    subscription: invoiceSubscription(inv),
    customer: inv.customer,
  });
  await upsertInvoice(deps, inv, l?.id ?? null);
  if (!l) return "invoice_recorded_no_licensee";
  if (type === "invoice.paid") {
    // Paid: the licensee is active again - unless it is still being set up (or waiting for checkout, or cancelled).
    await deps.db.query(
      `UPDATE licensees SET status = 'active', past_due_since = NULL, past_due_reminder_sent_at = NULL, updated_at = now()
        WHERE id = $1 AND status NOT IN ('provisioning','pending_payment','cancelled')`,
      [l.id],
    );
    return "paid";
  }
  if (type === "invoice.payment_failed") {
    await deps.db.query(
      `UPDATE licensees SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
        WHERE id = $1 AND status IN ('active','trial','past_due')`,
      [l.id],
    );
    return "past_due";
  }
  return "invoice_recorded";
}

export async function handleStripeEvent(deps: Pick<Deps, "db" | "mailer">, event: Obj): Promise<{ duplicate: boolean; result: string }> {
  const seen = await deps.db.query("SELECT 1 FROM stripe_events WHERE id = $1", [event.id]);
  if (seen.rows.length) return { duplicate: true, result: "duplicate" };
  const obj = event.data?.object ?? {};
  let result = "ignored";
  switch (event.type) {
    case "checkout.session.completed":
      result = await checkoutCompleted(deps, obj);
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
