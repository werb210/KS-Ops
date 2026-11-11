// KS_OPS_OUTREACH_v1 - who qualifies as a brokerage, who to contact first, and the priority score.
import { describe, expect, it } from "vitest";
import { classify, contactRank, countryCode, domainOf, fitRules, nameKey, priority, type FirmFacts, type PersonFacts } from "../../src/outreach/rules.js";

const person = (title: string, over: Partial<PersonFacts> = {}): PersonFacts => ({ title, email: null, direct_phone: null, mobile_phone: null, direct_dnc: false, mobile_dnc: false, needs_review: false, ...over });
const firm = (over: Partial<FirmFacts> = {}): FirmFacts => ({ country: "CA", firm_type: null, employee_count: null, website: null, has_address: false, people: [], ...over });

describe("matching keys", () => {
  it("ignores company suffixes, case and punctuation", () => {
    expect(nameKey("Northfield Leasing Inc.")).toBe(nameKey("NORTHFIELD LEASING"));
    expect(nameKey("Smith & Lee Capital Ltd")).toBe("smith and lee capital");
  });
  it("takes the firm's domain from its website or a business email, never a free mailbox", () => {
    expect(domainOf("https://www.Northfield-Leasing.example/team")).toBe("northfield-leasing.example");
    expect(domainOf(null, "pat@northfield.example")).toBe("northfield.example");
    expect(domainOf(null, "pat@gmail.com")).toBeNull();
  });
  it("reads country names", () => {
    expect(countryCode("Canada")).toBe("CA");
    expect(countryCode("United States")).toBe("US");
  });
});

describe("contact priority", () => {
  it("ranks owners first, then partners, brokers, business development, advisors", () => {
    expect(contactRank("Chief Executive Officer")).toBe(1);
    expect(contactRank("Founder & President")).toBe(1);
    expect(contactRank("Vice President, Sales")).toBe(4);
    expect(contactRank("Managing Partner")).toBe(2);
    expect(contactRank("Business Loan Broker")).toBe(3);
    expect(contactRank("Director of Business Development")).toBe(4);
    expect(contactRank("Commercial Capital Advisor")).toBe(5);
    expect(contactRank("Office Administrator")).toBe(9);
  });
});

describe("qualification", () => {
  it("keeps a brokerage with a decision-maker, whatever its size (a solo broker qualifies)", () => {
    expect(classify(firm({ employee_count: 1, people: [person("Business Loan Broker")] })).qualification).toBe("keep");
    expect(classify(firm({ employee_count: 400, people: [person("President")] })).qualification).toBe("keep");
  });
  it("sends a firm with no decision-maker to research, not to the bin", () => {
    expect(classify(firm({ people: [person("Office Administrator")] })).qualification).toBe("research");
    expect(classify(firm()).qualification).toBe("research");
  });
  it("sends hybrids and unclear roles to review", () => {
    expect(classify(firm({ firm_type: "hybrid_lender_broker", people: [person("President")] })).qualification).toBe("review");
    expect(classify(firm({ people: [person("Account Manager", { needs_review: true })] })).qualification).toBe("review");
  });
  it("removes lenders, banks, residential-only and firms outside Canada and the US", () => {
    for (const t of ["direct_lender", "bank_or_credit_union", "insurance_or_wealth", "residential_mortgage", "non_financing"] as const) {
      expect(classify(firm({ firm_type: t, people: [person("President")] })).qualification).toBe("remove");
    }
    expect(classify(firm({ country: "GB", people: [person("President")] })).qualification).toBe("remove");
  });
});

describe("priority score", () => {
  it("puts a reachable owner at a mid-sized firm ahead of an unknown contact", () => {
    const strong = priority(firm({ employee_count: 12, website: "https://a.example", has_address: true, people: [person("Owner", { email: "o@a.example", mobile_phone: "555" }), ...Array(4).fill(person("Broker"))] }));
    const weak = priority(firm({ people: [person("Office Administrator")] }));
    expect(strong.score).toBe(90);
    expect(weak.score).toBeLessThan(15);
    expect(strong.reasons[0]).toMatch(/owner/);
  });
  it("does not count a number marked do-not-call", () => {
    const p = priority(firm({ people: [person("Owner", { mobile_phone: "555", mobile_dnc: true })] }));
    expect(p.reasons.join(" ")).not.toMatch(/phone/);
  });
  it("reads changed weights and ignores nonsense", () => {
    const r = fitRules({ w_owner: 50, employees_max: "250", w_email: "x" });
    expect(r.w_owner).toBe(50);
    expect(r.employees_max).toBe(250);
    expect(r.w_email).toBe(15);
  });
});
