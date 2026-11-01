// KS_OPS_MARKETING_ADDON - the Marketing add-on ($49 a month, flat), the e-signing allowance (4 a month, $2.50 each
// over) and campaign email overage ($10 per 10,000 with the add-on): pricing, catalogue, sign-up, push and QuickBooks.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  FEATURES, MARKETING_ADDON, MARKETING_LIMITS, SIGNINGS, computeOverage, monthlyCharge, publicPlans, stripePriceSpecs,
  subscriptionItems,
} from "../../src/pricing.js";
import { overageGoesOnNextInvoice, OVERAGE_KINDS } from "../../src/billing/billing.js";
import { overageItemKind } from "../../src/qbo/posting.js";
import { planPushBody } from "../../src/sync/planPush.js";
import { signupSchema } from "../../src/licensees/validation.js";
import { fakeDb, fakeStripe, licenseeRow, makeDeps, validSignup } from "../helpers.js";

const mk = { marketing: true };

describe("Marketing add-on pricing", () => {
  it("is a flat $49 a month per brokerage on any plan, whatever the seats", () => {
    for (const plan of ["starter", "growth", "pro"] as const) {
      const without = monthlyCharge({ plan, billing_interval: "monthly", seats: 5, support_level: "email" });
      const withIt = monthlyCharge({ plan, billing_interval: "monthly", seats: 5, support_level: "email", addons: mk });
      expect(withIt.recurring_cents - without.recurring_cents).toBe(4900);
      expect(withIt.marketing_addon_cents).toBe(4900);
    }
  });

  it("matches the pricing guide's worked examples", () => {
    expect(monthlyCharge({ plan: "starter", billing_interval: "monthly", seats: 1, support_level: "email", addons: mk }).total_cents).toBe(10800);
    expect(monthlyCharge({ plan: "growth", billing_interval: "annual", seats: 5, support_level: "email", addons: mk }).total_cents).toBe(64400);
    expect(monthlyCharge({ plan: "pro", billing_interval: "annual", seats: 12, support_level: "priority", addons: mk }).total_cents).toBe(266600);
  });

  it("is one subscription item (12 x on annual) and a Stripe price for each interval", () => {
    expect(subscriptionItems({ plan: "growth", billing_interval: "monthly", seats: 2, support_level: "email", addons: mk }))
      .toContainEqual({ price_key: "marketing_addon:monthly", quantity: 1 });
    expect(subscriptionItems({ plan: "growth", billing_interval: "monthly", seats: 2, support_level: "email" })
      .some((i) => i.price_key.startsWith("marketing_addon"))).toBe(false);
    const specs = stripePriceSpecs().filter((s) => s.product_key === "marketing_addon");
    expect(specs.map((s) => [s.key, s.unit_amount, s.recurring])).toEqual([
      ["marketing_addon:annual", 4900 * 12, "year"],
      ["marketing_addon:monthly", 4900, "month"],
    ]);
  });
});

describe("overage: signings, campaign emails and bonus marketing texts", () => {
  const base = { plan: "growth" as const, seats: 2, trial: false };

  it("bills signings over the 4 included on every plan", () => {
    expect(computeOverage(base, { minutes: 0, texts: 0, signings: 4 }).signings).toBe(0);
    expect(computeOverage(base, { minutes: 0, texts: 0, signings: 11 }).signings).toBe(7);
    expect(monthlyCharge({ plan: "starter", billing_interval: "monthly", seats: 1, support_level: "email", overage_signings: 4 }).overage_cents).toBe(1000);
  });

  it("bills campaign emails only with the add-on, per started block of 10,000", () => {
    expect(computeOverage(base, { minutes: 0, texts: 0, campaign_emails: 50_000 }).campaign_email_blocks).toBe(0);
    const o = computeOverage({ ...base, marketing_addon: true }, { minutes: 0, texts: 0, campaign_emails: 1000 + 10_000 + 1 });
    expect(o).toMatchObject({ campaign_emails: 1, campaign_email_blocks: 1 });
    expect(computeOverage({ ...base, marketing_addon: true }, { minutes: 0, texts: 0, campaign_emails: 11_000 + 20_000 }).campaign_email_blocks).toBe(2);
  });

  it("lets up to 1,000 marketing texts not count against texts with the add-on", () => {
    const used = { minutes: 0, texts: 1000 + 900, marketing_texts: 1500 };
    expect(computeOverage(base, used).texts).toBe(900);
    expect(computeOverage({ ...base, marketing_addon: true }, used).texts).toBe(0);
  });

  it("gives trials the add-on's allowance", () => {
    const o = computeOverage({ ...base, trial: true }, { minutes: 0, texts: 0, campaign_emails: 12_000 });
    expect(o.allowance.campaign_emails).toBe(MARKETING_LIMITS.pro.campaign_emails + MARKETING_ADDON.extra_campaign_emails);
    expect(o.campaign_email_blocks).toBe(0);
  });

  it("puts monthly subscriptions' overage on the next invoice and annual ones on their own", () => {
    expect(overageGoesOnNextInvoice({ billing_interval: "monthly", stripe_subscription_id: "sub_1" })).toBe(true);
    expect(overageGoesOnNextInvoice({ billing_interval: "annual", stripe_subscription_id: "sub_1" })).toBe(false);
    expect(overageGoesOnNextInvoice({ billing_interval: "monthly", stripe_subscription_id: null })).toBe(false);
    expect(Object.keys(OVERAGE_KINDS)).toEqual(["minutes", "texts", "signings", "campaign_emails", "id_checks"]); // KS_OPS_KYC - ID checks too
  });

  it("posts the new lines to their own QuickBooks items", () => {
    expect(overageItemKind("signings")).toBe("signings");
    expect(overageItemKind("campaign_emails")).toBe("marketing");
    expect(overageItemKind("minutes")).toBe("overage");
  });
});

