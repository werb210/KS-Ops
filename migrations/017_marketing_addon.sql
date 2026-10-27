-- KS_OPS_MARKETING_ADDON - the Marketing add-on and e-signing allowance (Todd, Oct 26). Idempotent.
-- The add-on itself is licensees.addons.marketing (the jsonb that already holds staff-only add-ons).

-- Usage the licensee's server reports for campaign emails, marketing texts and signings.
ALTER TABLE usage_reports ADD COLUMN IF NOT EXISTS campaign_emails integer NOT NULL DEFAULT 0;
ALTER TABLE usage_reports ADD COLUMN IF NOT EXISTS marketing_texts integer NOT NULL DEFAULT 0;
ALTER TABLE usage_reports ADD COLUMN IF NOT EXISTS signings integer NOT NULL DEFAULT 0;

-- Overage billing now also bills signings (over 4, $2.50) and campaign emails (add-on, $10 per 10,000 or part).
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS signings integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS campaign_email_blocks integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS signings_amount integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS campaign_emails_amount integer NOT NULL DEFAULT 0;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS signings_invoice_item_id text;
ALTER TABLE overage_billing ADD COLUMN IF NOT EXISTS campaign_emails_invoice_item_id text;

-- Monthly subscriptions: overage lines wait on the customer as pending invoice items and go on the next subscription
-- invoice ('pending_next_invoice'). Annual subscriptions still get their own overage invoice each month.
ALTER TABLE overage_billing DROP CONSTRAINT IF EXISTS overage_billing_status_check;
ALTER TABLE overage_billing ADD CONSTRAINT overage_billing_status_check
  CHECK (status IN ('started', 'items_created', 'invoiced', 'nothing_to_bill', 'pending_next_invoice'));
