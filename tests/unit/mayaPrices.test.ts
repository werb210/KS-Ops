// KS_OPS_MAYA_PRICES - Maya answers price questions from the live catalogue even when the AI is off.
import { describe, expect, it } from "vitest";
import { asksAboutPrice, priceAnswer } from "../../src/assistant/sales.js";
import { publicPlans } from "../../src/pricing.js";

describe("Maya and prices", () => {
  it("knows a price question when she sees one", () => {
    for (const q of ["how much does it cost?", "What's the pricing?", "monthly fee per user", "How is it priced"]) expect(asksAboutPrice(q)).toBe(true);
    for (const q of ["Does it have a dialler?", "Where is my data stored?"]) expect(asksAboutPrice(q)).toBe(false);
  });

  it("quotes every plan with the catalogue's numbers, in CAD, and the Marketing add-on", () => {
    const a = priceAnswer();
    expect(a).toMatch(/Canadian dollars/);
    for (const p of publicPlans().plans) {
      expect(a).toContain(`**${p.name}**`);
      expect(a).toContain(`$${p.seat_price_annual.toLocaleString("en-CA")}`);
    }
    expect(a).toContain("Marketing add-on is $49 a month");
    expect(a).toContain("[Pricing](/pricing)");
  });
});
