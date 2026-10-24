// The Stripe client. Only the calls KS-Ops makes are typed here, which keeps tests' fakes small.
import Stripe from "stripe";
import { env } from "../config.js";

type Opts = { idempotencyKey?: string };
type Obj = Record<string, any>;

export type StripeLike = {
  checkout: { sessions: { create: (params: Obj, opts?: Opts) => Promise<{ id: string; url: string | null }> } };
  subscriptions: {
    retrieve: (id: string) => Promise<Obj>;
    update: (id: string, params: Obj, opts?: Opts) => Promise<Obj>;
    /** The staff-only free trial creates its subscription directly (no Checkout). */
    create?: (params: Obj, opts?: Opts) => Promise<Obj & { id: string }>;
  };
  invoiceItems: {
    create: (params: Obj, opts?: Opts) => Promise<{ id: string }>;
    list: (params: Obj) => Promise<{ data: Obj[] }>;
  };
  invoices: {
    create: (params: Obj, opts?: Opts) => Promise<{ id: string }>;
    list: (params: Obj) => Promise<{ data: Obj[] }>;
    /** All of an invoice's lines (webhook payloads carry the first page only). Used by the QuickBooks posting. */
    listLineItems?: (id: string, params?: Obj) => Promise<{ data: Obj[]; has_more?: boolean }>;
  };
  /** Sets the customer's default payment method (invoice_settings) after Checkout. */
  customers?: {
    update: (id: string, params: Obj, opts?: Opts) => Promise<Obj>;
    create?: (params: Obj, opts?: Opts) => Promise<Obj & { id: string }>;
  };
  /** The QuickBooks posting reads these; optional so test fakes stay small. */
  invoicePayments?: { list: (params: Obj) => Promise<{ data: Obj[] }> };
  paymentIntents?: { retrieve: (id: string, params?: Obj) => Promise<Obj> };
  refunds?: { list: (params: Obj) => Promise<{ data: Obj[]; has_more?: boolean }> };
  products: { create: (params: Obj, opts?: Opts) => Promise<{ id: string }> };
  prices: {
    create: (params: Obj, opts?: Opts) => Promise<Obj>;
    list: (params: Obj) => Promise<{ data: Obj[] }>;
  };
  webhooks: { constructEvent: (payload: Buffer | string, header: string, secret: string) => Obj };
};

let cached: { key: string; client: StripeLike } | null = null;

/** The real client, or null when STRIPE_SECRET_KEY is not set. */
export function realStripe(): StripeLike | null {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) return null;
  if (!cached || cached.key !== key) {
    cached = { key, client: new Stripe(key, { appInfo: { name: "KS-Ops" } }) as unknown as StripeLike };
  }
  return cached.client;
}

export class BillingNotConfigured extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "BillingNotConfigured";
  }
}
