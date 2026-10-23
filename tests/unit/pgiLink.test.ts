// PGI referrals: linking licensees to the insurance partner and pushing the credentials to their servers.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { encryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { linkPgi, queuePgiBackfill, syncPgiLinks } from "../../src/sync/pgiLink.js";
import { fakeDb, jsonResponse, licenseeRow, makeDeps, staffToken } from "../helpers.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const keyed = (over: Record<string, unknown> = {}) =>
  licenseeRow({ ops_key_encrypted: encryptSecret("ksops_abc", encryptionKey()!), pgi_link_status: "pending", ...over });

function db(row: ReturnType<typeof licenseeRow>) {
  return fakeDb([
    [/SELECT \* FROM licensees WHERE id/, () => [row]],
    [/SELECT id FROM licensees WHERE server_url IS NOT NULL/, () => [{ id: row.id }]],
  ]);
}

function partner(over: { bi?: Response; server?: Response } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("/api/v1/bi/ks/ops/licensees")) {
      return over.bi ?? jsonResponse({ referral_source_id: "src-1", credentials: { api_key: "bk_ks_" + "k".repeat(32), callback_secret: "c".repeat(64), key_prefix: "bk_ks_kkkkkk" } });
    }
    return over.server ?? jsonResponse({ ok: true, configured: true });
  });
}

beforeEach(() => {
  process.env.BI_SERVER_URL = "https://bi-server.example.azurewebsites.net/";
  process.env.BI_KEYSTONE_OPS_KEY = "bi-keystone-key";
});
afterEach(() => {
  delete process.env.BI_SERVER_URL;
  delete process.env.BI_KEYSTONE_OPS_KEY;
});

describe("linking a licensee to the insurance partner", () => {
  it("creates the referral source with fresh credentials and pushes them to the licensee's server", async () => {
    const row = keyed();
    const d = db(row);
    const f = partner();
    const r = await linkPgi({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW }, row.id);
    expect(r).toEqual({ ok: true, action: "linked" });
    const [biUrl, biInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(biUrl).toBe("https://bi-server.example.azurewebsites.net/api/v1/bi/ks/ops/licensees");
    expect((biInit.headers as Record<string, string>)["X-BI-Keystone-Key"]).toBe("bi-keystone-key");
    expect(JSON.parse(String(biInit.body))).toMatchObject({ ks_licensee_id: row.id, company_code: row.company_code, server_url: row.server_url, issue_credentials: true });
    const [srvUrl, srvInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(srvUrl).toBe("https://ks-northwind.example/api/pgi/link");
    expect(srvInit.method).toBe("PUT");
    expect((srvInit.headers as Record<string, string>)["X-KS-Ops-Key"]).toBe("ksops_abc");
    expect(JSON.parse(String(srvInit.body))).toMatchObject({ bi_server_url: "https://bi-server.example.azurewebsites.net", referral_source_id: "src-1", api_key: expect.stringMatching(/^bk_ks_/) });
    const done = d.calls.find((c) => /pgi_link_status = 'linked'/.test(c.sql))!;
    expect(done.params).toEqual([row.id, "src-1", row.server_url]);
    // credentials are never written to KS-Ops' database
    expect(d.calls.some((c) => c.params.some((p) => String(p).startsWith("bk_ks_")))).toBe(false);
  });

  it("failures are recorded and retried later", async () => {
    const row = keyed();
    const d = db(row);
    const r = await linkPgi({ db: d, fetch: partner({ server: new Response("nope", { status: 401 }) }) as unknown as typeof fetch, now: () => NOW }, row.id);
    expect(r).toEqual({ ok: false, error: "licensee server status 401: nope" });
    const upd = d.calls.find((c) => /pgi_link_attempts = pgi_link_attempts \+ 1/.test(c.sql))!;
    expect(upd.params[2]).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    const r2 = await linkPgi({ db: db(keyed()), fetch: partner({ bi: jsonResponse({ error: "server_url_not_allowed" }, 400) }) as unknown as typeof fetch, now: () => NOW }, row.id);
    expect(r2).toEqual({ ok: false, error: "partner status 400: server_url_not_allowed" });
  });

  it("nothing without the partner settings, a server address, an ops key or a live status", async () => {
    const f = vi.fn();
    const deps = (row: ReturnType<typeof licenseeRow>) => ({ db: db(row), fetch: f as unknown as typeof fetch, now: () => NOW });
    expect(await linkPgi(deps(keyed({ server_url: null })), "x")).toEqual({ ok: false, error: "no_server_url" });
    expect(await linkPgi(deps(keyed({ ops_key_encrypted: null })), "x")).toEqual({ ok: false, error: "no_ops_key" });
    expect(await linkPgi(deps(keyed({ status: "pending_payment" })), "x")).toEqual({ ok: false, error: "licensee_not_live" });
    delete process.env.BI_SERVER_URL;
    expect(await linkPgi(deps(keyed()), "x")).toEqual({ ok: false, error: "bi_not_configured" });
    expect(await syncPgiLinks(deps(keyed()))).toEqual({ tried: 0, linked: 0, disabled: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("a suspended or cancelled licensee is switched off at the partner", async () => {
    const row = keyed({ status: "suspended", pgi_link_status: "linked" });
    const d = db(row);
    const f = vi.fn(async () => jsonResponse({ active: false }));
    const r = await linkPgi({ db: d, fetch: f as unknown as typeof fetch, now: () => NOW }, row.id);
    expect(r).toEqual({ ok: true, action: "disabled" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://bi-server.example.azurewebsites.net/api/v1/bi/ks/ops/licensees/${row.id}`);
    expect(init.method).toBe("PATCH");
    expect(d.calls.some((c) => /pgi_link_status = 'disabled'/.test(c.sql))).toBe(true);
  });

  it("the worker links everyone due (the backfill for existing licensees) and staff can queue a relink", async () => {
    const row = keyed();
    const d = db(row);
    const r = await syncPgiLinks({ db: d, fetch: partner() as unknown as typeof fetch, now: () => NOW });
    expect(r).toEqual({ tried: 1, linked: 1, disabled: 0 });
    const pick = d.calls.find((c) => /SELECT id FROM licensees WHERE server_url IS NOT NULL/.test(c.sql.replace(/\s+/g, " ")))!;
    expect(pick.sql).toMatch(/pgi_linked_server_url IS DISTINCT FROM server_url/);
    const d2 = fakeDb([[/UPDATE licensees SET pgi_link_status = CASE/, () => [{ id: "a" }, { id: "b" }]]]);
    expect(await queuePgiBackfill({ db: d2 })).toBe(2);
  });
});

describe("staff endpoints", () => {
  it("POST /api/ops/licensees/:id/pgi-link links now; POST /api/ops/pgi/backfill queues everyone", async () => {
    const row = keyed();
    const d = db(row);
    d.on(/UPDATE licensees SET pgi_link_status = CASE/, () => [{ id: row.id }]);
    const app = createApp(makeDeps({ db: d, fetch: partner() as unknown as typeof fetch }));
    const auth = { Authorization: `Bearer ${staffToken()}` };
    const linked = await request(app).post(`/api/ops/licensees/${row.id}/pgi-link`).set(auth);
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ ok: true, action: "linked" });
    const queued = await request(app).post("/api/ops/pgi/backfill").set(auth);
    expect(queued.body).toEqual({ ok: true, queued: 1 });
    expect((await request(app).post("/api/ops/pgi/backfill")).status).toBe(401);
    delete process.env.BI_SERVER_URL;
    expect((await request(app).post(`/api/ops/licensees/${row.id}/pgi-link`).set(auth)).status).toBe(503);
  });
});
