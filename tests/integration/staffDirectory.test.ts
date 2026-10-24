// KS_STAFF_DIRECTORY_v1 - the staff directory end to end against real Postgres: two brokerages push their staff lists,
// a person in both gets both, a full push replaces the old list, and a suspended brokerage is never returned.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { identifierHash } from "../../src/staffDirectory.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const lic: Array<{ id: string; key: string }> = [];

async function makeLicensee(code: string, name: string): Promise<{ id: string; key: string }> {
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: name, legal_name: `${name} Inc.`, company_code: code, contact_name: "A B", contact_email: `${code}@x.example`,
    contact_phone: "403-555-0123", plan: "pro", billing: "monthly", support_level: "email", seats: 2, country: "CA", status: "active",
    server_url: `https://ks-${code}.azurewebsites.net`,
  });
  expect(res.status).toBe(201);
  return { id: res.body.licensee.id, key: res.body.ops_key };
}

const push = (l: { id: string; key: string }, entries: Array<{ kind: "email" | "phone"; hash: string }>) =>
  request(app()).post(`/api/licensees/${l.id}/staff-directory`).set("X-KS-Ops-Key", l.key).send({ entries });
const lookup = (identifier: string) => request(app()).post("/api/staff-directory/lookup").send({ identifier });
const email = (v: string) => ({ kind: "email" as const, hash: identifierHash("email", v) });
const phone = (v: string) => ({ kind: "phone" as const, hash: identifierHash("phone", v) });

beforeAll(async () => {
  process.env.KS_STAFF_DIRECTORY_PEPPER = "ops-side-pepper";
  process.env.STAFF_DIRECTORY_MIN_MS = "0";
  pool = await freshPool();
  await pool.query("TRUNCATE staff_directory_entries");
  deps = { db: pool, fetch: (async () => new Response("{}")) as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => new Date("2026-10-24T12:00:00Z") };
  lic.push(await makeLicensee("sd-alpha", "Alpha Capital"), await makeLicensee("sd-beta", "Beta Funding"));
});

afterAll(async () => {
  delete process.env.KS_STAFF_DIRECTORY_PEPPER;
  delete process.env.STAFF_DIRECTORY_MIN_MS;
  await pool.end();
});

describe("staff directory", () => {
  it("finds the brokerage(s) for an email or mobile number", async () => {
    expect((await push(lic[0]!, [email("ann@alpha.example"), phone("+14035550101"), email("shared@example.test")])).body).toEqual({ ok: true, stored: 3 });
    expect((await push(lic[1]!, [email("shared@example.test")])).body).toEqual({ ok: true, stored: 1 });

    expect((await lookup("Ann@Alpha.example")).body).toEqual({ matches: [{ name: "Alpha Capital", server_url: "https://ks-sd-alpha.azurewebsites.net" }] });
    expect((await lookup("(403) 555-0101")).body.matches).toHaveLength(1);
    expect((await lookup("shared@example.test")).body.matches.map((m: { name: string }) => m.name)).toEqual(["Alpha Capital", "Beta Funding"]);
    expect((await lookup("nobody@example.test")).body).toEqual({ matches: [] });

    // Hashes are keyed again before they are stored.
    const stored = (await pool.query(`SELECT hash FROM staff_directory_entries WHERE licensee_id = $1`, [lic[0]!.id])).rows.map((r) => r.hash);
    expect(stored).not.toContain(identifierHash("email", "ann@alpha.example"));
    const row = (await pool.query(`SELECT staff_directory_count FROM licensees WHERE id = $1`, [lic[0]!.id])).rows[0];
    expect(row.staff_directory_count).toBe(3);
  });

  it("a new push replaces the old list (a removed person is no longer found)", async () => {
    expect((await push(lic[0]!, [email("shared@example.test")])).body).toEqual({ ok: true, stored: 1 });
    expect((await lookup("ann@alpha.example")).body).toEqual({ matches: [] });
    expect((await push(lic[0]!, [email("shared@example.test")])).body).toEqual({ ok: true, stored: 1 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM staff_directory_entries WHERE licensee_id = $1`, [lic[0]!.id])).rows[0].n).toBe(1);
  });

  it("never returns a brokerage that is not live", async () => {
    await pool.query(`UPDATE licensees SET status = 'suspended' WHERE id = $1`, [lic[1]!.id]);
    expect((await lookup("shared@example.test")).body.matches.map((m: { name: string }) => m.name)).toEqual(["Alpha Capital"]);
  });
});
