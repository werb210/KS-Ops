-- KS-Ops v4: the self-serve sales demo. One row per prospect who asked for a demo on the website; their progress
-- events from the demo server; the lender package to email them. Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS demo_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL,
  ip text,
  user_agent text,
  -- The magic link's secret: only its SHA-256 is kept. A fresh link replaces it.
  token_hash text NOT NULL,
  -- pending (link sent, never opened) | active (opened) | completed (submitted to lenders) | wiped (expired and wiped)
  status text NOT NULL DEFAULT 'pending',
  link_sends integer NOT NULL DEFAULT 1,
  last_link_sent_at timestamptz NOT NULL DEFAULT now(),
  server_session_id uuid,
  opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  event_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  -- The digest of what they did (kept for sales after the events are deleted).
  digest jsonb NOT NULL DEFAULT '{}'::jsonb,
  package_pdf bytea,
  package_filename text,
  prospect_package_sent_at timestamptz,
  sales_completed_sent_at timestamptz,
  sales_unfinished_sent_at timestamptz,
  mail_attempts integer NOT NULL DEFAULT 0,
  wiped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_signups_email_idx ON demo_signups (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS demo_signups_ip_idx ON demo_signups (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_signups_status_idx ON demo_signups (status, expires_at);

CREATE TABLE IF NOT EXISTS demo_events (
  id bigserial PRIMARY KEY,
  signup_id uuid NOT NULL REFERENCES demo_signups(id) ON DELETE CASCADE,
  type text NOT NULL,
  step text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_events_signup_idx ON demo_events (signup_id, at, id);
