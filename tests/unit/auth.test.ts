import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { bfIdentity, exchangeBfToken, verifyStaffToken } from "../../src/auth/staff.js";
import { sha256Hex } from "../../src/lib/crypto.js";
import { fakeDb, jsonResponse, licenseeRow, makeDeps, staffToken } from "../helpers.js";

// The body BF-Server's GET /api/auth/me returns for a staff user (src/routes/auth/me.ts).
const bfMe = (role: string) => ({
  success: true,
  ok: true,
  data: { user: { id: "33333333-3333-4333-8333-333333333333", role, silo: "BF", phone: "+15555550100", first_name: "Ada", last_name: "Admin", email: "ada@boreal.example", silos: [] } },
  userId: "33333333-3333-4333-8333-333333333333",
  role,
});

describe("BF token exchange", () => {
  it("reads the BF-Server /api/auth/me shape", () => {
    expect(bfIdentity(bfMe("Admin"))).toEqual({ id: "33333333-3333-4333-8333-333333333333", role: "Admin", email: "ada@boreal.example", name: "Ada Admin" });
    expect(bfIdentity({ user: { id: "x", role: "Staff" } })).toMatchObject({ id: "x", role: "Staff" });
    expect(bfIdentity({})).toBeNull();
  });

  it("gives Admin users a KS-Ops token", async () => {
    const f = vi.fn(async () => jsonResponse(bfMe("Admin")));
    const r = await exchangeBfToken("bf-token-1234567890", f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledWith("https://bf.example.test/api/auth/me", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer bf-token-1234567890" }) }));
    if (r.ok) {
      expect(verifyStaffToken(r.token)).toMatchObject({ id: "33333333-3333-4333-8333-333333333333", role: "Admin", email: "ada@boreal.example" });
      expect(r.expires_in).toBe(3600);
    }
  });

  it("refuses other roles, bad tokens and an unreachable BF-Server", async () => {
    const staff = await exchangeBfToken("bf-token-1234567890", (async () => jsonResponse(bfMe("Staff"))) as unknown as typeof fetch);
    expect(staff).toMatchObject({ ok: false, status: 403, error: "admin_only" });
    const expired = await exchangeBfToken("bf-token-1234567890", (async () => jsonResponse({ ok: false }, 401)) as unknown as typeof fetch);
    expect(expired).toMatchObject({ ok: false, status: 401 });
    const down = await exchangeBfToken("bf-token-1234567890", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    expect(down).toMatchObject({ ok: false, status: 502 });
    const missing = await exchangeBfToken("", fetch);
    expect(missing).toMatchObject({ ok: false, status: 400 });
  });

  it("works through the route", async () => {
    const deps = makeDeps({ fetch: (async () => jsonResponse(bfMe("admin"))) as unknown as typeof fetch });
    const res = await request(createApp(deps)).post("/api/ops/auth/exchange").send({ bfToken: "bf-token-1234567890" });
    expect(res.status).toBe(200);
    const me = await request(createApp(deps)).get("/api/ops/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.body.user).toMatchObject({ role: "Admin", via: "bf" });
  });
});

describe("staff API guard", () => {
  const app = () => createApp(makeDeps({ db: fakeDb([[/FROM licensees l/, () => []]]) }));

  it("needs a token", async () => {
    expect((await request(app()).get("/api/ops/licensees")).status).toBe(401);
    expect((await request(app()).get("/api/ops/licensees").set("Authorization", "Bearer nonsense")).status).toBe(401);
  });

  it("accepts a KS-Ops token and the break-glass token", async () => {
    expect((await request(app()).get("/api/ops/licensees").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(200);
    const bg = await request(app()).get("/api/ops/licensees").set("Authorization", `Bearer ${process.env.OPS_ADMIN_TOKEN}`);
    expect(bg.status).toBe(200);
  });

  it("rejects expired, foreign and non-admin tokens", async () => {
    const secret = process.env.OPS_JWT_SECRET!;
    const expired = jwt.sign({ typ: "ks-ops-staff", role: "Admin" }, secret, { subject: "x", issuer: "ks-ops", expiresIn: -10 });
    const foreign = jwt.sign({ typ: "ks-ops-staff", role: "Admin" }, "another-secret-another-secret-123", { subject: "x", issuer: "ks-ops" });
    const notAdmin = jwt.sign({ typ: "ks-ops-staff", role: "Staff" }, secret, { subject: "x", issuer: "ks-ops" });
    for (const t of [expired, foreign, notAdmin]) {
      expect((await request(app()).get("/api/ops/licensees").set("Authorization", `Bearer ${t}`)).status).toBe(401);
    }
  });

  it("allows the staff portal origin only", async () => {
    const ok = await request(app()).options("/api/ops/licensees").set("Origin", "https://staff.example.test").set("Access-Control-Request-Method", "GET");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://staff.example.test");
    const bad = await request(app()).options("/api/ops/licensees").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "GET");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("licensee key", () => {
  const key = "ksops_the-right-key";
  const db = () => fakeDb([[/SELECT \* FROM licensees WHERE id/, () => [licenseeRow({ ops_key_hash: sha256Hex(key) })]]]);
  const report = { period: "2026-10", generated_at: "2026-10-20T00:00:00Z", seats: 3, minutes: 10, texts: 5 };

  it("rejects a wrong or missing key", async () => {
    const app = createApp(makeDeps({ db: db() }));
    const id = licenseeRow().id;
    expect((await request(app).post(`/api/licensees/${id}/usage-reports`).send(report)).status).toBe(401);
    expect((await request(app).post(`/api/licensees/${id}/usage-reports`).set("X-KS-Ops-Key", "wrong").send(report)).status).toBe(401);
    expect((await request(app).post(`/api/licensees/not-a-uuid/usage-reports`).set("X-KS-Ops-Key", key).send(report)).status).toBe(401);
  });

  it("accepts the right key", async () => {
    const d = db();
    d.on(/INSERT INTO usage_reports/, () => [{ id: "u1" }]);
    const res = await request(createApp(makeDeps({ db: d }))).post(`/api/licensees/${licenseeRow().id}/usage-reports`).set("X-KS-Ops-Key", key).send(report);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stored: true, period: "2026-10" });
  });
});
