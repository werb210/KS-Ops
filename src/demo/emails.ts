// The demo's emails: the magic link, the prospect's lender package, and the two notes to sales (finished / started
// but did not finish). Plain words; every value a prospect typed is escaped by bodies().
import { bodies, esc, type Mail, type MailAttachment } from "../lib/email.js";
import { DEMO_STEPS } from "./config.js";
import { minutes, type Digest } from "./digest.js";

export type SignupLike = { id: string; name: string; email: string; company: string; created_at: Date | string; expires_at: Date | string; opened_at?: Date | string | null; completed_at?: Date | string | null };

const label = (step: string | null) => DEMO_STEPS.find(([k]) => k === step)?.[1] ?? (step ?? "not started");
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function magicLinkUrl(portalUrl: string, id: string, token: string): string {
  return `${portalUrl.replace(/\/+$/, "")}/demo#d=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

const DEMO_HIGHLIGHTS: Array<[string, string]> = [
  ["See it as your client", "Walk through the client app the way your borrowers do - every answer is already filled in, you just click Next."],
  ["See it as the broker", "The application lands in your pipeline. Accept the documents, check the financials and the bank summary, and approve the credit summary."],
  ["Catch the fraud", "One bank statement has been doctored. Keystone flags it before it ever reaches a lender."],
  ["Take the call and send it", "Your client rings on iPhone and Apple Watch with their file on screen, AI writes the call note, and you send the file to a lender."],
]

export function magicLinkMail(s: SignupLike, url: string, days: number): Mail {
  const first = firstName(s.name);
  const text = [
    `Hi ${first},`,
    `Your private Keystone demo for ${s.company} is ready. In about ten minutes you will see a real deal from both sides:`,
    DEMO_HIGHLIGHTS.map(([h, b]) => `- ${h}: ${b}`).join("\n"),
    `Start your demo: ${url}`,
    `It works best on a computer or tablet. Nothing to download or type. Your link works for ${days} days. Everything in it is sample data.`,
    "Questions? Just reply - a real person reads every email.",
    "The Keystone team",
    "You are getting this because someone asked for a Keystone demo with this email address. If that was not you, ignore it and nothing else will be sent.",
  ].join("\n\n");
  const ink = "#0B1F3A";
  const muted = "#475569";
  const p = (t: string, extra = "") => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${ink};${extra}">${t}</p>`;
  const html =
    `<div style="background:#F4F6F9;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">` +
    `<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:12px;padding:32px 28px">` +
    `<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:${ink}">Keystone</p>` +
    p(`Hi ${esc(first)},`) +
    p(`Your private Keystone demo for <strong>${esc(s.company)}</strong> is ready. In about ten minutes you will see a real deal from both sides:`) +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%">` +
    DEMO_HIGHLIGHTS.map(
      ([h, b], i) =>
        `<tr><td style="vertical-align:top;padding:0 12px 14px 0;width:28px"><div style="width:26px;height:26px;border-radius:13px;background:#E7F0EC;color:#1F5C46;font-weight:bold;font-size:14px;line-height:26px;text-align:center">${i + 1}</div></td>` +
        `<td style="padding:0 0 14px;font-size:15px;line-height:1.5;color:${ink}"><strong>${esc(h)}.</strong> ${esc(b)}</td></tr>`,
    ).join("") +
    `</table>` +
    `<p style="margin:0 0 24px;text-align:center"><a href="${esc(url)}" style="display:inline-block;background:#1F5C46;color:#FFFFFF;text-decoration:none;font-weight:bold;font-size:17px;padding:14px 32px;border-radius:8px">Start my demo</a></p>` +
    p(`It works best on a computer or tablet. Nothing to download or type. Your link works for ${days} days. Everything in it is sample data.`, `color:${muted};font-size:15px`) +
    p("Questions? Just reply - a real person reads every email.") +
    p("The Keystone team", "margin-bottom:24px") +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:${muted}">If the button does not work, copy this link into your browser:<br/><a href="${esc(url)}" style="color:#1F5C46;word-break:break-all">${esc(url)}</a></p>` +
    `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:${muted}">You are getting this because someone asked for a Keystone demo with this email address. If that was not you, ignore it and nothing else will be sent.</p>` +
    `</div></div>`;
  return { to: [s.email], subject: `${first}, your Keystone demo is ready`, text, html };
}

/** The same link by text message. Short: carriers split long texts and some drop them. */
export function magicLinkSms(s: Pick<SignupLike, "name">, url: string): string {
  return `Keystone: Hi ${firstName(s.name)}, here is your private demo (best on a computer or tablet): ${url} Reply STOP to opt out.`;
}

/** KS_OPS_v12 - the real lender email the demo server rendered for the sample file (see routes/demo.ts). */
export type LenderEmail = { lenderName: string | null; subject: string; html: string; text: string; attachments: MailAttachment[] };

export const DEMO_BANNER = "Keystone demo - this is exactly what your lender would receive (sample data).";

/**
 * The prospect's copy of their lender submission: with the real lender email, exactly that email (subject, body,
 * signature, attachments) under a one-line demo banner; from an older demo server, the short note with the PDF.
 */
