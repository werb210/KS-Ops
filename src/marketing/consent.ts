// KS_OPS_PROSPECT_MARKETING_v1 - who may get Keystone marketing email, and why not (CASL in Canada, CAN-SPAM in the US).
//
// Every send goes through eligibility(): when the audience is previewed, when a campaign or a sequence step is queued,
// and again right before each email leaves. Nothing is sent without a "yes" from it.
//
// Consent types:
//   express              the person said yes (a consent box, a written or recorded request). No expiry until they
//                        unsubscribe.
//   implied_inquiry      they asked us about Keystone (demo sign-up, beta sign-up, a website sign-up that never paid):
//                        CASL implied consent for 6 months from the inquiry.
//   implied_business     an existing business relationship (a Keystone subscription): while the contract runs, then
//                        2 years after it ends.
//   implied_publication  their business email is published (website, directory) with no "no marketing" statement and
//                        the message is about their role. Staff record where it was published; reviewed after 12 months.
//   us_opt_out           US prospects only: CAN-SPAM lets us email a business contact until they opt out. Refused
//                        for anyone not recorded as being in the US.
//   none                 nothing recorded: blocked.
// The suppression list (unsubscribed, hard bounce, spam report, opted out in the CRM, added by staff) always wins.

export const CONSENT_TYPES = ["none", "express", "implied_inquiry", "implied_business", "implied_publication", "us_opt_out"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const CONSENT_LABELS: Record<ConsentType, string> = {
  none: "No consent recorded",
  express: "Express consent",
  implied_inquiry: "Implied - inquiry (6 months)",
  implied_business: "Implied - existing customer (2 years after it ends)",
  implied_publication: "Implied - published business email",
  us_opt_out: "US business contact (CAN-SPAM opt-out)",
};

export const PROSPECT_STATUSES = ["lead", "demo_booked", "trial", "customer", "lost"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const PROSPECT_SOURCES = [
  "demo_signup", "beta_signup", "assistant", "website_signup", "licensee", "crm", "import", "manual",
] as const;
export type ProspectSource = (typeof PROSPECT_SOURCES)[number];

export const SUPPRESSION_REASONS = ["unsubscribed", "hard_bounce", "spam_report", "crm_opt_out", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const INQUIRY_MONTHS = 6;
export const BUSINESS_MONTHS_AFTER_END = 24;
export const PUBLICATION_REVIEW_MONTHS = 12;

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

/** The expiry a consent type gets by default (null = no expiry). implied_business has none while the contract runs. */
export function defaultExpiry(type: ConsentType, at: Date): Date | null {
  if (type === "implied_inquiry") return addMonths(at, INQUIRY_MONTHS);
  if (type === "implied_publication") return addMonths(at, PUBLICATION_REVIEW_MONTHS);
  return null;
}

export type ConsentRecord = {
  consent_type: ConsentType | string;
  consent_source?: string | null;
  consent_text?: string | null;
  consent_at?: Date | string | null;
  consent_expires_at?: Date | string | null;
};

export type EligibilityInput = ConsentRecord & {
  email: string | null | undefined;
  country?: string | null;
  /** The suppression reason when the email is on the suppression list. */
  suppressed?: SuppressionReason | string | null;
};

export type BlockReason =
  | "invalid_email"
  | "suppressed_unsubscribed"
  | "suppressed_hard_bounce"
  | "suppressed_spam_report"
  | "suppressed_crm_opt_out"
  | "suppressed_manual"
  | "no_consent"
  | "consent_expired"
  | "consent_missing_date"
  | "us_opt_out_not_us";

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  invalid_email: "The email address is not valid.",
  suppressed_unsubscribed: "They unsubscribed.",
  suppressed_hard_bounce: "Their address bounced (hard bounce).",
  suppressed_spam_report: "They reported a Keystone email as spam.",
  suppressed_crm_opt_out: "They are marked as opted out of marketing in the Keystone CRM.",
  suppressed_manual: "Staff added them to the suppression list.",
  no_consent: "No consent is recorded. Record express or implied consent first.",
  consent_expired: "Their implied consent has expired. Get express consent to keep emailing them.",
  consent_missing_date: "The consent has no date, so its expiry cannot be checked. Add the date it was given.",
  us_opt_out_not_us: "CAN-SPAM opt-out only applies to prospects in the US. Record their country, or record consent.",
};

export type Eligibility = { ok: true } | { ok: false; reason: BlockReason; message: string };

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmail = (e: unknown): boolean => typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e.trim());

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const block = (reason: BlockReason): Eligibility => ({ ok: false, reason, message: BLOCK_MESSAGES[reason] });

/** The one gate for every marketing email. */
export function eligibility(p: EligibilityInput, now: Date): Eligibility {
  if (!isEmail(p.email)) return block("invalid_email");
  if (p.suppressed) {
    const key = `suppressed_${p.suppressed}` as BlockReason;
    return block(key in BLOCK_MESSAGES ? key : "suppressed_manual");
  }
  const type = String(p.consent_type ?? "none") as ConsentType;
  if (!(CONSENT_TYPES as readonly string[]).includes(type) || type === "none") return block("no_consent");
  if (type === "us_opt_out") {
    return String(p.country ?? "").trim().toUpperCase() === "US" ? { ok: true } : block("us_opt_out_not_us");
  }
  if (type === "express") return { ok: true };
  // Implied consent: the date it was given must be known, and the expiry (stored, or the default) not passed.
  const at = toDate(p.consent_at);
  if (!at) return block("consent_missing_date");
  const expires = toDate(p.consent_expires_at) ?? defaultExpiry(type, at);
  if (expires && expires.getTime() <= now.getTime()) return block("consent_expired");
  return { ok: true };
}

/** How long a consent lasts, for comparing two of them (express and open-ended last for ever). */
function strength(c: ConsentRecord, now: Date): number {
  const type = String(c.consent_type ?? "none");
  if (type === "none") return -1;
  if (type === "express") return Number.MAX_SAFE_INTEGER;
  if (type === "us_opt_out") return 0;
  const at = toDate(c.consent_at);
  if (!at) return 0;
  const exp = toDate(c.consent_expires_at) ?? defaultExpiry(type as ConsentType, at);
  if (!exp) return Number.MAX_SAFE_INTEGER - 1; // ongoing business relationship
  return Math.max(0, exp.getTime() - now.getTime() + 1);
}

/**
 * Which consent to keep when a source reports one for someone we already know: express is never replaced by implied,
 * and between two others the one that lasts longer wins. A tie keeps the current record.
 */
export function mergeConsent<T extends ConsentRecord>(current: T, incoming: ConsentRecord, now: Date): ConsentRecord {
  return strength(incoming, now) > strength(current, now) ? incoming : current;
}

const STATUS_RANK: Record<string, number> = { lead: 0, demo_booked: 1, trial: 2, customer: 3 };

/**
 * The status after an automatic update (a sync from a source). It only moves forward (lead < demo booked < trial <
 * customer). "lost" is kept unless the person actually signs up again (trial or customer). An automatic "lost" (a
 * cancelled subscription) replaces anything.
 */
export function nextStatus(current: string | null | undefined, incoming: string | null | undefined): ProspectStatus {
  const cur = (PROSPECT_STATUSES as readonly string[]).includes(String(current)) ? (current as ProspectStatus) : "lead";
  if (!incoming || !(PROSPECT_STATUSES as readonly string[]).includes(incoming)) return cur;
  const inc = incoming as ProspectStatus;
  if (inc === "lost") return "lost";
  if (cur === "lost") return inc === "trial" || inc === "customer" ? inc : "lost";
  return STATUS_RANK[inc]! > STATUS_RANK[cur]! ? inc : cur;
}

/** A licensee's status as a prospect status. */
export function statusFromLicensee(status: string): ProspectStatus {
  if (["active", "past_due", "suspended"].includes(status)) return "customer";
  if (status === "cancelled") return "lost";
  return "trial"; // pending_payment, provisioning, trial
}

/** The Keystone CRM's stage (BF-Server, KS silo) as a prospect status. */
export function statusFromCrmStage(stage: string | null | undefined): ProspectStatus | null {
  switch (stage) {
    case "lead":
      return "lead";
    case "demo_started":
    case "demo_finished":
      return "demo_booked";
    case "signed_up":
      return "trial";
    case "paying":
      return "customer";
    case "lost":
      return "lost";
    default:
      return null;
  }
}

// ---- sequence stop rules ----

export type StopCheck = {
  enrolled_at: Date | string;
  last_replied_at?: Date | string | null;
  signed_up_at?: Date | string | null;
  demo_booked_at?: Date | string | null;
  status?: string | null;
};
export type StopReason = "replied" | "signed_up" | "demo_booked";
export const STOP_MESSAGES: Record<StopReason, string> = {
  replied: "They replied.",
  signed_up: "They signed up for Keystone.",
  demo_booked: "They booked a demo.",
};

/**
 * Why a sequence must stop for this prospect, or null to carry on. Only things that happen after the enrolment count,
 * so a prospect enrolled in a "demo booked" follow-up is not stopped by the booking that put them there.
 */
export function stopReason(e: StopCheck): StopReason | null {
  const since = toDate(e.enrolled_at)?.getTime() ?? 0;
  const after = (v: Date | string | null | undefined) => {
    const d = toDate(v);
    return d !== null && d.getTime() >= since;
  };
  if (after(e.last_replied_at)) return "replied";
  if (after(e.signed_up_at)) return "signed_up";
  if (after(e.demo_booked_at)) return "demo_booked";
  return null;
}
