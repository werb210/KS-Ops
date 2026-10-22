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
