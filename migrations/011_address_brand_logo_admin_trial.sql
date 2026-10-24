-- KS-Ops v11 (Todd, Oct 24): the mailing address in separate fields, more than one brand colour, an uploaded logo, and
-- the staff-only 14-day free trial. Idempotent: safe to run again.

-- Mailing address in parts. mailing_address stays and is still written (one line made from the parts), so anything
-- that reads it keeps working; rows from before this migration keep only mailing_address.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS postal_code text;

-- Brand colours besides primary_color: accent (secondary) and an optional background / surface colour.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS accent_color text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS background_color text;

-- The logo uploaded on sign-up. Kept apart from licensees so SELECT * never carries the image. The public address
-- (GET /api/public/logos/<key>) is written to licensees.logo_url, so the logo flows wherever logo_url already does.
CREATE TABLE IF NOT EXISTS licensee_logos (
  licensee_id uuid PRIMARY KEY REFERENCES licensees(id) ON DELETE CASCADE,
  logo_key text NOT NULL,
  content_type text NOT NULL,
  data bytea NOT NULL,
  filename text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licensee_logos_type_check CHECK (content_type IN ('image/png', 'image/jpeg', 'image/svg+xml')),
  CONSTRAINT licensee_logos_size_check CHECK (octet_length(data) BETWEEN 1 AND 524288)
);
CREATE UNIQUE INDEX IF NOT EXISTS licensee_logos_key_idx ON licensee_logos (logo_key);

-- The staff-only free trial (no payment up front). Days 1-14 free with every Pro feature; days 15-28 billed at the
-- Starter price, still with Pro features; then Starter unless they chose a plan. Who started it is kept here and in
-- staff_audit.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_started_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_started_by text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_billing_starts_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_pro_until timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_ended_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS admin_trial_end_reason text;
CREATE INDEX IF NOT EXISTS licensees_admin_trial_due_idx ON licensees (admin_trial_pro_until)
  WHERE admin_trial_started_at IS NOT NULL AND admin_trial_ended_at IS NULL;
