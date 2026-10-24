// KS_OPS_BETA_v1 - the beta features programme: who sees and gets which feature, the schemas, the plan push carrying
// the flags, the ops page, the auth gates, the website sign-up and its CRM push.
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { betaCreateSchema, betaUpdateSchema, flagFor, snapshotFrom, type BetaFeatureRow } from "../../src/beta/catalogue.js";
import { betaSignupNote } from "../../src/crm/triggers.js";
import { pushPlan } from "../../src/sync/planPush.js";
import { encryptionKey, encryptSecret } from "../../src/lib/crypto.js";
import { BETA_PAGE_HTML } from "../../src/routes/opsBetaPage.js";
import { fakeDb, licenseeRow, makeDeps, staffToken } from "../helpers.js";

const feat = (over: Partial<BetaFeatureRow> = {}): BetaFeatureRow => ({
  key: "ai_notes", name: "AI notes", description: "Writes call notes.", status: "public_beta", plans: [], open: true,
  feedback_url: null, docs_url: null, ...over,
});

describe("who sees which feature", () => {
  it("a public beta is shown to eligible licensees, joinable while open, and on only once joined", () => {
    expect(flagFor(feat(), "starter", false)).toMatchObject({ enabled: false, can_join: true, can_leave: false });
    expect(flagFor(feat({ open: false }), "starter", false)).toMatchObject({ enabled: false, can_join: false });
    expect(flagFor(feat(), "starter", true)).toMatchObject({ enabled: true, enrolled: true, can_join: false, can_leave: true });
  });

  it("plan limits hide a beta from other plans, but someone already in keeps it", () => {
    const pro = feat({ plans: ["pro"] });
    expect(flagFor(pro, "starter", false)).toBeNull();
    expect(flagFor(pro, "pro", false)).toMatchObject({ can_join: true });
    expect(flagFor(pro, "starter", true)).toMatchObject({ enabled: true });
  });

  it("a private beta is invisible unless enrolled; GA is on for allowed plans and cannot be left; retired is gone", () => {
    expect(flagFor(feat({ status: "private_beta" }), "pro", false)).toBeNull();
    expect(flagFor(feat({ status: "private_beta" }), "pro", true)).toMatchObject({ enabled: true, can_leave: true, can_join: false });
    expect(flagFor(feat({ status: "ga" }), "growth", false)).toMatchObject({ enabled: true, can_leave: false, can_join: false });
    expect(flagFor(feat({ status: "ga", plans: ["pro"] }), "growth", false)).toBeNull();
    expect(flagFor(feat({ status: "retired" }), "pro", true)).toBeNull();
  });

  it("builds the snapshot in catalogue order", () => {
    const s = snapshotFrom([feat({ key: "a_one" }), feat({ key: "b_two", status: "retired" }), feat({ key: "c_three", status: "ga" })], "pro", ["a_one"]);
    expect(s.map((f) => [f.key, f.enabled])).toEqual([["a_one", true], ["c_three", true]]);
  });
});

describe("schemas", () => {
  it("validates keys, plans and links on create", () => {
    expect(betaCreateSchema.safeParse({ key: "AI_Notes", name: "AI notes" }).data).toMatchObject({ key: "ai_notes", status: "private_beta", plans: [], open: true });
    expect(betaCreateSchema.safeParse({ key: "1bad", name: "x" }).success).toBe(false);
    expect(betaCreateSchema.safeParse({ key: "ok_key", name: "x", plans: ["enterprise"] }).success).toBe(false);
    expect(betaCreateSchema.safeParse({ key: "ok_key", name: "x", feedback_url: "http://insecure.example" }).success).toBe(false);
    expect(betaCreateSchema.safeParse({ key: "ok_key", name: "x", feedback_url: "" }).data?.feedback_url).toBeNull();
  });

  it("does not apply defaults on a partial update", () => {
    expect(betaUpdateSchema.parse({ open: false })).toEqual({ open: false });
  });
});

