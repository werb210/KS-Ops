// KS_STAFF_DIRECTORY_v1 - staff find their brokerage from their email or mobile number.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { identifierHash, normalizeIdentifier, storedStaffHash } from "../../src/staffDirectory.js";
import { fakeDb, licenseeRow, makeDeps } from "../helpers.js";

const KEY = "ksops_the-right-key";
const ID = licenseeRow().id;
const hash = (kind: "email" | "phone", value: string) => identifierHash(kind, value);

beforeEach(() => {
  process.env.STAFF_DIRECTORY_MIN_MS = "0";
});
afterEach(() => {
  delete process.env.STAFF_DIRECTORY_MIN_MS;
  delete process.env.KS_STAFF_DIRECTORY_PEPPER;
});

describe("identifiers", () => {
  it("normalises emails and North American numbers the same way KS-server does", () => {
    expect(normalizeIdentifier("  Nora@NorthWind.Example ")).toEqual({ kind: "email", value: "nora@northwind.example" });
    expect(normalizeIdentifier("(403) 555-0199")).toEqual({ kind: "phone", value: "+14035550199" });
    expect(normalizeIdentifier("+1 403 555 0199")).toEqual({ kind: "phone", value: "+14035550199" });
    expect(normalizeIdentifier("4035550199x")).toBeNull();
    expect(normalizeIdentifier("12345")).toBeNull();
    expect(normalizeIdentifier("not-an-email@")).toBeNull();
    // The contract value, fixed: KS-server's tests check the same string.
    expect(hash("email", "nora@northwind.example")).toBe(sha256Hex("ks-staff-directory:v1:email:nora@northwind.example"));
  });

  it("keys stored hashes with the pepper when one is set", () => {
    const h = hash("email", "a@b.co");
    expect(storedStaffHash(h, {})).toBe(h);
    expect(storedStaffHash(h, { KS_STAFF_DIRECTORY_PEPPER: "pepper" })).not.toBe(h);
  });
});

describe("POST /api/licensees/:id/staff-directory", () => {
  const db = () => fakeDb([[/SELECT \* FROM licensees WHERE id/, () => [licenseeRow({ ops_key_hash: sha256Hex(KEY) })]]]);

  it("needs the licensee's key", async () => {
    const app = createApp(makeDeps({ db: db() }));
    expect((await request(app).post(`/api/licensees/${ID}/staff-directory`).send({ entries: [] })).status).toBe(401);
    expect((await request(app).post(`/api/licensees/${ID}/staff-directory`).set("X-KS-Ops-Key", "wrong").send({ entries: [] })).status).toBe(401);
  });

  it("replaces the licensee's list with the hashes it sent", async () => {
    const d = db();
    const entries = [
      { kind: "email", hash: hash("email", "nora@northwind.example") },
      { kind: "phone", hash: hash("phone", "+14035550199") },
      { kind: "phone", hash: hash("phone", "+14035550199") },
    ];
    const res = await request(createApp(makeDeps({ db: d }))).post(`/api/licensees/${ID}/staff-directory`).set("X-KS-Ops-Key", KEY).send({ entries });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stored: 2 });
    const del = d.calls.find((c) => /DELETE FROM staff_directory_entries/.test(c.sql))!;
    expect(del.params[0]).toBe(ID);
    const ins = d.calls.find((c) => /INSERT INTO staff_directory_entries/.test(c.sql))!;
    expect(ins.params[1]).toEqual(["email", "phone"]);
    expect(d.calls.some((c) => /staff_directory_count = \$3/.test(c.sql) && c.params[2] === 2)).toBe(true);
  });

  it("refuses anything that is not a hash (plain emails are never accepted)", async () => {
    const res = await request(createApp(makeDeps({ db: db() })))
      .post(`/api/licensees/${ID}/staff-directory`).set("X-KS-Ops-Key", KEY)
      .send({ entries: [{ kind: "email", hash: "nora@northwind.example" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_staff_directory");
  });
});

describe("POST /api/staff-directory/lookup", () => {
  const known = hash("email", "nora@northwind.example");
  const lookupDb = () =>
    fakeDb([[/FROM staff_directory_entries e JOIN licensees l/, (p) =>
      p[0] === known ? [{ company_name: "Northwind Capital", server_url: "https://ks-northwind.example" }] : []]]);

  it("returns only the brokerage's name and server address", async () => {
    const d = lookupDb();
    const res = await request(createApp(makeDeps({ db: d }))).post("/api/staff-directory/lookup").send({ identifier: " NORA@northwind.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [{ name: "Northwind Capital", server_url: "https://ks-northwind.example" }] });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toBe("no-store");
    const call = d.calls.find((c) => /staff_directory_entries/.test(c.sql))!;
    expect(call.params[2]).toEqual(["trial", "active", "past_due"]);
  });

  it("answers an unknown, malformed or missing identifier exactly like a known one with no match", async () => {
    const d = lookupDb();
    const app = createApp(makeDeps({ db: d }));
    for (const body of [{ identifier: "nobody@example.test" }, { identifier: "x" }, {}, { identifier: 42 }]) {
      const res = await request(app).post("/api/staff-directory/lookup").send(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matches: [] });
    }
    // The same query ran every time, so the answer takes the same time.
    expect(d.calls.filter((c) => /staff_directory_entries/.test(c.sql))).toHaveLength(4);
  });

  it("compares with the peppered hash when a pepper is set", async () => {
    process.env.KS_STAFF_DIRECTORY_PEPPER = "pepper";
    const d = lookupDb();
    await request(createApp(makeDeps({ db: d }))).post("/api/staff-directory/lookup").send({ identifier: "nora@northwind.example" });
    const call = d.calls.find((c) => /staff_directory_entries/.test(c.sql))!;
    expect(call.params[0]).toBe(storedStaffHash(known, { KS_STAFF_DIRECTORY_PEPPER: "pepper" }));
  });

  it("is rate limited per caller", async () => {
    const app = createApp(makeDeps());
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(app).post("/api/staff-directory/lookup").send({ identifier: `p${i}@example.test` })).status;
    expect(last).toBe(429);
  });

  it("is rate limited per identifier, whatever address asks", async () => {
    const app = createApp(makeDeps());
    let last = 0;
    for (let i = 0; i < 7; i++) {
      last = (await request(app).post("/api/staff-directory/lookup").set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ identifier: "target@example.test" })).status;
    }
    expect(last).toBe(429);
  });

  it("holds every answer to the minimum time", async () => {
    process.env.STAFF_DIRECTORY_MIN_MS = "120";
    const app = createApp(makeDeps({ db: lookupDb() }));
    const t = Date.now();
    await request(app).post("/api/staff-directory/lookup").send({ identifier: "nobody@example.test" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(110);
  });
});
