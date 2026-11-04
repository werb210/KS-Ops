// KS_OPS_KB_v2 - a new seed version refreshes untouched starter articles and leaves edited ones alone.
import { describe, expect, it, vi } from "vitest";
import { seedKnowledgeBase } from "../../src/kb/seed.js";

describe("starter library refresh", () => {
  it("updates only rows still owned by keystone", async () => {
    const updates: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, p: unknown[] = []) => {
        if (/FROM kb_seed_runs/.test(sql)) return { rows: [] };
        if (/^\s*UPDATE kb_articles/.test(sql)) { updates.push(p); return { rows: [{ id: "1" }] }; }
        return { rows: [] };
      }),
    };
    const arts = [{ slug: "a", title: "A", category: "c", summary: "s", body: " b ", audience: "public", plans: [] }] as any;
    await seedKnowledgeBase(db as any, arts, 2);
    expect(updates).toEqual([["a", "A", "s", "b"]]);
    const upd = String(db.query.mock.calls.find((c) => /^\s*UPDATE kb_articles/.test(String(c[0])))![0]);
    expect(upd).toMatch(/updated_by = 'keystone'/);
    expect(upd).toMatch(/seed_key IS NOT NULL/);
  });
});
