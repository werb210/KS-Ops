// The demo's emails: the magic link, the prospect's lender package, and the two notes to sales (finished / started
// but did not finish). Plain words; every value a prospect typed is escaped by bodies().
import { bodies, type Mail } from "../lib/email.js";
import { DEMO_STEPS } from "./config.js";
import { minutes, type Digest } from "./digest.js";

export type SignupLike = { id: string; name: string; email: string; company: string; created_at: Date | string; expires_at: Date | string; opened_at?: Date | string | null; completed_at?: Date | string | null };

const label = (step: string | null) => DEMO_STEPS.find(([k]) => k === step)?.[1] ?? (step ?? "not started");
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function magicLinkUrl(portalUrl: string, id: string, token: string): string {
  return `${portalUrl.replace(/\/+$/, "")}/demo#d=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
}

export function magicLinkMail(s: SignupLike, url: string, days: number): Mail {
  return {
    to: [s.email],
    subject: "Your Keystone demo is ready",
    ...bodies([
      `Hi ${firstName(s.name)},`,
      `Here is your private Keystone demo for ${s.company}. Open it on a computer or tablet, keep your phone handy, and you will play both sides of a real file: the borrower uploading documents from their phone, and the broker reviewing it, catching a doctored bank statement, taking the client's call and sending the file to lenders.`,
      `Open your demo: ${url}`,
      `The link is just for you - it works for ${days} days, and you can come back to it any time to pick up where you left off. Everything in the demo is sample data.`,
      "If you did not ask for this, you can ignore this email.",
    ]),
  };
}

export function prospectPackageMail(s: SignupLike, pdfBase64: string, filename: string): Mail {
  return {
    to: [s.email],
    subject: "Your sample lender submission package (Keystone demo)",
    attachments: [{ filename: filename || "Lender-Submission-Package-SAMPLE.pdf", contentType: "application/pdf", base64: pdfBase64 }],
    ...bodies([
      `Hi ${firstName(s.name)},`,
      "Nice work - you just took a file from the borrower's phone to lenders. Attached is the lender submission package Keystone built from what you did: the credit summary, the call note, every document with its fraud-check result, and the documents you accepted.",
      "Everything in it is sample data (the business, the bank and the lenders are fictional).",
      "Want to see it with your own team and lenders? Reply to this email and we will set up a call.",
    ]),
  };
}

function digestLines(d: Digest): string[] {
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
