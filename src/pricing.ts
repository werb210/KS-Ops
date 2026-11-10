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
/** Most seats a licensee can buy (sign-up and staff); larger teams contact sales. */
export const MAX_SEATS = 1000;
/** Most extra 50 GB storage blocks a licensee can buy. */
export const MAX_STORAGE_BLOCKS = 1000;

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
// KS_OPS_MARKETING_ADDON - signings over the 4 included are $2.50 each; with the Marketing add-on, campaign emails over
// the allowance are $10 for each 10,000 (or part). Both go on the next month's bill.
export const OVERAGE_CENTS = { minute: 4, text: 3, signing: 250, campaign_email_block: 1000, id_check: 400 };
// KS_OPS_KYC - ID and selfie verification (Entrust IDV): each completed vendor check is counted by the licensee's server
// (usage report id_checks). Some are included each month per brokerage (not per seat); each one over is $4.00 on the
// next bill. Never blocked. Mirrors KS-server src/plans/idChecks.ts. Starter has no ID verification (growth and up).
export const ID_CHECKS = { included: { starter: 0, growth: 10, pro: 30 } as Record<"starter" | "growth" | "pro", number>, trial_included: 5, overage_cents: 400 };

/** ID checks over the month's included number. During a trial at least the trial's few are included. */
export function idCheckOverage(plan: "starter" | "growth" | "pro", trial: boolean, used: number): { id_checks: number; included: number } {
  const included = trial ? Math.max(ID_CHECKS.trial_included, ID_CHECKS.included[plan]) : ID_CHECKS.included[plan];
  return { id_checks: Math.max(0, Math.floor(Number(used) || 0) - included), included };
}

// KS_OPS_MARKETING_ADDON (Todd, Oct 26) - mirrors KS-server src/plans/marketing.ts. Every plan markets to its own
// client list at these limits; the Marketing add-on ($49 a month, flat, one per brokerage, any plan; Pro does not
// include it) raises them and adds the advanced tools. Both trials include the add-on.
export type MarketingLimits = {
  campaign_emails: number;
  text_to_many: number;
  /** null = unlimited */
  sequences: number | null;
  /** null = full history */
  visitor_history_days: number | null;
  /** null = unlimited */
  lead_forms: number | null;
};
export const MARKETING_LIMITS: Record<Plan, MarketingLimits> = {
  starter: { campaign_emails: 500, text_to_many: 50, sequences: 2, visitor_history_days: 30, lead_forms: 1 },
  growth: { campaign_emails: 1000, text_to_many: 250, sequences: 5, visitor_history_days: 90, lead_forms: 1 },
  pro: { campaign_emails: 2500, text_to_many: 500, sequences: 10, visitor_history_days: 365, lead_forms: 1 },
};
export const MARKETING_ADDON = {
  key: "marketing",
  name: "Marketing add-on",
  price_cents: 4900,
  extra_campaign_emails: 10_000,
  campaign_email_block: 10_000,
  bonus_marketing_texts: 1000,
  text_to_many: 1000,
  sequences: null,
  visitor_history_days: null,
  lead_forms: null,
  marketing_seats: 3,
  adds: [
    "10,000 campaign emails a month on top of your plan's, then $10 per 10,000 on next month's bill",
    "1,000 bonus marketing texts a month",
    "Send one text to up to 1,000 people at a time",
    "Unlimited sequences running at once",
    "Unlimited website lead forms, plus an AI chat widget and tracking script for your own website",
    "Full visitor history and session replay",
    "Full Google Ads tools: attribution, ad-waste report, Customer Match, Monday ads email and AI ads suggestions",
    "Landing pages with a lead form, built in the portal",
    "Lead scoring",
    "Subject-line A/B test and send-time choice",
    "Campaign report with applications and funded deals by campaign",
  ],
} as const;
/** E-signing: 4 signings a month in every subscription, whatever the plan or seats. A signing is one signature request
 *  sent to one signer. Never blocked; each one over is $2.50. */
