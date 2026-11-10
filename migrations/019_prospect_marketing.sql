-- KS_OPS_PROSPECT_MARKETING_v1: email marketing to prospective Keystone licensees (CASL and CAN-SPAM).
--
-- ks_prospects            one row per email: who they are, where they came from, their sales status and the consent
--                         we hold for them (type, source, wording, when, and when implied consent runs out)
-- ks_prospect_events      the prospect's marketing timeline (sync, consent, sends, opens, clicks, bounces, replies)
-- ks_mkt_suppressions     emails that must never get marketing (unsubscribed, hard bounce, spam report, staff)
-- ks_mkt_templates        Keystone-branded templates (subject + content fields; the layout and footer are fixed)
-- ks_mkt_campaigns        one-off sends to a segment, now or scheduled
-- ks_mkt_sequences        multi-step drips; stop on reply, sign-up or demo booked
-- ks_mkt_enrollments      a prospect in a sequence
-- ks_mkt_sends            every email (campaign or sequence step), or why it was blocked
-- ks_mkt_timeline_outbox  marketing events waiting to be written to the Keystone CRM timeline on BF-Server
-- ks_mkt_sync_state       cursors for the prospect sync (KS-Ops sources, BF-Server's Keystone CRM, reply mailbox)
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS ks_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text,
  company text,
  phone text,
  title text,
  country text,
  province_state text,
  status text NOT NULL DEFAULT 'lead',
  source text NOT NULL DEFAULT 'manual',
  sources text[] NOT NULL DEFAULT '{}',
  plan_interest text,
  consent_type text NOT NULL DEFAULT 'none',
  consent_source text,
  consent_text text,
  consent_at timestamptz,
  consent_expires_at timestamptz,
  consent_recorded_by text,
  licensee_id uuid,
  crm_contact_id text,
  demo_booked_at timestamptz,
  signed_up_at timestamptz,
  last_replied_at timestamptz,
  last_emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_prospects_email_uidx ON ks_prospects (lower(email));
CREATE INDEX IF NOT EXISTS ks_prospects_status_idx ON ks_prospects (status);
CREATE INDEX IF NOT EXISTS ks_prospects_updated_idx ON ks_prospects (updated_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_prospects_status_check') THEN
    ALTER TABLE ks_prospects ADD CONSTRAINT ks_prospects_status_check
      CHECK (status IN ('lead', 'demo_booked', 'trial', 'customer', 'lost'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_prospects_consent_type_check') THEN
    ALTER TABLE ks_prospects ADD CONSTRAINT ks_prospects_consent_type_check
      CHECK (consent_type IN ('none', 'express', 'implied_inquiry', 'implied_business', 'implied_publication', 'us_opt_out'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_prospect_events (
  id bigserial PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES ks_prospects (id) ON DELETE CASCADE,
  type text NOT NULL,
  summary text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  send_id bigint,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_prospect_events_prospect_idx ON ks_prospect_events (prospect_id, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ks_prospect_events_dedupe_uidx ON ks_prospect_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ks_mkt_suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL,
  source text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_suppressions_reason_check') THEN
    ALTER TABLE ks_mkt_suppressions ADD CONSTRAINT ks_mkt_suppressions_reason_check
      CHECK (reason IN ('unsubscribed', 'hard_bounce', 'spam_report', 'crm_opt_out', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_suppressions_lower_check') THEN
    ALTER TABLE ks_mkt_suppressions ADD CONSTRAINT ks_mkt_suppressions_lower_check CHECK (email = lower(email));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  subject text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ks_mkt_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  template_id uuid REFERENCES ks_mkt_templates (id),
  subject text NOT NULL,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  send_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_mkt_campaigns_due_idx ON ks_mkt_campaigns (send_at) WHERE status IN ('scheduled', 'sending');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_campaigns_status_check') THEN
    ALTER TABLE ks_mkt_campaigns ADD CONSTRAINT ks_mkt_campaigns_status_check
      CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  -- [{ "wait_days": 0, "template_id": "..." }, ...]: each wait counts from the enrolment (first step) or the step before.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_sequences_status_check') THEN
    ALTER TABLE ks_mkt_sequences ADD CONSTRAINT ks_mkt_sequences_status_check CHECK (status IN ('draft', 'active', 'paused'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL REFERENCES ks_mkt_sequences (id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES ks_prospects (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  next_step integer NOT NULL DEFAULT 0,
  next_send_at timestamptz,
  stopped_reason text,
  enrolled_by text,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_mkt_enrollments_uidx ON ks_mkt_enrollments (sequence_id, prospect_id);
CREATE INDEX IF NOT EXISTS ks_mkt_enrollments_due_idx ON ks_mkt_enrollments (next_send_at) WHERE status = 'active';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_enrollments_status_check') THEN
    ALTER TABLE ks_mkt_enrollments ADD CONSTRAINT ks_mkt_enrollments_status_check CHECK (status IN ('active', 'completed', 'stopped'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_sends (
  id bigserial PRIMARY KEY,
  campaign_id uuid REFERENCES ks_mkt_campaigns (id) ON DELETE CASCADE,
  enrollment_id uuid REFERENCES ks_mkt_enrollments (id) ON DELETE CASCADE,
  step_index integer,
  prospect_id uuid NOT NULL REFERENCES ks_prospects (id) ON DELETE CASCADE,
  email text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'queued',
  block_reason text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  sg_message_id text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  bounced_at timestamptz,
  spam_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_mkt_sends_campaign_uidx ON ks_mkt_sends (campaign_id, prospect_id) WHERE campaign_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ks_mkt_sends_step_uidx ON ks_mkt_sends (enrollment_id, step_index) WHERE enrollment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_mkt_sends_queued_idx ON ks_mkt_sends (campaign_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ks_mkt_sends_prospect_idx ON ks_mkt_sends (prospect_id, created_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_sends_status_check') THEN
    ALTER TABLE ks_mkt_sends ADD CONSTRAINT ks_mkt_sends_status_check CHECK (status IN ('queued', 'sent', 'blocked', 'failed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_timeline_outbox (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  event jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_mkt_timeline_outbox_due_idx ON ks_mkt_timeline_outbox (next_attempt_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS ks_mkt_sync_state (
  name text PRIMARY KEY,
  cursor_at timestamptz,
  last_run_at timestamptz,
  last_error text
);
