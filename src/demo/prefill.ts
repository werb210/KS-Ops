// KS_OPS_v13_PREFILL - hands a prospect's demo details to the website's sign-up and contact forms.
//
// The key is an HMAC of the demo id (OPS_JWT_SECRET), so any email can carry it at any time without storing another
// secret. Links put the id and key in the URL #fragment ({site}/signup#demo=<id>&k=<key>), which browsers never send to
// a server, and the website swaps them for the details with POST /api/public/demo/prefill.
import { createHmac } from "node:crypto";
import { env, publicSiteUrl } from "../config.js";
import { safeEqual } from "../lib/crypto.js";

function secret(): string {
  return env("OPS_JWT_SECRET");
}

/** The prefill key for a demo, or "" when OPS_JWT_SECRET is not set. */
export function prefillKey(demoId: string): string {
  const s = secret();
  if (!s) return "";
  return createHmac("sha256", s).update(`ks-signup-prefill:${demoId}`).digest("base64url").slice(0, 32);
}

export function prefillKeyMatches(demoId: string, given: unknown): boolean {
  const expected = prefillKey(demoId);
  return Boolean(expected) && typeof given === "string" && safeEqual(given, expected);
}

/** The website page with the demo's prefill key in the fragment; "" when the site address or the secret is missing. */
export function prefillLink(demoId: string, page: "signup" | "contact" = "signup"): string {
  const site = publicSiteUrl();
  const key = prefillKey(demoId);
  if (!site || !key) return "";
  return `${site}/${page}#demo=${encodeURIComponent(demoId)}&k=${encodeURIComponent(key)}`;
}

export const signupLinkFor = (demoId: string) => prefillLink(demoId, "signup");
