// KS_OPS_TENANT_IDENTITY_v1
import { describe, expect, it } from "vitest";
import { identitySettings } from "../../src/provisioning/sharedSteps.js";

describe("brokerage identity settings", () => {
  it("passes the name, legal name, address and province time zone", () => {
    expect(identitySettings({ company_name: "KS Test 1", legal_name: "KS Test 1 Ltd.", country: "CA", province_state: "ab", address_line1: "100 Test Street", city: "Calgary", postal_code: "T2P 1J9" })).toEqual({
      KS_COMPANY_NAME: "KS Test 1", KS_LEGAL_NAME: "KS Test 1 Ltd.", KS_COUNTRY: "CA",
      KS_MAILING_ADDRESS: "100 Test Street, Calgary, AB T2P 1J9", KS_ASSISTANT_NAME: "", KS_TIME_ZONE: "America/Edmonton",
    });
  });
  it("uses the province's zone and leaves US zones alone", () => {
    expect(identitySettings({ company_name: "x", country: "CA", province_state: "BC" }).KS_TIME_ZONE).toBe("America/Vancouver");
    expect(identitySettings({ company_name: "x", country: "US", province_state: "WA" }).KS_TIME_ZONE).toBeUndefined();
  });
});
