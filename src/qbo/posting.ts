// What a Stripe invoice, payment, refund or fee becomes in Keystone's QuickBooks.
//
// - Invoice: one QuickBooks Invoice per Stripe invoice, for the licensee's Customer (found by company name, then email,
//   or made). Lines: seats, support, extra storage, onboarding, usage overage and anything else, from the Stripe lines
//   (prices are recognised from stripe_prices); a discount line for Stripe discounts; tax from Stripe's tax amount
//   with the tax code in the settings. If the result does not add up to Stripe's total, a line for the difference is
//   added and a warning logged, so the books match what Stripe charged.
// - Payment: a QuickBooks Payment against that invoice for the amount paid (deposited to deposit_account_id when set,
//   otherwise QuickBooks' Undeposited Funds).
// - Refund: a Refund Receipt (paid out of deposit_account_id); without deposit_account_id a Credit Memo instead.
// - Fee: the Stripe processing fee as an Expense (Purchase) from deposit_account_id to fee_account_id, vendor "Stripe".
//   Needs both settings; otherwise the fee is skipped (and the row says why).
import type { Q } from "../db.js";
import type { StripeLike } from "../billing/stripeClient.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { qboQuote, requestIdFor, QboError, type QboApi } from "./client.js";

type Obj = Record<string, any>;

export type QboSettings = {
  tax_code_id: string | null;
  exempt_tax_code_id: string | null;
  income_account_id: string | null;
  deposit_account_id: string | null;
  fee_account_id: string | null;
};
export const SETTING_KEYS = ["tax_code_id", "exempt_tax_code_id", "income_account_id", "deposit_account_id", "fee_account_id"] as const;

export async function loadSettings(db: Q): Promise<QboSettings> {
  const r = await db.query("SELECT * FROM qbo_settings WHERE id = 1");
  const row = r.rows[0] ?? {};
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, row[k] ? String(row[k]) : null])) as QboSettings;
}

export type PostCtx = { db: Q; api: QboApi; settings: QboSettings; stripe: StripeLike | null };
export type PostResult = { status: "done" | "skipped"; qbo_id?: string | null; note?: string };

