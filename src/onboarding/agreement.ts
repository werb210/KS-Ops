// KS_OPS_ONBOARDING_v1 - the Keystone Software Licence Agreement: rendered for one licensee (company, legal name, plan,
// seats, add-ons, support level and price), signed by click (full name, title, "I agree"), and kept with who signed,
// from where, when, which version and a SHA-256 of the exact text shown. No e-signature service: the website shows the
// text and posts the signature here; a copy goes to the owner and to sales by email (HTML; KS-Ops has no PDF library).
//
// THE WORDING IS A TEMPLATE PENDING LEGAL REVIEW. Changing it means a new AGREEMENT_VERSION: signatures are per version.
import type { Q } from "../db.js";
import { env, salesEmail, supportEmail } from "../config.js";
import { esc, type Mail } from "../lib/email.js";
import { sha256Hex } from "../lib/crypto.js";
import { DATA_RETENTION_DAYS, type LicenseeRow } from "../licensees/repo.js";
import {
  CURRENCY, MARKETING_ADDON, PLAN_NAMES, STORAGE_BLOCK, SUPPORT, dollars, hasMarketingAddon, monthlyCharge, onboardingFeeCents,
} from "../pricing.js";

export const AGREEMENT_VERSION = "2026-11-06.template-1";
export const AGREEMENT_TITLE = "Keystone Software Licence Agreement";
export const RECORD_RETENTION_YEARS = 7;

/** KS_LICENSOR_LEGAL_NAME (default 2630108 Alberta Ltd.): the company that licenses Keystone. */
export function licensorName(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_LICENSOR_LEGAL_NAME", e) || "2630108 Alberta Ltd.";
}

const money = (cents: number) =>
  `$${dollars(cents).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${CURRENCY}`;

type Section = { heading: string; paragraphs: string[] };

/** What the licensee bought, in plain lines (shown in the agreement and in its email). */
export function orderLines(l: LicenseeRow): string[] {
  const c = monthlyCharge(l);
  const support = SUPPORT[l.support_level];
  const fee = onboardingFeeCents(l.plan);
  const annual = l.billing_interval === "annual";
  const addons: string[] = [];
  if (hasMarketingAddon(l)) addons.push(`${MARKETING_ADDON.name} (${money(MARKETING_ADDON.price_cents)} a month)`);
  if (l.extra_storage_blocks > 0) addons.push(`${l.extra_storage_blocks} extra ${STORAGE_BLOCK.gb} GB storage block(s) (${money(c.storage_cents)} a month)`);
  return [
    `Plan: ${PLAN_NAMES[l.plan]}`,
    `Seats: ${c.billable_seats} (${money(c.seat_price_cents)} per seat per month, billed ${annual ? "annually" : "monthly"})`,
    `Add-ons: ${addons.length ? addons.join("; ") : "none"}`,
    `Support level: ${support.name} (${c.support_cents ? `${money(c.support_cents)} a month` : "included"}; first reply within ${support.first_reply}; live help: ${support.live_help})`,
    `Subscription fees: ${money(c.recurring_cents)} a month${annual ? `, billed as ${money(c.recurring_cents * 12)} a year in advance` : ", billed monthly in advance"}`,
    `One-time onboarding fee: ${fee ? money(fee) : "none"}`,
    "Taxes: applicable sales taxes are extra. Usage over the plan's allowances (call minutes, texts, signings, ID checks, campaign emails) is billed after use at the published rates.",
  ];
}

