import { createApp } from "./app.js";
import { workersEnabled } from "./config.js";
import { getPool } from "./db.js";
import type { Deps } from "./deps.js";
import { realStripe } from "./billing/stripeClient.js";
import { jwtSecret } from "./auth/staff.js";
import { encryptionKey } from "./lib/crypto.js";
import { createMailer, graphConfigured, sendgridConfigured } from "./lib/email.js";
import { runMigrations } from "./migrate.js";
import { startWorkers } from "./workers.js";

async function main() {
  const pool = getPool();
  await runMigrations(pool);

  const deps: Deps = { db: pool, fetch, mailer: createMailer(fetch), stripe: realStripe, now: () => new Date() };

  if (!jwtSecret()) console.warn("[startup] OPS_JWT_SECRET missing or shorter than 32 characters: staff sign-in is off.");
  if (!encryptionKey()) console.warn("[startup] OPS_ENCRYPTION_KEY missing or not 32 bytes: ops keys cannot be made or used.");
  if (!realStripe()) console.warn("[startup] STRIPE_SECRET_KEY not set: billing endpoints answer 503.");
  if (!graphConfigured() && !sendgridConfigured()) console.warn("[startup] no email provider configured: emails are logged only.");

  const port = Number(process.env.PORT ?? 8080);
  createApp(deps).listen(port, () => console.log(`[startup] KS-Ops listening on ${port}`));
  if (workersEnabled()) startWorkers(deps);
}

main().catch((err) => {
  console.error("[startup] failed", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
