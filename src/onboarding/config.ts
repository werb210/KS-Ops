// KS_OPS_ONBOARDING_v1 - settings for the onboarding emails. Read when needed so tests can change process.env.
import { env, publicSiteUrl, supportEmail } from "../config.js";

/** KS_ONBOARDING_BOOKING_URL: where the brokerage owner books their Microsoft Teams setup session. Unset: reply to book. */
export function onboardingBookingUrl(e: NodeJS.ProcessEnv = process.env): string {
  const v = env("KS_ONBOARDING_BOOKING_URL", e);
  return /^https:\/\/[^\s]+$/i.test(v) ? v : "";
}

/** KS_ONBOARDING_CONTACT_NAME (default Todd Werboweski): the person introduced as the brokerage's onboarding contact. */
export function onboardingContactName(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_ONBOARDING_CONTACT_NAME", e) || "Todd Werboweski";
}

/** KS_SUPPORT_PHONE: Keystone's support line, when there is one. Never a person's own mobile. */
export function supportPhone(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_SUPPORT_PHONE", e);
}

/** The From address of onboarding emails: the support mailbox (KS_SUPPORT_EMAIL, default support@keystonecrm.online). */
export function onboardingFrom(e: NodeJS.ProcessEnv = process.env): { email: string; name: string } {
  return { email: supportEmail(e), name: "Keystone Support" };
}

/** A link to a sign-up page on the website (?l=<licensee>&t=<signup token>), or "" when PUBLIC_SITE_URL is not set. */
export function signupLink(path: "agreement" | "team", licenseeId: string, token: string | null, e: NodeJS.ProcessEnv = process.env): string {
  const site = publicSiteUrl(e);
  if (!site || !token) return "";
  return `${site}/signup/${path}?l=${encodeURIComponent(licenseeId)}&t=${encodeURIComponent(token)}`;
}
