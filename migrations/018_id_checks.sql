-- KS_OPS_KYC - ID checks (Entrust IDV) the licensee's server reports, and their overage billing (over the month's
-- included number, $4.00 each) next to minutes, texts, signings and campaign emails. Idempotent.
ALTER TABLE usage_reports ADD COLUMN IF NOT EXISTS id_checks integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS id_checks integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS id_checks_amount integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS id_checks_invoice_item_id text;
