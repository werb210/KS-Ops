-- KS-Ops v11: the staff directory (KS_STAFF_DIRECTORY_v1). Idempotent: safe to run again.
--
-- The Keystone dialler and iPad portal find a staff member's brokerage from their work email or mobile number instead
-- of a company code. Each licensee's KS-server sends the full list of its active staff identifiers as hashes:
-- SHA-256("ks-staff-directory:v1:<kind>:<normalised value>"), kind = email | phone. KS-Ops never receives the email
-- addresses or phone numbers themselves. When KS_STAFF_DIRECTORY_PEPPER is set, each hash is keyed once more
-- (HMAC-SHA256) before it is stored and before it is compared, so a copy of this table alone is useless.
CREATE TABLE IF NOT EXISTS staff_directory_entries (
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  kind text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (licensee_id, kind, hash)
);
CREATE INDEX IF NOT EXISTS staff_directory_entries_hash_idx ON staff_directory_entries (hash);

ALTER TABLE licensees ADD COLUMN IF NOT EXISTS staff_directory_synced_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS staff_directory_count integer;