const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? ((v as Obj).id ?? null) : null);
/** Cents to dollars, exactly two decimals. */
export const money = (cents: number) => Math.round(Number(cents) || 0) / 100;
const sum = (xs: Array<{ amount?: unknown }> | null | undefined) => (xs ?? []).reduce((a, x) => a + (Number(x?.amount) || 0), 0);
const dateOf = (unix: unknown, fallback: Date): string => {
  const n = Number(unix);
  return (Number.isFinite(n) && n > 0 ? new Date(n * 1000) : fallback).toISOString().slice(0, 10);
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// ---------------------------------------------------------------------------------------------------- links (cache)

async function getLink(db: Q, realm: string, kind: string, key: string): Promise<{ qbo_id: string; details: Obj | null } | null> {
  const r = await db.query("SELECT qbo_id, details FROM qbo_links WHERE realm_id = $1 AND kind = $2 AND key = $3", [realm, kind, key]);
  return (r.rows[0] as { qbo_id: string; details: Obj | null }) ?? null;
}

async function saveLink(db: Q, realm: string, kind: string, key: string, qboId: string, details: Obj | null = null): Promise<void> {
  await db.query(
    `INSERT INTO qbo_links (realm_id, kind, key, qbo_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (realm_id, kind, key) DO UPDATE SET qbo_id = EXCLUDED.qbo_id, details = EXCLUDED.details`,
    [realm, kind, key, qboId, details ? JSON.stringify(details) : null],
  );
}

const firstOf = (res: Obj, entity: string): Obj | null => res?.QueryResponse?.[entity]?.[0] ?? null;

// ------------------------------------------------------------------------------------------------------- customers

/** The licensee's QuickBooks Customer: remembered, else found by company name, else by email, else made. */
export async function customerFor(ctx: PostCtx, l: LicenseeRow): Promise<string> {
  const { api, db } = ctx;
  const saved = await getLink(db, api.realmId, "customer", l.id);
  if (saved) return saved.qbo_id;
  let found = firstOf(await api.query(`SELECT Id, DisplayName FROM Customer WHERE DisplayName = ${qboQuote(l.company_name)}`), "Customer");
  if (!found && l.contact_email) {
    try {
      found = firstOf(await api.query(`SELECT Id, DisplayName FROM Customer WHERE PrimaryEmailAddr = ${qboQuote(l.contact_email)}`), "Customer");
    } catch (err) {
      // Not every QuickBooks company allows this filter; the name check above already ran, so carry on and create.
      console.warn(`[qbo] customer lookup by email for ${l.company_code} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let id: string | null = found?.Id ? String(found.Id) : null;
  if (!id) {
    const body = (displayName: string) => ({
      DisplayName: clip(displayName, 500),
      CompanyName: clip(l.legal_name || l.company_name, 100),
      PrimaryEmailAddr: l.contact_email ? { Address: l.contact_email } : undefined,
      PrimaryPhone: l.contact_phone ? { FreeFormNumber: clip(l.contact_phone, 30) } : undefined,
      Notes: `Keystone licensee ${l.company_code} (${l.id})`,
    });
    try {
      id = String((await api.post("customer", body(l.company_name), { requestId: requestIdFor(`customer-${l.id}`) })).Customer.Id);
    } catch (err) {
      // 6240: the name is already used (by a vendor or employee): use the name with the company code.
      if (!(err instanceof QboError) || err.code !== "6240") throw err;
      console.warn(`[qbo] the name "${l.company_name}" is taken in QuickBooks; using "${l.company_name} (${l.company_code})"`);
      id = String(
        (await api.post("customer", body(`${l.company_name} (${l.company_code})`), { requestId: requestIdFor(`customer-${l.id}-coded`) })).Customer.Id,
      );
    }
  }
  await saveLink(db, api.realmId, "customer", l.id, id);
  return id;
}

// ----------------------------------------------------------------------------------------------------------- items

export const ITEMS = {
  seats: "Keystone seats",
  support: "Keystone support",
  storage: "Keystone extra storage",
  onboarding: "Keystone onboarding",
  overage: "Keystone usage overage",
  other: "Keystone other charges",
  refund: "Keystone refunds",
} as const;
export type ItemKind = keyof typeof ITEMS;

async function incomeAccount(ctx: PostCtx): Promise<string> {
  if (ctx.settings.income_account_id) return ctx.settings.income_account_id;
  const saved = await getLink(ctx.db, ctx.api.realmId, "account", "income_default");
  if (saved) return saved.qbo_id;
  const acc = firstOf(await ctx.api.query("SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1"), "Account");
  if (!acc?.Id) throw new QboError("no Income account in QuickBooks: set income_account_id in the QuickBooks settings");
  await saveLink(ctx.db, ctx.api.realmId, "account", "income_default", String(acc.Id), { name: acc.Name ?? null });
  return String(acc.Id);
}

/** The Service item for a kind of charge: remembered, else found by name, else made. */
export async function itemFor(ctx: PostCtx, kind: ItemKind): Promise<string> {
  const name = ITEMS[kind];
  const saved = await getLink(ctx.db, ctx.api.realmId, "item", name);
  if (saved) return saved.qbo_id;
  const found = firstOf(await ctx.api.query(`SELECT Id, Name FROM Item WHERE Name = ${qboQuote(name)}`), "Item");
  const id = found?.Id
    ? String(found.Id)
    : String(
        (
          await ctx.api.post(
            "item",
            { Name: name, Type: "Service", IncomeAccountRef: { value: await incomeAccount(ctx) } },
            { requestId: requestIdFor(`item-${ctx.api.realmId}-${name}`) },
          )
        ).Item.Id,
      );
  await saveLink(ctx.db, ctx.api.realmId, "item", name, id);
  return id;
}

async function vendorFor(ctx: PostCtx, name: string): Promise<string> {
  const saved = await getLink(ctx.db, ctx.api.realmId, "vendor", name);
  if (saved) return saved.qbo_id;
  const found = firstOf(await ctx.api.query(`SELECT Id FROM Vendor WHERE DisplayName = ${qboQuote(name)}`), "Vendor");
  const id = found?.Id
    ? String(found.Id)
    : String((await ctx.api.post("vendor", { DisplayName: name }, { requestId: requestIdFor(`vendor-${ctx.api.realmId}-${name}`) })).Vendor.Id);
  await saveLink(ctx.db, ctx.api.realmId, "vendor", name, id);
  return id;
}

// ------------------------------------------------------------------------------------------------------- invoices

export type InvoiceLine = { kind: ItemKind; description: string; quantity: number; amount: number };

/** Every line of a Stripe invoice (webhook payloads carry the first page only). */
async function allLines(stripe: StripeLike | null, inv: Obj): Promise<Obj[]> {
  const first: Obj[] = inv.lines?.data ?? [];
  if (!inv.lines?.has_more) return first;
  if (!stripe?.invoices.listLineItems) throw new QboError(`Stripe invoice ${inv.id} has more lines than the event carries and Stripe is not configured`);
  const out: Obj[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await stripe.invoices.listLineItems(inv.id, { limit: 100, ...(after ? { starting_after: after } : {}) });
    out.push(...(r.data ?? []));
    if (!r.has_more || !r.data?.length) return out;
    after = r.data[r.data.length - 1].id;
  }
  throw new QboError(`Stripe invoice ${inv.id} has too many lines`);
}

function linePrice(line: Obj): string | null {
  return idOf(line.pricing?.price_details?.price) ?? idOf(line.price) ?? idOf(line.plan);
}

function kindOfKey(key: string | undefined): ItemKind {
  if (!key) return "other";
  const k = key.split(":")[0];
  if (k === "seat") return "seats";
  if (k === "support" || k === "support_extra_seat") return "support";
  if (k === "storage_block") return "storage";
  if (k === "onboarding") return "onboarding";
  return "other";
}

/** The Stripe invoice's lines sorted into seats, support, storage, onboarding, overage and other. */
export async function invoiceLines(db: Q, stripe: StripeLike | null, inv: Obj): Promise<InvoiceLine[]> {
  const lines = await allLines(stripe, inv);
  const prices = [...new Set(lines.map(linePrice).filter((p): p is string => Boolean(p)))];
  const keys = new Map<string, string>();
  if (prices.length) {
    const r = await db.query("SELECT key, stripe_price_id FROM stripe_prices WHERE stripe_price_id = ANY($1::text[])", [prices]);
    for (const row of r.rows) keys.set(String(row.stripe_price_id), String(row.key));
  }
  return lines.map((line) => {
    const price = linePrice(line);
    const kind: ItemKind = line.metadata?.overage || line.metadata?.ks_overage ? "overage" : kindOfKey(price ? keys.get(price) : undefined);
    return {
      kind,
      description: clip(String(line.description ?? ITEMS[kind]), 4000),
      quantity: Number(line.quantity) > 0 ? Number(line.quantity) : 1,
      amount: Number(line.amount) || 0,
    };
  });
}

export const stripeTax = (inv: Obj): number =>
  Array.isArray(inv.total_taxes) ? sum(inv.total_taxes) : Number(inv.tax) || 0;
export const stripeDiscount = (inv: Obj): number => sum(inv.total_discount_amounts);

function taxCodeFor(settings: QboSettings, taxed: boolean): string | null {
  return taxed ? settings.tax_code_id : settings.exempt_tax_code_id;
}

function salesLine(itemId: string, l: InvoiceLine, taxCode: string | null): Obj {
  // QuickBooks wants Amount = Qty x UnitPrice: keep the quantity only when the amount divides evenly.
  const even = l.quantity > 1 && l.amount % l.quantity === 0;
  const qty = even ? l.quantity : 1;
  return {
    Amount: money(l.amount),
    Description: l.description,
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      ItemRef: { value: itemId },
      Qty: qty,
      UnitPrice: money(l.amount / qty),
      ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}),
    },
  };
}

/** The QuickBooks Invoice body for a Stripe invoice. */
export async function buildInvoice(ctx: PostCtx, inv: Obj, l: LicenseeRow, customerId: string, now: Date): Promise<Obj> {
  const lines = await invoiceLines(ctx.db, ctx.stripe, inv);
  const tax = stripeTax(inv);
  const discount = stripeDiscount(inv);
  const taxed = tax > 0;
  if (taxed && !ctx.settings.tax_code_id) {
    throw new QboError(`Stripe invoice ${inv.id} has tax but no tax code is set: set tax_code_id in the QuickBooks settings`);
  }
  const code = taxCodeFor(ctx.settings, taxed);
  const qLines: Obj[] = [];
  for (const line of lines) {
    if (line.amount === 0) continue;
    qLines.push(salesLine(await itemFor(ctx, line.kind), line, code));
  }
  if (discount > 0) {
    qLines.push({ Amount: money(discount), Description: "Discount", DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false } });
  }
  const subtotal = lines.reduce((a, x) => a + x.amount, 0);
  const total = Number(inv.total ?? subtotal - discount + tax);
  const diff = total - (subtotal - discount + tax);
  if (diff !== 0) {
    console.warn(`[qbo] Stripe invoice ${inv.id}: lines, discount and tax come to ${subtotal - discount + tax} cents but the total is ${total}; adding a ${diff} cent line`);
    qLines.push(
      salesLine(await itemFor(ctx, "other"), { kind: "other", description: "Difference to match the Stripe invoice total", quantity: 1, amount: diff }, code),
    );
  }
  return {
    CustomerRef: { value: customerId },
    ...(inv.number ? { DocNumber: clip(String(inv.number), 21) } : {}),
    TxnDate: dateOf(inv.status_transitions?.finalized_at ?? inv.created, now),
    ...(inv.due_date ? { DueDate: dateOf(inv.due_date, now) } : {}),
    ...(l.contact_email ? { BillEmail: { Address: l.contact_email } } : {}),
    PrivateNote: clip(`Stripe invoice ${inv.id}${inv.number ? ` (${inv.number})` : ""}, Keystone licensee ${l.company_code}`, 4000),
    Line: qLines,
    ...(code ? { GlobalTaxCalculation: "TaxExcluded" } : {}),
    ...(taxed ? { TxnTaxDetail: { TotalTax: money(tax) } } : {}),
  };
}

export async function postInvoice(ctx: PostCtx, inv: Obj, l: LicenseeRow, now: Date): Promise<PostResult> {
  if ((Number(inv.total) || 0) === 0 && !(inv.lines?.data ?? []).some((x: Obj) => Number(x.amount))) {
    return { status: "skipped", note: "nothing charged (total 0)" };
  }
  if (Number(inv.total) < 0) return { status: "skipped", note: "a credit (negative total) is not posted as an invoice" };
  // Made before but not recorded (a crash between the two): find it by its number instead of making another.
  if (inv.number) {
    const existing = firstOf(await ctx.api.query(`SELECT Id FROM Invoice WHERE DocNumber = ${qboQuote(clip(String(inv.number), 21))}`), "Invoice");
    if (existing?.Id) return { status: "done", qbo_id: String(existing.Id), note: "found by invoice number" };
  }
  const customerId = await customerFor(ctx, l);
  const body = await buildInvoice(ctx, inv, l, customerId, now);
  const res = await ctx.api.post("invoice", body, { requestId: requestIdFor(`invoice-${inv.id}`) });
  const made = res.Invoice ?? {};
  const want = money(Number(inv.total) || 0);
  if (made.TotalAmt !== undefined && Math.abs(Number(made.TotalAmt) - want) >= 0.01) {
    console.warn(`[qbo] QuickBooks invoice ${made.Id} for Stripe ${inv.id} totals ${made.TotalAmt}, Stripe charged ${want} (check the tax code)`);
  }
  return { status: "done", qbo_id: String(made.Id) };
}

// ------------------------------------------------------------------------------------------------------- payments

/** The payment intent that paid a Stripe invoice (from the invoice, or Stripe's invoice payments). */
export async function paymentIntentOf(stripe: StripeLike | null, inv: Obj): Promise<string | null> {
  const fromInvoice =
    (inv.payments?.data ?? []).map((p: Obj) => idOf(p?.payment?.payment_intent)).find(Boolean) ?? idOf(inv.payment_intent);
  if (fromInvoice) return fromInvoice;
  if (!stripe?.invoicePayments) return null;
  const r = await stripe.invoicePayments.list({ invoice: inv.id, limit: 10 });
  const paid = (r.data ?? []).find((p) => p.status === "paid") ?? r.data?.[0];
  return idOf(paid?.payment?.payment_intent);
}

export async function postPayment(ctx: PostCtx, inv: Obj, l: LicenseeRow, qboInvoiceId: string, now: Date): Promise<PostResult> {
  const paid = Number(inv.amount_paid) || 0;
  if (paid <= 0) return { status: "skipped", note: "nothing paid (amount_paid 0)" };
  const pi = await paymentIntentOf(ctx.stripe, inv);
  const customerId = await customerFor(ctx, l);
  const body = {
    CustomerRef: { value: customerId },
    TotalAmt: money(paid),
    TxnDate: dateOf(inv.status_transitions?.paid_at, now),
    PaymentRefNum: clip(pi ?? String(inv.number ?? inv.id), 21),
    PrivateNote: clip(`Stripe payment ${pi ?? "(unknown)"} for invoice ${inv.id}${inv.number ? ` (${inv.number})` : ""}`, 4000),
    ...(ctx.settings.deposit_account_id ? { DepositToAccountRef: { value: ctx.settings.deposit_account_id } } : {}),
    Line: [{ Amount: money(paid), LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: "Invoice" }] }],
  };
  const res = await ctx.api.post("payment", body, { requestId: requestIdFor(`payment-${inv.id}`) });
  const id = String(res.Payment?.Id);
  if (pi) {
    await saveLink(ctx.db, ctx.api.realmId, "payment_intent", pi, id, {
      stripe_invoice_id: inv.id, qbo_invoice_id: qboInvoiceId, taxed: stripeTax(inv) > 0,
    });
  }
  return { status: "done", qbo_id: id, ...(pi ? {} : { note: "no Stripe payment intent found" }) };
}

// ----------------------------------------------------------------------------------------------------------- fees

export async function postFee(ctx: PostCtx, inv: Obj, now: Date): Promise<PostResult> {
  const { deposit_account_id: from, fee_account_id: to } = ctx.settings;
  if (!from || !to) return { status: "skipped", note: "fee posting is off: set deposit_account_id and fee_account_id" };
  if ((Number(inv.amount_paid) || 0) <= 0) return { status: "skipped", note: "nothing paid" };
  if (!ctx.stripe?.paymentIntents) throw new QboError("Stripe is not configured, so the fee cannot be read");
  const pi = await paymentIntentOf(ctx.stripe, inv);
  if (!pi) return { status: "skipped", note: "no Stripe payment intent for this invoice" };
  const intent = await ctx.stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge.balance_transaction"] });
  const bt = intent?.latest_charge?.balance_transaction;
  if (!bt || typeof bt !== "object") throw new QboError(`the Stripe balance transaction for ${pi} is not available yet`);
  const fee = Number(bt.fee) || 0;
  if (fee <= 0) return { status: "skipped", note: "no Stripe fee" };
  const code = ctx.settings.exempt_tax_code_id;
  const body = {
    PaymentType: "Cash",
    AccountRef: { value: from },
    EntityRef: { value: await vendorFor(ctx, "Stripe"), type: "Vendor" },
    TxnDate: dateOf(bt.created, now),
    DocNumber: clip(String(idOf(intent.latest_charge) ?? pi), 21),
    PrivateNote: clip(`Stripe fee for payment ${pi} (invoice ${inv.id})`, 4000),
    Line: [
      {
        Amount: money(fee),
        Description: `Stripe fee, invoice ${inv.number ?? inv.id}`,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: { AccountRef: { value: to }, ...(code ? { TaxCodeRef: { value: code } } : {}) },
      },
    ],
  };
  const res = await ctx.api.post("purchase", body, { requestId: requestIdFor(`fee-${inv.id}`) });
  return { status: "done", qbo_id: String(res.Purchase?.Id) };
}

// --------------------------------------------------------------------------------------------------------- refunds

export async function postRefund(ctx: PostCtx, refund: Obj, charge: Obj, l: LicenseeRow, now: Date): Promise<PostResult> {
  const status = String(refund.status ?? "succeeded");
  if (status === "failed" || status === "canceled") return { status: "skipped", note: `refund ${status}` };
  const amount = Number(refund.amount) || 0;
  if (amount <= 0) return { status: "skipped", note: "nothing refunded" };
  const pi = idOf(refund.payment_intent) ?? idOf(charge.payment_intent);
  let stripeInvoice: string | null = null;
  let taxed = false;
  if (pi) {
    const link = await getLink(ctx.db, ctx.api.realmId, "payment_intent", pi);
    if (link?.details) {
      stripeInvoice = link.details.stripe_invoice_id ?? null;
      taxed = Boolean(link.details.taxed);
    } else if (ctx.stripe?.invoicePayments) {
      const r = await ctx.stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
      stripeInvoice = idOf(r.data?.[0]?.invoice);
    }
  }
  const useTax = taxed && Boolean(ctx.settings.tax_code_id);
  const code = taxCodeFor(ctx.settings, useTax);
  const line = salesLine(
    await itemFor(ctx, "refund"),
    { kind: "refund", description: `Refund${stripeInvoice ? ` of Stripe invoice ${stripeInvoice}` : ""}${refund.reason ? ` (${refund.reason})` : ""}`, quantity: 1, amount },
    code,
  );
  const base = {
    CustomerRef: { value: await customerFor(ctx, l) },
    TxnDate: dateOf(refund.created, now),
    PrivateNote: clip(`Stripe refund ${refund.id} of charge ${charge.id ?? idOf(refund.charge) ?? ""}${stripeInvoice ? ` (invoice ${stripeInvoice})` : ""}`, 4000),
    Line: [line],
    ...(code ? { GlobalTaxCalculation: useTax ? "TaxInclusive" : "TaxExcluded" } : {}),
  };
  if (ctx.settings.deposit_account_id) {
    const res = await ctx.api.post(
      "refundreceipt",
      { ...base, PaymentRefNum: clip(String(refund.id), 21), DepositToAccountRef: { value: ctx.settings.deposit_account_id } },
      { requestId: requestIdFor(`refund-${refund.id}`) },
    );
    return { status: "done", qbo_id: String(res.RefundReceipt?.Id), note: "refund receipt" };
  }
  const res = await ctx.api.post("creditmemo", { ...base, DocNumber: clip(String(refund.id), 21) }, { requestId: requestIdFor(`refund-${refund.id}`) });
  return { status: "done", qbo_id: String(res.CreditMemo?.Id), note: "credit memo (set deposit_account_id for refund receipts)" };
}
