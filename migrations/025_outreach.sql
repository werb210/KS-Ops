-- KS_OPS_OUTREACH_v1: selling Keystone to brokerages through every channel, not only email.
--
-- ks_brokerages         one row per brokerage (the firm we sell to): size, tools in use, mailing address, its
--                       qualification (keep / research / review / remove) and a priority score
-- ks_broker_people      everyone we know at a brokerage, with or without an email (phones, do-not-call flags, owner
--                       flag, where the contact was verified). A person with an email is also a ks_prospects row.
-- ks_mkt_channels       the outreach channels under test (phone, mail, events, ...), each with its test window,
--                       budget and the keep / drop decision
-- ks_mkt_channel_items  the things inside a channel: an event, a community, a podcast pitch, an ad campaign,
--                       a directory listing, a video, a partner, a landing page, a mail batch
-- ks_mkt_touches        every contact made or received through a channel, its outcome and its cost
-- ks_mkt_links          tracked links (one per channel / brokerage / item) and their clicks
-- ks_referrals          a customer referring another brokerage, and the reward owed
-- ks_outreach_settings  the fit-score rules (one row)
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS ks_brokerages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text NOT NULL,
  website text,
  country text,
  province_state text,
  city text,
  address_line1 text,
  address_line2 text,
  postal_code text,
  employee_count integer,
  seats_estimate integer,
  current_tools text[] NOT NULL DEFAULT '{}',
  products text,
  external_id text,
  domain text,
  firm_type text,
  qualification text NOT NULL DEFAULT 'research',
  qualification_reason text,
  qualification_locked boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'working',
  assigned_to text,
  fit_score integer NOT NULL DEFAULT 0,
  fit_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  licensee_id uuid,
  last_touch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_brokerages_key_uidx ON ks_brokerages (name_key, COALESCE(country, ''));
