-- KS_OPS_TEST_BROKERAGE_v1 - a staff-made test brokerage: provisioning runs exactly as for a client but buys no phone
-- numbers and submits no regulatory bundle or texting registration. Idempotent.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS test_brokerage boolean NOT NULL DEFAULT false;
