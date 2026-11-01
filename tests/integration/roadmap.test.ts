// KS_OPS_ROADMAP_v1 against a real Postgres: ideas from the website are stored with consent and stay private until a
// person approves them; the public list never shows who asked or voted; +1s are one per browser; staff moderate.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { IDEA_CONSENT_TEXT } from "../../src/roadmap/roadmap.js";
import { ROADMAP_PAGE_HTML } from "../../src/routes/opsRoadmapPage.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
const mail = fakeMailer();
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const idea = (over: Record<string, unknown> = {}) => ({
  title: "Hold queue for the main line", details: "Callers should wait for the next free person.",
  name: "Dana Fraser", email: "Dana@PrairieCap.example", brokerage: "Prairie Capital", consent: true, website_url: "", ...over,
});

beforeAll(async () => {
  pool = await freshPool();
  await pool.query("TRUNCATE roadmap_votes, roadmap_ideas, roadmap_items CASCADE");
  deps = { db: pool, fetch: (async () => jsonResponse({})) as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => {
  await pool.end();
});
beforeEach(() => {
  mail.sent.length = 0;
});

describe("ideas from the website", () => {
  it("needs consent, refuses the honeypot, and stores the consent wording", async () => {
    const noConsent = await request(app()).post("/api/public/roadmap/ideas").send(idea({ consent: false }));
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.errors.consent).toBeTruthy();
    const bot = await request(app()).post("/api/public/roadmap/ideas").send(idea({ website_url: "http://spam.example" }));
    expect(bot.status).toBe(400);

    const ok = await request(app()).post("/api/public/roadmap/ideas").send(idea());
    expect(ok.status).toBe(201);
    expect(ok.body.message).toMatch(/reviewed/);
    const again = await request(app()).post("/api/public/roadmap/ideas").send(idea());
    expect(again.status).toBe(201);
    const rows = await pool.query("SELECT email, consent_text, status, ip_hash FROM roadmap_ideas");
    expect(rows.rows).toHaveLength(1); // the same idea twice in a day is stored once
    expect(rows.rows[0]).toMatchObject({ email: "dana@prairiecap.example", consent_text: IDEA_CONSENT_TEXT, status: "pending" });
    expect(mail.sent).toHaveLength(1); // sales hears about it once, not for the duplicate
    expect(mail.sent[0].subject).toBe("Roadmap idea: Hold queue for the main line");
  });

  it("is not public until a person approves it", async () => {
    const r = await request(app()).get("/api/public/roadmap");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

describe("moderation and the public list", () => {
  let itemId = "";
  it("staff see the idea with its sender; the public list never does", async () => {
    expect((await request(app()).get("/api/ops/roadmap")).status).toBe(401);
    const list = await request(app()).get("/api/ops/roadmap").set(staff());
    expect(list.status).toBe(200);
    const pending = list.body.ideas.find((d: any) => d.status === "pending");
    expect(pending).toMatchObject({ name: "Dana Fraser", email: "dana@prairiecap.example" });

    const ap = await request(app()).post(`/api/ops/roadmap/ideas/${pending.id}/approve`).set(staff())
      .send({ title: "Hold queue for callers", summary: "Callers wait on hold for the next free person.", status: "planned", area: "Phones" });
    expect(ap.status).toBe(201);
    itemId = ap.body.item.id;
    expect((await request(app()).post(`/api/ops/roadmap/ideas/${pending.id}/approve`).set(staff()).send({})).status).toBe(404);

    const pub = await request(app()).get("/api/public/roadmap");
    expect(pub.body.items).toEqual([{ id: itemId, title: "Hold queue for callers", summary: "Callers wait on hold for the next free person.", area: "Phones", status: "planned", votes: 0, shipped_at: null }]);
    const text = JSON.stringify(pub.body);
    expect(text).not.toMatch(/Dana|prairiecap|Prairie Capital/i);
    const audit = await pool.query("SELECT action FROM staff_audit WHERE action LIKE 'roadmap.%'");
    expect(audit.rows.map((r) => r.action)).toContain("roadmap.idea_approve");
  });

  it("+1 is once per browser, can be taken back, and is stored only as a hash", async () => {
    const v = (voter: string, on = true) => request(app()).post(`/api/public/roadmap/items/${itemId}/${on ? "vote" : "unvote"}`).send({ voter_id: voter });
    expect((await v("browser-aaaaaaaaaaaaaaaa")).body).toEqual({ votes: 1, voted: true });
    expect((await v("browser-aaaaaaaaaaaaaaaa")).body.votes).toBe(1);
    expect((await v("browser-bbbbbbbbbbbbbbbb")).body.votes).toBe(2);
    expect((await v("browser-aaaaaaaaaaaaaaaa", false)).body).toEqual({ votes: 1, voted: false });
    expect((await v("short")).status).toBe(400);
    const stored = await pool.query("SELECT voter_hash FROM roadmap_votes");
    expect(JSON.stringify(stored.rows)).not.toContain("browser-");
  });

  it("merges and rejects ideas, hides items, and closes voting once shipped", async () => {
    await request(app()).post("/api/public/roadmap/ideas").send(idea({ title: "Hold music", email: "lee@x.example" }));
    await request(app()).post("/api/public/roadmap/ideas").send(idea({ title: "buy cheap watches", email: "spam@x.example" }));
    const list = (await request(app()).get("/api/ops/roadmap").set(staff())).body.ideas;
    const music = list.find((d: any) => d.title === "Hold music");
    const spam = list.find((d: any) => d.title === "buy cheap watches");
    expect((await request(app()).post(`/api/ops/roadmap/ideas/${music.id}/merge`).set(staff()).send({ item_id: itemId })).status).toBe(200);
    expect((await request(app()).post(`/api/ops/roadmap/ideas/${spam.id}/reject`).set(staff()).send({ note: "spam" })).status).toBe(200);
    const items = (await request(app()).get("/api/ops/roadmap").set(staff())).body.items;
    expect(items.find((i: any) => i.id === itemId).ideas).toBe(2);
    expect(JSON.stringify((await request(app()).get("/api/public/roadmap")).body)).not.toMatch(/watches/);

    const created = await request(app()).post("/api/ops/roadmap/items").set(staff()).send({ title: "Internal only", public: false });
    expect(created.status).toBe(201);
    expect((await request(app()).get("/api/public/roadmap")).body.items.map((i: any) => i.title)).not.toContain("Internal only");

    const shipped = await request(app()).patch(`/api/ops/roadmap/items/${itemId}`).set(staff()).send({ status: "shipped" });
    expect(shipped.body.item.status).toBe("shipped");
    expect(shipped.body.item.shipped_at).toBeTruthy();
    expect((await request(app()).post(`/api/public/roadmap/items/${itemId}/vote`).send({ voter_id: "browser-cccccccccccccccc" })).status).toBe(404);
  });

  it("serves the moderation page, which writes broker text as text", async () => {
    const r = await request(app()).get("/ops/roadmap");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Ideas waiting for review");
    expect(ROADMAP_PAGE_HTML).not.toMatch(/innerHTML/);
  });
});