CREATE INDEX IF NOT EXISTS ks_brokerages_status_score_idx ON ks_brokerages (status, fit_score DESC);
CREATE INDEX IF NOT EXISTS ks_brokerages_external_idx ON ks_brokerages (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_brokerages_domain_idx ON ks_brokerages (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_brokerages_qualification_idx ON ks_brokerages (qualification, fit_score DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_brokerages_status_check') THEN
    ALTER TABLE ks_brokerages ADD CONSTRAINT ks_brokerages_status_check
      CHECK (status IN ('working', 'parked', 'customer'));
  END IF;
  -- keep = verified commercial finance brokerage; research = no decision-maker found yet; review = hybrid lender /
  -- unverified; remove = not a brokerage (lender, bank, residential-only...). Removed firms are never deleted: they are
  -- the exclusion ledger, so a later import cannot add them again.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_brokerages_qualification_check') THEN
    ALTER TABLE ks_brokerages ADD CONSTRAINT ks_brokerages_qualification_check
      CHECK (qualification IN ('keep', 'research', 'review', 'remove'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_broker_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES ks_brokerages (id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,
  title text,
  email text,
  direct_phone text,
  mobile_phone text,
  direct_dnc boolean NOT NULL DEFAULT false,
  mobile_dnc boolean NOT NULL DEFAULT false,
  is_owner boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  verification_url text,
  qualification text,
  external_id text,
  prospect_id uuid REFERENCES ks_prospects (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_broker_people_key_uidx ON ks_broker_people (brokerage_id, name_key);
CREATE INDEX IF NOT EXISTS ks_broker_people_external_idx ON ks_broker_people (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_broker_people_email_idx ON ks_broker_people (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS ks_mkt_channels (
  key text PRIMARY KEY,
  name text NOT NULL,
  sort integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  test_started_on date,
  test_weeks integer NOT NULL DEFAULT 4,
  budget_cents integer NOT NULL DEFAULT 0,
  decision text NOT NULL DEFAULT 'testing',
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_channels_decision_check') THEN
    ALTER TABLE ks_mkt_channels ADD CONSTRAINT ks_mkt_channels_decision_check CHECK (decision IN ('testing', 'keep', 'drop'));
  END IF;
END $$;
INSERT INTO ks_mkt_channels (key, name, sort) VALUES
  ('email', 'Email', 10), ('linkedin', 'LinkedIn', 20), ('phone', 'Phone calls to owners', 30), ('mail', 'Physical mail', 40),
  ('events', 'Associations and events', 50), ('communities', 'Broker communities online', 60),
  ('podcasts_webinars', 'Podcasts and webinars', 70), ('search', 'Search', 80), ('paid_ads', 'Paid ads', 90),
  ('directories', 'Software directories', 100), ('videos', 'Short videos', 110), ('referrals', 'Referral rewards', 120),
  ('partners', 'Adjacent partners', 130)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ks_mkt_channel_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key text NOT NULL REFERENCES ks_mkt_channels (key),
  kind text NOT NULL,
  name text NOT NULL,
  url text,
  happens_on date,
  cost_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_mkt_channel_items_channel_idx ON ks_mkt_channel_items (channel_key, created_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_channel_items_status_check') THEN
    ALTER TABLE ks_mkt_channel_items ADD CONSTRAINT ks_mkt_channel_items_status_check
      CHECK (status IN ('planned', 'in_progress', 'live', 'done', 'dropped'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key text NOT NULL REFERENCES ks_mkt_channels (key),
  brokerage_id uuid REFERENCES ks_brokerages (id) ON DELETE CASCADE,
  person_id uuid REFERENCES ks_broker_people (id) ON DELETE SET NULL,
  item_id uuid REFERENCES ks_mkt_channel_items (id) ON DELETE SET NULL,
  direction text NOT NULL DEFAULT 'out',
  outcome text NOT NULL DEFAULT 'sent',
  summary text,
  cost_cents integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_mkt_touches_channel_idx ON ks_mkt_touches (channel_key, at DESC);
CREATE INDEX IF NOT EXISTS ks_mkt_touches_brokerage_idx ON ks_mkt_touches (brokerage_id, at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_touches_outcome_check') THEN
    ALTER TABLE ks_mkt_touches ADD CONSTRAINT ks_mkt_touches_outcome_check
      CHECK (outcome IN ('sent', 'no_answer', 'voicemail', 'reply', 'conversation', 'owner_conversation', 'demo', 'signup', 'not_interested', 'do_not_contact', 'click'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_mkt_touches_direction_check') THEN
    ALTER TABLE ks_mkt_touches ADD CONSTRAINT ks_mkt_touches_direction_check CHECK (direction IN ('out', 'in'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_mkt_links (
  code text PRIMARY KEY,
  channel_key text NOT NULL REFERENCES ks_mkt_channels (key),
  brokerage_id uuid REFERENCES ks_brokerages (id) ON DELETE CASCADE,
  item_id uuid REFERENCES ks_mkt_channel_items (id) ON DELETE SET NULL,
  target_url text NOT NULL,
  label text,
  clicks integer NOT NULL DEFAULT 0,
  last_click_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_mkt_links_brokerage_idx ON ks_mkt_links (brokerage_id);

CREATE TABLE IF NOT EXISTS ks_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_licensee_id uuid,
  referrer_name text NOT NULL,
  code text NOT NULL,
  referred_brokerage_id uuid REFERENCES ks_brokerages (id) ON DELETE SET NULL,
  referred_name text,
  referred_licensee_id uuid,
  status text NOT NULL DEFAULT 'open',
  reward text,
  reward_cents integer NOT NULL DEFAULT 0,
  reward_applied_at timestamptz,
  reward_applied_by text,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_referrals_code_idx ON ks_referrals (lower(code));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ks_referrals_status_check') THEN
    ALTER TABLE ks_referrals ADD CONSTRAINT ks_referrals_status_check
      CHECK (status IN ('open', 'referred', 'signed_up', 'reward_owed', 'reward_applied', 'void'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_outreach_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fit_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ks_outreach_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
