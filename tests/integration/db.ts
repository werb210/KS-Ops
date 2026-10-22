import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

export const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ks_ops_test";

export async function freshPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  await runMigrations(pool);
  await pool.query(
    `TRUNCATE licensees, usage_reports, plan_changes, invoices, tickets, ticket_messages, requests, notes, staff_audit,
              stripe_prices, stripe_events, job_runs, overage_billing CASCADE`,
  );
  return pool;
}

/** Fills stripe_prices the way scripts/stripe-setup.ts would. */
export async function seedPrices(pool: pg.Pool): Promise<void> {
  const { stripePriceSpecs } = await import("../../src/pricing.js");
  for (const s of stripePriceSpecs()) {
    await pool.query(
      `INSERT INTO stripe_prices (key, stripe_product_id, stripe_price_id, unit_amount, currency, recurring_interval)
       VALUES ($1, $2, $3, $4, 'cad', $5) ON CONFLICT (key) DO NOTHING`,
      [s.key, `prod_${s.product_key}`, `price_${s.key}`, s.unit_amount, s.recurring],
    );
  }
}
