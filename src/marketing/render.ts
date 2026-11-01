// KS_OPS_PROSPECT_MARKETING_v1 - the Keystone-branded marketing email: a fixed layout (Keystone wordmark and colours,
// never Boreal's), content from the template's fields, and a footer that is always added and cannot be edited away:
// why they are getting it, who is sending (business and legal name), the physical mailing address, a contact address
// and the unsubscribe link (CASL s.6 and CAN-SPAM). The same unsubscribe address goes in the List-Unsubscribe header
// with List-Unsubscribe-Post for one-click unsubscribe (RFC 8058).
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { opsPublicUrl } from "../config.js";
import { esc } from "../lib/email.js";
import type { ConsentType } from "./consent.js";
import { sender, unsubscribeSecret, type Sender } from "./settings.js";

export const KS_BRAND = {
  name: "Keystone",
  accent: "#6D28D9", // white text on it: 7.1:1
  ink: "#111827", // body text on white: 16:1
  muted: "#4B5563", // footer text on #F3F4F6: 7.0:1
  background: "#F3F4F6",
};

const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => v === "" || /^https:\/\/[^\s"'<>]+$/i.test(v), "Links must start with https://");

export const templateFieldsSchema = z.object({
  preheader: z.string().trim().max(200).default(""),
  headline: z.string().trim().max(200).default(""),
  body: z.string().trim().max(10_000).default(""),
  cta_label: z.string().trim().max(60).default(""),
  cta_url: httpsUrl.default(""),
  body2: z.string().trim().max(5_000).default(""),
  signature: z.string().trim().max(500).default(""),
});
export type TemplateFields = z.infer<typeof templateFieldsSchema>;

export type Recipient = {
  email: string;
  name?: string | null;
  company?: string | null;
  consent_type?: ConsentType | string | null;
};

// ---- unsubscribe links ----

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function mac(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`ks-mkt-unsub:${email.trim().toLowerCase()}`).digest("base64url").slice(0, 32);
}

/** A token that names the email and proves we made it (no database lookup, never expires). */
export function unsubscribeToken(email: string, secret = unsubscribeSecret()): string {
  if (!secret) throw new Error("unsubscribe secret not configured");
  const e = email.trim().toLowerCase();
  return `${b64(e)}.${mac(e, secret)}`;
}

/** The email in a valid token, or null. */
export function readUnsubscribeToken(token: unknown, secret = unsubscribeSecret()): string | null {
  if (typeof token !== "string" || !secret) return null;
  const [p, sig] = token.trim().split(".");
  if (!p || !sig) return null;
  let email: string;
  try {
    email = Buffer.from(p, "base64url").toString("utf8").trim().toLowerCase();
  } catch {
    return null;
  }
  if (!email.includes("@")) return null;
  const want = Buffer.from(mac(email, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? email : null;
}

export function unsubscribeUrl(email: string, base = opsPublicUrl()): string {
  return `${base}/api/public/marketing/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email))}`;
}

// ---- merge tags ----

const firstName = (name: string | null | undefined) => String(name ?? "").trim().split(/\s+/)[0] || "";

/** {{first_name}}, {{name}}, {{company}}, {{email}} - plain text in, plain text out (escaped later for HTML). */
export function mergeTags(text: string, r: Recipient): string {
  const values: Record<string, string> = {
    first_name: firstName(r.name) || "there",
    name: String(r.name ?? "").trim() || "there",
    company: String(r.company ?? "").trim() || "your brokerage",
    email: r.email,
  };
  return text.replace(/\{\{\s*(first_name|name|company|email)\s*\}\}/g, (_m, k: string) => values[k] ?? "");
}

export const WHY_YOU_GET_THIS: Record<string, string> = {
  express: "you asked to hear from Keystone",
  implied_inquiry: "you recently asked us about Keystone",
  implied_business: "you are, or recently were, a Keystone customer",
  implied_publication: "your business email address is published and this message relates to your role",
  us_opt_out: "you are a business contact in the US who has not opted out",
};

// ---- the email ----

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

function htmlParagraphs(text: string): string {
  return paragraphs(text)
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${KS_BRAND.ink}">${esc(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function button(label: string, url: string): string {
  if (!label || !url) return "";
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${KS_BRAND.accent}">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:12px 22px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a>` +
    `</td></tr></table>`
  );
}

export type Rendered = { subject: string; html: string; text: string; headers: Record<string, string>; unsubscribe_url: string };

export function footerLines(s: Sender, r: Recipient): string[] {
  const why = WHY_YOU_GET_THIS[String(r.consent_type ?? "")] ?? "you have been in touch with Keystone";
  return [
    `You are getting this email from ${s.business_name} because ${why}.`,
    `Sent by ${s.business_name} (${s.legal_name}), ${s.address}. Contact us: ${s.reply_to}.`,
  ];
}

/** Renders one email for one recipient. The footer and unsubscribe link are always added. */
export function renderEmail(
  subjectIn: string,
  fieldsIn: Partial<TemplateFields>,
  r: Recipient,
  opts: { base?: string; s?: Sender; test?: boolean } = {},
): Rendered {
  const f = templateFieldsSchema.parse(fieldsIn ?? {});
  const s = opts.s ?? sender();
  const unsub = unsubscribeUrl(r.email, opts.base ?? opsPublicUrl());
  const m = (t: string) => mergeTags(t, r);
  const subject = (opts.test ? "[Test] " : "") + m(subjectIn).replace(/[\r\n]+/g, " ").trim();
  const [why, who] = footerLines(s, r);

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${KS_BRAND.background}">` +
    (f.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(m(f.preheader))}</div>` : "") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${KS_BRAND.background}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">` +
    `<tr><td style="background:${KS_BRAND.accent};padding:18px 28px"><span style="font-size:22px;font-weight:800;letter-spacing:0.02em;color:#ffffff">${esc(KS_BRAND.name)}</span></td></tr>` +
    `<tr><td style="padding:28px">` +
    (f.headline ? `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${KS_BRAND.ink}">${esc(m(f.headline))}</h1>` : "") +
    htmlParagraphs(m(f.body)) +
    button(m(f.cta_label), f.cta_url) +
    htmlParagraphs(m(f.body2)) +
    (f.signature ? `<p style="margin:0;font-size:16px;line-height:1.55;color:${KS_BRAND.ink}">${esc(m(f.signature)).replace(/\n/g, "<br/>")}</p>` : "") +
    `</td></tr>` +
    `<tr><td style="background:${KS_BRAND.background};padding:18px 28px;font-size:12px;line-height:1.6;color:${KS_BRAND.muted}">` +
    `<p style="margin:0 0 6px">${esc(why)}</p>` +
    `<p style="margin:0 0 6px">${esc(who)}</p>` +
    `<p style="margin:0"><a href="${esc(unsub)}" style="color:${KS_BRAND.muted};text-decoration:underline">Unsubscribe</a> from Keystone marketing emails. We act on it right away.</p>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = [
    ...(f.headline ? [m(f.headline), ""] : []),
    ...paragraphs(m(f.body)).flatMap((p) => [p, ""]),
    ...(f.cta_label && f.cta_url ? [`${m(f.cta_label)}: ${f.cta_url}`, ""] : []),
    ...paragraphs(m(f.body2)).flatMap((p) => [p, ""]),
    ...(f.signature ? [m(f.signature), ""] : []),
    "--",
    why,
    who,
    `Unsubscribe: ${unsub}`,
  ].join("\n");

  return {
    subject,
    html,
    text,
    unsubscribe_url: unsub,
    headers: {
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
