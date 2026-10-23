-- KS-Ops v7: the demo server sends the real lender email for the sample file (subject, bodies, the package zip); it
-- is kept here until the prospect's copy is sent, and dropped with the package on expiry. Idempotent.
ALTER TABLE demo_signups ADD COLUMN IF NOT EXISTS package_mail jsonb;
