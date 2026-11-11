// KS_OPS_OUTREACH_v1 - who is a brokerage worth selling Keystone to, and in what order. Pure functions, no database.
//
// Qualification (does the firm belong in the list at all):
//   keep      a firm that helps businesses obtain financing from third-party lenders, in Canada or the US, with an
//             identified decision-maker
//   research  looks like a brokerage but no decision-maker is known yet (kept, never deleted)
//   review    hybrid lender / broker, or every contact's role is unclear: a person decides
//   remove    not a brokerage (direct lender, bank, credit union, insurance or wealth only, residential mortgages only,
//             accounting / grants / software / consulting with no placement) or outside Canada and the US. Removed
//             firms stay in the table as the exclusion ledger so later imports cannot add them again.
// Employee count and owner availability set the PRIORITY score, never whether the firm is kept.

export const QUALIFICATIONS = ["keep", "research", "review", "remove"] as const;
export type Qualification = (typeof QUALIFICATIONS)[number];

export const FIRM_TYPES = [
  "commercial_finance_brokerage", "equipment_finance_brokerage", "multi_product_brokerage", "solo_broker", "commercial_mortgage_brokerage",
  "hybrid_lender_broker", "direct_lender", "bank_or_credit_union", "insurance_or_wealth", "residential_mortgage", "non_financing", "unknown",
] as const;
export type FirmType = (typeof FIRM_TYPES)[number];
export const FIRM_TYPE_LABELS: Record<FirmType, string> = {
  commercial_finance_brokerage: "Commercial finance brokerage", equipment_finance_brokerage: "Equipment finance brokerage",
  multi_product_brokerage: "Multi-product business financing brokerage", solo_broker: "Solo commercial finance broker",
  commercial_mortgage_brokerage: "Commercial mortgage brokerage with business lending", hybrid_lender_broker: "Hybrid lender and broker",
  direct_lender: "Direct lender or funder only", bank_or_credit_union: "Bank or credit union", insurance_or_wealth: "Insurance or wealth management only",
  residential_mortgage: "Residential mortgage brokerage only", non_financing: "Accounting, grants, software or consulting (no financing placement)",
  unknown: "Not classified yet",
};
const REMOVE_TYPES = new Set<FirmType>(["direct_lender", "bank_or_credit_union", "insurance_or_wealth", "residential_mortgage", "non_financing"]);

export const nameKey = (v: string): string =>
  String(v ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|ltd|limited|llc|corp|corporation|co|company|lp|llp)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "yahoo.ca", "icloud.com", "live.com", "aol.com", "me.com", "shaw.ca", "telus.net", "rogers.com", "bell.net"]);
/** The firm's own domain from its website, or from a business email (free mailboxes do not identify a firm). */
export function domainOf(website: string | null | undefined, email?: string | null): string | null {
  const w = String(website ?? "").trim().toLowerCase();
  if (w) {
    const host = w.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return host;
  }
  const d = String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !FREE_MAIL.has(d) ? d : null;
}

export function countryCode(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["ca", "can", "canada"].includes(s)) return "CA";
  if (["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"].includes(s)) return "US";
  return s.toUpperCase().slice(0, 40);
}

/** 1 owner / founder / president / CEO; 2 managing partner / principal; 3 broker; 4 VP or director of business
 *  development; 5 capital advisor / consultant; 9 anything else. 1-4 are decision-makers for outreach. */
export function contactRank(title: string | null | undefined): number {
  const t = ` ${String(title ?? "").toLowerCase().replace(/[^a-z]+/g, " ")} `;
  if (/ (owner|co owner|founder|co founder|cofounder|president|ceo|chief executive( officer)?) /.test(t) && !/ vice president /.test(t)) return 1;
  if (/ (managing partner|managing director|principal|partner) /.test(t)) return 2;
  if (/ broker /.test(t)) return 3;
  if (/ (vp|vice president|director|head) /.test(t) && / (business development|sales|origination|originations) /.test(t)) return 4;
  if (/ (advisor|adviser|consultant) /.test(t) && / (capital|finance|financing|funding|commercial|leasing) /.test(t)) return 5;
  return 9;
}
export const isOwnerRank = (rank: number) => rank <= 2;
export const isDecisionMaker = (rank: number) => rank <= 4;

