// Everything a route or worker needs from the outside world, so tests can replace any part.
import type { Q } from "./db.js";
import type { Mailer } from "./lib/email.js";
import type { StripeLike } from "./billing/stripeClient.js";
import type { ScanDeps } from "./lib/brandScan.js";

export type Deps = {
  db: Q;
  fetch: typeof fetch;
  mailer: Mailer;
  /** The Stripe client, or null when STRIPE_SECRET_KEY is not set. */
  stripe: () => StripeLike | null;
  now: () => Date;
  /** KS_OPS_v14_BRAND_SCAN - DNS and HTTP for POST /api/public/brand-scan (tests replace them; unset = the real ones). */
  brandScan?: ScanDeps;
};
