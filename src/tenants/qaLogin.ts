// KS_OPS_QA_LOGIN_v1 - test brokerages get a QA sign-in (KS-server KS_SERVER_QA_LOGIN_v1): the brokerage's settings
// carry KS_TEST_BROKERAGE=true and a random KS_QA_LOGIN_CODE, and fictional NXX-555-0100..0199 numbers sign in with
// that code, no text sent. Real licensees get KS_TEST_BROKERAGE=false and never a code.
import { randomInt } from "node:crypto";
import type { Q } from "../db.js";
import { mergeTenantEnv, getTenant, tenantEnv } from "./repo.js";

export const QA_PHONE_RE = /^\+1[2-9]\d{2}55501\d{2}$/;

// 6 digits: the portal and client app code boxes take exactly 6.
export function newQaCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

/** The settings a brokerage gets for its test flag (merged into its ks_tenants env). */
export function qaSettings(testBrokerage: boolean): Record<string, string> {
  return { KS_TEST_BROKERAGE: testBrokerage ? "true" : "false" };
}

/** Make sure a test brokerage has its QA code; returns it. */
export async function ensureQaLogin(control: Q, key: Buffer, code: string): Promise<string> {
  const row = await getTenant(control, code);
  const env = row ? tenantEnv(row, key) : {};
  const current = String(env.KS_QA_LOGIN_CODE ?? "");
  const qa = /^[0-9]{6}$/.test(current) ? current : newQaCode(); // an older 8-digit code is replaced
  await mergeTenantEnv(control, key, code, { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: qa });
  return qa;
}

/**
 * KS_OPS_STORE_REVIEW_v1 - mark ONE test brokerage as the App Store / Google Play review brokerage: KS-server then gives
 * it the reviewer user (403-555-0100) and sample data (KS_SERVER_STORE_REVIEW_SEED_v2). Every other test brokerage is
 * set back to KS_STORE_REVIEW=false so the reviewer's number finds only this one. Returns the QA code to give Apple.
 */
export async function markStoreReview(control: Q, key: Buffer, code: string, otherTestCodes: string[]): Promise<string> {
  const qa = await ensureQaLogin(control, key, code);
  await mergeTenantEnv(control, key, code, { KS_STORE_REVIEW: "true" });
  for (const other of otherTestCodes) {
    if (other === code) continue;
    if (!(await getTenant(control, other))) continue;
    await mergeTenantEnv(control, key, other, { KS_STORE_REVIEW: "false" });
  }
  return qa;
}
