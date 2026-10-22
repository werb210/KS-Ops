import { vi } from "vitest";
import type { Q } from "../src/db.js";
import type { Deps } from "../src/deps.js";
import type { Mail } from "../src/lib/email.js";
import type { StripeLike } from "../src/billing/stripeClient.js";
import { signStaffToken } from "../src/auth/staff.js";

type Handler = { match: RegExp; rows: (params: unknown[]) => any[] | { rows: any[]; rowCount: number } };

/** A fake database that answers by SQL content (never by call order) and records every query. */
export function fakeDb(handlers: Array<[RegExp, Handler["rows"]]> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: Q & { calls: typeof calls; on: (m: RegExp, rows: Handler["rows"]) => void } = {
    calls,
    on(match, rows) {
      handlers.unshift([match, rows]);
    },
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const flat = sql.replace(/\s+/g, " ");
      for (const [match, rows] of handlers) {
        if (match.test(flat)) {
          const out = rows(params);
          return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

export function fakeMailer() {
  const sent: Mail[] = [];
  const mailer = vi.fn(async (m: Mail) => {
    sent.push(m);
    return { ok: true };
  });
  return { mailer, sent };
}

export function fakeStripe(overrides: Partial<Record<string, any>> = {}) {
  let n = 0;
  const stripe = {
    checkout: { sessions: { create: vi.fn(async () => ({ id: `cs_test_${++n}`, url: `https://checkout.stripe.test/c/${n}` })) } },
    subscriptions: {
      retrieve: vi.fn(async (id: string) => ({ id, items: { data: [] } })),
      update: vi.fn(async (id: string) => ({ id })),
    },
    invoiceItems: {
      create: vi.fn(async () => ({ id: `ii_${++n}` })),
      list: vi.fn(async (_p: Record<string, unknown>) => ({ data: [] as Record<string, any>[] })),
    },
    invoices: {
      create: vi.fn(async () => ({ id: `in_${++n}` })),
      list: vi.fn(async (_p: Record<string, unknown>) => ({ data: [] as Record<string, any>[] })),
    },
    products: { create: vi.fn(async () => ({ id: `prod_${++n}` })) },
    prices: { create: vi.fn(async () => ({ id: `price_${++n}` })), list: vi.fn(async () => ({ data: [] })) },
    webhooks: {
      constructEvent: vi.fn((payload: Buffer | string, header: string) => {
        if (header !== "valid") throw new Error("No signatures found matching the expected signature");
        return JSON.parse(String(payload));
      }),
    },
    ...overrides,
  };
  return stripe as unknown as StripeLike & typeof stripe;
}

export function makeDeps(partial: Partial<Deps> = {}): Deps {
  return {
    db: partial.db ?? fakeDb(),
    fetch: partial.fetch ?? (vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch),
    mailer: partial.mailer ?? fakeMailer().mailer,
    stripe: partial.stripe ?? (() => null),
    now: partial.now ?? (() => new Date()),
  };
}

export function staffToken(): string {
  return signStaffToken({ id: "11111111-1111-4111-8111-111111111111", email: "admin@example.test", name: "Ada Admin", role: "Admin" });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const validSignup = () => ({
  company_name: "Northwind Capital",
  legal_name: "Northwind Capital Ltd.",
  company_code: "northwind",
  country: "CA",
  province_state: "AB",
  mailing_address: "100 Main Street, Calgary AB T2P 1A1",
  website: "northwind.example",
  contact_name: "Nora North",
  contact_email: "Nora@Northwind.example",
  contact_phone: "(403) 555-0199",
  seats: 3,
  plan: "growth",
  billing_interval: "annual",
  support_level: "priority",
  accept_terms: true,
  accept_privacy: true,
});

export function licenseeRow(over: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    company_name: "Northwind Capital",
    legal_name: "Northwind Capital Ltd.",
    company_code: "northwind",
    contact_name: "Nora North",
    contact_email: "nora@northwind.example",
    contact_phone: "(403) 555-0199",
    country: "CA",
    province_state: "AB",
    mailing_address: "100 Main Street",
    website: null,
    status: "active",
    plan: "growth",
    billing_interval: "monthly",
    support_level: "email",
    seats: 3,
    extra_storage_blocks: 0,
    server_url: "https://ks-northwind.example",
    client_url: null,
    portal_url: null,
    logo_url: null,
    primary_color: null,
    assistant_name: null,
    ops_key_hash: null,
    ops_key_encrypted: null,
    ops_key_rotated_at: null,
    signup_token_hash: null,
    source: "staff",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_checkout_session_id: null,
    onboarding_fee_paid: false,
    plan_sync_status: "synced",
    plan_sync_error: null,
    plan_sync_attempts: 0,
    plan_sync_next_at: null,
    plan_synced_at: null,
    past_due_since: null,
    past_due_reminder_sent_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}
