// KS_OPS_TV_PAIRING_v1 - pairing an Apple TV with a brokerage's server, start to finish, against a small in-memory table.
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { CODE_ALPHABET, normalizeCode } from "../../src/tv/pairing.js";
import { licenseeRow, makeDeps } from "../helpers.js";

function tvDb(licensee: Record<string, unknown>) {
  const rows = new Map<string, any>();
  return {
    rows,
    async query(sql: string, p: any[] = []) {
      const s = sql.replace(/\s+/g, " ");
      if (/^DELETE FROM tv_pairings/.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO tv_pairings/.test(s)) {
        if (rows.has(p[0])) return { rows: [], rowCount: 0 };
        rows.set(p[0], { code: p[0], device_secret_hash: p[1], expires_at: p[2], claimed_at: null, collected_at: null });
        return { rows: [{ code: p[0] }], rowCount: 1 };
      }
      if (/^UPDATE tv_pairings SET claimed_at/.test(s)) {
        const r = rows.get(p[0]);
        if (!r || r.claimed_at || new Date(r.expires_at) <= p[1]) return { rows: [], rowCount: 0 };
        Object.assign(r, { claimed_at: p[1], licensee_id: p[2], server_url: p[3], screen_token: p[4], company_name: p[5], logo_url: p[6], primary_color: p[7] });
        return { rows: [{ code: p[0] }], rowCount: 1 };
      }
      if (/^SELECT \* FROM tv_pairings/.test(s)) { const r = rows.get(p[0]); return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 }; }
      if (/^UPDATE tv_pairings SET collected_at/.test(s)) { Object.assign(rows.get(p[0]), { collected_at: p[1], screen_token: null }); return { rows: [], rowCount: 1 }; }
      if (/FROM licensees/.test(s)) return { rows: [licensee], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const TOKEN = "screen-token-abcdefghijklmnopqrstuvwxyz";

describe("TV pairing", () => {
  it("codes avoid look-alike characters and accept spaces or dashes", () => {
    expect(CODE_ALPHABET).not.toMatch(/[01IO]/);
    expect(normalizeCode("ab3-k7q")).toBe("AB3K7Q");
    expect(normalizeCode("AB0K7Q")).toBeNull();
    expect(normalizeCode("ABC")).toBeNull();
  });

  it("a brokerage claims the code and the TV collects its server and token once", async () => {
    const L = { ...licenseeRow(), server_url: "https://northwind.keystone.example/", logo_url: "https://cdn.example/logo.png", primary_color: "#112233", ops_key_hash: sha256Hex("ops-key-1") };
    const db = tvDb(L);
    const app = createApp(makeDeps({ db: db as any }));
    const start = await request(app).post("/api/tv/pair/start").expect(201);
    const { code, device_secret } = start.body;
    expect(code).toHaveLength(6);

    expect((await request(app).post("/api/tv/pair/collect").send({ code, device_secret })).body.state).toBe("waiting");
    await request(app).post(`/api/licensees/${L.id}/tv/claim`).set("X-KS-Ops-Key", "wrong").send({ code, token: TOKEN }).expect(401);
    await request(app).post(`/api/licensees/${L.id}/tv/claim`).set("X-KS-Ops-Key", "ops-key-1").send({ code: code.toLowerCase(), token: TOKEN }).expect(200);
    // A second claim of the same code fails.
    await request(app).post(`/api/licensees/${L.id}/tv/claim`).set("X-KS-Ops-Key", "ops-key-1").send({ code, token: TOKEN }).expect(404);

    expect((await request(app).post("/api/tv/pair/collect").send({ code, device_secret: "guess" })).body.state).toBe("expired");
    const got = (await request(app).post("/api/tv/pair/collect").send({ code, device_secret })).body;
    expect(got).toMatchObject({ state: "paired", server_url: "https://northwind.keystone.example", token: TOKEN, company: { name: "Northwind Capital", primary_color: "#112233" } });
    expect(db.rows.get(code).screen_token).toBeNull();
    expect((await request(app).post("/api/tv/pair/collect").send({ code, device_secret })).body.state).toBe("expired");
  });

  it("Boreal Financial claims with an admin's BF sign-in, checked with BF-Server", async () => {
    process.env.BF_SERVER_URL = "https://server.boreal.example";
    const db = tvDb({});
    const fetch = vi.fn(async (_url: string, init: any) => new Response(JSON.stringify({ ok: true, data: { user: { id: "u1", role: init.headers.Authorization.includes("staff") ? "Staff" : "Admin", email: "a@b.c" } } }), { status: 200 }));
    const app = createApp(makeDeps({ db: db as any, fetch: fetch as any }));
    const { code, device_secret } = (await request(app).post("/api/tv/pair/start")).body;
    await request(app).post("/api/tv/pair/claim/bf").send({ code, token: TOKEN }).expect(401);
    await request(app).post("/api/tv/pair/claim/bf").set("Authorization", "Bearer staff-token-123").send({ code, token: TOKEN }).expect(403);
    await request(app).post("/api/tv/pair/claim/bf").set("Authorization", "Bearer admin-token-123").send({ code, token: TOKEN }).expect(200);
    expect(fetch.mock.calls[0][0]).toBe("https://server.boreal.example/api/auth/me");
    const got = (await request(app).post("/api/tv/pair/collect").send({ code, device_secret })).body;
    expect(got).toMatchObject({ state: "paired", server_url: "https://server.boreal.example", company: { name: "Boreal Financial" } });
    delete process.env.BF_SERVER_URL;
  });
});
