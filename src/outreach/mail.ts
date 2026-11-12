// KS_OPS_OUTREACH_v2 - physical mail to brokerage owners. A mail batch picks the best firms that have a mailing address
// and a decision-maker, gives each its own tracked link (printed as a QR code), and produces print-ready letters
// (one US Letter page each, the address placed for a #10 window envelope) plus an address label file. Printing and
// posting are done by hand for now; a mailing service can take the same batch later.
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type { Q } from "../db.js";
import { sender } from "../marketing/settings.js";
import { contactRank, isDecisionMaker } from "./rules.js";
import { addTouch, newCode } from "./store.js";

export type Letter = { greeting: string; body: string; closing: string; signature: string; target_url: string; ps: string };
export const DEFAULT_LETTER: Letter = {
  greeting: "Dear {{first_name}},",
  body: [
    "We run a commercial finance brokerage, and for years we stitched together a CRM, a dialler, e-signing, spreadsheets for commissions and a shared drive for client documents. None of it knew what a deal was.",
    "So we built the system we wished we could buy. Keystone is one place for the whole brokerage: the pipeline, calls and texts, a client app that collects documents, bank statements and financials read automatically, lender matching, term sheets, and commissions and broker pay worked out for you.",
    "It starts at $49 a seat, and we move your contacts, deals and lenders over for you.",
    "I would like 15 minutes to show you what it would replace at {{company}} and what it would cost. The code on this page opens a short walkthrough made for you.",
  ].join("\n\n"),
  closing: "Sincerely,",
  signature: "",
  target_url: "",
  ps: "P.S. There is nothing to install to try it: scan the code and click through a live brokerage.",
};
export function letterFrom(raw: unknown): Letter {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LETTER };
  for (const k of Object.keys(out) as Array<keyof Letter>) if (typeof o[k] === "string") out[k] = String(o[k]).slice(0, k === "body" ? 4000 : 500);
  return out;
}
export const loadLetter = async (db: Q): Promise<Letter> => letterFrom((await db.query(`SELECT letter FROM ks_outreach_settings WHERE id = 1`)).rows[0]?.letter);

export type Recipient = {
  brokerage_id: string; company: string; person_id: string | null; name: string; first_name: string; title: string | null;
  address_line1: string; address_line2: string | null; city: string; province_state: string | null; postal_code: string | null; country: string | null;
  link_code: string; link_url: string;
};
const fill = (text: string, r: Recipient) => text.replace(/\{\{\s*(first_name|name|company|title)\s*\}\}/g, (_m, k: string) => String((r as unknown as Record<string, unknown>)[k] ?? ""));

/** The best firms to write to: kept, working, with an address and a decision-maker, not written to before. */
export async function pickRecipients(db: Q, opts: { limit: number; countries?: string[]; brokerage_ids?: string[] }) {
  const rows = (await db.query(
    `SELECT b.id, b.name, b.address_line1, b.address_line2, b.city, b.province_state, b.postal_code, b.country, b.fit_score
       FROM ks_brokerages b
      WHERE b.qualification = 'keep' AND b.status = 'working' AND b.address_line1 IS NOT NULL AND b.city IS NOT NULL
        AND ($1::text[] IS NULL OR upper(b.country) = ANY($1)) AND ($2::uuid[] IS NULL OR b.id = ANY($2))
        AND ($2::uuid[] IS NOT NULL OR NOT EXISTS (SELECT 1 FROM ks_mkt_touches t WHERE t.brokerage_id = b.id AND t.channel_key = 'mail' AND t.outcome = 'sent'))
      ORDER BY b.fit_score DESC, b.name LIMIT 2000`,
    [opts.countries?.length ? opts.countries.map((c) => c.toUpperCase()) : null, opts.brokerage_ids?.length ? opts.brokerage_ids : null])).rows;
  const out: Array<Omit<Recipient, "link_code" | "link_url">> = [];
  for (const b of rows) {
    if (out.length >= opts.limit) break;
    const people = (await db.query(`SELECT id, name, title FROM ks_broker_people WHERE brokerage_id = $1`, [b.id])).rows
      .map((p: any) => ({ ...p, rank: contactRank(p.title) })).filter((p: any) => isDecisionMaker(p.rank)).sort((a: any, c: any) => a.rank - c.rank || a.name.localeCompare(c.name));
    const p = people[0];
    if (!p) continue;
    out.push({
      brokerage_id: b.id, company: b.name, person_id: p.id, name: p.name, first_name: String(p.name).trim().split(/\s+/)[0] ?? p.name, title: p.title,
      address_line1: b.address_line1, address_line2: b.address_line2, city: b.city, province_state: b.province_state, postal_code: b.postal_code, country: b.country,
    });
  }
  return out;
}

