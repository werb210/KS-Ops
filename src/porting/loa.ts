// KS_OPS_NUMBER_PORTING_v1 - the letter of authorization (LOA) for one transfer request, built from what the brokerage
// entered: its legal name, the name on the carrier account, the service address exactly as on the bill, the numbers, the
// carrier and the account number. The PIN is never written into it (only "on file"). Signed by click like the licence
// agreement (src/onboarding/agreement.ts): name, title, time, IP address, version and a SHA-256 of the exact text shown.
// The carrier needs it dated within 30 days, so an older signature has to be renewed before submission.
//
// THE WORDING IS A TEMPLATE PENDING LEGAL REVIEW. Changing it means a new LOA_VERSION.
import type { Q } from "../db.js";
import { esc } from "../lib/email.js";
import { decryptSecret, encryptSecret, sha256Hex } from "../lib/crypto.js";
import { licensorName } from "../onboarding/agreement.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { carrierLabel, LOA_MAX_AGE_DAYS, NUMBER_TYPE_LABELS, pretty, type NumberType } from "./model.js";
import type { PortNumberRow, PortRequestRow } from "./repo.js";

export const LOA_VERSION = "2026-11-06.loa-1";
export const LOA_TITLE = "Letter of Authorization to transfer phone numbers";

export type RenderedLoa = { version: string; title: string; text: string; html: string; sha256: string };

function sections(l: Pick<LicenseeRow, "legal_name" | "company_name">, r: PortRequestRow, numbers: PortNumberRow[], accountNumber: string, e: NodeJS.ProcessEnv) {
  const address = [r.service_line1, r.service_line2, `${r.service_city}, ${r.service_region} ${r.service_postal_code}`, r.service_country === "US" ? "United States" : "Canada"]
    .filter(Boolean).join(", ");
  return [
    { heading: "Customer", lines: [
      `Business (legal name): ${l.legal_name}`,
      ...(l.company_name && l.company_name !== l.legal_name ? [`Operating as: ${l.company_name}`] : []),
      `Name on the carrier account: ${r.account_name}`,
      `Service address (as on the carrier's bill): ${address}`,
    ] },
    { heading: "Current carrier", lines: [
      `Carrier: ${carrierLabel(r.carrier, r.carrier_other)}`,
      `Account number: ${accountNumber}`,
      `Account PIN or passcode: ${r.pin_encrypted ? "on file with Keystone (not shown)" : "none given"}`,
    ] },
    { heading: "Numbers to transfer", lines: numbers.map((n) => `${pretty(n.phone_number)} (${NUMBER_TYPE_LABELS[n.number_type as NumberType] ?? n.number_type})`) },
    { heading: "Authorization", lines: [
      `I authorize Twilio Inc. and its carrier partners, acting for ${licensorName(e)} (Keystone, the software provider of ${l.company_name}), to transfer the numbers listed above from the current carrier, and to act as ${l.legal_name}'s agent for that purpose.`,
      "I confirm that I am authorized to sign for the business named above, that the account details and service address match the current carrier's records, and that I understand the transfer may end my service with the current carrier for these numbers and may close that account if no numbers remain on it.",
      `I understand the current carrier may text a listed number asking to approve the transfer, and that it must be approved within 90 minutes or the transfer is rejected.`,
      `This letter is valid for ${LOA_MAX_AGE_DAYS} days from the date it is signed.`,
    ] },
    { heading: "Template pending legal review", lines: ["This letter is a plain-English template that has not yet been reviewed by a lawyer."] },
  ];
}

