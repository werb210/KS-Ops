-- KS-Ops v2 hardening. Idempotent: safe to run again.

-- The signup token encrypted with OPS_ENCRYPTION_KEY, so a "finish your payment" email can link back to the sign-up
-- without replacing the token the person's browser already holds.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS signup_token_encrypted text;
-- The company code a never-paid website sign-up gave up when it expired (its company_code is replaced so the code
-- can be chosen again).
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS released_company_code text;
CREATE INDEX IF NOT EXISTS licensees_pending_created_idx ON licensees (created_at) WHERE status = 'pending_payment';

-- Status changes are pushed to the licensee's server with the plan (PUT /api/plan { plan, extra_storage_blocks, status }).
ALTER TABLE plan_changes ADD COLUMN IF NOT EXISTS from_status text;
ALTER TABLE plan_changes ADD COLUMN IF NOT EXISTS to_status text;

-- Overage billing progress per licensee and month. Stripe's idempotency keys only last 24 hours, so each step's
-- result is kept here and a rerun (days later, after a crash) picks up where it stopped instead of charging again.
CREATE TABLE IF NOT EXISTS overage_billing (
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  period text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  stripe_customer_id text,
  minutes integer NOT NULL DEFAULT 0,
  texts integer NOT NULL DEFAULT 0,
  minutes_amount integer NOT NULL DEFAULT 0,
  texts_amount integer NOT NULL DEFAULT 0,
  minutes_invoice_item_id text,
  texts_invoice_item_id text,
  invoice_id text,
  details jsonb,
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licensee_id, period),
  CONSTRAINT overage_billing_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT overage_billing_status_check CHECK (status IN ('started','items_created','invoiced','nothing_to_bill'))
);

-- Cancellation and data retention (Todd, Oct 22): a cancelled licensee may download its data for 180 days, then
-- KS-server deletes and purges it. cancelled_at is set whenever a licensee becomes cancelled (and cleared if it is
-- restored); purged_at is set when the server reports the purge or staff mark it after the purge date.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS purged_at timestamptz;
UPDATE licensees SET cancelled_at = updated_at WHERE status = 'cancelled' AND cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION licensees_cancelled_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'cancelled' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'cancelled' OR NEW.cancelled_at IS NULL THEN
      NEW.cancelled_at := COALESCE(CASE WHEN TG_OP = 'UPDATE' AND OLD.status = 'cancelled' THEN OLD.cancelled_at END, now());
    END IF;
  ELSE
    NEW.cancelled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS licensees_cancelled_at_trg ON licensees;
CREATE TRIGGER licensees_cancelled_at_trg BEFORE INSERT OR UPDATE OF status ON licensees
  FOR EACH ROW EXECUTE FUNCTION licensees_cancelled_at();
