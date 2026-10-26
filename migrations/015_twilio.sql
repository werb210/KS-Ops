-- KS-Ops v18 (Todd, Oct 26): Twilio for every licensee, set up automatically (KS_OPS_TWILIO_AUTO_v1). Each licensee
-- gets its own Twilio sub-account under Keystone's master account; its address, regulatory bundle and texting
-- registrations are made through the Twilio APIs and their status is kept here. Idempotent: safe to run again.

-- What texting registration needs from the business, asked at sign-up: the business (registration) number (CRA
-- business number or US EIN), the kind of business, and the job title of the contact who signs for it.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS business_number text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS contact_title text;

-- One Twilio sub-account per licensee. The auth token and the API key secret are encrypted with OPS_ENCRYPTION_KEY
-- (AES-256-GCM, like the ops key). A row is never deleted with its licensee (RESTRICT): the sub-account must be
-- closed through KS-Ops first, so no Twilio account is ever lost track of.
CREATE TABLE IF NOT EXISTS licensee_twilio (
  licensee_id uuid PRIMARY KEY REFERENCES licensees(id) ON DELETE RESTRICT,
  subaccount_sid text NOT NULL,
  auth_token_encrypted text NOT NULL,
  friendly_name text NOT NULL,
  api_key_sid text,
  api_key_secret_encrypted text,
  twiml_app_sid text,
  twiml_app_voice_url text,
  verify_service_sid text,
  address_sid text,
  -- Regulatory bundle for buying numbers, when Twilio's rules ask for one (none for Canada and the US today).
  bundle_required boolean,
  bundle_sid text,
  bundle_status text,
  bundle_end_user_sid text,
  bundle_document_sid text,
  bundle_failure text,
  -- active | suspended | closed (Twilio's own account status, as last set or read).
  account_status text NOT NULL DEFAULT 'active',
  status_changed_at timestamptz,
  close_notice_sent_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licensee_twilio_status_check CHECK (account_status IN ('active', 'suspended', 'closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS licensee_twilio_subaccount_key ON licensee_twilio (subaccount_sid);

-- Texting registrations: toll-free verification (texts from the toll-free line) and A2P 10DLC (texts to US numbers
-- from a US local line). One row per licensee and kind. status: needs_info (something is missing to submit),
-- submitted, pending (carriers reviewing), approved, rejected (with the reason), not_needed.
CREATE TABLE IF NOT EXISTS texting_registrations (
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'needs_info',
  phone_number text,
  phone_number_sid text,
  -- Toll-free: the verification (HH...). 10DLC: customer profile (BU...), A2P trust product (BU...), brand (BN...),
  -- messaging service (MG...) and campaign (QE...).
  verification_sid text,
  customer_profile_sid text,
  trust_product_sid text,
  brand_sid text,
  messaging_service_sid text,
  campaign_sid text,
  twilio_status text,
  reason text,
  submitted_at timestamptz,
  approved_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  -- The status last pushed to the licensee's KS-server (PUT /api/provision/texting); differs = push again.
  pushed_status text,
  pushed_at timestamptz,
  push_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licensee_id, kind),
  CONSTRAINT texting_registrations_kind_check CHECK (kind IN ('toll_free', 'a2p_10dlc')),
  CONSTRAINT texting_registrations_status_check CHECK (status IN ('needs_info', 'submitted', 'pending', 'approved', 'rejected', 'not_needed'))
);
CREATE INDEX IF NOT EXISTS texting_registrations_due ON texting_registrations (next_check_at) WHERE status IN ('submitted', 'pending');
