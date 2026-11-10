// KS_OPS_QA_LOGIN_v1
import { describe, expect, it } from "vitest";
import { newQaCode, QA_PHONE_RE, qaSettings } from "../../src/tenants/qaLogin.js";

describe("QA sign-in settings", () => {
  it("makes a 6-digit random code", () => {
    const a = newQaCode();
    expect(a).toMatch(/^[0-9]{6}$/);
    expect(new Set(Array.from({ length: 20 }, newQaCode)).size).toBeGreaterThan(1);
  });
  it("flags only test brokerages", () => {
    expect(qaSettings(true)).toEqual({ KS_TEST_BROKERAGE: "true" });
    expect(qaSettings(false)).toEqual({ KS_TEST_BROKERAGE: "false" });
  });
  it("matches only fictional 555-01xx numbers", () => {
    expect(QA_PHONE_RE.test("+14035550101")).toBe(true);
    expect(QA_PHONE_RE.test("+14035550200")).toBe(false);
    expect(QA_PHONE_RE.test("+15878042761")).toBe(false);
  });
});
