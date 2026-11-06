// KS_OPS_ONBOARDING_v1 - the onboarding emails: each broker's invite with a quick guide, the owner's onboarding email
// introducing their onboarding contact (Microsoft Teams sessions scaled by support level), and the agreement link.
// Never a personal mobile number: only the support mailbox and, when set, Keystone's support line (KS_SUPPORT_PHONE).
import { salesEmail, supportEmail } from "../config.js";
import { bodies, type Mail } from "../lib/email.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { PLAN_NAMES, SUPPORT, type SupportLevel } from "../pricing.js";
import { AGREEMENT_TITLE } from "./agreement.js";
import { onboardingBookingUrl, onboardingContactName, onboardingFrom, supportPhone } from "./config.js";
import type { TeamMember } from "./team.js";

const trim = (u: string | null | undefined) => String(u ?? "").replace(/\/+$/, "");
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "+14035550123" as "(403) 555-0123". */
export function displayPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

function contactLines(e: NodeJS.ProcessEnv): string {
  const phone = supportPhone(e);
  return `Questions? Email ${supportEmail(e)}${phone ? ` or call the Keystone support line at ${phone}` : ""}.`;
}

/** The main features, for the quick guide. Marketing tools only for the Marketing role (and admins on the add-on). */
export function quickGuide(role: TeamMember["role"], marketingAddon: boolean): string[] {
  const lines = [
    "Pipeline and applications: every deal is a card on the pipeline. Open one to see the client, the application, notes, calls and messages in one place.",
    "Client documents: clients upload through their own app. Open the Documents tab on a deal to accept each document or reject it with a reason; the client is told what to send again.",
    "Lender submission: when a file is ready, pick the matching lenders and send the package by email or API from the deal, and track each lender's answer.",
    "Dialler and phone: call and text clients from the portal or the iPhone dialler app on your business line. Calls are logged on the client's record.",
    "Maya, the AI assistant: ask Maya to find a client, summarise a deal, draft an email or explain a feature. She is in the corner of every page.",
  ];
  if (role === "Marketing" || (role === "Admin" && marketingAddon)) {
    lines.splice(4, 0, "Marketing: email and text campaigns to your own client list, sequences, templates, website lead forms and ads results, under Marketing in the sidebar.");
  }
  return lines;
}

export function brokerInviteMail(l: LicenseeRow, m: TeamMember, e: NodeJS.ProcessEnv = process.env): Mail {
  const portal = trim(l.portal_url);
  const role = m.role === "Broker" ? "a broker" : m.role === "Marketing" ? "marketing" : "an admin";
  const guide = quickGuide(m.role, l.addons?.marketing === true);
  return {
    to: [m.email],
    subject: `${l.company_name} invited you to Keystone`,
    from: onboardingFrom(e),
    replyTo: supportEmail(e),
    ...bodies([
      `Hi ${firstName(m.full_name)},`,
      `${l.contact_name} has set up Keystone for ${l.company_name} and added you as ${role}.`,
      [
        `Sign in to your portal: ${portal}`,
        `Sign-in is by a one-time code texted to your mobile (${displayPhone(m.phone_e164)}). There is no password. You can also use your email address (${m.email}) to find your account.`,
        `On the iPhone dialler or iPad app, sign in with the same email or mobile. If the app asks, your company code is "${l.company_code}".`,
      ].join("\n"),
      "The first time you sign in, a short set-up wizard walks you through your profile, your email and calendar connection and your phone, so your portal space is ready to use.",
      "Quick guide to the main features:\n" + guide.map((g, i) => `${i + 1}. ${g}`).join("\n"),
      "The Help Center (Get help in the sidebar) has step-by-step articles for everything else.",
      contactLines(e),
      "The Keystone team",
    ]),
  };
}

