-- KS-Ops v5: every licensee is a referral source of the insurance partner (Boreal Insurance) for PGI. KS-Ops creates
-- the referral source at the partner and pushes the credentials to the licensee's server. Idempotent.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_source_id text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_link_status text NOT NULL DEFAULT 'pending';
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_link_error text;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_link_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_link_next_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_linked_at timestamptz;
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS pgi_linked_server_url text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'licensees_pgi_link_status_check') THEN
    ALTER TABLE licensees ADD CONSTRAINT licensees_pgi_link_status_check
      CHECK (pgi_link_status IN ('pending', 'linked', 'error', 'disabled'));
  END IF;
END $$;
