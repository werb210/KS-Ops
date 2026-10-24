-- KS-Ops v14: the beta features programme (KS_OPS_BETA_v1). KS-Ops is the source of truth: the catalogue of beta
-- features, which licensees are in each one, the feedback they send and the website's beta programme sign-ups. Each
-- licensee's enabled flags reach its KS-server with the plan push (PUT /api/plan { beta_features }).
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS beta_features (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- private_beta: invite only (staff enrol); public_beta: any eligible licensee admin can join or leave;
  -- ga: on for every eligible licensee; retired: off for everyone and hidden.
  status text NOT NULL DEFAULT 'private_beta',
  -- Plans that may join (starter, growth, pro). Empty = every plan.
  plans text[] NOT NULL DEFAULT '{}',
  -- Whether new licensees may join now (staff can close a beta without retiring it).
  open boolean NOT NULL DEFAULT true,
  feedback_url text,
  docs_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT beta_features_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT beta_features_status_check CHECK (status IN ('private_beta', 'public_beta', 'ga', 'retired'))
);

CREATE TABLE IF NOT EXISTS beta_enrolments (
  feature_key text NOT NULL REFERENCES beta_features(key) ON DELETE CASCADE ON UPDATE CASCADE,
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  -- ops (staff enrolled them) or licensee (their admin joined a public beta)
  source text NOT NULL DEFAULT 'ops',
  enrolled_by text,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_key, licensee_id)
);
CREATE INDEX IF NOT EXISTS beta_enrolments_licensee_idx ON beta_enrolments (licensee_id);

CREATE TABLE IF NOT EXISTS beta_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key text NOT NULL REFERENCES beta_features(key) ON DELETE CASCADE ON UPDATE CASCADE,
  licensee_id uuid REFERENCES licensees(id) ON DELETE SET NULL,
  author_name text,
  author_email text,
  rating integer,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beta_feedback_rating_check CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))
);
CREATE INDEX IF NOT EXISTS beta_feedback_feature_idx ON beta_feedback (feature_key, created_at DESC);

-- The website's "Join our beta programme" form. Each sign-up is also pushed to the Keystone CRM.
CREATE TABLE IF NOT EXISTS beta_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  brokerage text NOT NULL,
  interests text[] NOT NULL DEFAULT '{}',
  message text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beta_signups_created_idx ON beta_signups (created_at DESC);
CREATE INDEX IF NOT EXISTS beta_signups_email_idx ON beta_signups (lower(email));
