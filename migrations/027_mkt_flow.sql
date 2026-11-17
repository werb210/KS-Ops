-- KS_OPS_MKT_FLOW_v1 - an email flow: everyone gets the first email, and whether each prospect opens or clicks
-- decides the next one (see src/marketing/flow.ts). A flow is a sequence of kind 'flow' with seven fixed steps.
ALTER TABLE ks_mkt_sequences ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'steps';
ALTER TABLE ks_mkt_sequences ADD COLUMN IF NOT EXISTS daily_new integer NOT NULL DEFAULT 50;
ALTER TABLE ks_mkt_sequences ADD COLUMN IF NOT EXISTS from_name text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_sequences_kind_check') THEN
    ALTER TABLE ks_mkt_sequences ADD CONSTRAINT ks_mkt_sequences_kind_check CHECK (kind IN ('steps', 'flow'));
  END IF;
END $$;
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'none';
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS flow_sent text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS flow_next text;
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS flow_last_sent_at timestamptz;
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS opened_at timestamptz;
ALTER TABLE ks_mkt_enrollments ADD COLUMN IF NOT EXISTS clicked_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_enrollments_track_check') THEN
    ALTER TABLE ks_mkt_enrollments ADD CONSTRAINT ks_mkt_enrollments_track_check CHECK (track IN ('none', 'opened', 'clicked'));
  END IF;
END $$;
-- A click by a person: not within a minute of the email leaving (mail filters scan links on arrival) and not the
-- unsubscribe link.
ALTER TABLE ks_mkt_sends ADD COLUMN IF NOT EXISTS human_clicked_at timestamptz;
