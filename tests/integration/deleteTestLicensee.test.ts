// KS_OPS_DELETE_TEST_LICENSEE_v1 - only unpaid test licensees can be removed.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

async function make(code: string, name: string, status: string): Promise<string> {
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: name, legal_name: `${name} Inc.`, company_code: code, contact_name: "A B", contact_email: `${code}@x.example`,
    contact_phone: "403-555-0123", plan: "starter", billing: "monthly", support_level: "email", seats: 2, country: "CA", status,
    server_url: `https://${code}.azurewebsites.net`,
  });
  expect(res.status).toBe(201);
  return res.body.licensee.id;
}

beforeAll(async () => {
  pool = await freshPool();
  deps = { db: pool, fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => { await pool?.end(); });

describe("DELETE /api/ops/licensees/:id", () => {
  it("removes an unpaid test licensee", async () => {
    const id = await make("deltest1", "KS Test Delete", "pending_payment");
    const res = await request(app()).delete(`/api/ops/licensees/${id}`).set(staff());
    expect(res.status).toBe(200);
    const left = await pool.query("SELECT 1 FROM licensees WHERE id = $1", [id]);
    expect(left.rows).toHaveLength(0);
  });

  it("closes a test licensee's Twilio sub-account first, then removes it", async () => {
    const id = await make("deltest4", "KS Test Twilio", "pending_payment");
    await pool.query(
      `INSERT INTO licensee_twilio (licensee_id, subaccount_sid, auth_token_encrypted, friendly_name, account_status)
       VALUES ($1, 'AC_test', 'x', 'KS Test Twilio', 'closed')`,
      [id],
    );
    const res = await request(app()).delete(`/api/ops/licensees/${id}`).set(staff());
    expect(res.body).toMatchObject({ deleted: true });
    expect(res.body.twilio.closed).toBe("AC_test");
    expect((await pool.query("SELECT 1 FROM licensee_twilio WHERE licensee_id = $1", [id])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM licensees WHERE id = $1", [id])).rows).toHaveLength(0);
  });

  it("refuses a real licensee", async () => {
    const id = await make("realco1", "Real Brokerage", "pending_payment");
    const res = await request(app()).delete(`/api/ops/licensees/${id}`).set(staff());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_test");
  });

  it("refuses a test licensee that is live", async () => {
    const id = await make("deltest2", "Live Test Co", "active");
    const res = await request(app()).delete(`/api/ops/licensees/${id}`).set(staff());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_pending");
  });

  it("needs staff", async () => {
    const id = await make("deltest3", "KS Test Auth", "pending_payment");
    const res = await request(app()).delete(`/api/ops/licensees/${id}`);
    expect(res.status).toBe(401);
  });
});
