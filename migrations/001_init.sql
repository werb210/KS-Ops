-- KS-Ops v1 schema. Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS licensees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  legal_name text NOT NULL,
  company_code text NOT NULL,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_phone text NOT NULL,
  country text NOT NULL DEFAULT 'CA',
  province_state text,
  mailing_address text,
  website text,
  status text NOT NULL DEFAULT 'pending_payment',
  plan text NOT NULL DEFAULT 'starter',
  billing_interval text NOT NULL DEFAULT 'monthly',
  support_level text NOT NULL DEFAULT 'email',
  seats integer NOT NULL DEFAULT 1,
  extra_storage_blocks integer NOT NULL DEFAULT 0,
  server_url text,
  client_url text,
  portal_url text,
  logo_url text,
  primary_color text,
  assistant_name text,
  ops_key_hash text,
  ops_key_encrypted text,
  ops_key_rotated_at timestamptz,
  signup_token_hash text,
  source text NOT NULL DEFAULT 'staff',
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_checkout_session_id text,
  onboarding_fee_paid boolean NOT NULL DEFAULT false,
  plan_sync_status text NOT NULL DEFAULT 'synced',
  plan_sync_error text,
  plan_sync_attempts integer NOT NULL DEFAULT 0,
  plan_sync_next_at timestamptz,
  plan_synced_at timestamptz,
  past_due_since timestamptz,
  past_due_reminder_sent_at timestamptz,
  accepted_terms_at timestamptz,
  accepted_privacy_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licensees_company_code_format CHECK (company_code ~ '^[a-z0-9-]{3,32}$'),
  CONSTRAINT licensees_status_check CHECK (status IN
    ('pending_payment','provisioning','trial','active','past_due','suspended','cancelled')),
  CONSTRAINT licensees_plan_check CHECK (plan IN ('starter','growth','pro')),
  CONSTRAINT licensees_interval_check CHECK (billing_interval IN ('annual','monthly')),
  CONSTRAINT licensees_support_check CHECK (support_level IN ('email','priority','premium','dedicated')),
  CONSTRAINT licensees_seats_check CHECK (seats >= 1),
  CONSTRAINT licensees_blocks_check CHECK (extra_storage_blocks >= 0),
  CONSTRAINT licensees_sync_check CHECK (plan_sync_status IN ('synced','pending_sync'))
);
CREATE UNIQUE INDEX IF NOT EXISTS licensees_company_code_key ON licensees (company_code);
CREATE INDEX IF NOT EXISTS licensees_status_idx ON licensees (status);
CREATE INDEX IF NOT EXISTS licensees_stripe_customer_idx ON licensees (stripe_customer_id);
CREATE INDEX IF NOT EXISTS licensees_stripe_subscription_idx ON licensees (stripe_subscription_id);

-- One row per licensee and month; a newer report replaces an older one.
CREATE TABLE IF NOT EXISTS usage_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  period text NOT NULL,
  generated_at timestamptz NOT NULL,
  plan text,
  effective_plan text,
  seats integer NOT NULL DEFAULT 0,
  minutes integer NOT NULL DEFAULT 0,
  texts integer NOT NULL DEFAULT 0,
  assistant_chats integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  overage_minutes integer NOT NULL DEFAULT 0,
  overage_texts integer NOT NULL DEFAULT 0,
  extra_storage_blocks integer NOT NULL DEFAULT 0,
  trial jsonb,
  report jsonb NOT NULL,
  source text NOT NULL DEFAULT 'push',
  overage_billed_at timestamptz,
  overage_invoice_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_reports_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_reports_licensee_period_key ON usage_reports (licensee_id, period);

CREATE TABLE IF NOT EXISTS plan_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  from_plan text,
  to_plan text,
  from_extra_storage_blocks integer,
  to_extra_storage_blocks integer,
  changed_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending_sync',
  last_error text,
  pushed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_changes_status_check CHECK (status IN ('pushed','pending_sync'))
);
CREATE INDEX IF NOT EXISTS plan_changes_licensee_idx ON plan_changes (licensee_id, created_at DESC);

-- A copy of the licensee's Stripe invoices, kept up to date by the webhook.
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid REFERENCES licensees(id) ON DELETE SET NULL,
  stripe_invoice_id text NOT NULL,
  stripe_customer_id text,
  number text,
  status text,
  currency text,
  amount_due integer NOT NULL DEFAULT 0,
  amount_paid integer NOT NULL DEFAULT 0,
  period_start timestamptz,
  period_end timestamptz,
  due_date timestamptz,
  paid_at timestamptz,
  hosted_invoice_url text,
  invoice_pdf text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_invoice_key ON invoices (stripe_invoice_id);
CREATE INDEX IF NOT EXISTS invoices_licensee_idx ON invoices (licensee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid REFERENCES licensees(id) ON DELETE SET NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  source text NOT NULL DEFAULT 'licensee',
  requester_name text,
  requester_email text,
  assigned_to text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tickets_status_check CHECK (status IN ('open','waiting','resolved','closed')),
  CONSTRAINT tickets_priority_check CHECK (priority IN ('low','normal','high','urgent'))
);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS tickets_licensee_idx ON tickets (licensee_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type text NOT NULL,
  author_name text,
  author_email text,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_messages_author_check CHECK (author_type IN ('licensee','staff'))
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);

-- Upgrade and storage requests relayed by a licensee's server.
CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'upgrade',
  current_plan text,
  requested_plan text,
  requested_extra_storage_blocks integer,
  requested_by text,
  message text,
  payload jsonb,
  status text NOT NULL DEFAULT 'open',
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT requests_status_check CHECK (status IN ('open','done','declined'))
);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_licensee_idx ON notes (licensee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_audit (
  id bigserial PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  licensee_id uuid,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_audit_licensee_idx ON staff_audit (licensee_id, created_at DESC);

-- Stripe price ids, written by scripts/stripe-setup.ts. Keys come from src/pricing.ts (stripePriceSpecs).
CREATE TABLE IF NOT EXISTS stripe_prices (
  key text PRIMARY KEY,
  stripe_product_id text NOT NULL,
  stripe_price_id text NOT NULL,
  unit_amount integer NOT NULL,
  currency text NOT NULL,
  recurring_interval text,
  livemode boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Stripe webhook events already handled (Stripe can deliver an event more than once).
CREATE TABLE IF NOT EXISTS stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Daily jobs claim their run here so two instances (or a restart) do not run them twice in a day.
CREATE TABLE IF NOT EXISTS job_runs (
  job text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT 'epoch'
);
