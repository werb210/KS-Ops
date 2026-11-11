// KS_OPS_OUTREACH_v1 - the brokerage list end to end against real Postgres: the import (firms matched by company id,
// domain and name; people with and without email), qualification and priority, the exclusion ledger, the owner call
// list, touches, the channel scoreboard, tracked links and referrals. All names are invented.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });

const ROWS = [
  { country: "Canada", company: "Northfield Leasing Inc.", company_id: "C100", contact_name: "Olive Owner", person_id: "P1", title: "President", email: "olive@northfield-leasing.example", direct_phone: "(555) 010-0001", mobile_phone: "(555) 010-0002", mobile_dnc: "Y", website: "https://northfield-leasing.example", qualification_status: "Qualified — brokerage", verification_url: "https://northfield-leasing.example/team", employee_count: 14, address_line1: "1 Main St", city: "Calgary", province_state: "ab", postal_code: "t2p 1a1", technologies: "HubSpot; RingCentral" },
  { country: "Canada", company: "Northfield Leasing", company_id: "C100", contact_name: "Bram Broker", person_id: "P2", title: "Equipment Finance Broker", mobile_phone: "(555) 010-0003", qualification_status: "Qualified" },
  { country: "Canada", company: "Northfield Leasing", company_id: "C100", contact_name: "Uma Unclear", person_id: "P3", title: "Account Manager", email: "uma@northfield-leasing.example", qualification_status: "Review — brokerage confirmed, individual sales role unclear" },
  { country: "United States", company: "Solo Capital LLC", contact_name: "Sam Solo", title: "Business Loan Broker", email: "sam@solocapital.example", direct_phone: "(555) 020-0001", website: "https://www.solocapital.example" },
  { country: "Canada", company: "Deskwork Finance", contact_name: "Ada Admin", title: "Office Administrator", email: "ada@deskwork.example" },
  { country: "Canada", company: "Big Direct Lender Corp", company_id: "C900", contact_name: "Lee Lender", title: "President", email: "lee@bigdirect.example", firm_type: "direct_lender" },
  { country: "Canada", company: "", contact_name: "No Firm" },
  { country: "Canada", company: "Bad Email Co", contact_name: "Bad Email", email: "not-an-email" },
];
const firm = async (name: string) => (await pool.query(`SELECT * FROM ks_brokerages WHERE name = $1`, [name])).rows[0];

beforeAll(async () => {
  pool = await freshPool();
  await pool.query(`TRUNCATE ks_brokerages, ks_broker_people, ks_mkt_touches, ks_mkt_channel_items, ks_mkt_links, ks_referrals, ks_prospects, ks_prospect_events, ks_mkt_sends CASCADE`);
  await pool.query(`UPDATE ks_outreach_settings SET fit_rules = '{}'::jsonb WHERE id = 1`);
  deps = { db: pool, fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, mailer: fakeMailer().mailer, stripe: () => null, now: () => new Date() };
});
afterAll(async () => { await pool?.end(); });