describe("catalogue", () => {
  it("lists the add-on, the signing allowance and each plan's marketing limits", () => {
    const p = publicPlans();
    expect(p.marketing_addon).toMatchObject({ key: "marketing", price: 49, per: "brokerage", extra_campaign_emails: 10000, included_in_trials: true });
    expect(p.marketing_addon.adds).toHaveLength(10);
    expect(p.signings).toEqual({ included: SIGNINGS.included, price: 2.5, per: "brokerage" });
    expect(p.plans.map((x) => x.marketing.campaign_emails)).toEqual([500, 1000, 2500]);
    expect(p.plans.map((x) => x.marketing.text_to_many)).toEqual([50, 250, 500]);
    expect(p.plans.map((x) => x.marketing.sequences)).toEqual([2, 5, 10]);
    expect(p.plans.map((x) => x.marketing.visitor_history_days)).toEqual([30, 90, 365]);
    expect(p.plans.map((x) => x.allowances.signings)).toEqual([4, 4, 4]);
  });

  it("puts marketing and visitor tracking on every plan, session replay on Growth, the full Google Ads tools on Pro", () => {
    const level = Object.fromEntries(FEATURES.map((f) => [f.key, f.plan]));
    expect(level).toMatchObject({ marketing: "starter", ads_results: "starter", visitor_tracking: "starter", session_replay: "growth", ad_attribution: "pro", templates: "growth" });
  });
});

describe("sign-up and push", () => {
  it("takes the add-on at sign-up, saves it and bills it in Checkout", async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = fakeDb([
      [/SELECT 1 FROM licensees WHERE company_code/, () => []],
      [/INSERT INTO licensees/, (p) => {
        const cols = /INSERT INTO licensees \(([^)]+)\)/.exec(db.calls.at(-1)!.sql.replace(/\s+/g, " "))![1].split(", ");
        const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
        inserted.push(row);
        return [licenseeRow({ ...row, id: "44444444-4444-4444-8444-444444444444" })];
      }],
      [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
    ]);
    const stripe = fakeStripe();
    const res = await request(createApp(makeDeps({ db, stripe: () => stripe }))).post("/api/public/signup").send({ ...validSignup(), marketing_addon: true });
    expect(res.status).toBe(201);
    expect(inserted[0].addons).toEqual({ marketing: true });
    const params = (stripe.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.line_items).toContainEqual({ price: "price_marketing_addon:annual", quantity: 1 });
  });

  it("defaults to no add-on and refuses a non-boolean", () => {
    const off = signupSchema.safeParse(validSignup());
    expect(off.success && off.data.marketing_addon).toBe(false);
    expect(signupSchema.safeParse({ ...validSignup(), marketing_addon: "yes" }).success).toBe(false);
  });

  it("tells the licensee's server about the add-on with the plan", () => {
    expect(planPushBody({ plan: "starter", extra_storage_blocks: 0, status: "active", addons: { marketing: true } }).addons)
      .toEqual({ bank_connect: false, marketing: true });
  });
});
