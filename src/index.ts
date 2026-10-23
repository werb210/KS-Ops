import { createApp } from "./app.js";
import { isProduction, opsAdminEmails, signupTurnstileOptional, workersEnabled } from "./config.js";
import { getPool } from "./db.js";
import type { Deps } from "./deps.js";
import { realStripe } from "./billing/stripeClient.js";
import { jwtSecret } from "./auth/staff.js";
import { encryptionKey } from "./lib/crypto.js";
import { turnstileEnabled } from "./lib/turnstile.js";
import { createMailer, graphConfigured, sendgridConfigured } from "./lib/email.js";
import { runMigrations } from "./migrate.js";
import { startWorkers } from "./workers.js";
import { demoConfigured } from "./demo/config.js";
import { smsConfigured } from "./lib/sms.js";
import { bfCrmConfigured } from "./lib/bfCrm.js";

async function main() {
  const pool = getPool();
  await runMigrations(pool);

  const deps: Deps = { db: pool, fetch, mailer: createMailer(fetch), stripe: realStripe, now: () => new Date() };

  if (!jwtSecret()) console.warn("[startup] OPS_JWT_SECRET missing or shorter than 32 characters: staff sign-in is off.");
  if (!encryptionKey()) console.warn("[startup] OPS_ENCRYPTION_KEY missing or not 32 bytes: ops keys cannot be made or used.");
  if (!realStripe()) console.warn("[startup] STRIPE_SECRET_KEY not set: billing endpoints answer 503.");
  if (!opsAdminEmails().length) console.warn("[startup] OPS_ADMIN_EMAILS not set: every BF-Server Admin can open Keystone operations.");
  if (isProduction() && !turnstileEnabled() && !signupTurnstileOptional()) {
    console.warn("[startup] TURNSTILE_SECRET not set: website sign-ups answer 503 (set SIGNUP_TURNSTILE_OPTIONAL=true to allow).");
  }
  if (!graphConfigured() && !sendgridConfigured()) console.warn("[startup] no email provider configured: emails are logged only.");
  if (!smsConfigured()) console.warn("[startup] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / KS_SMS_FROM not set: demo links are emailed only, not texted.");
  if (!bfCrmConfigured()) console.warn("[startup] BF_CRM_KEY not set: demo sign-ups, sign-ups and licensees are not pushed to the Keystone CRM on BF-Server.");
  if (!demoConfigured()) console.warn("[startup] KS_DEMO_SERVER_URL / KS_DEMO_OPS_KEY (16+ chars) / KS_DEMO_PORTAL_URL not all set: the self-serve demo answers 503.");

  const port = Number(process.env.PORT ?? 8080);
  createApp(deps).listen(port, () => console.log(`[startup] KS-Ops listening on ${port}`));
  if (workersEnabled()) startWorkers(deps);
}

main().catch((err) => {
  console.error("[startup] failed", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