export const SIGNINGS = { included: 4, overage_cents: 250 };

/** Has this licensee bought the Marketing add-on (switched on at sign-up or by Keystone staff)? */
export function hasMarketingAddon(l: { addons?: Record<string, boolean> | null } | null | undefined): boolean {
  return l?.addons?.marketing === true;
}
// KS_OPS_v14_TRIAL_RULES - the in-app Pro trial is offered on Starter AND Growth (Todd, Oct 24; was Starter only).
// allowance_from: the trial's call and text allowance is still Starter's plus the bonus (unchanged), and never less
// than the brokerage's own plan gives.
export const TRIAL = {
  days: 14,
  plan: "pro" as Plan,
  for: ["starter", "growth"] as Plan[],
  allowance_from: "starter" as Plan,
  bonus_minutes_per_seat: 100,
  bonus_texts_per_seat: 100,
};

/** Features per plan; each plan includes the ones before it. Mirrors KS-server src/plans/catalogue.ts. */
export const FEATURES: ReadonlyArray<{ key: string; label: string; plan: Plan }> = [
  // KS_OPS_MARKETING_ADDON - the same keys, labels, plan levels and order as KS-server src/plans/catalogue.ts (the
  // website's drift test compares all three). Marketing on every plan; visitor tracking on every plan (history by plan);
  // session replay Growth and up; the full Google Ads tools Pro. Fraud: starter 1, 2, 4, 5; growth adds 6, 7, 8; pro all 15.
  { key: "contacts", label: "Contacts", plan: "starter" },
  { key: "pipeline", label: "Pipeline", plan: "starter" },
  { key: "client_portal", label: "Branded client portal and application wizard", plan: "starter" },
  { key: "iphone_dialler", label: "iPhone dialler", plan: "starter" },
  // KS_OPS_PLAN_FIXES (Todd, Oct 26) - the iPad staff portal app on every plan; the Apple Watch app growth and up.
  { key: "ipad_app", label: "iPad staff portal app", plan: "starter" },
  { key: "android_staff_app", label: "Android staff app (portal and phone)", plan: "starter" }, // KS_ANDROID_STAFF_v1 - same as KS-server and KS-Website
  // Inbox sync reads Outlook (Microsoft 365) only for now; Gmail sends only.
  { key: "office_sync", label: "Email sync: Outlook (Microsoft 365) inbox sync; Gmail sends only for now", plan: "starter" },
  { key: "ai_assistant", label: "AI assistant", plan: "starter" },
  // Lender packages go to each lender by email or API; lenders do not review files in the portal.
  { key: "lender_portal", label: "Lender portal (lenders keep their details and products current and send you deals they can't place)", plan: "starter" },
  // PGI referrals to the insurance partner on every plan (20% referral fee on bound policies); same key as KS-server.
  { key: "pgi_referrals", label: "Personal Guarantee Insurance referrals (20% referral fee)", plan: "starter" },
  // Calls are recorded on every plan; playback is growth and up.
  // Custom fields on contacts, companies and applications, every plan (KS-server v20).
  { key: "custom_fields", label: "Custom fields", plan: "starter" },
  { key: "call_recording", label: "Call recording on every plan (playback on Growth and Pro)", plan: "starter" },
  { key: "marketing", label: "Marketing to your own client list: email and text campaigns, sequences, templates and a website lead form", plan: "starter" },
  { key: "ads_results", label: "Google Ads and LinkedIn Ads results, Google Analytics connection", plan: "starter" },
  // KS_BROKER_TOOLS - broker deal tools 1-3, every plan.
  { key: "funding_conditions", label: "Funding conditions checklist", plan: "starter" },
  { key: "sales_tax", label: "Canadian sales tax in quotes and calculators", plan: "starter" },
  { key: "invoice_reading", label: "Vendor invoice reading (vendor, line items, taxes, serial numbers and VINs)", plan: "starter" },
  { key: "call_recording_playback", label: "Call recording playback", plan: "growth" },
  // Teams and record visibility (all / team / own), growth and up (KS-server v20).
  { key: "teams", label: "Teams and record visibility", plan: "growth" },
  { key: "call_summaries", label: "AI call summaries", plan: "growth" },
  { key: "voicemail_transcription", label: "Voicemail transcription", plan: "growth" },
  { key: "watch_app", label: "Apple Watch app", plan: "growth" },
  // Templates and snippets (one store) and automations are growth and up.
  { key: "templates", label: "Message templates and snippets", plan: "growth" },
  { key: "automations", label: "Automations (workflows)", plan: "growth" },
  { key: "referrer_portal", label: "Referrer portal", plan: "growth" },
  { key: "broker_portal", label: "Broker portal", plan: "growth" },
  { key: "full_reports", label: "Reports", plan: "growth" },
  { key: "visitor_tracking", label: "Website visitor tracking (30 days on Starter, 90 days on Growth, 12 months on Pro)", plan: "starter" },
  { key: "session_replay", label: "Session replay of website visits", plan: "growth" },
  { key: "toll_free_number", label: "Toll-free number", plan: "growth" },
  // The post-funding survey and review request, growth and up (KS-server settings pack).
  { key: "nps_survey", label: "Post-funding survey and review requests", plan: "growth" },
  { key: "payment_links", label: "Payment links and bank debit for fees (your own Stripe account)", plan: "growth" },
  { key: "call_scripts", label: "Call scripts (playbooks)", plan: "growth" },
  { key: "custom_pipelines", label: "Extra pipelines with custom stages (Growth 3, Pro unlimited)", plan: "growth" },
  // KS_OPS_KYC - ID and selfie verification of applicants and guarantors, growth and up (some checks included; see ID_CHECKS).
  { key: "id_verification", label: "ID and selfie verification of applicants and guarantors (some checks included each month)", plan: "growth" },
  // KS_OPS_QUOTES_FORECAST - quotes for the client and the revenue forecast, growth and up (mirrors KS-server).
  { key: "quotes", label: "Quotes: compare lender offers for the client, branded PDF and acceptance in the client app", plan: "growth" },
  { key: "forecasting", label: "Revenue forecast: weighted pipeline, commit and best case per rep and team, against goals", plan: "growth" },
  // KS_ACTIVE_CONTRACTS - funded facilities as contracts, renewal engine, commission tracking (KS-server).
  { key: "active_contracts", label: "Active contracts: renewals, re-engagement queues and commission tracking", plan: "growth" },
  // Lender API connections: send the lender package by API, sync status, offers and conditions back (KS-server lender API).
  { key: "lender_api", label: "Lender API connections (submit by API, sync status, offers and conditions)", plan: "growth" },
  { key: "credit_lines", label: "Approved credit lines per client: limit, used, available and expiry reminders", plan: "growth" },
  { key: "rate_cards", label: "Rate cards and deal structuring: payment options across lenders side by side, with sales tax", plan: "growth" },
  { key: "credit_scorecards", label: "Credit scorecards and pre-decision rules: grade, rule hits and lender ranking on each application", plan: "growth" },
  { key: "contract_templates", label: "Contracts from Word templates: merge fields, Word and PDF, sent for e-signature", plan: "growth" },
  { key: "multiple_lines", label: "Multiple business lines and a direct line for each person", plan: "pro" },
  { key: "ad_attribution", label: "Google Ads tools: attribution, ad-waste report, Customer Match, Monday ads email and AI ads suggestions", plan: "pro" },
  { key: "api_access", label: "API access", plan: "pro" },
  { key: "sso", label: "Single sign-on", plan: "pro" },
  // Outgoing webhooks and Zapier Catch Hook triggers, pro (KS-server v20).
  { key: "webhooks", label: "Webhooks and Zapier", plan: "pro" },
  { key: "call_queues", label: "Call queues", plan: "pro" },
  { key: "vendor_portal", label: "Vendor and dealer portal: point-of-sale quotes, apply links, deal status, invoice upload and vendor fees", plan: "pro" },
  // Custom roles from a permission matrix (view/create/edit/delete/export per area, own/team/all records), pro (KS-server custom roles).
  { key: "custom_roles", label: "Custom roles and permissions", plan: "pro" },
  // KS_BROKER_TOOLS - Vendor and dealer portal, pro.
  // Fraud protection (matches KS-server src/plans/catalogue.ts): starter 1, 2, 4, 5; growth adds 6, 7, 8; pro all 15.
  // No bank connect / Flinks in Keystone: bank_connect and fraud_3 are gone; the other keys keep their numbers.
  { key: "fraud_1", label: "Document tamper scan", plan: "starter" },
  { key: "fraud_2", label: "Bank statement math check", plan: "starter" },
  { key: "fraud_4", label: "Duplicate document check", plan: "starter" },
  { key: "fraud_5", label: "Revenue vs bank deposits", plan: "starter" },
  { key: "fraud_6", label: "Business reality check", plan: "growth" },
  { key: "fraud_7", label: "Phone and email risk", plan: "growth" },
  { key: "fraud_8", label: "ID checks", plan: "growth" },
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
  /** KS_OPS_MARKETING_ADDON - { marketing: true } = the Marketing add-on is on the subscription. */
  addons?: Record<string, boolean> | null;
  overage_minutes?: number;
  overage_texts?: number;
  overage_signings?: number;
  overage_campaign_email_blocks?: number;
  /** KS_OPS_KYC - ID checks over the month's included number. */
  overage_id_checks?: number;
};