describe("the plan push carries the licensee's beta features", () => {
  it("sends beta_features with the plan", async () => {
    const l = licenseeRow({ plan: "pro", ops_key_hash: "x", ops_key_encrypted: encryptSecret("ksops_key", encryptionKey()!) });
    const db = fakeDb([
      [/SELECT \* FROM licensees WHERE id/, () => [l]],
      [/SELECT \* FROM beta_features/, () => [feat(), feat({ key: "hidden_one", status: "private_beta" })]],
      [/SELECT feature_key FROM beta_enrolments/, () => [{ feature_key: "ai_notes" }]],
    ]);
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await pushPlan({ db, fetch: fetch as unknown as typeof globalThis.fetch, now: () => new Date() }, l.id)).toEqual({ ok: true });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.beta_features).toEqual([expect.objectContaining({ key: "ai_notes", enabled: true, enrolled: true })]);
  });

  it("still pushes the plan when the beta tables cannot be read", async () => {
    const l = licenseeRow({ plan: "pro", ops_key_hash: "x", ops_key_encrypted: encryptSecret("ksops_key", encryptionKey()!) });
    const db = fakeDb([
      [/SELECT \* FROM licensees WHERE id/, () => [l]],
      [/FROM beta_features/, () => { throw new Error("relation \"beta_features\" does not exist"); }],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await pushPlan({ db, fetch: fetch as unknown as typeof globalThis.fetch, now: () => new Date() }, l.id)).toEqual({ ok: true });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty("beta_features");
    warn.mockRestore();
  });
});

describe("routes", () => {
  it("serves the ops page without data, and the ops API only with a staff token", async () => {
    const app = createApp(makeDeps());
    const page = await request(app).get("/ops/beta");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Beta features");
    expect(BETA_PAGE_HTML).not.toMatch(/587-?888-?1837/);
    expect((await request(app).get("/api/ops/beta/features")).status).toBe(401);
    const ok = await request(createApp(makeDeps({ db: fakeDb([[/FROM beta_features/, () => [feat()]]]) })))
      .get("/api/ops/beta/features").set("Authorization", `Bearer ${staffToken()}`);
    expect(ok.status).toBe(200);
    expect(ok.body.features[0]).toMatchObject({ key: "ai_notes", status: "public_beta" });
  });

  it("refuses licensee calls without the right ops key", async () => {
    const app = createApp(makeDeps());
    const r = await request(app).post("/api/licensees/22222222-2222-4222-8222-222222222222/beta/enrolment").send({ feature_key: "ai_notes", action: "join" });
    expect(r.status).toBe(401);
  });

  it("rejects a bad beta key on create", async () => {
    const r = await request(createApp(makeDeps())).post("/api/ops/beta/features").set("Authorization", `Bearer ${staffToken()}`).send({ key: "Bad Key", name: "x" });
    expect(r.status).toBe(400);
    expect(r.body.errors.key).toBeTruthy();
  });
});

describe("website beta sign-up", () => {
  it("validates, drops honeypot fills and unknown interests", async () => {
    const db = fakeDb([[/INSERT INTO beta_signups/, (p) => [{ id: "33333333-3333-4333-8333-333333333333", created_at: new Date(), interests: p[3] }]]]);
    const app = createApp(makeDeps({ db }));
    expect((await request(app).post("/api/public/beta-signup").send({ name: "", email: "x", brokerage: "" })).status).toBe(400);
    expect((await request(app).post("/api/public/beta-signup").send({ name: "Bo", email: "bo@x.example", brokerage: "B", website_url: "spam" })).status).toBe(400);
    const ok = await request(app).post("/api/public/beta-signup").send({ name: "Bo Brown", email: "Bo@X.example", brokerage: "Brown Capital", interests: ["mobile_apps", "nonsense"] });
    expect(ok.status).toBe(201);
    const ins = db.calls.find((c) => /INSERT INTO beta_signups/.test(c.sql))!;
    expect(ins.params.slice(0, 4)).toEqual(["Bo Brown", "bo@x.example", "Brown Capital", ["mobile_apps"]]);
  });

  it("writes a readable CRM note", () => {
    expect(betaSignupNote({ id: "x", name: "Bo", email: "b@x", brokerage: "Brown Capital", interests: ["Mobile apps"], message: "Keen" }))
      .toBe("Bo from Brown Capital joined the Keystone beta programme on the website.\nInterests: Mobile apps.\nTheir note: Keen");
  });
});
