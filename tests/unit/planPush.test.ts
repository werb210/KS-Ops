import { describe, expect, it, vi } from "vitest";
import { encryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { planPushBody, pushPlan, queueStatusPush, retryPendingPlanPushes } from "../../src/sync/planPush.js";
import { fakeDb, jsonResponse, licenseeRow } from "../helpers.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const keyed = (over: Record<string, unknown> = {}) =>
  licenseeRow({ plan: "pro", extra_storage_blocks: 2, ops_key_encrypted: encryptSecret("ksops_abc", encryptionKey()!), ...over });

function db(row: ReturnType<typeof licenseeRow>) {
  return fakeDb([
    [/SELECT \* FROM licensees WHERE id/, () => [row]],
    [/SELECT id FROM licensees WHERE plan_sync_status = 'pending_sync'/, () => [{ id: row.id }]],
  ]);
}

describe("plan push", () => {
  it("PUTs the plan to the licensee's server with the ops key and marks it synced", async () => {
    const d = db(keyed());
    const f = vi.fn(async () => jsonResponse({ plan: "pro" }));
    const r = await pushPlan({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW }, keyed().id, "ada@example.test");
    expect(r).toEqual({ ok: true });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://ks-northwind.example/api/plan");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["X-KS-Ops-Key"]).toBe("ksops_abc");
    expect(JSON.parse(String(init.body))).toEqual({ plan: "pro", extra_storage_blocks: 2, status: "active", addons: { bank_connect: false }, beta_features: [] });
    expect(d.calls.some((c) => /plan_sync_status = 'synced'/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /UPDATE plan_changes SET status = 'pushed'/.test(c.sql))).toBe(true);
  });

  it("on failure marks pending_sync and schedules a retry in 5 minutes", async () => {
    const d = db(keyed());
    const f = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await pushPlan({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW }, keyed().id);
    expect(r).toEqual({ ok: false, error: "status 503: down" });
    const upd = d.calls.find((c) => /plan_sync_status = 'pending_sync'/.test(c.sql))!;
    expect(upd.params[2]).toEqual(new Date(NOW.getTime() + 5 * 60_000));
  });

  it("network errors and missing server address or key are failures too", async () => {
    const boom = vi.fn(async () => { throw new Error("ECONNRESET"); });
    expect(await pushPlan({ db: db(keyed()), fetch: boom as unknown as typeof fetch, now: () => NOW }, keyed().id)).toEqual({ ok: false, error: "ECONNRESET" });
    const f = vi.fn();
    expect(await pushPlan({ db: db(keyed({ server_url: null })), fetch: f as unknown as typeof fetch, now: () => NOW }, keyed().id)).toEqual({ ok: false, error: "no_server_url" });
    expect(await pushPlan({ db: db(keyed({ ops_key_encrypted: null })), fetch: f as unknown as typeof fetch, now: () => NOW }, keyed().id)).toEqual({ ok: false, error: "no_ops_key" });
    expect(f).not.toHaveBeenCalled();
  });

  it("the retry worker pushes licensees that are due", async () => {
    const d = db(keyed({ plan_sync_status: "pending_sync" }));
    const f = vi.fn(async () => jsonResponse({}));
    const r = await retryPendingPlanPushes({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW });
    expect(r).toEqual({ tried: 1, pushed: 1 });
    const pick = d.calls.find((c) => /pending_sync/.test(c.sql) && /SELECT id/.test(c.sql))!;
    expect(pick.params[0]).toEqual(NOW);
  });

  it("sends status only once the licensee is live", () => {
    for (const status of ["trial", "active", "past_due", "suspended", "cancelled"]) {
      expect(planPushBody({ plan: "growth", extra_storage_blocks: 0, status })).toEqual({ plan: "growth", extra_storage_blocks: 0, status, addons: { bank_connect: false } });
    }
    for (const status of ["pending_payment", "provisioning"]) {
      expect(planPushBody({ plan: "growth", extra_storage_blocks: 0, status })).toEqual({ plan: "growth", extra_storage_blocks: 0, addons: { bank_connect: false } });
    }
  });

  // KS_OPS_BANK_CONNECT_ADDON - the add-on set always travels in full, so switching it off reaches the server too.
  it("sends the bank_connect add-on as an explicit boolean", () => {
    expect(planPushBody({ plan: "starter", extra_storage_blocks: 0, status: "active", addons: { bank_connect: true } }).addons).toEqual({ bank_connect: true });
    expect(planPushBody({ plan: "pro", extra_storage_blocks: 0, status: "active", addons: { other: true } as any }).addons).toEqual({ bank_connect: false });
    expect(planPushBody({ plan: "pro", extra_storage_blocks: 0, status: "active", addons: null }).addons).toEqual({ bank_connect: false });
  });

  it("a suspended licensee's server is told so", async () => {
    const d = db(keyed({ status: "suspended" }));
    const f = vi.fn(async () => jsonResponse({}));
    await pushPlan({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW }, keyed().id);
    const [, init] = (f.mock.calls[0] as unknown) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ status: "suspended" });
  });

  it("queues a status push: records the change and marks pending_sync, only for live statuses with a server", async () => {
    const d = fakeDb([[/INSERT INTO plan_changes/, () => [{ id: "pc1" }]]]);
    expect(await queueStatusPush(d, "lid", "active", "cancelled", "stripe-webhook")).toBe(true);
    const ins = d.calls.find((c) => /INSERT INTO plan_changes/.test(c.sql))!;
    expect(ins.sql).toMatch(/server_url IS NOT NULL/);
    expect(ins.params).toEqual(["lid", "active", "cancelled", "stripe-webhook"]);
    expect(d.calls.some((c) => /plan_sync_status = 'pending_sync', plan_sync_next_at = NULL/.test(c.sql))).toBe(true);
    const d2 = fakeDb();
    expect(await queueStatusPush(d2, "lid", "pending_payment", "provisioning", "x")).toBe(false);
    expect(await queueStatusPush(d2, "lid", "active", "active", "x")).toBe(false);
    expect(d2.calls).toHaveLength(0);
    // No server yet: nothing recorded, nothing marked.
    expect(await queueStatusPush(d2, "lid", "trial", "cancelled", "x")).toBe(false);
    expect(d2.calls.some((c) => /pending_sync/.test(c.sql))).toBe(false);
  });
});
