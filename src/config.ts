// Environment helpers. Every value is read when needed (not at import time) so tests can change process.env.

export function env(name: string, e: NodeJS.ProcessEnv = process.env): string {
  return String(e[name] ?? "").trim();
}

/** Comma-separated list of origins, without trailing slashes. */
export function originList(name: string, e: NodeJS.ProcessEnv = process.env): string[] {
  return env(name, e)
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** The public website's address (first entry of PUBLIC_SITE_URL), used for Stripe success and cancel pages. */
export function publicSiteUrl(e: NodeJS.ProcessEnv = process.env): string {
  return originList("PUBLIC_SITE_URL", e)[0] ?? "";
}

export function salesEmail(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_SALES_EMAIL", e) || "keystone@boreal.financial";
}

export function supportEmail(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_SUPPORT_EMAIL", e) || salesEmail(e);
}

export function workersEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  const v = env("OPS_WORKERS", e).toLowerCase();
  if (v === "off" || v === "false" || v === "0") return false;
  return e.NODE_ENV !== "test";
}

export function isProduction(e: NodeJS.ProcessEnv = process.env): boolean {
  return env("NODE_ENV", e) === "production";
}

/** Comma-separated list, trimmed and lower-cased, empty entries dropped. */
export function lowerList(name: string, e: NodeJS.ProcessEnv = process.env): string[] {
  return env(name, e)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** OPS_ADMIN_EMAILS: the Boreal staff allowed into Keystone operations (compared case-insensitively). */
export function opsAdminEmails(e: NodeJS.ProcessEnv = process.env): string[] {
  return lowerList("OPS_ADMIN_EMAILS", e);
}

export const DEFAULT_SERVER_HOST_SUFFIXES = ".azurewebsites.net,.azurestaticapps.net";

/** OPS_ALLOWED_SERVER_HOST_SUFFIXES: where a licensee's server_url may point. ["*"] allows any host. */
export function allowedServerHostSuffixes(e: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env("OPS_ALLOWED_SERVER_HOST_SUFFIXES", e) || DEFAULT_SERVER_HOST_SUFFIXES;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** PENDING_SIGNUP_DAYS (default 7): website sign-ups still waiting for payment after this are cancelled. */
export function pendingSignupDays(e: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env("PENDING_SIGNUP_DAYS", e) || 7);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
}

/** SIGNUP_TURNSTILE_OPTIONAL=true lets production take sign-ups without TURNSTILE_SECRET. */
export function signupTurnstileOptional(e: NodeJS.ProcessEnv = process.env): boolean {
  return env("SIGNUP_TURNSTILE_OPTIONAL", e).toLowerCase() === "true";
}
