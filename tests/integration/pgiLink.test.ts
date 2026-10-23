// PGI referral link on the real schema: the worker's selection, linking, a moved server, switching off a stopped licensee.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptSecret, encryptionKey } from "../../src/lib/crypto.js";
import { insertLicensee } from "../../src/licensees/repo.js";
import { syncPgiLinks } from "../../src/sync/pgiLink.js";
import { jsonResponse } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
const now = new Date("2026-10-22T12:00:00Z");
const calls: Array<{ url: string; method: string; body: any }> = [];
const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
  if (url.endsWith("/api/v1/bi/ks/ops/licensees")) {
    return jsonResponse({ referral_source_id: "src-it", credentials: { api_key: "bk_ks_" + "i".repeat(32), callback_secret: "c".repeat(64) } }, 201);
  }
  return jsonResponse({ ok: true });
});

beforeAll(async () => {
  pool = await freshPool();
  process.env.BI_SERVER_URL = "https://bi.example.azurewebsites.net";
  process.env.BI_KEYSTONE_OPS_KEY = "it-bi-key";
});
afterAll(async () => {
  delete process.env.BI_SERVER_URL;
  delete process.env.BI_KEYSTONE_OPS_KEY;
  await pool?.end();
});

describe("PGI link worker (real database)", () => {
  it("links live licensees once, relinks when the server moves, switches off a suspended one", async () => {
    const live = await insertLicensee(pool, {
      company_name: "Live Co", legal_name: "Live Co Ltd", company_code: "live-co", contact_name: "L", contact_email: "l@x.example",
      contact_phone: "4035550100", status: "active", server_url: "https://live-co.azurewebsites.net",
    });
    await insertLicensee(pool, {
      company_name: "Unpaid Co", legal_name: "Unpaid", company_code: "unpaid-co", contact_name: "U", contact_email: "u@x.example",
      contact_phone: "4035550101", status: "pending_payment", server_url: "https://unpaid.azurewebsites.net",
    });
    await pool.query("UPDATE licensees SET ops_key_encrypted = $1", [encryptSecret("ksops_it", encryptionKey()!)]);
    const deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, now: () => now };

    expect(await syncPgiLinks(deps)).toEqual({ tried: 1, linked: 1, disabled: 0 });
    const row = (await pool.query("SELECT pgi_link_status, pgi_source_id, pgi_linked_server_url FROM licensees WHERE id = $1", [live.id])).rows[0];
    expect(row).toEqual({ pgi_link_status: "linked", pgi_source_id: "src-it", pgi_linked_server_url: "https://live-co.azurewebsites.net" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://bi.example.azurewebsites.net/api/v1/bi/ks/ops/licensees"],
      ["PUT", "https://live-co.azurewebsites.net/api/pgi/link"],
    ]);
    expect(await syncPgiLinks(deps)).toEqual({ tried: 0, linked: 0, disabled: 0 });

    await pool.query("UPDATE licensees SET server_url = 'https://live-co-2.azurewebsites.net' WHERE id = $1", [live.id]);
    expect((await syncPgiLinks(deps)).linked).toBe(1);

    await pool.query("UPDATE licensees SET status = 'suspended' WHERE id = $1", [live.id]);
    expect(await syncPgiLinks(deps)).toEqual({ tried: 1, linked: 0, disabled: 1 });
    expect((await pool.query("SELECT pgi_link_status FROM licensees WHERE id = $1", [live.id])).rows[0].pgi_link_status).toBe("disabled");
  });
});