/** Makes the batch: a channel item, one tracked link per firm, and a "sent" touch per firm. */
export async function createMailBatch(
  db: Q, now: Date, input: { name: string; limit: number; countries?: string[]; brokerage_ids?: string[]; cost_per_letter_cents?: number; by: string; base_url: string; fallback_url: string },
) {
  const letter = await loadLetter(db);
  const target = /^https:\/\//i.test(letter.target_url) ? letter.target_url : input.fallback_url;
  const picked = await pickRecipients(db, input);
  if (!picked.length) return null;
  const each = Math.max(0, Math.round(input.cost_per_letter_cents ?? 0));
  const item = (await db.query(
    `INSERT INTO ks_mkt_channel_items (channel_key, kind, name, happens_on, cost_cents, status, created_by) VALUES ('mail', 'mail_batch', $1, $2::date, 0, 'in_progress', $3) RETURNING id`,
    [input.name, now.toISOString().slice(0, 10), input.by])).rows[0].id as string;
  const recipients: Recipient[] = [];
  for (const r of picked) {
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const c = newCode();
      const ins = await db.query(
        `INSERT INTO ks_mkt_links (code, channel_key, brokerage_id, item_id, target_url, label, created_by) VALUES ($1, 'mail', $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING RETURNING code`,
        [c, r.brokerage_id, item, target, `Letter: ${input.name}`, input.by]);
      if (ins.rows.length) code = c;
    }
    if (!code) throw new Error("could not make a link code");
    recipients.push({ ...r, link_code: code, link_url: `${input.base_url}/api/public/marketing/l/${code}` });
    await addTouch(db, { channel_key: "mail", brokerage_id: r.brokerage_id, person_id: r.person_id, item_id: item, outcome: "sent", summary: `Letter to ${r.name}: ${input.name}.`, cost_cents: each, at: now, by: input.by });
  }
  await db.query(`UPDATE ks_mkt_channel_items SET data = $2::jsonb, updated_at = now() WHERE id = $1`, [item, JSON.stringify({ recipients, letter })]);
  return { item_id: item, count: recipients.length };
}

const PT = 72;
/** Print-ready letters: one US Letter page per firm; the address block sits where a #10 window envelope shows it. */
export async function lettersPdf(recipients: Recipient[], letter: Letter, now: Date): Promise<Buffer> {
  const s = sender();
  const doc = new PDFDocument({ size: "LETTER", margins: { top: PT, bottom: PT, left: PT, right: PT }, autoFirstPage: false, info: { Title: "Keystone letters", Author: s.business_name } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const dateText = now.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  for (const r of recipients) {
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(s.business_name, PT, 0.6 * PT);
    doc.font("Helvetica").fontSize(9).fillColor("#555555").text(s.address, PT, 0.6 * PT + 20);
    // Window position: 0.875in from the left, 2.0in from the top.
    doc.font("Helvetica").fontSize(11).fillColor("#111111");
    const lines = [r.name, r.title, r.company, r.address_line1, r.address_line2, [r.city, r.province_state, r.postal_code].filter(Boolean).join(" "), r.country === "US" ? "USA" : r.country === "CA" ? "Canada" : r.country]
      .filter((x): x is string => !!x && String(x).trim() !== "");
    doc.text(lines.join("\n"), 0.875 * PT, 2.0 * PT, { width: 3.5 * PT, lineGap: 1 });
    doc.text(dateText, PT, 3.6 * PT);
    doc.moveDown(1.2);
    doc.text(fill(letter.greeting, r));
    doc.moveDown(0.8);
    doc.text(fill(letter.body, r), { width: 6.5 * PT, lineGap: 2 });
    doc.moveDown(0.8);
    doc.text(letter.closing);
    doc.moveDown(1.6);
    doc.text(fill(letter.signature, r) || s.business_name);
    const qr = await QRCode.toBuffer(r.link_url, { errorCorrectionLevel: "M", margin: 1, width: 300 });
    const y = Math.min(Math.max(doc.y + 16, 7.5 * PT), 9.3 * PT); // under the signature, never off the page
    doc.image(qr, PT, y, { width: 1.2 * PT });
    doc.font("Helvetica").fontSize(10).fillColor("#111111").text(fill(letter.ps, r), PT + 1.4 * PT, y + 6, { width: 5 * PT, lineGap: 2 });
    doc.fontSize(9).fillColor("#555555").text(r.link_url, PT + 1.4 * PT, y + 62, { width: 5 * PT });
  }
  doc.end();
  return done;
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (head: string[], rows: unknown[][]): string => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function labelsCsv(recipients: Recipient[]): string {
  return toCsv(["Name", "Title", "Company", "Address 1", "Address 2", "City", "Province or state", "Postal or zip code", "Country", "Link"],
    recipients.map((r) => [r.name, r.title, r.company, r.address_line1, r.address_line2, r.city, r.province_state, r.postal_code, r.country, r.link_url]));
}

/** The company list LinkedIn's matched audiences takes (company name, website, email domain, country), kept firms only. */
export async function linkedInAudienceCsv(db: Q, countries?: string[]): Promise<{ csv: string; count: number }> {
  const rows = (await db.query(
    `SELECT name, website, domain, city, province_state, country FROM ks_brokerages
      WHERE qualification = 'keep' AND status <> 'customer' AND ($1::text[] IS NULL OR upper(country) = ANY($1)) ORDER BY fit_score DESC, name LIMIT 300000`,
    [countries?.length ? countries.map((c) => c.toUpperCase()) : null])).rows;
  return {
    count: rows.length,
    csv: toCsv(["companyname", "companywebsite", "companyemaildomain", "city", "state", "companycountry"], rows.map((b: any) => [b.name, b.website ?? (b.domain ? `https://${b.domain}` : ""), b.domain, b.city, b.province_state, b.country])),
  };
}
