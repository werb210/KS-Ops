// npm run stripe:setup - creates the Stripe products and prices described by src/pricing.ts and records their ids in
// the stripe_prices table. Safe to run again: a price that already matches is reused (found by its lookup key
// "ks:<key>"); a price whose amount changed gets a new Stripe price and the lookup key moves to it.
// Needs STRIPE_SECRET_KEY and DATABASE_URL.
import { closePool, getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { realStripe } from "../src/billing/stripeClient.js";
import { CURRENCY, stripePriceSpecs } from "../src/pricing.js";

const stripe = realStripe();
if (!stripe) {
  console.error("STRIPE_SECRET_KEY is not set.");
  process.exit(1);
}
const pool = getPool();
await runMigrations(pool);
const currency = CURRENCY.toLowerCase();
const livemode = String(process.env.STRIPE_SECRET_KEY).startsWith("sk_live_");

const existing = new Map(
  (await pool.query("SELECT key, stripe_product_id, stripe_price_id, unit_amount, recurring_interval FROM stripe_prices")).rows.map(
    (r) => [r.key as string, r],
  ),
);
const products = new Map<string, string>();
const specs = stripePriceSpecs();
for (const spec of specs) {
  const row = existing.get(spec.key);
  if (row) products.set(spec.product_key, row.stripe_product_id);
}

let created = 0;
let reused = 0;
for (const spec of specs) {
  const row = existing.get(spec.key);
  if (row && row.unit_amount === spec.unit_amount && (row.recurring_interval ?? null) === spec.recurring) {
    reused += 1;
    continue;
  }
  const lookupKey = `ks:${spec.key}`;
  const found = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
  let priceId: string;
  let productId: string;
  if (
    found &&
    found.unit_amount === spec.unit_amount &&
    found.currency === currency &&
    (found.recurring?.interval ?? null) === spec.recurring
  ) {
    priceId = found.id;
    productId = typeof found.product === "string" ? found.product : found.product.id;
    reused += 1;
  } else {
    productId =
      products.get(spec.product_key) ??
      (found ? (typeof found.product === "string" ? found.product : found.product.id) : "") ??
      "";
    if (!productId) {
      productId = (await stripe.products.create({ name: spec.product_name, metadata: { ks_product_key: spec.product_key } })).id;
    }
    const price = await stripe.prices.create({
      product: productId,
      currency,
      unit_amount: spec.unit_amount,
      nickname: spec.nickname,
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      metadata: { ks_key: spec.key },
      ...(spec.recurring ? { recurring: { interval: spec.recurring } } : {}),
    });
    priceId = price.id;
    created += 1;
  }
  products.set(spec.product_key, productId);
  await pool.query(
    `INSERT INTO stripe_prices (key, stripe_product_id, stripe_price_id, unit_amount, currency, recurring_interval, livemode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) DO UPDATE SET stripe_product_id = EXCLUDED.stripe_product_id,
       stripe_price_id = EXCLUDED.stripe_price_id, unit_amount = EXCLUDED.unit_amount, currency = EXCLUDED.currency,
       recurring_interval = EXCLUDED.recurring_interval, livemode = EXCLUDED.livemode, updated_at = now()`,
    [spec.key, productId, priceId, spec.unit_amount, currency, spec.recurring, livemode],
  );
  console.log(`${spec.key}: ${priceId}`);
}
console.log(`Stripe prices ready: ${created} created, ${reused} already in place (${livemode ? "live" : "test"} mode).`);
await closePool();
