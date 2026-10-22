// Keystone prices and allowances, as decided by Todd (KEYSTONE_CONTRACTS.md, "Plans and allowances"). Pure: no
// database, no Stripe. Money is kept in cents; the public payload shows dollars.

export const PLANS = ["starter", "growth", "pro"] as const;
export type Plan = (typeof PLANS)[number];
export const BILLING_INTERVALS = ["annual", "monthly"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const SUPPORT_LEVELS = ["email", "priority", "premium", "dedicated"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

export const CURRENCY = "CAD";

export const isPlan = (v: unknown): v is Plan => typeof v === "string" && (PLANS as readonly string[]).includes(v);
export const isInterval = (v: unknown): v is BillingInterval =>
  typeof v === "string" && (BILLING_INTERVALS as readonly string[]).includes(v);
export const isSupportLevel = (v: unknown): v is SupportLevel =>
  typeof v === "string" && (SUPPORT_LEVELS as readonly string[]).includes(v);

export const PLAN_NAMES: Record<Plan, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

/** Per seat per month, in cents. Annual = the monthly rate when billed yearly. */
export const SEAT_PRICE_CENTS: Record<Plan, Record<BillingInterval, number>> = {
  starter: { annual: 4900, monthly: 5900 },
  growth: { annual: 11900, monthly: 13900 },
  pro: { annual: 19900, monthly: 22900 },
};

export const ONBOARDING_FEE_CENTS: Record<Plan, number> = { starter: 0, growth: 75000, pro: 200000 };
export const MIN_SEATS: Record<Plan, number> = { starter: 1, growth: 1, pro: 2 };

export type Allowance = {
  minutes_per_seat: number;
  texts_per_seat: number;
  /** null = unlimited */
  assistant_chats: number | null;
  storage_gb_per_seat: number;
};

export const ALLOWANCES: Record<Plan, Allowance> = {
  starter: { minutes_per_seat: 50, texts_per_seat: 100, assistant_chats: 200, storage_gb_per_seat: 10 },
  growth: { minutes_per_seat: 500, texts_per_seat: 500, assistant_chats: 1000, storage_gb_per_seat: 25 },
  pro: { minutes_per_seat: 1500, texts_per_seat: 1500, assistant_chats: null, storage_gb_per_seat: 50 },
};

export type SupportDef = {
  name: string;
  price_cents: number;
  /** null = any number of seats */
  covered_seats: number | null;
  extra_seat_cents: number;
  channels: string[];
  first_reply: string;
  live_help: string;
};

// Channels, first reply and live help come from the Oct 20 pricing draft.
export const SUPPORT: Record<SupportLevel, SupportDef> = {
  email: {
    name: "Email", price_cents: 0, covered_seats: null, extra_seat_cents: 0,
    channels: ["Email", "Help articles"], first_reply: "1 business day", live_help: "None",
  },
  priority: {
    name: "Priority", price_cents: 19900, covered_seats: 10, extra_seat_cents: 1500,
    channels: ["Email", "Live chat"], first_reply: "4 business hours",
    live_help: "2 hours of voice or screen-share sessions a month",
  },
  premium: {
    name: "Premium", price_cents: 49900, covered_seats: 10, extra_seat_cents: 3000,
    channels: ["Email", "Chat", "Phone", "Screen sharing"], first_reply: "1 business hour",
    live_help: "6 hours of sessions a month and a quarterly training call",
  },
  dedicated: {
    name: "Dedicated", price_cents: 120000, covered_seats: 25, extra_seat_cents: 4000,
    channels: ["All channels, 7 am to 9 pm Mountain", "Named contact"], first_reply: "30 minutes",
    live_help: "15 hours of sessions a month and new-staff training",
  },
};

export const STORAGE_BLOCK = { gb: 50, price_cents: 1000 };
export const OVERAGE_CENTS = { minute: 4, text: 3 };
export const TRIAL = { days: 14, plan: "pro" as Plan, for: "starter" as Plan, bonus_minutes_per_seat: 100, bonus_texts_per_seat: 100 };

/** Features per plan; each plan includes the ones before it. Mirrors KS-server src/plans/catalogue.ts. */
export const FEATURES: ReadonlyArray<{ key: string; label: string; plan: Plan }> = [
  { key: "contacts", label: "Contacts", plan: "starter" },
  { key: "pipeline", label: "Pipeline", plan: "starter" },
  { key: "client_portal", label: "Branded client portal and application wizard", plan: "starter" },
  { key: "iphone_dialler", label: "iPhone dialler", plan: "starter" },
  { key: "office_sync", label: "Office 365 / Google sync", plan: "starter" },
  { key: "ai_assistant", label: "AI assistant", plan: "starter" },
  { key: "call_recording", label: "Call recording", plan: "growth" },
  { key: "call_summaries", label: "AI call summaries", plan: "growth" },
  { key: "voicemail_transcription", label: "Voicemail transcription", plan: "growth" },
  { key: "watch_ipad_apps", label: "Apple Watch and iPad apps", plan: "growth" },
  { key: "templates", label: "Message templates", plan: "growth" },
  { key: "referrer_portal", label: "Referrer portal", plan: "growth" },
  { key: "full_reports", label: "Reports", plan: "growth" },
  { key: "visitor_tracking", label: "Website visitor tracking", plan: "growth" },
  { key: "toll_free_number", label: "Toll-free number", plan: "growth" },
  { key: "multiple_lines", label: "Multiple business lines", plan: "pro" },
  { key: "lender_portal", label: "Lender portal", plan: "pro" },
  { key: "bank_connect", label: "Bank connect", plan: "pro" },
  { key: "ad_attribution", label: "Ad attribution", plan: "pro" },
  { key: "api_access", label: "API access", plan: "pro" },
  { key: "sso", label: "Single sign-on", plan: "pro" },
  // Fraud protection (matches KS-server src/plans/catalogue.ts): starter 1, 2, 4, 5; growth adds 6, 7, 8; pro all 16.
  { key: "fraud_1", label: "Document tamper scan", plan: "starter" },
  { key: "fraud_2", label: "Bank statement math check", plan: "starter" },
  { key: "fraud_4", label: "Duplicate document check", plan: "starter" },
  { key: "fraud_5", label: "Revenue vs bank deposits", plan: "starter" },
  { key: "fraud_6", label: "Business reality check", plan: "growth" },
  { key: "fraud_7", label: "Phone and email risk", plan: "growth" },
  { key: "fraud_8", label: "ID checks", plan: "growth" },
  { key: "fraud_3", label: "Statement vs live bank data", plan: "pro" },
  { key: "fraud_9", label: "Device and location check", plan: "pro" },
  { key: "fraud_10", label: "Application behaviour signals", plan: "pro" },
  { key: "fraud_11", label: "Loan stacking detector", plan: "pro" },
  { key: "fraud_12", label: "Fraud network map", plan: "pro" },
  { key: "fraud_13", label: "Shared fraud watchlist", plan: "pro" },
  { key: "fraud_14", label: "Inside-job alerts", plan: "pro" },
  { key: "fraud_15", label: "Call voice check", plan: "pro" },
  { key: "fraud_16", label: "Fraud score and lender pre-screen", plan: "pro" },
];

export function featuresFor(plan: Plan): Array<{ key: string; label: string }> {
  const rank = PLANS.indexOf(plan);
  return FEATURES.filter((f) => PLANS.indexOf(f.plan) <= rank).map(({ key, label }) => ({ key, label }));
}

const whole = (n: unknown) => Math.max(0, Math.floor(Number(n) || 0));

/** Seats charged: what the licensee has, but never below the plan's minimum (pro: 2). */
export function billableSeats(plan: Plan, seats: number): number {
  return Math.max(MIN_SEATS[plan], whole(seats), 1);
}

/** Seats above what the support level covers. */
export function supportExtraSeats(level: SupportLevel, seats: number): number {
  const covered = SUPPORT[level].covered_seats;
  return covered === null ? 0 : Math.max(0, whole(seats) - covered);
}

export function supportCents(level: SupportLevel, seats: number): number {
  const s = SUPPORT[level];
  return s.price_cents + supportExtraSeats(level, seats) * s.extra_seat_cents;
}

export type ChargeInput = {
  plan: Plan;
  billing_interval: BillingInterval;
  seats: number;
  support_level: SupportLevel;
  extra_storage_blocks?: number;
  overage_minutes?: number;
  overage_texts?: number;
};

export type ChargeBreakdown = {
  billable_seats: number;
  seat_price_cents: number;
  seats_cents: number;
  support_cents: number;
  support_extra_seats: number;
  storage_cents: number;
  overage_minutes_cents: number;
  overage_texts_cents: number;
  overage_cents: number;
  /** Recurring part only (seats + support + storage): the licensee's MRR. */
  recurring_cents: number;
  total_cents: number;
};

/** One month's charge: seats x seat price + support (+ extra seats) + extra storage x $10 + overage. */
export function monthlyCharge(i: ChargeInput): ChargeBreakdown {
  const seats = billableSeats(i.plan, i.seats);
  const seatPrice = SEAT_PRICE_CENTS[i.plan][i.billing_interval];
  const seatsCents = seats * seatPrice;
  const support = supportCents(i.support_level, seats);
  const storage = whole(i.extra_storage_blocks) * STORAGE_BLOCK.price_cents;
  const om = whole(i.overage_minutes) * OVERAGE_CENTS.minute;
  const ot = whole(i.overage_texts) * OVERAGE_CENTS.text;
  const recurring = seatsCents + support + storage;
  return {
    billable_seats: seats,
    seat_price_cents: seatPrice,
    seats_cents: seatsCents,
    support_cents: support,
    support_extra_seats: supportExtraSeats(i.support_level, seats),
    storage_cents: storage,
    overage_minutes_cents: om,
    overage_texts_cents: ot,
    overage_cents: om + ot,
    recurring_cents: recurring,
    total_cents: recurring + om + ot,
  };
}

export function onboardingFeeCents(plan: Plan): number {
  return ONBOARDING_FEE_CENTS[plan];
}

/** Pooled allowances for a number of seats. */
export function pooledAllowances(plan: Plan, seats: number) {
  const a = ALLOWANCES[plan];
  const s = Math.max(1, whole(seats));
  return {
    minutes: a.minutes_per_seat * s,
    texts: a.texts_per_seat * s,
    assistant_chats: a.assistant_chats,
    storage_gb: a.storage_gb_per_seat * s,
  };
}

export const dollars = (cents: number) => Math.round(cents) / 100;

/** GET /api/public/plans */
export function publicPlans() {
  return {
    plans: PLANS.map((key) => ({
      key,
      name: PLAN_NAMES[key],
      seat_price_annual: dollars(SEAT_PRICE_CENTS[key].annual),
      seat_price_monthly: dollars(SEAT_PRICE_CENTS[key].monthly),
      onboarding_fee: dollars(ONBOARDING_FEE_CENTS[key]),
      min_seats: MIN_SEATS[key],
      allowances: { ...ALLOWANCES[key] },
      features: featuresFor(key),
    })),
    support_levels: SUPPORT_LEVELS.map((key) => {
      const s = SUPPORT[key];
      return {
        key,
        name: s.name,
        price: dollars(s.price_cents),
        covered_seats: s.covered_seats,
        extra_seat_price: dollars(s.extra_seat_cents),
        channels: s.channels,
        first_reply: s.first_reply,
        live_help: s.live_help,
      };
    }),
    extra_storage: { block_gb: STORAGE_BLOCK.gb, price: dollars(STORAGE_BLOCK.price_cents) },
    overage: { minute: dollars(OVERAGE_CENTS.minute), text: dollars(OVERAGE_CENTS.text) },
    trial: { ...TRIAL },
    currency: CURRENCY,
  };
}

/**
 * The Stripe prices the service needs, keyed by a stable name. stripe-setup.ts creates them; billing looks them up in
 * the stripe_prices table by key. Recurring prices exist for both intervals because a subscription's items must all
 * share one interval: a yearly price is 12 x the monthly rate.
 */
export type PriceSpec = {
  key: string;
  product_key: string;
  product_name: string;
  nickname: string;
  unit_amount: number;
  recurring: "month" | "year" | null;
};

export const intervalOf = (b: BillingInterval): "month" | "year" => (b === "annual" ? "year" : "month");
const perInterval = (monthlyCents: number, b: BillingInterval) => (b === "annual" ? monthlyCents * 12 : monthlyCents);

export function priceKey(kind: "seat", plan: Plan, b: BillingInterval): string;
export function priceKey(kind: "support" | "support_extra_seat", level: SupportLevel, b: BillingInterval): string;
export function priceKey(kind: "storage_block", b: BillingInterval): string;
export function priceKey(kind: "onboarding", plan: Plan): string;
export function priceKey(kind: string, a: string, b?: string): string {
  return [kind, a, b].filter(Boolean).join(":");
}

export function stripePriceSpecs(): PriceSpec[] {
  const specs: PriceSpec[] = [];
  for (const b of BILLING_INTERVALS) {
    for (const plan of PLANS) {
      specs.push({
        key: priceKey("seat", plan, b),
        product_key: `seat:${plan}`,
        product_name: `Keystone ${PLAN_NAMES[plan]} seat`,
        nickname: `${PLAN_NAMES[plan]} seat (${b})`,
        unit_amount: perInterval(SEAT_PRICE_CENTS[plan][b], b),
        recurring: intervalOf(b),
      });
    }
    for (const level of SUPPORT_LEVELS) {
      const s = SUPPORT[level];
      if (s.price_cents > 0) {
        specs.push({
          key: priceKey("support", level, b),
          product_key: `support:${level}`,
          product_name: `Keystone ${s.name} support`,
          nickname: `${s.name} support (${b})`,
          unit_amount: perInterval(s.price_cents, b),
          recurring: intervalOf(b),
        });
      }
      if (s.extra_seat_cents > 0) {
        specs.push({
          key: priceKey("support_extra_seat", level, b),
          product_key: `support_extra_seat:${level}`,
          product_name: `Keystone ${s.name} support - extra seat`,
          nickname: `${s.name} support extra seat (${b})`,
          unit_amount: perInterval(s.extra_seat_cents, b),
          recurring: intervalOf(b),
        });
      }
    }
    specs.push({
      key: priceKey("storage_block", b),
      product_key: "storage_block",
      product_name: "Keystone extra storage (50 GB)",
      nickname: `Extra storage 50 GB (${b})`,
      unit_amount: perInterval(STORAGE_BLOCK.price_cents, b),
      recurring: intervalOf(b),
    });
  }
  for (const plan of PLANS) {
    if (ONBOARDING_FEE_CENTS[plan] > 0) {
      specs.push({
        key: priceKey("onboarding", plan),
        product_key: `onboarding:${plan}`,
        product_name: `Keystone ${PLAN_NAMES[plan]} onboarding`,
        nickname: `${PLAN_NAMES[plan]} onboarding (one time)`,
        unit_amount: ONBOARDING_FEE_CENTS[plan],
        recurring: null,
      });
    }
  }
  return specs;
}

export type LineItem = { price_key: string; quantity: number };

/** The subscription items for a licensee (no onboarding fee, no overage). */
export function subscriptionItems(i: Omit<ChargeInput, "overage_minutes" | "overage_texts">): LineItem[] {
  const seats = billableSeats(i.plan, i.seats);
  const items: LineItem[] = [{ price_key: priceKey("seat", i.plan, i.billing_interval), quantity: seats }];
  if (SUPPORT[i.support_level].price_cents > 0) {
    items.push({ price_key: priceKey("support", i.support_level, i.billing_interval), quantity: 1 });
  }
  const extra = supportExtraSeats(i.support_level, seats);
  if (extra > 0) items.push({ price_key: priceKey("support_extra_seat", i.support_level, i.billing_interval), quantity: extra });
  const blocks = whole(i.extra_storage_blocks);
  if (blocks > 0) items.push({ price_key: priceKey("storage_block", i.billing_interval), quantity: blocks });
  return items;
}

export type TrialInfo = { status?: unknown; started_at?: unknown; ends_at?: unknown } | null | undefined;

const toTime = (v: unknown): number | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
};

/** True when the trial window (as reported by the licensee's server) overlaps the month "YYYY-MM" (UTC). */
export function trialOverlapsPeriod(trial: TrialInfo, period: string): boolean {
  if (!trial || typeof trial !== "object") return false;
  const started = toTime(trial.started_at);
  if (started === null) return false;
  const [y, m] = period.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  const ends = toTime(trial.ends_at);
  return started < end && (ends === null || ends > start);
}

/**
 * Pooled minute and text allowances KS-Ops bills against: the plan's per-seat allowance times the billable seats.
 * During a trial the licensee gets at least the trial allowance (TRIAL.for's minutes/texts plus the per-seat bonus).
 */
export function billingAllowance(plan: Plan, seats: number, trial: boolean): { minutes: number; texts: number } {
  const n = billableSeats(plan, seats);
  const base = ALLOWANCES[plan];
  let minutes = base.minutes_per_seat * n;
  let texts = base.texts_per_seat * n;
  if (trial) {
    const t = ALLOWANCES[TRIAL.for];
    minutes = Math.max(minutes, (t.minutes_per_seat + TRIAL.bonus_minutes_per_seat) * n);
    texts = Math.max(texts, (t.texts_per_seat + TRIAL.bonus_texts_per_seat) * n);
  }
  return { minutes, texts };
}

/** Overage worked out by KS-Ops from its own plan and seats; the overage a licensee's server reports is not used. */
export function computeOverage(
  i: { plan: Plan; seats: number; trial: boolean },
  used: { minutes: number; texts: number },
): { minutes: number; texts: number; allowance: { minutes: number; texts: number } } {
  const allowance = billingAllowance(i.plan, i.seats, i.trial);
  return {
    minutes: Math.max(0, whole(used.minutes) - allowance.minutes),
    texts: Math.max(0, whole(used.texts) - allowance.texts),
    allowance,
  };
}
