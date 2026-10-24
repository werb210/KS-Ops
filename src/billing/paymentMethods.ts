// How licensees pay Keystone: Canadian pre-authorized debit (Stripe acss_debit) by default, card as the alternative.
export const PAYMENT_METHODS = ["acss_debit", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const DEFAULT_PAYMENT_METHOD: PaymentMethod = "acss_debit";

export const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);

export const PAYMENT_METHOD_NAMES: Record<PaymentMethod, string> = {
  acss_debit: "Bank debit (Canadian pre-authorized debit)",
  card: "Credit card",
};

/** The PAD mandate's description of when Keystone debits the account (Stripe shows it with the mandate). */
export const PAD_INTERVAL_DESCRIPTION =
  "Your Keystone subscription, charged monthly or yearly as your plan sets out, plus any usage over your plan's allowance billed after each month ends.";

/**
 * Stripe Checkout payment settings for the licensee's choice. Bank debit keeps card as a fallback in the same
 * Checkout, so nobody without a Canadian bank account is stuck; choosing card offers card only.
 * Stripe API 2026-09-30 takes allowed_payment_method_types (a filter on the methods enabled in the Stripe account).
 */
export function checkoutPaymentParams(method: unknown): Record<string, unknown> {
  const m: PaymentMethod = isPaymentMethod(method) ? method : DEFAULT_PAYMENT_METHOD;
  if (m === "card") return { allowed_payment_method_types: ["card"] };
  return {
    allowed_payment_method_types: ["acss_debit", "card"],
    payment_method_options: {
      acss_debit: {
        mandate_options: {
          // Subscription charges on a schedule, plus overage invoices when they happen.
          payment_schedule: "combined",
          interval_description: PAD_INTERVAL_DESCRIPTION,
          transaction_type: "business",
        },
        verification_method: "automatic",
      },
    },
  };
}