describe("brokerage list import", () => {
  it("needs a staff sign-in", async () => {
    expect((await request(app()).get("/api/ops/outreach/brokerages")).status).toBe(401);
  });

  it("groups people under their firm, keeps people with no email, and links those with one as prospects", async () => {
    const res = await request(app()).post("/api/ops/outreach/import").set(staff()).send({ rows: ROWS, consent: { consent_type: "implied_publication", consent_source: "Published on the firm's team page" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: 8, brokerages_added: 4, people_added: 6, prospects_linked: 5 });
    expect(res.body.skipped.map((s: any) => s.row)).toEqual([7, 8]);
    const n = await firm("Northfield Leasing Inc.");
    expect(n).toMatchObject({ country: "CA", province_state: "AB", postal_code: "T2P 1A1", employee_count: 14, domain: "northfield-leasing.example", external_id: "C100", qualification: "keep" });
    expect(n.current_tools).toEqual(["HubSpot", "RingCentral"]);
    expect(n.fit_score).toBeGreaterThanOrEqual(80);
    const people = (await pool.query(`SELECT name, email, is_owner, needs_review, mobile_dnc, prospect_id FROM ks_broker_people WHERE brokerage_id = $1 ORDER BY name`, [n.id])).rows;
    expect(people.map((p) => p.name)).toEqual(["Bram Broker", "Olive Owner", "Uma Unclear"]);
    expect(people[0]).toMatchObject({ email: null, prospect_id: null });
    expect(people[1]).toMatchObject({ is_owner: true, mobile_dnc: true });
    expect(people[1].prospect_id).toBeTruthy();
    expect(people[2].needs_review).toBe(true);
    const p = (await pool.query(`SELECT consent_type, source FROM ks_prospects WHERE lower(email) = 'olive@northfield-leasing.example'`)).rows[0];
    expect(p).toEqual({ consent_type: "implied_publication", source: "import" });
  });

  it("qualifies by what the firm is, not its size: solo broker kept, no decision-maker to research, lender removed", async () => {
    expect((await firm("Solo Capital LLC")).qualification).toBe("keep");
    expect((await firm("Deskwork Finance")).qualification).toBe("research");
    const lender = await firm("Big Direct Lender Corp");
    expect(lender.qualification).toBe("remove");
    expect(lender.qualification_reason).toMatch(/Direct lender/);
  });

  it("importing again adds nothing new, and a removed firm stays out (the exclusion ledger)", async () => {
    const res = await request(app()).post("/api/ops/outreach/import").set(staff()).send({
      rows: [ROWS[0], { country: "Canada", company: "Big Direct Lender", company_id: "C900", contact_name: "New Person", title: "Broker", email: "new@bigdirect.example" }],
    });
    expect(res.body).toMatchObject({ brokerages_added: 0, people_added: 0, people_updated: 1, excluded: 1 });
    expect((await pool.query(`SELECT 1 FROM ks_broker_people WHERE name = 'New Person'`)).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM ks_prospects WHERE lower(email) = 'new@bigdirect.example'`)).rows).toHaveLength(0);
  });

  it("a staff decision on the qualification is locked against re-scoring", async () => {
    const d = await firm("Deskwork Finance");
    const res = await request(app()).patch(`/api/ops/outreach/brokerages/${d.id}`).set(staff()).send({ qualification: "remove", firm_type: "non_financing" });
    expect(res.status).toBe(200);
    expect(res.body.brokerage).toMatchObject({ qualification: "remove", qualification_locked: true });
    await request(app()).put("/api/ops/outreach/fit-rules").set(staff()).send({ rules: { w_owner: 40 } });
    expect((await firm("Deskwork Finance")).qualification).toBe("remove");
    const list = await request(app()).get("/api/ops/outreach/brokerages?qualification=keep").set(staff());
    expect(list.body.brokerages.map((b: any) => b.name)).toEqual(["Northfield Leasing Inc.", "Solo Capital LLC"]);
    expect(list.body.counts).toMatchObject({ keep: 2, remove: 2 });
  });
});

describe("phone, touches and the scoreboard", () => {
  it("lists one decision-maker per kept firm with only the numbers that may be called", async () => {
    const res = await request(app()).get("/api/ops/outreach/call-list").set(staff());
    expect(res.body.calls.map((c: any) => [c.brokerage, c.name, c.direct_phone, c.mobile_phone])).toEqual([
      ["Northfield Leasing Inc.", "Olive Owner", "(555) 010-0001", null],
      ["Solo Capital LLC", "Sam Solo", "(555) 020-0001", null],
    ]);
  });

  it("logs a call, rests the firm, and counts it on the phone channel", async () => {
    const calls = (await request(app()).get("/api/ops/outreach/call-list").set(staff())).body.calls;
    const t = await request(app()).post("/api/ops/outreach/touches").set(staff()).send({ channel_key: "phone", brokerage_id: calls[0].brokerage_id, person_id: calls[0].person_id, outcome: "owner_conversation", summary: "Booked 15 minutes for Tuesday.", cost_cents: 0 });
    expect(t.status).toBe(201);
    expect((await request(app()).post("/api/ops/outreach/touches").set(staff()).send({ channel_key: "carrier-pigeon", outcome: "sent" })).status).toBe(400);
    const again = (await request(app()).get("/api/ops/outreach/call-list").set(staff())).body.calls;
    expect(again.map((c: any) => c.brokerage)).toEqual(["Solo Capital LLC"]);
    await request(app()).patch("/api/ops/outreach/channels/phone").set(staff()).send({ test_started_on: new Date().toISOString().slice(0, 10), budget_cents: 20000 });
    const board = (await request(app()).get("/api/ops/outreach/channels").set(staff())).body.channels;
    expect(board).toHaveLength(13);
    const phone = board.find((c: any) => c.key === "phone");
    expect(phone).toMatchObject({ touches: 1, firms: 1, owner_conversations: 1, decision: "testing", test_days_left: 28 });
  });

  it("\"do not contact\" on a call stops that person being rung again", async () => {
    const calls = (await request(app()).get("/api/ops/outreach/call-list").set(staff())).body.calls;
    await request(app()).post("/api/ops/outreach/touches").set(staff()).send({ channel_key: "phone", brokerage_id: calls[0].brokerage_id, person_id: calls[0].person_id, outcome: "do_not_contact", at: "2020-01-01T00:00:00Z" });
    expect((await request(app()).get("/api/ops/outreach/call-list").set(staff())).body.calls).toEqual([]);
  });
});

describe("items, tracked links and referrals", () => {
  it("an event with a tracked link: the click is credited to the channel, the item and the firm", async () => {
    const n = await firm("Northfield Leasing Inc.");
    const item = await request(app()).post("/api/ops/outreach/items").set(staff()).send({ channel_key: "mail", kind: "mail_batch", name: "Owner letter, wave 1", cost_cents: 4500 });
    expect(item.status).toBe(201);
    const link = await request(app()).post("/api/ops/outreach/links").set(staff()).send({ channel_key: "mail", brokerage_id: n.id, item_id: item.body.item.id, target_url: "https://www.keystone.example/try", label: "Letter QR code" });
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/\/api\/public\/marketing\/l\/[a-z0-9]{7}$/);
    expect((await request(app()).post("/api/ops/outreach/links").set(staff()).send({ channel_key: "mail", target_url: "http://insecure.example" })).status).toBe(400);
    const go = await request(app()).get(`/api/public/marketing/l/${link.body.link.code}`);
    expect(go.status).toBe(302);
    expect(go.headers.location).toBe("https://www.keystone.example/try");
    expect((await request(app()).get("/api/public/marketing/l/nosuchcode")).status).toBe(302);
    const mail = (await request(app()).get("/api/ops/outreach/channels").set(staff())).body.channels.find((c: any) => c.key === "mail");
    expect(mail).toMatchObject({ clicks: 1, touches: 0, items: 1, cost_cents: 4500 });
    const items = (await request(app()).get("/api/ops/outreach/items?channel=mail").set(staff())).body.items;
    expect(items[0]).toMatchObject({ name: "Owner letter, wave 1", clicks: 1 });
    const detail = (await request(app()).get(`/api/ops/outreach/brokerages/${n.id}`).set(staff())).body;
    expect(detail.people[0].name).toBe("Olive Owner");
    expect(detail.touches.some((t: any) => t.outcome === "click" && t.item_name === "Owner letter, wave 1")).toBe(true);
  });

  it("tracks a referral from the code to the reward applied", async () => {
    const s = await firm("Solo Capital LLC");
    const made = await request(app()).post("/api/ops/outreach/referrals").set(staff()).send({ referrer_name: "First Customer Brokerage", referred_brokerage_id: s.id, reward: "One month free per seat", reward_cents: 14700 });
    expect(made.status).toBe(201);
    expect(made.body.referral).toMatchObject({ status: "referred" });
    expect(made.body.referral.code).toMatch(/^[A-Z0-9]{8}$/);
    await request(app()).patch(`/api/ops/outreach/referrals/${made.body.referral.id}`).set(staff()).send({ status: "reward_owed" });
    expect((await request(app()).get("/api/ops/outreach/referrals").set(staff())).body.owed_cents).toBe(14700);
    const done = await request(app()).patch(`/api/ops/outreach/referrals/${made.body.referral.id}`).set(staff()).send({ status: "reward_applied" });
    expect(done.body.referral.reward_applied_at).toBeTruthy();
    expect((await request(app()).get("/api/ops/outreach/referrals").set(staff())).body.owed_cents).toBe(0);
  });
});

// KS_OPS_OUTREACH_v2
describe("mail, the LinkedIn company list and webinar sign-ups", () => {
  it("makes a mail batch: one letter per firm with an address, its own tracked link, a PDF and a label file", async () => {
    await request(app()).put("/api/ops/outreach/letter").set(staff()).send({ greeting: "Dear {{first_name}},", body: "A note for {{company}}.", closing: "Sincerely,", signature: "Pat Founder", ps: "P.S. Scan the code.", target_url: "https://www.keystone.example/tour" });
    const ready = await request(app()).get("/api/ops/outreach/mail/ready").set(staff());
    expect(ready.body).toMatchObject({ ready: 1, without_address: 1 });
    expect(ready.body.first[0]).toMatchObject({ company: "Northfield Leasing Inc.", name: "Olive Owner" });
    const made = await request(app()).post("/api/ops/outreach/mail/batches").set(staff()).send({ name: "Owner letter, wave 2", limit: 50, cost_per_letter_cents: 150 });
    expect(made.status).toBe(201);
    expect(made.body.count).toBe(1);
    const pdf = await request(app()).get(`/api/ops/outreach/mail/batches/${made.body.item_id}/letters`).set(staff());
    expect(pdf.body).toMatchObject({ filename: "Owner-letter-wave-2.pdf", letters: 1 });
    expect(Buffer.from(pdf.body.data_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const labels = await request(app()).get(`/api/ops/outreach/mail/batches/${made.body.item_id}/labels`).set(staff());
    const line = labels.body.csv.split("\r\n")[1];
    expect(line).toMatch(/^Olive Owner,President,Northfield Leasing Inc\.,1 Main St,,Calgary,AB,T2P 1A1,CA,https?:\/\/.+\/api\/public\/marketing\/l\/[a-z0-9]{7}$/);
    const link = (await pool.query(`SELECT target_url FROM ks_mkt_links WHERE item_id = $1`, [made.body.item_id])).rows[0];
    expect(link.target_url).toBe("https://www.keystone.example/tour");
    // Written to once: the firm is not offered again, and a second batch has no one to write to.
    expect((await request(app()).get("/api/ops/outreach/mail/ready").set(staff())).body.ready).toBe(0);
    expect((await request(app()).post("/api/ops/outreach/mail/batches").set(staff()).send({ name: "Again", limit: 5 })).status).toBe(400);
    const mail = (await request(app()).get("/api/ops/outreach/channels").set(staff())).body.channels.find((c: any) => c.key === "mail");
    expect(mail.touches).toBe(1);
    expect(mail.cost_cents).toBe(4500 + 150);
  });

  it("exports kept firms as a LinkedIn company list", async () => {
    const res = await request(app()).get("/api/ops/outreach/ads/linkedin-audience?countries=CA").set(staff());
    expect(res.body.count).toBe(1);
    expect(res.body.csv.split("\r\n").slice(0, 2)).toEqual(["companyname,companywebsite,companyemaildomain,city,state,companycountry", "Northfield Leasing Inc.,https://northfield-leasing.example,northfield-leasing.example,Calgary,AB,CA"]);
  });

  it("a webinar sign-up becomes a prospect with express consent and is credited to the webinar", async () => {
    const item = await request(app()).post("/api/ops/outreach/items").set(staff()).send({ channel_key: "podcasts_webinars", kind: "webinar", name: "How we cut file prep time", happens_on: "2026-12-10", notes: "30 minutes, live." });
    const id = item.body.item.id;
    const pageRes = await request(app()).get(`/api/public/marketing/webinar/${id}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain("How we cut file prep time");
    expect((await request(app()).get(`/api/public/marketing/webinar/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`)).status).toBe(404);
    expect((await request(app()).post(`/api/public/marketing/webinar/${id}`).type("form").send({ name: "Wes Webinar", email: "wes@webinar.example", company: "Webinar Capital" })).status).toBe(400);
    const ok = await request(app()).post(`/api/public/marketing/webinar/${id}`).type("form").send({ name: "Wes Webinar", email: "wes@webinar.example", company: "Webinar Capital", consent: "yes" });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("You are in");
    await request(app()).post(`/api/public/marketing/webinar/${id}`).type("form").send({ name: "Wes Webinar", email: "wes@webinar.example", company: "Webinar Capital", consent: "yes" });
    const p = (await pool.query(`SELECT consent_type, company FROM ks_prospects WHERE lower(email) = 'wes@webinar.example'`)).rows[0];
    expect(p).toEqual({ consent_type: "express", company: "Webinar Capital" });
    expect((await pool.query(`SELECT count(*)::int AS n FROM ks_mkt_touches WHERE item_id = $1`, [id])).rows[0].n).toBe(1);
  });
});