export function prospectPackageMail(s: SignupLike, pdfBase64: string | null, filename: string, lender: LenderEmail | null = null): Mail {
  if (lender) {
    return {
      to: [s.email],
      subject: lender.subject,
      attachments: lender.attachments,
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;background:#FFF7E6;border:1px solid #F0C36D;color:#5C3B00;padding:8px 12px;margin:0 0 16px;border-radius:4px;max-width:576px">${esc(DEMO_BANNER)}</div>` +
        lender.html,
      text: `${DEMO_BANNER}\n\n${lender.text}`,
    };
  }
  return {
    to: [s.email],
    subject: "Your sample lender submission package (Keystone demo)",
    attachments: pdfBase64 ? [{ filename: filename || "Lender-Submission-Package-SAMPLE.pdf", contentType: "application/pdf", base64: pdfBase64 }] : [],
    ...bodies([
      `Hi ${firstName(s.name)},`,
      "Nice work - you just took a file from the borrower's phone to lenders. Attached is the lender submission package Keystone built from what you did: the credit summary, the call note, every document with its fraud-check result, and the documents you accepted.",
      "Everything in it is sample data (the business, the bank and the lenders are fictional).",
      "Want to see it with your own team and lenders? Reply to this email and we will set up a call.",
    ]),
  };
}

export function digestLines(d: Digest): string[] {
  const done = DEMO_STEPS.filter(([k]) => d.steps_completed.includes(k)).map(([, l]) => l);
  const skipped = DEMO_STEPS.filter(([k]) => d.steps_skipped.includes(k)).map(([, l]) => l);
  const notReached = DEMO_STEPS.filter(([k]) => !d.steps_completed.includes(k) && !d.steps_skipped.includes(k)).map(([, l]) => l);
  const device = d.phone_device ? ({ iPhone: "an iPhone", iPad: "an iPad", Android: "an Android phone", mobile: "a phone", desktop: "a computer" } as Record<string, string>)[d.phone_device] ?? null : null;
  const phone = d.used_phone
    ? `Yes - opened the borrower link${device ? ` on ${device}` : ""}`
    : d.used_screen ? "No - played the borrower on the computer screen instead" : "No - did not play the borrower";
  const doctored = {
    rejected: "Caught it - rejected the doctored September statement the fraud check flagged.",
    accepted: "Accepted the doctored September statement even though the fraud check flagged it red.",
    not_reviewed: "Uploaded it but never decided on the flagged statement.",
    not_uploaded: "Never got as far as the doctored statement.",
  }[d.doctored];
  const call = { completed: "Answered and listened to the end (AI summary added to the file)", answered: "Answered but did not finish", declined: "Declined the call", rang: "The call rang but they did not answer", not_reached: "Did not reach the call" }[d.call];
  return [
    `Time spent: about ${minutes(d.active_seconds)} active (${minutes(d.elapsed_seconds)} from first to last action).`,
    `Used the phone: ${phone}.`,
    `Steps completed (${done.length}/${DEMO_STEPS.length}): ${done.join(", ") || "none"}.`,
    `Steps skipped: ${skipped.join(", ") || "none"}.${d.tour_skipped ? " They hid the guided tour." : ""}`,
    `Not reached: ${notReached.join(", ") || "none"}.`,
    `Documents uploaded: ${d.documents_uploaded.length}. Decisions: ${d.decisions.map((x) => `${x.document} - ${x.decision}`).join("; ") || "none"}.`,
    `Doctored statement: ${doctored}`,
    `Client call: ${call}.`,
    `Assistant questions asked as the borrower: ${d.assistant_questions}.`,
    `Lenders picked: ${d.lenders.join(", ") || "none"}.${d.package_downloaded ? " Downloaded the package in the portal." : ""}`,
    `Other clicks: ${d.clicks.join(", ") || "none"}.`,
  ];
}

export function salesCompletedMail(salesTo: string, s: SignupLike, d: Digest): Mail {
  return {
    to: [salesTo],
    subject: `Demo finished: ${s.name} (${s.company})`,
    ...bodies([
      `${s.name} from ${s.company} finished the Keystone demo and was emailed the sample lender package.`,
      [`Name: ${s.name}`, `Email: ${s.email}`, `Company: ${s.company}`, `Signed up: ${day(s.created_at)}`, `Opened: ${day(s.opened_at)}`, `Finished: ${day(s.completed_at)}`].join("\n"),
      digestLines(d).join("\n"),
      "Suggested next step: follow up within a day while it is fresh.",
    ]),
  };
}

export function salesUnfinishedMail(salesTo: string, s: SignupLike, d: Digest, reason: "idle" | "expired", idleHours: number): Mail {
  return {
    to: [salesTo],
    subject: `Demo not finished: ${s.name} (${s.company})`,
    ...bodies([
      `${s.name} from ${s.company} started the Keystone demo but did not finish it (${reason === "expired" ? "the demo has expired" : `no activity for ${idleHours} hours`}). They got as far as: ${label(d.last_step)}.`,
      [`Name: ${s.name}`, `Email: ${s.email}`, `Company: ${s.company}`, `Signed up: ${day(s.created_at)}`, `Opened: ${day(s.opened_at)}`, `Last activity: ${day(d.last_at)}`, `Demo expires: ${day(s.expires_at)}`].join("\n"),
      digestLines(d).join("\n"),
      reason === "idle" ? "Their demo link still works until it expires, so a nudge can bring them back to where they stopped." : "Their demo data has been wiped.",
    ]),
  };
}
