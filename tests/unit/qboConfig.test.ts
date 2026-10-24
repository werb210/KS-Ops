import { describe, expect, it } from "vitest";
import { checkoutPaymentParams } from "../../src/billing/paymentMethods.js";
import { requestIdFor, qboQuote } from "../../src/qbo/client.js";
import { qboApiBase, qboConfig, qboEnvironment, qboMissing, qboRedirectUri } from "../../src/qbo/config.js";

const full = { KS_QBO_CLIENT_ID: "id", KS_QBO_CLIENT_SECRET: "secret", KS_QBO_TOKEN_ENCRYPTION_KEY: "c".repeat(64) };

describe("Keystone QuickBooks settings", () => {
  it("is off until the client id, secret and a 32-byte key are all set", () => {
    expect(qboConfig({})).toBeNull();
    expect(qboMissing({})).toHaveLength(3);
    expect(qboConfig({ ...full, KS_QBO_TOKEN_ENCRYPTION_KEY: "short" })).toBeNull();
    expect(qboConfig(full)).toMatchObject({ clientId: "id", environment: "sandbox", apiBase: "https://sandbox-quickbooks.api.intuit.com" });
  });

  it("defaults to sandbox; production only when asked", () => {
    expect(qboEnvironment({})).toBe("sandbox");
    expect(qboEnvironment({ KS_QBO_ENVIRONMENT: "Production" })).toBe("production");
    expect(qboEnvironment({ KS_QBO_ENVIRONMENT: "prod" })).toBe("sandbox");
    expect(qboApiBase("production")).toBe("https://quickbooks.api.intuit.com");
  });

  it("works out the redirect address", () => {
    expect(qboRedirectUri("https://x.test", { KS_QBO_REDIRECT_URI: "https://a.test/cb" })).toBe("https://a.test/cb");
    expect(qboRedirectUri("https://x.test", { KS_OPS_PUBLIC_URL: "https://ops.test/" })).toBe("https://ops.test/api/ops/quickbooks/oauth/callback");
    expect(qboRedirectUri("https://x.test", { WEBSITE_HOSTNAME: "ks-ops.azurewebsites.net" })).toBe(
      "https://ks-ops.azurewebsites.net/api/ops/quickbooks/oauth/callback",
    );
    expect(qboRedirectUri("https://x.test", {})).toBe("https://x.test/api/ops/quickbooks/oauth/callback");
  });

  it("quotes query values and makes stable request ids", () => {
    expect(qboQuote("O'Brien \\ Co")).toBe("'O\\'Brien \\\\ Co'");
    expect(requestIdFor("invoice-in_1")).toBe(requestIdFor("invoice-in_1"));
    expect(requestIdFor("invoice-in_1")).not.toBe(requestIdFor("invoice-in_2"));
  });
});

describe("Stripe payment methods", () => {
  it("bank debit by default (with the PAD mandate), card when chosen", () => {
    expect(checkoutPaymentParams(undefined)).toMatchObject({ allowed_payment_method_types: ["acss_debit", "card"] });
    expect(checkoutPaymentParams("acss_debit")).toHaveProperty("payment_method_options.acss_debit.mandate_options.payment_schedule", "combined");
    expect(checkoutPaymentParams("card")).toEqual({ allowed_payment_method_types: ["card"] });
  });
});
