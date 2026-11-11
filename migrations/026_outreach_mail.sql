-- KS_OPS_OUTREACH_v2: the owner letter (physical mail). One letter template for the brokerage, kept with the outreach
-- settings; each mail batch keeps the letters it produced on its channel item. Idempotent: safe to run again.
ALTER TABLE ks_outreach_settings ADD COLUMN IF NOT EXISTS letter jsonb NOT NULL DEFAULT '{}'::jsonb;
