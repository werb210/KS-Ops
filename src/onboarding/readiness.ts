// KS_OPS_SIGNUP_READINESS_v1 - what still has to be set before a brokerage can sign up on the website, pay and get
// its emails, with no one stepping in. Shown on /ops/provisioning beside the provisioning checks; names settings only,
// never their values.
import { env, isProduction, signupTurnstileOptional } from "../config.js";
import { graphConfigured, sendgridConfigured } from "../lib/email.js";
import { stripePriceSpecs } from "../pricing.js";
import type { SetupItem } from "../provisioning/config.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export async function signupSetupMissing(db: Q, e: NodeJS.ProcessEnv = process.env): Promise<SetupItem[]> {
  const out: SetupItem[] = [];
  const has = (k: string) => env(k, e) !== "";
  if (!has("TURNSTILE_SECRET") && isProduction(e) && !signupTurnstileOptional(e)) {
    out.push({ key: "TURNSTILE_SECRET", label: "KS-Ops app setting TURNSTILE_SECRET (Cloudflare Turnstile secret), and VITE_TURNSTILE_SITE_KEY on KS-Website: without it the website refuses every sign-up" });
  }
  if (!has("STRIPE_SECRET_KEY")) {
    out.push({ key: "STRIPE_SECRET_KEY", label: "KS-Ops app setting STRIPE_SECRET_KEY: without it sign-ups cannot pay by card and sales is emailed to send a payment link" });
  } else {
    try {
      const keys = stripePriceSpecs().map((p) => p.key);
      const r = await db.query("SELECT key FROM stripe_prices WHERE key = ANY($1::text[])", [keys]);
      const found = new Set(r.rows.map((x) => String(x.key)));
      const missing = keys.filter((k) => !found.has(k));
      if (missing.length) out.push({ key: "stripe_prices", label: `Stripe prices: ${missing.length} of ${keys.length} missing. Run scripts/stripe-setup.ts once against the live Stripe account` });
    } catch (err) {
      console.error("[readiness] could not read stripe_prices", err instanceof Error ? err.message : String(err));
      out.push({ key: "stripe_prices", label: "Stripe prices could not be checked (the stripe_prices table did not answer). Run scripts/stripe-setup.ts" });
    }
  }
  if (!has("STRIPE_WEBHOOK_SECRET")) {
    out.push({ key: "STRIPE_WEBHOOK_SECRET", label: "KS-Ops app setting STRIPE_WEBHOOK_SECRET, with a Stripe webhook pointed at <KS-Ops>/api/ops/stripe/webhook: without it a paid sign-up is never marked paid, so set-up never starts" });
  }
  if (!graphConfigured() && !sendgridConfigured()) {
    out.push({ key: "email", label: "Email sending: MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET and MS_GRAPH_SEND_AS (or SENDGRID_API_KEY and SENDGRID_FROM): without it the welcome, agreement and sign-in emails are not sent" });
  }
  if (!has("KS_SALES_EMAIL")) {
    out.push({ key: "KS_SALES_EMAIL", label: "KS-Ops app setting KS_SALES_EMAIL (optional): sign-up notices go to sales@keystonecrm.online until it is set" });
  }
  return out;
}