/** Teams setup sessions with the onboarding contact, by support level. */
export function sessionOffer(level: SupportLevel, contact: string): string {
  switch (level) {
    case "priority":
      return `Your Priority support includes one 60-minute setup session with ${contact} on Microsoft Teams.`;
    case "premium":
      return `Your Premium support includes two 60-minute setup sessions with ${contact} on Microsoft Teams: one to set everything up, and a follow-up once your team has started.`;
    case "dedicated":
      return `Your Dedicated support includes a dedicated onboarding plan. ${contact} will contact you to plan your setup, data import and team training, all on Microsoft Teams.`;
    default:
      return `Your plan includes one 30-minute kickoff call with ${contact} on Microsoft Teams to get you started.`;
  }
}

export function ownerOnboardingMail(l: LicenseeRow, team: TeamMember[], e: NodeJS.ProcessEnv = process.env): Mail {
  const contact = onboardingContactName(e);
  const contactFirst = firstName(contact);
  const booking = onboardingBookingUrl(e);
  const others = team.filter((t) => !t.is_owner);
  const setUp = [
    `Your own Keystone copy for ${l.company_name}, on the ${PLAN_NAMES[l.plan]} plan with ${l.seats} seat(s) and ${SUPPORT[l.support_level].name} support.`,
    `Your staff portal: ${trim(l.portal_url)} (you are the admin).`,
    ...(l.client_url ? [`Your branded client app: ${trim(l.client_url)}`] : []),
    others.length
      ? `Your team: ${others.map((t) => `${t.full_name} (${t.role})`).join(", ")}. Each of them has been emailed an invite and a quick guide.`
      : "Your team: just you for now. Add people any time from Settings > Users.",
    "Your phone lines and texting registration are being set up; carriers can take a few business days to approve texting.",
  ];
  const book =
    l.support_level === "dedicated"
      ? `${contactFirst} will be in touch within one business day to plan it with you.`
      : booking
        ? `Book a time that suits you here: ${booking}`
        : `Reply to this email with a few times that suit you and ${contactFirst} will send a Teams invite.`;
  return {
    to: [l.contact_email],
    subject: `Welcome to Keystone, ${firstName(l.contact_name)}: meet your onboarding contact`,
    from: onboardingFrom(e),
    replyTo: supportEmail(e),
    ...bodies([
      `Hi ${firstName(l.contact_name)},`,
      `Welcome to Keystone. I'm writing to introduce ${contact}, who will be your onboarding contact. ${contactFirst} will help you set up Keystone the way your brokerage works: your lenders and products, your branding, your phone lines, importing your data and getting your team going.`,
      "What has been set up for you:\n" + setUp.map((s) => `- ${s}`).join("\n"),
      sessionOffer(l.support_level, contactFirst),
      book,
      "Before the session, it helps to have your lender list, a recent export from your current CRM (if you have one) and your logo handy.",
      contactLines(e),
      "Keystone Support",
    ]),
  };
}

/** The link to sign the agreement (after payment, and the one reminder 24 hours later). */
export function agreementLinkMail(l: LicenseeRow, link: string, reminder: boolean, e: NodeJS.ProcessEnv = process.env): Mail {
  return {
    to: [l.contact_email],
    subject: reminder ? `Reminder: please sign the ${AGREEMENT_TITLE} for ${l.company_name}` : `Please sign the ${AGREEMENT_TITLE} for ${l.company_name}`,
    replyTo: salesEmail(e),
    ...bodies([
      `Hi ${firstName(l.contact_name)},`,
      reminder
        ? `${l.company_name}'s Keystone system is being set up, but we can't invite your team until the ${AGREEMENT_TITLE} is signed.`
        : `One more step: please review and sign the ${AGREEMENT_TITLE} for ${l.company_name}. We invite your team as soon as it is signed.`,
      link ? `Review and sign here: ${link}` : `Reply to this email and we will send you the agreement to sign.`,
      `If you have questions about the agreement, reply to this email or write to ${salesEmail(e)}.`,
      "The Keystone team",
    ]),
  };
}
