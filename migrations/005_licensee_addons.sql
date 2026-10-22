-- KS_OPS_BANK_CONNECT_ADDON - per-licensee add-ons that are not plan features, set only by Keystone staff
-- (PATCH /api/ops/licensees/:id { addons: { bank_connect: true|false } }) and pushed to the licensee's server with the
-- plan (PUT {server}/api/plan { addons }). Never listed in /api/public/plans. Default: nothing on. Safe to run again.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS addons jsonb NOT NULL DEFAULT '{}'::jsonb;
