-- KS_OPS_ONBOARDING_v1: the brokerage's team roster from sign-up, the click-to-sign Keystone Software Licence Agreement,
-- and the onboarding emails sent during provisioning. Idempotent.

-- The people the brokerage owner entered at sign-up (the owner is position 0, role Admin). Editable until provisioning
-- creates them on the brokerage's server (step team_users).
CREATE TABLE IF NOT EXISTS licensee_team (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id     uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  full_name       text NOT NULL,
  email           text NOT NULL,
  phone_e164      text NOT NULL,
  role            text NOT NULL CHECK (role IN ('Broker', 'Marketing', 'Admin')),
  is_owner        boolean NOT NULL DEFAULT false,
  server_user_id  text,
  provisioned_at  timestamptz,
  invite_sent_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licensee_team_licensee ON licensee_team (licensee_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS licensee_team_email ON licensee_team (licensee_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS licensee_team_phone ON licensee_team (licensee_id, phone_e164);

-- One signature per licensee and agreement version: who signed, from where, and a SHA-256 of the exact text they saw.
CREATE TABLE IF NOT EXISTS licence_agreements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id     uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  version         text NOT NULL,
  signer_name     text NOT NULL,
  signer_title    text NOT NULL,
  signer_email    text NOT NULL,
  ip              text,
  user_agent      text,
  text_sha256     text NOT NULL,
  rendered_text   text NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  emailed_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS licence_agreements_version ON licence_agreements (licensee_id, version);

-- The agreement link (emailed after payment, or by the provisioning step), its single reminder 24 hours later, and the
-- owner's onboarding email (sent once).
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS agreement_link_sent_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS agreement_reminder_sent_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS onboarding_email_sent_at timestamptz;
