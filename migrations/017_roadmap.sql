-- KS-Ops: the public roadmap (KS_OPS_ROADMAP_v1). Brokers suggest features on the website (/roadmap); Keystone staff
-- moderate every suggestion on /ops/roadmap before anything appears publicly. The public list shows only the item's
-- title, summary, status and vote count - never who suggested or voted.
-- Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  -- requested: asked for by brokers; planned: we will build it; in_progress: being built now; shipped: available.
  status text NOT NULL DEFAULT 'requested',
  area text NOT NULL DEFAULT '',
  -- Hidden items stay on /ops/roadmap only.
  public boolean NOT NULL DEFAULT true,
  shipped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT roadmap_items_status_check CHECK (status IN ('requested', 'planned', 'in_progress', 'shipped'))
);
CREATE INDEX IF NOT EXISTS roadmap_items_public_idx ON roadmap_items (public, status);

-- What the website form sends. Personal details stay here, visible to Keystone staff only.
CREATE TABLE IF NOT EXISTS roadmap_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  details text,
  name text NOT NULL,
  email text NOT NULL,
  brokerage text,
  consent_text text NOT NULL,
  consent_at timestamptz NOT NULL,
  ip_hash text,
  -- pending: waiting for a person; approved: became a new public item; merged: added to an existing item;
  -- rejected: not shown.
  status text NOT NULL DEFAULT 'pending',
  item_id uuid REFERENCES roadmap_items(id) ON DELETE SET NULL,
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roadmap_ideas_status_check CHECK (status IN ('pending', 'approved', 'merged', 'rejected'))
);
CREATE INDEX IF NOT EXISTS roadmap_ideas_status_idx ON roadmap_ideas (status, created_at DESC);
CREATE INDEX IF NOT EXISTS roadmap_ideas_email_idx ON roadmap_ideas (lower(email));

-- One +1 per item per browser. voter_hash is a salted hash of a random id the browser keeps; ip_hash is a salted hash
-- of the address, for the per-address limit. Neither can be turned back into a person.
CREATE TABLE IF NOT EXISTS roadmap_votes (
  item_id uuid NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  voter_hash text NOT NULL,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS roadmap_votes_ip_idx ON roadmap_votes (ip_hash, created_at DESC);
