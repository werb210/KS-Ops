// KS_OPS_TWILIO_AUTO_v1 - Keystone's own Twilio settings on KS-Ops (set once by Todd, see docs/PROVISIONING.md).
import { env, salesEmail } from "../config.js";
import type { TwilioCreds } from "./http.js";

/** Keystone's master Twilio account: every licensee's sub-account is made under it. */
export function masterCreds(e: NodeJS.ProcessEnv = process.env): TwilioCreds | null {
  const accountSid = env("KS_TWILIO_ACCOUNT_SID", e);
  const authToken = env("KS_TWILIO_AUTH_TOKEN", e);
  return /^AC[0-9a-fA-F]{32}$/.test(accountSid) && authToken ? { accountSid, authToken } : null;
}

/** Keystone's approved ISV primary customer profile in Trust Hub (BU...), needed for US A2P 10DLC registrations. */
export function isvProfileSid(e: NodeJS.ProcessEnv = process.env): string {
  const v = env("KS_TWILIO_ISV_PROFILE_SID", e);
  return /^BU[0-9a-fA-F]{32}$/.test(v) ? v : "";
}

/** Where Twilio sends registration notices (and the email on Trust Hub profiles): Keystone's, never the licensee's. */
export function notificationEmail(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_TWILIO_NOTIFICATION_EMAIL", e) || salesEmail(e);
}

/** The name a licensee's sub-account gets: "Keystone - <company> (<code>)". Also how an existing one is found. */
export function subaccountName(l: { company_name: string; company_code: string }): string {
  return `Keystone - ${l.company_name}`.slice(0, 50) + ` (${l.company_code})`;
}

/** Days a cancelled licensee's sub-account stays active, so its numbers are released cleanly (KS-server waits 30). */
export const CANCELLED_ACTIVE_DAYS = 31;
/** Notice to sales before a sub-account is closed for good. */
export const CLOSE_NOTICE_DAYS = 7;
