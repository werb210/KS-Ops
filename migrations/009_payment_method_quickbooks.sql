-- KS-Ops v9: how a licensee pays (Canadian pre-authorized bank debit by default, or card), and Keystone's own
-- QuickBooks Online connection with the outbox that posts Stripe invoices, payments, refunds and fees to it.
-- Idempotent: safe to run again.

ALTER TABLE licensees ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'acss_debit';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'licensees_payment_method_check') THEN
    ALTER TABLE licensees ADD CONSTRAINT licensees_payment_method_check CHECK (payment_method IN ('acss_debit', 'card'));
  END IF;
END $$;

-- One row (id = 1): Keystone's QuickBooks company. Tokens are AES-256-GCM encrypted with KS_QBO_TOKEN_ENCRYPTION_KEY.
-- version is bumped on every token change so two instances refreshing at once do not overwrite each other.
CREATE TABLE IF NOT EXISTS qbo_connection (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  realm_id text NOT NULL,
  environment text NOT NULL,
  company_name text,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  connected_by text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row (id = 1): which QuickBooks ids to use. All optional; see docs/QUICKBOOKS.md.
CREATE TABLE IF NOT EXISTS qbo_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tax_code_id text,
  exempt_tax_code_id text,
  income_account_id text,
  deposit_account_id text,
  fee_account_id text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use OAuth states (only the hash is kept).
CREATE TABLE IF NOT EXISTS qbo_oauth_states (
  state_hash text PRIMARY KEY,
  created_by text,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- QuickBooks ids KS-Ops has found or made, per QuickBooks company: customers (by licensee), items (by name) and
-- payment intent -> Stripe invoice links used to place refunds.
CREATE TABLE IF NOT EXISTS qbo_links (
  realm_id text NOT NULL,
  kind text NOT NULL,
  key text NOT NULL,
  qbo_id text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (realm_id, kind, key)
);

-- One row per Stripe object to post. kind + stripe_id is the idempotency key: invoice (Stripe invoice id), payment
-- (Stripe invoice id, one QuickBooks Payment per paid invoice), refund (Stripe refund id), fee (Stripe invoice id).
CREATE TABLE IF NOT EXISTS qbo_outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invoice', 'payment', 'refund', 'fee')),
  stripe_id text NOT NULL,
  licensee_id uuid REFERENCES licensees(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  qbo_id text,
  qbo_realm_id text,
  note text,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, stripe_id)
);
CREATE INDEX IF NOT EXISTS qbo_outbox_due_idx ON qbo_outbox (next_attempt_at) WHERE status = 'pending';
