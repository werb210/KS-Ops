// KS_OPS_QA_LOGIN_v1 - test brokerages get a QA sign-in (KS-server KS_SERVER_QA_LOGIN_v1): the brokerage's settings
// carry KS_TEST_BROKERAGE=true and a random KS_QA_LOGIN_CODE, and fictional NXX-555-0100..0199 numbers sign in with
// that code, no text sent. Real licensees get KS_TEST_BROKERAGE=false and never a code.
import { randomInt } from "node:crypto";
import type { Q } from "../db.js";
import { mergeTenantEnv, getTenant, tenantEnv } from "./repo.js";

export const QA_PHONE_RE = /^\+1[2-9]\d{2}55501\d{2}$/;

export function newQaCode(): string {
  return String(randomInt(10_000_000, 100_000_000));
}

/** The settings a brokerage gets for its test flag (merged into its ks_tenants env). */
export function qaSettings(testBrokerage: boolean): Record<string, string> {
  return { KS_TEST_BROKERAGE: testBrokerage ? "true" : "false" };
}

/** Make sure a test brokerage has its QA code; returns it. */
export async function ensureQaLogin(control: Q, key: Buffer, code: string): Promise<string> {
  await mergeTenantEnv(control, key, code, { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: newQaCode() }, { keep: true });
  const row = await getTenant(control, code);
  const env = row ? tenantEnv(row, key) : {};
  if (env.KS_TEST_BROKERAGE !== "true") await mergeTenantEnv(control, key, code, { KS_TEST_BROKERAGE: "true" });
  return String(env.KS_QA_LOGIN_CODE ?? "");
}
