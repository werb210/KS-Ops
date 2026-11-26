-- KS_OPS_TV_PAIRING_v1 - the Apple TV scoreboard app is one App Store app for every Keystone brokerage (and Boreal
-- Financial). A TV has no keyboard, so it pairs with a code: the TV asks here for a code, shows it, and an admin types it
-- into their own portal. Their server makes a read-only screen token and hands it here with the code; the TV picks it up
-- with its own secret and from then on talks only to that brokerage's server. Rows live ten minutes; the token is cleared
-- the moment the TV collects it.
CREATE TABLE IF NOT EXISTS tv_pairings (
  code text PRIMARY KEY,
  device_secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  licensee_id uuid,
  server_url text,
  screen_token text,
  company_name text,
  logo_url text,
  primary_color text,
  collected_at timestamptz
);
CREATE INDEX IF NOT EXISTS tv_pairings_expires_idx ON tv_pairings (expires_at);
