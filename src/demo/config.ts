// The self-serve sales demo (KS-Ops side). KS-Ops owns the sign-up, the magic link, creating the prospect's session
// on the shared demo server, their progress, and the two demo emails (lender package to the prospect, notes to sales).
//
//   KS_DEMO_SERVER_URL   the demo KS-server (DEMO_MODE=true), e.g. https://ks-demo-server.azurewebsites.net
//   KS_DEMO_OPS_KEY      shared secret with that server: its KS_OPS_KEY. Sent and checked as X-KS-Ops-Key.
//   KS_DEMO_PORTAL_URL   the portal web app that serves /demo (the magic link opens {portal}/demo#d=..&t=..)
//   DEMO_SESSION_DAYS    session lifetime before it is wiped (default 7)
//   DEMO_IDLE_HOURS      "started but didn't finish" email after this long without activity (default 24)
//   DEMO_MAX_ACTIVE      demos open at once across everyone (default 100)
//   DEMO_PER_EMAIL       demos per email address in 30 days (default 3)
//   DEMO_PER_IP_DAY      demo sign-ups per IP address in 24 hours (default 5)
import { env, originList } from "../config.js";

const int = (name: string, dflt: number, min: number, max: number) => {
  const n = Number(env(name) || dflt);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : dflt;
};

export const demoServerUrl = () => env("KS_DEMO_SERVER_URL").replace(/\/+$/, "");
export const demoOpsKey = () => env("KS_DEMO_OPS_KEY");
export const demoPortalUrl = () => originList("KS_DEMO_PORTAL_URL")[0] ?? "";
export const demoSessionDays = () => int("DEMO_SESSION_DAYS", 7, 1, 30);
export const demoIdleHours = () => int("DEMO_IDLE_HOURS", 24, 1, 24 * 14);
export const demoMaxActive = () => int("DEMO_MAX_ACTIVE", 100, 1, 100_000);
export const demoPerEmail = () => int("DEMO_PER_EMAIL", 3, 1, 100);
export const demoPerIpDay = () => int("DEMO_PER_IP_DAY", 5, 1, 1000);

/** The demo works only with the demo server, its key and the portal address. */
export function demoConfigured(): boolean {
  return Boolean(demoServerUrl() && demoOpsKey().length >= 16 && demoPortalUrl());
}

/** The walkthrough's steps (the demo server's src/demo/fixture.ts DEMO_STEPS, same order), for the sales emails. */
export const DEMO_STEPS: Array<[string, string]> = [
  ["welcome", "Welcome"],
  ["borrower", "Be the borrower (phone)"],
  ["application", "Application arrives live"],
  ["documents", "Review documents and the fraud check"],
  ["call", "Take the borrower's call"],
  ["financials", "Review the financials"],
  ["credit_summary", "Build the credit summary"],
  ["lenders", "Pick lenders from the match list"],
  ["submit", "Submit to lenders"],
];
