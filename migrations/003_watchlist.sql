-- KS-Ops v3: the shared fraud watchlist. Idempotent: safe to run again.
--
-- Licensees that opt in (Settings -> Company on their portal) send keyed hashes of the identifiers on files they
-- confirmed as fraud. Only hashes are stored here: HMAC-SHA256(KS_WATCHLIST_PEPPER, kind:value) computed on the
-- licensee's own server. KS-Ops never has that pepper, so it cannot turn a hash back into a phone number or name.
-- When KS_WATCHLIST_OPS_PEPPER is set, each hash is keyed once more before it is stored (and before it is compared).

ALTER TABLE licensees ADD COLUMN IF NOT EXISTS watchlist_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS watchlist_opt_in_at timestamptz;

CREATE TABLE IF NOT EXISTS watchlist_entries (
  id bigserial PRIMARY KEY,
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  application_ref text NOT NULL,
  kind text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS watchlist_entries_uq ON watchlist_entries (licensee_id, application_ref, kind, hash);
CREATE INDEX IF NOT EXISTS watchlist_entries_hash_idx ON watchlist_entries (hash);
