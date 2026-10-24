import { describe, expect, it } from "vitest";
import {
  billableSeats, monthlyCharge, onboardingFeeCents, pooledAllowances, publicPlans, stripePriceSpecs,
  subscriptionItems, supportCents,
} from "../../src/pricing.js";

describe("monthlyCharge", () => {
  it("charges seats at the monthly or annual rate", () => {
    expect(monthlyCharge({ plan: "starter", billing_interval: "monthly", seats: 3, support_level: "email" }).total_cents).toBe(3 * 5900);
    expect(monthlyCharge({ plan: "starter", billing_interval: "annual", seats: 3, support_level: "email" }).total_cents).toBe(3 * 4900);
    expect(monthlyCharge({ plan: "growth", billing_interval: "annual", seats: 5, support_level: "email" }).total_cents).toBe(5 * 11900);
    expect(monthlyCharge({ plan: "pro", billing_interval: "monthly", seats: 4, support_level: "email" }).total_cents).toBe(4 * 22900);
  });

  it("charges pro for at least 2 seats", () => {
    const c = monthlyCharge({ plan: "pro", billing_interval: "annual", seats: 1, support_level: "email" });
    expect(c.billable_seats).toBe(2);
    expect(c.seats_cents).toBe(2 * 19900);
    expect(billableSeats("starter", 1)).toBe(1);
  });

  it("adds support with extra seats over the covered count", () => {
    expect(supportCents("email", 500)).toBe(0);
    expect(supportCents("priority", 10)).toBe(19900);
    expect(supportCents("priority", 12)).toBe(19900 + 2 * 1500);
    expect(supportCents("premium", 11)).toBe(49900 + 3000);
    expect(supportCents("dedicated", 25)).toBe(120000);
    expect(supportCents("dedicated", 30)).toBe(120000 + 5 * 4000);
  });

  it("adds extra storage at $10 a block and overage at 4 and 3 cents", () => {
    const c = monthlyCharge({
      plan: "growth", billing_interval: "monthly", seats: 2, support_level: "priority",
      extra_storage_blocks: 3, overage_minutes: 250, overage_texts: 100,
    });
    expect(c.storage_cents).toBe(3000);
    expect(c.overage_minutes_cents).toBe(1000);
    expect(c.overage_texts_cents).toBe(300);
    expect(c.recurring_cents).toBe(2 * 13900 + 19900 + 3000);
    expect(c.total_cents).toBe(c.recurring_cents + 1300);
  });

  it("knows the onboarding fees and pooled allowances", () => {
    expect(onboardingFeeCents("starter")).toBe(0);
    expect(onboardingFeeCents("growth")).toBe(75000);
    expect(onboardingFeeCents("pro")).toBe(200000);
    expect(pooledAllowances("growth", 4)).toEqual({ minutes: 2000, texts: 2000, assistant_chats: 1000, storage_gb: 100 });
    expect(pooledAllowances("pro", 2).assistant_chats).toBeNull();
  });
});

describe("publicPlans", () => {
  it("matches the contract shape", () => {
    const p = publicPlans();
    expect(p.currency).toBe("CAD");
    expect(p.plans.map((x) => x.key)).toEqual(["starter", "growth", "pro"]);
    const pro = p.plans[2];
    expect(pro).toMatchObject({ seat_price_annual: 199, seat_price_monthly: 229, onboarding_fee: 2000, min_seats: 2 });
    expect(pro.allowances).toEqual({ minutes_per_seat: 1500, texts_per_seat: 1500, assistant_chats: null, storage_gb_per_seat: 50 });
    // Features are cumulative.
    expect(p.plans[0].features.length).toBeLessThan(p.plans[1].features.length);
    expect(pro.features.map((f) => f.key)).toContain("contacts");
    expect(p.plans[0].features.map((f) => f.key)).not.toContain("full_reports");
    expect(p.support_levels.find((s) => s.key === "premium")).toMatchObject({ price: 499, covered_seats: 10, extra_seat_price: 30 });
    expect(p.support_levels[0]).toMatchObject({ key: "email", price: 0, covered_seats: null });
    for (const s of p.support_levels) expect(Object.keys(s)).toEqual(["key", "name", "price", "covered_seats", "extra_seat_price", "channels", "first_reply", "live_help"]);
    expect(p.extra_storage).toEqual({ block_gb: 50, price: 10, max_blocks: 1000 });
    // Seat limits the sign-up form uses: the plan minimum and the most the sign-up accepts.
    expect(p.plans.map((x) => [x.min_seats, x.max_seats])).toEqual([[1, 1000], [1, 1000], [2, 1000]]);
    expect(p.overage).toEqual({ minute: 0.04, text: 0.03 });
    // KS_OPS_v14_TRIAL_RULES - the in-app Pro trial is offered on Starter and Growth; the allowance is unchanged.
    expect(p.trial).toEqual({ days: 14, plan: "pro", for: ["starter", "growth"], allowance_from: "starter", bonus_minutes_per_seat: 100, bonus_texts_per_seat: 100 });
  });
});

describe("Stripe prices", () => {
  it("prices yearly items at 12 times the monthly rate", () => {
    const specs = Object.fromEntries(stripePriceSpecs().map((s) => [s.key, s]));
    expect(specs["seat:growth:annual"]).toMatchObject({ unit_amount: 11900 * 12, recurring: "year" });
    expect(specs["seat:growth:monthly"]).toMatchObject({ unit_amount: 13900, recurring: "month" });
    expect(specs["support:priority:annual"].unit_amount).toBe(19900 * 12);
    expect(specs["storage_block:monthly"].unit_amount).toBe(1000);
    expect(specs["onboarding:pro"]).toMatchObject({ unit_amount: 200000, recurring: null });
    expect(specs["onboarding:starter"]).toBeUndefined();
    expect(specs["support:email:monthly"]).toBeUndefined();
    expect(new Set(Object.keys(specs)).size).toBe(stripePriceSpecs().length);
  });

  it("builds subscription items", () => {
    expect(subscriptionItems({ plan: "pro", billing_interval: "monthly", seats: 1, support_level: "email" })).toEqual([
      { price_key: "seat:pro:monthly", quantity: 2 },
    ]);
    expect(
      subscriptionItems({ plan: "growth", billing_interval: "annual", seats: 12, support_level: "priority", extra_storage_blocks: 2 }),
    ).toEqual([
      { price_key: "seat:growth:annual", quantity: 12 },
      { price_key: "support:priority:annual", quantity: 1 },
      { price_key: "support_extra_seat:priority:annual", quantity: 2 },
      { price_key: "storage_block:annual", quantity: 2 },
    ]);
  });
});
