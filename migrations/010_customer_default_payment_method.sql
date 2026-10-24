-- KS-Ops v10: the payment method KS-Ops last set as the Stripe customer's invoice_settings.default_payment_method
-- (copied from the subscription after Checkout), so one-off invoices such as usage overage collect automatically.
-- Idempotent: safe to run again.
ALTER TABLE licensees ADD COLUMN IF NOT EXISTS stripe_default_payment_method text;