/** The letter for this request as text (what is hashed and stored) and as HTML (what the portal shows). */
export function renderLoa(l: Pick<LicenseeRow, "legal_name" | "company_name">, r: PortRequestRow, numbers: PortNumberRow[], accountNumber: string, e: NodeJS.ProcessEnv = process.env): RenderedLoa {
  const secs = sections(l, r, numbers, accountNumber, e);
  const text = [`${LOA_TITLE}\nVersion ${LOA_VERSION}`, ...secs.map((s) => [s.heading, ...s.lines].join("\n"))].join("\n\n");
  const html = `<h2>${esc(LOA_TITLE)}</h2><p><small>Version ${esc(LOA_VERSION)}</small></p>` +
    secs.map((s) => `<h3>${esc(s.heading)}</h3>` + (s.heading === "Numbers to transfer" || s.heading === "Customer" || s.heading === "Current carrier"
      ? `<ul>${s.lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
      : s.lines.map((x) => `<p>${esc(x)}</p>`).join(""))).join("");
  return { version: LOA_VERSION, title: LOA_TITLE, text, html, sha256: sha256Hex(text) };
}

export type LoaRow = {
  id: string;
  port_request_id: string;
  version: string;
  signer_name: string;
  signer_title: string;
  signer_email: string | null;
  signer_user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  text_sha256: string;
  /** The signed text, encrypted (it holds the account number). Read it with loaText(). */
  rendered_text_encrypted: string;
  signed_at: Date;
};

export function loaText(a: Pick<LoaRow, "rendered_text_encrypted">, key: Buffer): string {
  return decryptSecret(a.rendered_text_encrypted, key);
}

export async function latestLoa(db: Q, requestId: string): Promise<LoaRow | null> {
  const r = await db.query("SELECT * FROM port_request_loas WHERE port_request_id = $1 ORDER BY signed_at DESC LIMIT 1", [requestId]);
  return (r.rows[0] as LoaRow) ?? null;
}

/** Age of a signature in whole days at `now`; a letter is good for 30 days. */
export function loaExpired(a: Pick<LoaRow, "signed_at"> | null, now: Date): boolean {
  if (!a) return true;
  return now.getTime() - new Date(a.signed_at).getTime() > LOA_MAX_AGE_DAYS * 86_400_000;
}

export type LoaSignInput = { signer_name: string; signer_title: string; signer_email?: string | null; signer_user_id?: string | null; ip: string; user_agent: string };

export async function recordLoaSignature(db: Q, requestId: string, doc: RenderedLoa, input: LoaSignInput, key: Buffer, now: Date): Promise<LoaRow> {
  const r = await db.query(
    `INSERT INTO port_request_loas (port_request_id, version, signer_name, signer_title, signer_email, signer_user_id, ip, user_agent, text_sha256, rendered_text_encrypted, signed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [requestId, doc.version, input.signer_name, input.signer_title, input.signer_email ?? null, input.signer_user_id ?? null,
      input.ip.slice(0, 100) || null, input.user_agent.slice(0, 500) || null, doc.sha256, encryptSecret(doc.text, key), now],
  );
  return r.rows[0] as LoaRow;
}

const when = (d: Date | string) => new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC";

/** The signed letter as a standalone HTML file (KS-Ops has no PDF library): for Twilio's form and the records. */
export function signedLoaHtml(a: LoaRow, company: string, key: Buffer): string {
  const record = [
    `Signed by: ${a.signer_name}, ${a.signer_title}`,
    ...(a.signer_email ? [`Email: ${a.signer_email}`] : []),
    `Date signed: ${when(a.signed_at)}`,
    `Version: ${a.version}`,
    `From IP address: ${a.ip ?? "unknown"}`,
    `Text fingerprint (SHA-256): ${a.text_sha256}`,
  ];
  const body = loaText(a, key).split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(LOA_TITLE)} - ${esc(company)}</title>` +
    `<style>body{font:15px/1.5 Arial,sans-serif;color:#111;max-width:46rem;margin:2rem auto;padding:0 1rem}h1{font-size:1.3rem}.sig{border:1px solid #444;padding:.8rem 1rem;margin-top:1.5rem}</style></head>` +
    `<body><h1>${esc(LOA_TITLE)}</h1>${body}<div class="sig"><strong>Signature (signed electronically)</strong><br/>${record.map(esc).join("<br/>")}</div></body></html>`;
}
