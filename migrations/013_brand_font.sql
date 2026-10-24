-- KS-Ops v14 (Todd, Oct 24): the brand font chosen on sign-up (or read from the brokerage's own website), next to the
-- brand colours. A font family name only, e.g. "Lato". Idempotent: safe to run again.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS font_family text;
