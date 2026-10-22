// The shared fraud watchlist: validation, hashing at rest and the queries (fake database answering by SQL content).
import { describe, expect, it } from "vitest";
import { checkEntries, checkSchema, replaceReport, reportSchema, setOptIn, storedHash } from "../../src/watchlist.js";
import { fakeDb } from "../helpers.js";

const H = (c: string) => c.repeat(64);

describe("watchlist", () => {
  it("accepts only kind + 64-hex hashes, at most 50", () => {
    expect(reportSchema.safeParse({ application_ref: H("a"), entries: [{ kind: "phone", hash: H("b") }] }).success).toBe(true);
    expect(reportSchema.safeParse({ application_ref: H("a"), entries: [{ kind: "phone", hash: "5875550100" }] }).success).toBe(false);
    expect(reportSchema.safeParse({ application_ref: H("a"), entries: [{ kind: "ssn", hash: H("b") }] }).success).toBe(false);
    expect(checkSchema.safeParse({ entries: Array.from({ length: 51 }, () => ({ kind: "email", hash: H("c") })) }).success).toBe(false);
    expect(checkSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it("keys hashes again at rest when KS_WATCHLIST_OPS_PEPPER is set", () => {
    expect(storedHash(H("a"), {} as any)).toBe(H("a"));
    const s = storedHash(H("a"), { KS_WATCHLIST_OPS_PEPPER: "ops-pepper" } as any);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(s).not.toBe(H("a"));
    expect(storedHash(H("a"), { KS_WATCHLIST_OPS_PEPPER: "ops-pepper" } as any)).toBe(s);
  });

  it("opting out deletes what the licensee shared", async () => {
    const db = fakeDb([[/DELETE FROM watchlist_entries WHERE licensee_id = \$1$/, () => ({ rows: [], rowCount: 4 })]]);
    expect(await setOptIn(db, "L1", false, new Date())).toEqual({ removed: 4 });
    expect(db.calls[0]!.sql).toMatch(/UPDATE licensees SET watchlist_opt_in/);
    expect(await setOptIn(db, "L1", true, new Date())).toEqual({ removed: 0 });
  });

  it("a report replaces the file's entries; check answers with the caller's own hashes only", async () => {
    const db = fakeDb([
      [/INSERT INTO watchlist_entries/, () => ({ rows: [], rowCount: 1 })],
      [/FROM watchlist_entries w JOIN licensees/, (p) => [{ hash: (p[0] as string[])[0], kind: "phone", brokerages: 2, reports: 3 }, { hash: "someone-else", kind: "email", brokerages: 1, reports: 1 }]],
    ]);
    expect(await replaceReport(db, "L1", H("f"), [{ kind: "phone", hash: H("b") }, { kind: "email", hash: H("c") }], {} as any)).toBe(2);
    expect(db.calls[0]!.sql).toMatch(/^DELETE FROM watchlist_entries WHERE licensee_id = \$1 AND application_ref = \$2/);
    const m = await checkEntries(db, "L2", [{ kind: "phone", hash: H("b") }], {} as any);
    expect(m).toEqual([{ kind: "phone", hash: H("b"), brokerages: 2, reports: 3 }]);
    expect(db.calls.at(-1)!.sql).toMatch(/w\.licensee_id <> \$2 AND l\.watchlist_opt_in = true/);
  });
});
