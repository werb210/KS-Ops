-- KS_OPS_SIGNUP_FAVICON_v1 - the favicon (browser tab icon) a brokerage can upload at sign-up, next to its logo.
-- Served from GET /api/public/favicons/<key>; the address goes into licensees.favicon_url and on to the brokerage's
-- settings with the branding push. Safe to run again.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS favicon_url text;
CREATE TABLE IF NOT EXISTS licensee_favicons (
  licensee_id uuid PRIMARY KEY REFERENCES licensees(id) ON DELETE CASCADE,
  favicon_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  data bytea NOT NULL,
  filename text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licensee_favicons_type_check CHECK (content_type IN ('image/png', 'image/svg+xml', 'image/x-icon')),
  CONSTRAINT licensee_favicons_size_check CHECK (octet_length(data) BETWEEN 1 AND 524288)
);