export type PersonFacts = { title: string | null; email: string | null; direct_phone: string | null; mobile_phone: string | null; direct_dnc: boolean; mobile_dnc: boolean; needs_review: boolean };
export type FirmFacts = {
  country: string | null; firm_type: FirmType | null; employee_count: number | null; website: string | null;
  has_address: boolean; people: PersonFacts[];
};

export function classify(f: FirmFacts): { qualification: Qualification; reason: string } {
  const type = f.firm_type ?? "unknown";
  if (f.country && f.country !== "CA" && f.country !== "US") return { qualification: "remove", reason: "Outside Canada and the United States." };
  if (REMOVE_TYPES.has(type)) return { qualification: "remove", reason: `${FIRM_TYPE_LABELS[type]}.` };
  if (type === "hybrid_lender_broker") return { qualification: "review", reason: "Hybrid lender and broker: confirm it places deals with third-party lenders." };
  if (f.people.length > 0 && f.people.every((p) => p.needs_review)) return { qualification: "review", reason: "Every contact's role is unclear." };
  if (!f.people.some((p) => isDecisionMaker(contactRank(p.title)))) return { qualification: "research", reason: "No decision-maker identified yet." };
  return { qualification: "keep", reason: type === "unknown" ? "Brokerage with an identified decision-maker." : `${FIRM_TYPE_LABELS[type]} with an identified decision-maker.` };
}

export type FitRules = {
  employees_min: number; employees_max: number;
  w_owner: number; w_decision_maker: number; w_email: number; w_phone: number; w_size: number; w_team: number; w_address: number; w_website: number;
};
export const DEFAULT_FIT_RULES: FitRules = { employees_min: 1, employees_max: 100, w_owner: 30, w_decision_maker: 15, w_email: 15, w_phone: 10, w_size: 15, w_team: 10, w_address: 5, w_website: 5 };
export function fitRules(raw: unknown): FitRules {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_FIT_RULES };
  for (const k of Object.keys(out) as Array<keyof FitRules>) {
    const n = Number(o[k]);
    if (o[k] !== undefined && o[k] !== null && o[k] !== "" && Number.isFinite(n) && n >= 0 && n <= 100_000) out[k] = Math.round(n);
  }
  if (out.employees_max < out.employees_min) out.employees_max = out.employees_min;
  return out;
}

/** Outreach priority, 0 to 100, with the reasons shown to staff. */
export function priority(f: FirmFacts, rules: FitRules = DEFAULT_FIT_RULES): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => { if (n > 0) { score += n; reasons.push(`+${n} ${why}`); } };
  const ranked = f.people.map((p) => ({ p, rank: contactRank(p.title) }));
  const owners = ranked.filter((x) => isOwnerRank(x.rank));
  const deciders = ranked.filter((x) => isDecisionMaker(x.rank));
  if (owners.length) add(rules.w_owner, "owner, president or principal on file");
  else if (deciders.length) add(rules.w_decision_maker, "a broker or business development lead on file");
  const reach = deciders.length ? deciders : ranked;
  if (reach.some((x) => x.p.email)) add(rules.w_email, deciders.length ? "business email for a decision-maker" : "a business email on file");
  if (reach.some((x) => (x.p.direct_phone && !x.p.direct_dnc) || (x.p.mobile_phone && !x.p.mobile_dnc))) add(rules.w_phone, "a phone number that may be called");
  const n = f.employee_count;
  if (n === null || n === undefined) add(Math.round(rules.w_size / 2), "size not known yet");
  else if (n >= rules.employees_min && n <= rules.employees_max) add(rules.w_size, `${n} staff (preferred size)`);
  else add(Math.round(rules.w_size / 3), `${n} staff (outside the preferred size)`);
  if (f.people.length >= 5) add(rules.w_team, `${f.people.length} contacts on file (more seats)`);
  if (f.has_address) add(rules.w_address, "mailing address on file");
  if (f.website) add(rules.w_website, "website on file");
  return { score: Math.min(100, score), reasons };
}