export type ChargeBreakdown = {
  billable_seats: number;
  seat_price_cents: number;
  seats_cents: number;
  support_cents: number;
  support_extra_seats: number;
  storage_cents: number;
  /** KS_OPS_MARKETING_ADDON - the Marketing add-on, flat per brokerage (0 when not bought). */
  marketing_addon_cents: number;
  overage_minutes_cents: number;
  overage_texts_cents: number;
  overage_signings_cents: number;
  overage_campaign_emails_cents: number;
  /** KS_OPS_KYC */
  overage_id_checks_cents: number;
  overage_cents: number;
  /** Recurring part only (seats + support + storage + Marketing add-on): the licensee's MRR. */
  recurring_cents: number;
  total_cents: number;
};

/** One month's charge: seats x seat price + support (+ extra seats) + extra storage x $10 + the Marketing add-on + overage. */
export function monthlyCharge(i: ChargeInput): ChargeBreakdown {
  const seats = billableSeats(i.plan, i.seats);
  const seatPrice = SEAT_PRICE_CENTS[i.plan][i.billing_interval];
  const seatsCents = seats * seatPrice;
  const support = supportCents(i.support_level, seats);
  const storage = whole(i.extra_storage_blocks) * STORAGE_BLOCK.price_cents;
  const marketing = hasMarketingAddon(i) ? MARKETING_ADDON.price_cents : 0;
  const om = whole(i.overage_minutes) * OVERAGE_CENTS.minute;
  const ot = whole(i.overage_texts) * OVERAGE_CENTS.text;
  const os = whole(i.overage_signings) * OVERAGE_CENTS.signing;
  const oe = whole(i.overage_campaign_email_blocks) * OVERAGE_CENTS.campaign_email_block;
  const oi = whole(i.overage_id_checks) * OVERAGE_CENTS.id_check; // KS_OPS_KYC
  const recurring = seatsCents + support + storage + marketing;
  return {
    billable_seats: seats,
    seat_price_cents: seatPrice,
    seats_cents: seatsCents,
    support_cents: support,
    support_extra_seats: supportExtraSeats(i.support_level, seats),
    storage_cents: storage,
    marketing_addon_cents: marketing,
    overage_minutes_cents: om,
    overage_texts_cents: ot,
    overage_signings_cents: os,
    overage_campaign_emails_cents: oe,
    overage_id_checks_cents: oi,
    overage_cents: om + ot + os + oe + oi,
    recurring_cents: recurring,
    total_cents: recurring + om + ot + os + oe + oi,
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
      max_seats: MAX_SEATS,
      // KS_OPS_MARKETING_ADDON - campaign emails and signings are per brokerage, not per seat.
      allowances: { ...ALLOWANCES[key], campaign_emails: MARKETING_LIMITS[key].campaign_emails, signings: SIGNINGS.included },
      marketing: { ...MARKETING_LIMITS[key] },
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
    extra_storage: { block_gb: STORAGE_BLOCK.gb, price: dollars(STORAGE_BLOCK.price_cents), max_blocks: MAX_STORAGE_BLOCKS },
    overage: {
      minute: dollars(OVERAGE_CENTS.minute),
      text: dollars(OVERAGE_CENTS.text),
      signing: dollars(OVERAGE_CENTS.signing),
      campaign_email_block: dollars(OVERAGE_CENTS.campaign_email_block),
      campaign_email_block_size: MARKETING_ADDON.campaign_email_block,
      id_check: dollars(OVERAGE_CENTS.id_check), // KS_OPS_KYC
    },
    // KS_OPS_KYC - ID checks included each month per brokerage, by plan, and during the trial.
    id_checks: { included: { ...ID_CHECKS.included }, trial_included: ID_CHECKS.trial_included, price: dollars(ID_CHECKS.overage_cents) },
    // KS_OPS_MARKETING_ADDON - sold at sign-up; Keystone staff can switch it on or off.
    marketing_addon: {
      key: MARKETING_ADDON.key,
      name: MARKETING_ADDON.name,
      price: dollars(MARKETING_ADDON.price_cents),
      per: "brokerage",
      extra_campaign_emails: MARKETING_ADDON.extra_campaign_emails,
      bonus_marketing_texts: MARKETING_ADDON.bonus_marketing_texts,
      text_to_many: MARKETING_ADDON.text_to_many,
      sequences: MARKETING_ADDON.sequences,
      visitor_history_days: MARKETING_ADDON.visitor_history_days,
      lead_forms: MARKETING_ADDON.lead_forms,
      marketing_seats: MARKETING_ADDON.marketing_seats,
      included_in_trials: true,
      adds: [...MARKETING_ADDON.adds],
    },
    signings: { included: SIGNINGS.included, price: dollars(SIGNINGS.overage_cents), per: "brokerage" },
    trial: { ...TRIAL, for: [...TRIAL.for] },
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
export function priceKey(kind: "marketing_addon", b: BillingInterval): string;
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
    // KS_OPS_MARKETING_ADDON - $49 a month flat (annual: 12 x, like every recurring price).
    specs.push({
      key: priceKey("marketing_addon", b),
      product_key: "marketing_addon",
      product_name: "Keystone Marketing add-on",
      nickname: `Marketing add-on (${b})`,
      unit_amount: perInterval(MARKETING_ADDON.price_cents, b),
      recurring: intervalOf(b),
    });
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
export function subscriptionItems(i: Omit<ChargeInput, "overage_minutes" | "overage_texts" | "overage_signings" | "overage_campaign_email_blocks">): LineItem[] {
  const seats = billableSeats(i.plan, i.seats);
  const items: LineItem[] = [{ price_key: priceKey("seat", i.plan, i.billing_interval), quantity: seats }];
  if (SUPPORT[i.support_level].price_cents > 0) {
    items.push({ price_key: priceKey("support", i.support_level, i.billing_interval), quantity: 1 });
  }
  const extra = supportExtraSeats(i.support_level, seats);
  if (extra > 0) items.push({ price_key: priceKey("support_extra_seat", i.support_level, i.billing_interval), quantity: extra });
  const blocks = whole(i.extra_storage_blocks);
  if (blocks > 0) items.push({ price_key: priceKey("storage_block", i.billing_interval), quantity: blocks });
  if (hasMarketingAddon(i)) items.push({ price_key: priceKey("marketing_addon", i.billing_interval), quantity: 1 }); // KS_OPS_MARKETING_ADDON
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
 * During a trial the licensee gets at least the trial allowance (TRIAL.allowance_from's minutes/texts plus the per-seat bonus).
 */
export function billingAllowance(plan: Plan, seats: number, trial: boolean): { minutes: number; texts: number } {
  const n = billableSeats(plan, seats);
  const base = ALLOWANCES[plan];
  let minutes = base.minutes_per_seat * n;
  let texts = base.texts_per_seat * n;
  if (trial) {
    const t = ALLOWANCES[TRIAL.allowance_from];
    minutes = Math.max(minutes, (t.minutes_per_seat + TRIAL.bonus_minutes_per_seat) * n);
    texts = Math.max(texts, (t.texts_per_seat + TRIAL.bonus_texts_per_seat) * n);
  }
  return { minutes, texts };
}

export type UsageForBilling = {
  minutes: number;
  texts: number;
  /** KS_OPS_MARKETING_ADDON - from the licensee's usage report (0 when an older server does not send them). */
  campaign_emails?: number;
  marketing_texts?: number;
  signings?: number;
  /** KS_OPS_KYC - completed ID checks (0 when an older server does not send them). */
  id_checks?: number;
};

export type OverageResult = {
  minutes: number;
  texts: number;
  signings: number;
  /** KS_OPS_KYC */
  id_checks: number;
  campaign_emails: number;
  campaign_email_blocks: number;
  allowance: { minutes: number; texts: number; signings: number; campaign_emails: number; bonus_marketing_texts: number; id_checks: number };
};

/**
 * Overage worked out by KS-Ops from its own plan, seats and add-ons; the overage a licensee's server reports is not
 * used. KS_OPS_MARKETING_ADDON: signings over 4 are always billed; campaign emails over the allowance only with the
 * Marketing add-on (bought, or a trial), in 10,000 blocks; with the add-on up to 1,000 marketing texts do not count
 * against the texts allowance.
 */
export function computeOverage(
  i: { plan: Plan; seats: number; trial: boolean; marketing_addon?: boolean },
  used: UsageForBilling,
): OverageResult {
  const allowance = billingAllowance(i.plan, i.seats, i.trial);
  const addon = i.marketing_addon === true || i.trial;
  const campaignAllowance = MARKETING_LIMITS[i.trial ? TRIAL.plan : i.plan].campaign_emails + (addon ? MARKETING_ADDON.extra_campaign_emails : 0);
  const bonus = addon ? Math.min(whole(used.marketing_texts), MARKETING_ADDON.bonus_marketing_texts) : 0;
  const overEmails = addon ? Math.max(0, whole(used.campaign_emails) - campaignAllowance) : 0;
  return {
    minutes: Math.max(0, whole(used.minutes) - allowance.minutes),
    texts: Math.max(0, whole(used.texts) - allowance.texts - bonus),
    signings: Math.max(0, whole(used.signings) - SIGNINGS.included),
    id_checks: idCheckOverage(i.plan, i.trial, whole(used.id_checks)).id_checks, // KS_OPS_KYC
    campaign_emails: overEmails,
    campaign_email_blocks: overEmails > 0 ? Math.ceil(overEmails / MARKETING_ADDON.campaign_email_block) : 0,
    allowance: { ...allowance, signings: SIGNINGS.included, campaign_emails: campaignAllowance, bonus_marketing_texts: addon ? MARKETING_ADDON.bonus_marketing_texts : 0, id_checks: idCheckOverage(i.plan, i.trial, 0).included },
  };
}