function sections(l: LicenseeRow, e: NodeJS.ProcessEnv): Section[] {
  const licensor = licensorName(e);
  const support = SUPPORT[l.support_level];
  const months = Math.round(DATA_RETENTION_DAYS / 30);
  return [
    {
      heading: "Template pending legal review",
      paragraphs: [
        "This agreement is a plain-English template that has not yet been reviewed by a lawyer. Keystone may replace it with a reviewed version; if the reviewed version changes your rights or fees, we will ask you to accept it before it applies to you.",
      ],
    },
    {
      heading: "1. Who this agreement is between",
      paragraphs: [
        `This agreement is between ${licensor}, which provides the Keystone software ("Keystone", "we", "us"), and ${l.legal_name}, operating as ${l.company_name} ("the Brokerage", "you"), company code "${l.company_code}".`,
      ],
    },
    {
      heading: "2. What Keystone is",
      paragraphs: [
        "Keystone is software: a customer-relationship and loan-origination system for commercial finance brokerages, with a staff portal, a branded client app, a dialler and an AI assistant. Keystone is not a lender. We do not lend money, arrange or approve financing, act as a broker, or give financial, credit, legal or tax advice. Your brokerage alone decides how it uses Keystone with its clients and lenders.",
      ],
    },
    {
      heading: "3. Your licence",
      paragraphs: [
        "While your subscription is paid up, we grant your brokerage a non-exclusive, non-transferable licence to use Keystone for its own business, by the number of people your seats allow. A seat is one named person who signs in; seats cannot be shared, but you can move a seat from one person to another.",
        "You may not resell, sublicense, copy, reverse-engineer or try to get around the limits or security of Keystone, or use it for anything unlawful, including sending messages to people who have not agreed to receive them.",
      ],
    },
    {
      heading: "4. What you bought and what it costs",
      paragraphs: orderLines(l),
    },
    {
      heading: "5. Billing, changes and renewal",
      paragraphs: [
        `Fees are charged in advance for each ${l.billing_interval === "annual" ? "year" : "month"} through Stripe, by the payment method you chose, and the subscription renews automatically for the same period until cancelled. You can add seats, add-ons or a higher support level at any time; the change is prorated. Reductions take effect at the next renewal. We may change prices with at least 30 days' notice by email; a change applies from your next renewal after the notice.`,
        "If a payment fails we will email you. If it is still unpaid after 14 days we may suspend access until it is paid; your data is not deleted while suspended.",
      ],
    },
    {
      heading: "6. Your data belongs to your brokerage",
      paragraphs: [
        "Everything your brokerage and its clients put into Keystone (contacts, applications, documents, call recordings, messages and notes) belongs to your brokerage. Each brokerage has its own separate database. We only use your data to provide and support Keystone for you, to keep it secure, and as the law requires. We never sell it or use it to market to your clients.",
        "You are responsible for having the consents your clients' information needs, and for what your team does in Keystone. You can export your data at any time while your subscription is active.",
      ],
    },
    {
      heading: "7. Record retention and deletion",
      paragraphs: [
        `Keystone keeps application and client documents for ${RECORD_RETENTION_YEARS} years from when the file is closed, so your brokerage can meet its record-keeping obligations, unless you delete them sooner where the law allows or a legal hold applies.`,
        `If you cancel, your data is held for ${months} months (${DATA_RETENTION_DAYS} days) after the cancellation date so you can export it or come back. After that hold, your brokerage's data is purged from Keystone, except records that must still be kept for the ${RECORD_RETENTION_YEARS}-year retention period or under a legal hold, which are kept read-only and then deleted.`,
      ],
    },
    {
      heading: "8. Support",
      paragraphs: [
        `Your support level is ${support.name}: ${support.channels.join(", ")}; first reply within ${support.first_reply}; live help: ${support.live_help}. Support is reached at ${supportEmail(e)}. Onboarding sessions are held on Microsoft Teams.`,
      ],
    },
    {
      heading: "9. Availability and changes to Keystone",
      paragraphs: [
        "We work to keep Keystone available and secure, and we improve it over time. Planned maintenance is scheduled outside business hours where we can. Some features depend on other providers (for example phone carriers, Microsoft, Google and Stripe), and their rules and approval times apply.",
      ],
    },
    {
      heading: "10. Confidentiality and security",
      paragraphs: [
        "Each of us keeps the other's confidential information private and uses it only for this agreement. We protect your data with encryption in transit and at rest, access controls and audit logs, and we will tell you without undue delay if we learn of a breach affecting your data.",
      ],
    },
    {
      heading: "11. Warranties and liability",
      paragraphs: [
        "Keystone is provided as described on our website and in this agreement. Except as stated here, it is provided without other warranties. Neither of us is liable to the other for indirect or consequential losses, such as lost profits. Our total liability under this agreement is limited to the fees you paid in the 12 months before the claim. Nothing limits liability that cannot be limited by law.",
      ],
    },
    {
      heading: "12. Term and cancellation",
      paragraphs: [
        "This agreement starts when you accept it and continues while your subscription is active. You can cancel at any time from your portal or by writing to support; cancellation takes effect at the end of the period already paid, and fees already paid are not refunded except where the law requires. We may end this agreement if you seriously breach it and do not fix the breach within 30 days of our notice.",
      ],
    },
    {
      heading: "13. General",
      paragraphs: [
        "This agreement is governed by the laws of the Province of Alberta and the federal laws of Canada that apply there, and the courts of Alberta have jurisdiction. It is the whole agreement about Keystone between us, together with the terms of service and privacy policy on our website. Notices are given by email: to you at the contact email on your account, and to us at " + supportEmail(e) + ".",
      ],
    },
  ];
}

