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

// KS_OPS_STORE_REVIEW_v1 - one test brokerage marked for store review, the others set back.
import { randomBytes } from "node:crypto";
import { markStoreReview } from "../../src/tenants/qaLogin.js";
import { decryptEnv, encryptEnv } from "../../src/tenants/crypto.js";

function fakeControl(codes: string[], key: Buffer) {
  const env: Record<string, string> = {};
  for (const c of codes) env[c] = encryptEnv(c === "kstest2" ? { KS_STORE_REVIEW: "true", KS_TEST_BROKERAGE: "true" } : {}, key);
  return {
    env,
    query: async (sql: string, params: unknown[] = []) => {
      const code = String(params[0]);
      if (/SELECT \* FROM ks_tenants/.test(sql)) return { rows: env[code] ? [{ code, env_enc: env[code] }] : [] };
      if (/UPDATE ks_tenants SET env_enc/.test(sql)) { env[code] = String(params[1]); return { rows: [] }; }
      throw new Error("unexpected SQL: " + sql);
    },
  };
}

describe("markStoreReview", () => {
  it("marks one brokerage, gives it a QA code, and unmarks the other test brokerages", async () => {
    const key = randomBytes(32);
    const db = fakeControl(["kstest1", "kstest2"], key);
    const code = await markStoreReview(db as any, key, "kstest1", ["kstest2", "missing"]);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(decryptEnv(db.env.kstest1!, key)).toMatchObject({ KS_STORE_REVIEW: "true", KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: code });
    expect(decryptEnv(db.env.kstest2!, key).KS_STORE_REVIEW).toBe("false");
  });
});
