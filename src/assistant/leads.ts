// KS_OPS_KB_v1 - leads from the website assistant (Keystone Maya for prospects).
//
// The widget's lead form sends name, email, brokerage, team size, phone (optional), the consent box and what they want
// (just information, a live demo, or a person). The lead is stored (assistant_leads) and pushed to the Keystone CRM on
// BF-Server's KS silo the same way demo and beta sign-ups are (crm_outbox -> POST /api/ks/crm/upsert, source
// "website_signup", external_id = the lead's id): stage "lead" (none when the email is already a licensee's contact,
// so a customer is never moved back), a signup event and a note with the conversation.
//
// A live demo or a person is a hand-off: Keystone sales get an email with the details and the conversation, and the
// CRM push carries a follow-up task (task: { title, due_at, priority, notes }) - due within one business day - plus
// the same follow-up written into the note, so the request is visible even where the CRM does not create tasks yet.
import { z } from "zod";
import { salesEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { enqueueCrm } from "../crm/outbox.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { normalizeNaPhone, prettyNaPhone } from "../lib/sms.js";
import { transcriptText, turnSchema, type Turn } from "./turns.js";
import { SALES_ASSISTANT_NAME } from "./sales.js";

export const TEAM_SIZES = ["1", "2-5", "6-15", "16-50", "51+"] as const;
export const CONSENT_TEXT =
  "I agree that Keystone may contact me by email (and phone, if I gave one) about Keystone. I can unsubscribe at any time.";

const text = (max: number, msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : v), z.string().min(1, msg).max(max, `At most ${max} characters`));

export const leadSchema = z.object({
  name: text(120, "Enter your name"),
  email: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.string().max(200).email("Enter a valid email address")),
  brokerage: text(160, "Enter your brokerage's name"),
  team_size: z.enum(TEAM_SIZES, { error: "Choose your team size" }),
  phone: z.string().max(40).optional(),
  consent: z.literal(true, { error: "Tick the box so we can contact you" }),
  wants: z.enum(["info", "live_demo", "person"]).default("info"),
  message: z.string().trim().max(2000).optional(),
  transcript: z.array(turnSchema).max(40).optional().default([]),
  website_url: z.any().optional(),
});
export type LeadInput = z.infer<typeof leadSchema>;

export const WANTS_LABEL: Record<LeadInput["wants"], string> = {
  info: "More information",
  live_demo: "A live demo with the team",
  person: "To talk to a person",
};

/** The next business day at 17:00 UTC (late morning in Canada), skipping weekends. */
export function followUpDue(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 17, 0, 0));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function leadNote(l: LeadInput, phone: string | null, transcript: Turn[]): string {
  const lines = [
    `${l.name} from ${l.brokerage} (team of ${l.team_size}) talked to ${SALES_ASSISTANT_NAME} on the Keystone website.`,
    `Wants: ${WANTS_LABEL[l.wants]}.`,
    `Email: ${l.email}${phone ? `. Phone: ${prettyNaPhone(phone)}` : ""}.`,
    `Consent to be contacted: yes ("${CONSENT_TEXT}").`,
  ];
  if (l.message) lines.push(`Their note: ${l.message}`);
  if (l.wants !== "info") lines.push(`Follow-up: contact them within one business day (${WANTS_LABEL[l.wants].toLowerCase()}).`);
  if (transcript.length) lines.push("", "Conversation:", transcriptText(transcript.slice(-12), { user: l.name, assistant: SALES_ASSISTANT_NAME }));
  return lines.join("\n");
}

export type LeadResult = { id: string; handed_off: boolean; message: string };

export async function captureLead(deps: Pick<Deps, "db" | "now" | "mailer">, l: LeadInput): Promise<{ ok: true; result: LeadResult } | { ok: false; errors: Record<string, string> }> {
  const rawPhone = (l.phone ?? "").trim();
  const phone = rawPhone ? normalizeNaPhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, errors: { phone: "Enter a Canadian or US number, like (403) 555-0199, or leave it empty" } };
  const now = deps.now();
  const transcript = (l.transcript ?? []).slice(-40);
  const handoff = l.wants !== "info";
  const ins = await deps.db.query(
    `INSERT INTO assistant_leads (name, email, brokerage, team_size, phone, consent, consent_text, wants, message, transcript, handed_off_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9::jsonb, $10) RETURNING id, created_at`,
    [l.name, l.email, l.brokerage, l.team_size, phone, CONSENT_TEXT, l.wants, l.message ?? null, JSON.stringify(transcript), handoff ? now : null],
  );
  const id = String(ins.rows[0].id);

  let existing = false;
  try {
    const r = await deps.db.query("SELECT 1 FROM licensees WHERE lower(contact_email) = lower($1) LIMIT 1", [l.email]);
    existing = r.rows.length > 0;
  } catch (err) {
    console.warn(`[assistant] lead licensee check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const note = leadNote(l, phone, transcript);
  const due = followUpDue(now);
  await enqueueCrm(deps, {
    source: "website_signup",
    external_id: id,
    ...(existing ? {} : { stage: "lead" as const }),
    contact: { name: l.name, email: l.email, phone, title: null },
    company: { name: l.brokerage },
    events: [{ type: "signup", at: now.toISOString(), summary: `Talked to ${SALES_ASSISTANT_NAME} on the Keystone website (${WANTS_LABEL[l.wants].toLowerCase()}).` }],
    note,
    ...(handoff
      ? {
          task: {
            title: l.wants === "live_demo" ? `Book a live demo with ${l.name} (${l.brokerage})` : `Contact ${l.name} (${l.brokerage}) from the website assistant`,
            due_at: due.toISOString(),
            priority: "high" as const,
            notes: note.slice(0, 2000),
          },
        }
      : {}),
  });

  if (handoff) {
    const subject = `${l.wants === "live_demo" ? "Live demo request" : "Talk to a person"}: ${l.name}, ${l.brokerage}`;
    await sendQuietly(
      deps.mailer,
      {
        to: [salesEmail()],
        subject,
        ...bodies([
          `${l.name} from ${l.brokerage} asked the website assistant for ${WANTS_LABEL[l.wants].toLowerCase()}.`,
          `Email: ${l.email}\nPhone: ${phone ? prettyNaPhone(phone) : "not given"}\nTeam size: ${l.team_size}`,
          ...(l.message ? [`Their note: ${l.message}`] : []),
          `Please reply within one business day (by ${due.toISOString().slice(0, 10)}). A follow-up task is on the contact in the Keystone CRM.`,
          ...(transcript.length ? [`Conversation:\n${transcriptText(transcript.slice(-12), { user: l.name, assistant: SALES_ASSISTANT_NAME })}`] : []),
        ]),
      },
      "assistant hand-off",
    );
  }
  return {
    ok: true,
    result: {
      id,
      handed_off: handoff,
      message: handoff
        ? `Thanks, ${l.name.split(/\s+/)[0]}. We've passed this to the Keystone team and someone will contact you within one business day.`
        : `Thanks, ${l.name.split(/\s+/)[0]}. We'll send you more information by email.`,
    },
  };
}