export type RenderedAgreement = { version: string; title: string; text: string; html: string; sha256: string };

/** The agreement for this licensee, as text (what is hashed and stored) and as HTML (what the website shows). */
export function renderAgreement(l: LicenseeRow, e: NodeJS.ProcessEnv = process.env): RenderedAgreement {
  const secs = sections(l, e);
  const head = [AGREEMENT_TITLE, `Version ${AGREEMENT_VERSION}`, `${l.legal_name} (${l.company_name})`];
  const text = [head.join("\n"), ...secs.map((s) => [s.heading, ...s.paragraphs].join("\n\n"))].join("\n\n");
  const html =
    `<h2>${esc(AGREEMENT_TITLE)}</h2><p><small>Version ${esc(AGREEMENT_VERSION)}</small></p>` +
    secs
      .map((s, i) =>
        `<h3>${esc(s.heading)}</h3>` +
        (i === 4 ? `<ul>${s.paragraphs.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")),
      )
      .join("");
  return { version: AGREEMENT_VERSION, title: AGREEMENT_TITLE, text, html, sha256: sha256Hex(text) };
}

export type AgreementRow = {
  id: string;
  licensee_id: string;
  version: string;
  signer_name: string;
  signer_title: string;
  signer_email: string;
  ip: string | null;
  user_agent: string | null;
  text_sha256: string;
  rendered_text: string;
  signed_at: Date;
  emailed_at: Date | null;
};

/** The licensee's signature on any version (the newest), or null. Provisioning only needs one signed agreement. */
export async function signedAgreement(db: Q, licenseeId: string): Promise<AgreementRow | null> {
  const r = await db.query("SELECT * FROM licence_agreements WHERE licensee_id = $1 ORDER BY signed_at DESC LIMIT 1", [licenseeId]);
  return (r.rows[0] as AgreementRow) ?? null;
}

export type SignInput = { signer_name: string; signer_title: string; ip: string; user_agent: string };

/** Records the signature on the current version. A second signature of the same version keeps the first. */
export async function recordSignature(db: Q, l: LicenseeRow, input: SignInput, e: NodeJS.ProcessEnv = process.env): Promise<{ row: AgreementRow; created: boolean }> {
  const doc = renderAgreement(l, e);
  const r = await db.query(
    `INSERT INTO licence_agreements (licensee_id, version, signer_name, signer_title, signer_email, ip, user_agent, text_sha256, rendered_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (licensee_id, version) DO NOTHING
     RETURNING *`,
    [l.id, doc.version, input.signer_name, input.signer_title, l.contact_email, input.ip.slice(0, 100) || null, input.user_agent.slice(0, 500) || null, doc.sha256, doc.text],
  );
  if (r.rows[0]) return { row: r.rows[0] as AgreementRow, created: true };
  const existing = await db.query("SELECT * FROM licence_agreements WHERE licensee_id = $1 AND version = $2", [l.id, doc.version]);
  return { row: existing.rows[0] as AgreementRow, created: false };
}

const when = (d: Date | string) => new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** The signed copy: to the owner and to sales, with the full text and the signature record. */
export function signedCopyMail(l: LicenseeRow, a: AgreementRow, e: NodeJS.ProcessEnv = process.env): Mail {
  const record = [
    `Signed by: ${a.signer_name}, ${a.signer_title}, for ${l.legal_name}`,
    `Email: ${a.signer_email}`,
    `Signed at: ${when(a.signed_at)}`,
    `Version: ${a.version}`,
    `From IP address: ${a.ip ?? "unknown"}`,
    `Text fingerprint (SHA-256): ${a.text_sha256}`,
  ];
  const intro = `Here is your signed copy of the ${AGREEMENT_TITLE} for ${l.company_name}. Keep it for your records.`;
  const paragraphs = a.rendered_text.split("\n\n");
  return {
    to: [l.contact_email, salesEmail(e)],
    subject: `${l.company_name}: your signed ${AGREEMENT_TITLE}`,
    replyTo: salesEmail(e),
    text: [intro, record.join("\n"), "-----", a.rendered_text].join("\n\n"),
    html:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0B1F3A">' +
      `<p>${esc(intro)}</p><p>${record.map(esc).join("<br/>")}</p><hr/>` +
      paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`).join("") +
      "</div>",
  };
}
