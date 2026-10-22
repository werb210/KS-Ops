// The shared fraud watchlist end to end against real Postgres: two licensees, opt-in, report, check, withdraw, opt-out.
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
const H = (c: string) => c.repeat(64);
const lic: Array<{ id: string; key: string }> = [];

async function makeLicensee(code: string): Promise<{ id: string; key: string }> {
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: `Co ${code}`, legal_name: `Co ${code} Inc.`, company_code: code, contact_name: "A B", contact_email: `${code}@x.example`,
    contact_phone: "403-555-0123", plan: "pro", billing: "monthly", support_level: "email", seats: 2, country: "CA", status: "active",
  });
  expect(res.status).toBe(201);
  return { id: res.body.licensee.id, key: res.body.ops_key };
}

const call = (l: { id: string; key: string }, path: string, body: object) =>
  request(app()).post(`/api/licensees/${l.id}/watchlist/${path}`).set("X-KS-Ops-Key", l.key).send(body);

beforeAll(async () => {
  process.env.KS_WATCHLIST_OPS_PEPPER = "ops-side-pepper";
  pool = await freshPool();
  deps = { db: pool, fetch: (async () => new Response("{}")) as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => new Date("2026-10-23T12:00:00Z") };
  lic.push(await makeLicensee("wl-one"), await makeLicensee("wl-two"));
});

afterAll(async () => {
  delete process.env.KS_WATCHLIST_OPS_PEPPER;
  await pool.end();
});

describe("shared fraud watchlist", () => {
  it("refuses report and check until the licensee opts in, and a wrong key always", async () => {
    expect((await call(lic[0]!, "check", { entries: [{ kind: "phone", hash: H("1") }] })).status).toBe(403);
    expect((await call(lic[0]!, "report", { application_ref: H("a"), entries: [] })).status).toBe(403);
    expect((await call({ ...lic[0]!, key: "ksops_wrong" }, "opt-in", { opt_in: true })).status).toBe(401);
  });

  it("matches what another brokerage reported, never your own, and stores hashes keyed again", async () => {
    for (const l of lic) expect((await call(l, "opt-in", { opt_in: true })).body).toMatchObject({ ok: true, opt_in: true });
    const rep = await call(lic[0]!, "report", { application_ref: H("a"), entries: [{ kind: "phone", hash: H("1") }, { kind: "email", hash: H("2") }] });
    expect(rep.body).toEqual({ ok: true, stored: 2 });
    const stored = (await pool.query(`SELECT hash FROM watchlist_entries WHERE licensee_id = $1`, [lic[0]!.id])).rows.map((r) => r.hash);
    expect(stored).not.toContain(H("1"));
    const other = await call(lic[1]!, "check", { entries: [{ kind: "phone", hash: H("1") }, { kind: "email", hash: H("9") }] });
    expect(other.body).toEqual({ ok: true, matches: [{ kind: "phone", hash: H("1"), brokerages: 1, reports: 1 }] });
    const own = await call(lic[0]!, "check", { entries: [{ kind: "phone", hash: H("1") }] });
    expect(own.body.matches).toEqual([]);
    expect((await call(lic[1]!, "check", { entries: [{ kind: "phone", hash: "not-a-hash" }] })).status).toBe(400);
    const stats = await request(app()).get("/api/ops/watchlist").set(staff());
    expect(stats.body).toEqual({ opted_in_licensees: 2, files: 1, entries: 2 });
  });

  it("withdraw removes one file; opting out removes everything the licensee shared", async () => {
    expect((await call(lic[0]!, "withdraw", { application_ref: H("a") })).body).toEqual({ ok: true, removed: 2 });
    expect((await call(lic[1]!, "check", { entries: [{ kind: "phone", hash: H("1") }] })).body.matches).toEqual([]);
    await call(lic[0]!, "report", { application_ref: H("b"), entries: [{ kind: "bank_account", hash: H("3") }] });
    expect((await call(lic[0]!, "opt-in", { opt_in: false })).body).toEqual({ ok: true, opt_in: false, removed: 1 });
    expect((await call(lic[1]!, "check", { entries: [{ kind: "bank_account", hash: H("3") }] })).body.matches).toEqual([]);
  });
});
