-- KS-Ops v6: the demo link is texted to the prospect's mobile as well as emailed. Idempotent.
ALTER TABLE demo_signups ADD COLUMN IF NOT EXISTS phone text;
