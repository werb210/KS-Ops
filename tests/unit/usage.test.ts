import { describe, expect, it, vi } from "vitest";
import { encryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { isFinal, pullUsageReport, storeUsageReport, usageReportSchema } from "../../src/sync/usage.js";
import { fakeDb, jsonResponse, licenseeRow } from "../helpers.js";

const report = {
  licensee_id: "22222222-2222-4222-8222-222222222222",
  period: "2026-09",
  generated_at: "2026-10-01T00:05:00Z",
  plan: "growth",
  effective_plan: "growth",
  trial: { status: "not_offered", started_at: null, ends_at: null },
  seats: 3,
  minutes: 1600,
  texts: 1400,
  assistant_chats: 50,
  storage_bytes: 1024,
  allowances: { minutes: 1500, texts: 1500, assistant_chats: 1000, storage_bytes: 1 },
  overage: { minutes: 100, texts: 0 },
  extra_storage_blocks: 0,
};

describe("usage reports", () => {
  it("validates the UsageReport shape", () => {
    expect(usageReportSchema.safeParse(report).success).toBe(true);
    expect(usageReportSchema.safeParse({ ...report, period: "2026-13" }).success).toBe(false);
    expect(usageReportSchema.safeParse({ ...report, generated_at: "yesterday" }).success).toBe(false);
    expect(usageReportSchema.safeParse({ ...report, minutes: -1 }).success).toBe(false);
  });

  it("knows when a month's report is final", () => {
    expect(isFinal("2026-09", "2026-10-01T00:05:00Z")).toBe(true);
    expect(isFinal("2026-09", "2026-09-30T23:59:00Z")).toBe(false);
    expect(isFinal("2026-12", "2027-01-01T00:00:00Z")).toBe(true);
  });

  it("stores one row per licensee and month, and only a report at least as new replaces it", async () => {
    const db = fakeDb([[/INSERT INTO usage_reports/, () => ({ rows: [], rowCount: 0 })]]);
    const r = await storeUsageReport(db, report.licensee_id, usageReportSchema.parse(report), "push");
    expect(r).toEqual({ stored: false, period: "2026-09" });
    const sql = db.calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("ON CONFLICT (licensee_id, period) DO UPDATE");
    expect(sql).toContain("WHERE usage_reports.generated_at <= EXCLUDED.generated_at");
    expect(db.calls[0].params.slice(0, 2)).toEqual([report.licensee_id, "2026-09"]);
    expect(db.calls[0].params[10]).toBe(100); // overage minutes
  });

  it("pulls a report from the licensee's server", async () => {
    const row = licenseeRow({ ops_key_encrypted: encryptSecret("ksops_abc", encryptionKey()!) });
    const db = fakeDb([
      [/SELECT \* FROM licensees WHERE id/, () => [row]],
      [/INSERT INTO usage_reports/, () => [{ id: "u1" }]],
    ]);
    const f = vi.fn(async () => jsonResponse(report));
    const r = await pullUsageReport({ db, fetch: f as unknown as typeof fetch }, row.id, "2026-09");
    expect(r).toMatchObject({ ok: true, stored: true });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://ks-northwind.example/api/plan/usage-report?period=2026-09");
    expect((init.headers as Record<string, string>)["X-KS-Ops-Key"]).toBe("ksops_abc");
    const wrong = await pullUsageReport({ db, fetch: (async () => jsonResponse({ ...report, period: "2026-08" })) as unknown as typeof fetch }, row.id, "2026-09");
    expect(wrong).toEqual({ ok: false, error: "wrong_period" });
  });
});
