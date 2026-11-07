-- KS_OPS_NUMBER_PORTING_v1 - "Keep your existing phone number": a brokerage's requests to transfer (port) numbers it
-- already has into its Keystone (Twilio) account. One request = one carrier account (one bill, one letter of
-- authorization) with one or more numbers. Keystone staff submit it to Twilio (Console for toll-free, Twilio's porting
-- form for local and mobile) and record what happens; submit_method leaves room for an API submission (US numbers)
-- later. The account number and PIN are encrypted with OPS_ENCRYPTION_KEY (AES-256-GCM), never stored in clear.
-- Idempotent.
CREATE TABLE IF NOT EXISTS port_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id                uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN (
                               'draft', 'ready_to_submit', 'submitted', 'carrier_approval_pending', 'scheduled',
                               'completed', 'rejected', 'cancelled')),
  carrier                    text NOT NULL,
  carrier_other              text,
  account_name               text NOT NULL,
  account_number_encrypted   text NOT NULL,
  account_last4              text NOT NULL,
  pin_encrypted              text,
  service_line1              text NOT NULL,
  service_line2              text,
  service_city               text NOT NULL,
  service_region             text NOT NULL,
  service_postal_code        text NOT NULL,
  service_country            text NOT NULL CHECK (service_country IN ('CA', 'US')),
  submit_method              text NOT NULL DEFAULT 'staff' CHECK (submit_method IN ('staff', 'api')),
  twilio_port_sid            text,
  twilio_reference           text,
  foc_date                   date,
  status_reason              text,
  requested_by_name          text,
  requested_by_email         text,
  requested_by_user_id       text,
  submitted_at               timestamptz,
  submitted_by               text,
  carrier_approval_at        timestamptz,
  scheduled_at               timestamptz,
  completed_at               timestamptz,
  rejected_at                timestamptz,
  cancelled_at               timestamptz,
  attach_error               text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_requests_licensee ON port_requests (licensee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS port_requests_status ON port_requests (status, updated_at);

CREATE TABLE IF NOT EXISTS port_request_numbers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_request_id      uuid NOT NULL REFERENCES port_requests(id) ON DELETE CASCADE,
  phone_number         text NOT NULL,
  number_type          text NOT NULL CHECK (number_type IN ('local', 'mobile', 'toll_free')),
  -- The person on the brokerage's server it belongs to (null = the brokerage's main or toll-free line).
  server_user_id       text,
  assignee_name        text NOT NULL,
  -- The Keystone number calls are forwarded to while the transfer runs.
  temporary_number     text,
  forwarding_tested_at timestamptz,
  attached_at          timestamptz,
  attach_status        text,
  attach_message       text,
  released_number      text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_request_numbers_request ON port_request_numbers (port_request_id);
-- A number can be in only one open request at a time (per licensee is enforced in code; this stops duplicates).
CREATE INDEX IF NOT EXISTS port_request_numbers_number ON port_request_numbers (phone_number);

-- The recent bill (PDF or image), kept in the database like licensee logos. "Bill blob ref" = this row's id.
CREATE TABLE IF NOT EXISTS port_request_files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_request_id  uuid NOT NULL REFERENCES port_requests(id) ON DELETE CASCADE,
  kind             text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill')),
  filename         text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       integer NOT NULL,
  sha256           text NOT NULL,
  data             bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_request_files_request ON port_request_files (port_request_id, created_at DESC);

-- The letter of authorization, click-signed by the owner or an admin: who, title, when, from where, which version and a
-- SHA-256 of the exact text shown (the PIN never in it). The text holds the account number, so it is kept encrypted
-- (OPS_ENCRYPTION_KEY) like the account number itself. A new signature is needed when the last is over 30 days old at
-- submission.
CREATE TABLE IF NOT EXISTS port_request_loas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_request_id  uuid NOT NULL REFERENCES port_requests(id) ON DELETE CASCADE,
  version          text NOT NULL,
  signer_name      text NOT NULL,
  signer_title     text NOT NULL,
  signer_email     text,
  signer_user_id   text,
  ip               text,
  user_agent       text,
  text_sha256      text NOT NULL,
  rendered_text_encrypted text NOT NULL,
  signed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_request_loas_request ON port_request_loas (port_request_id, signed_at DESC);

-- Every status change, who made it and whether the owner was told.
CREATE TABLE IF NOT EXISTS port_request_events (
  id               bigserial PRIMARY KEY,
  port_request_id  uuid NOT NULL REFERENCES port_requests(id) ON DELETE CASCADE,
  from_status      text,
  to_status        text NOT NULL,
  actor            text NOT NULL,
  note             text,
  emailed_at       timestamptz,
  texted_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_request_events_request ON port_request_events (port_request_id, id);
