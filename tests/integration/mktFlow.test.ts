// KS_OPS_MKT_FLOW_v1 - the Keystone broker email flow against real Postgres: created once with its seven templates,
// people started a set number a day, opened / not opened / clicked each get the right next email, a mail filter's
// click is ignored, a real click is sent to the Keystone CRM (BF-Server makes the call task), and a reply stops it.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { flushTimelineOutbox } from "../../src/marketing/events.js";
import { runFlows, inSendingHours } from "../../src/marketing/flow.js";
import { fakeMailer, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let deps: Deps;
let now = new Date("2031-03-03T16:00:00Z"); // Monday 10:00 in Alberta
const DAY = 86_400_000;
const sent: Array<{ to: string; subject: string; from: string; sendId: string }> = [];
const timeline: any[] = [];
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const TOKEN = "webhook-token-0123456789-abcdefghij";
const people = ["quiet", "opener", "clicker", "scanner", "replier"];
let flowId = "";
const at = (days: number, hours = 0) => new Date(new Date("2031-03-03T16:00:00Z").getTime() + days * DAY + hours * 3_600_000);
const sendIdFor = (who: string) => sent.filter((s) => s.to.startsWith(who)).at(-1)!.sendId;
async function event(who: string, type: "open" | "click", when: Date, url = "https://www.keystonecrm.online/features") {
  const body = [{ event: type, email: `${who}@brokers.example`, timestamp: Math.floor(when.getTime() / 1000), sg_event_id: `${who}-${type}-${when.getTime()}`, url, ks_mkt: "1", ks_mkt_send_id: sendIdFor(who) }];
  const r = await request(app()).post(`/api/public/marketing/sendgrid-events?token=${TOKEN}`).set("Content-Type", "application/json").send(JSON.stringify(body));
  expect(r.status).toBe(200);
}
const enrolment = async (who: string) => (await pool.query(
  `SELECT e.* FROM ks_mkt_enrollments e JOIN ks_prospects p ON p.id = e.prospect_id WHERE p.email = $1`, [`${who}@brokers.example`])).rows[0];
const keysSent = () => sent.map((s) => `${s.to.split("@")[0]}:${s.subject.slice(0, 12)}`);

beforeAll(async () => {
  process.env.BF_CRM_KEY = "ks-ops-crm-key-0123456789-0123456789";
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.KS_MARKETING_FROM = "sales@keystone.example";
  process.env.KS_OPS_PUBLIC_URL = "https://ops.keystone.example";
  process.env.KS_MARKETING_WEBHOOK_TOKEN = TOKEN;
  pool = await freshPool();
  await pool.query(`TRUNCATE ks_prospects, ks_prospect_events, ks_mkt_suppressions, ks_mkt_templates, ks_mkt_sequences, ks_mkt_enrollments, ks_mkt_sends, ks_mkt_timeline_outbox CASCADE`);
  let n = 0;
  deps = {
    db: pool,
    fetch: (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      if (u === "https://api.sendgrid.com/v3/mail/send") {
        const body = JSON.parse(String(init.body));
        sent.push({ to: body.personalizations[0].to[0].email, subject: body.subject, from: body.from.name, sendId: body.personalizations[0].custom_args.ks_mkt_send_id });
        return new Response("", { status: 202, headers: { "x-message-id": `m-${++n}` } });
      }
      if (u.includes("/api/ks/marketing/events")) { timeline.push(JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }
      if (u.includes("whitelabel/domains")) return new Response(JSON.stringify([{ domain: "keystone.example", valid: true }]), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    mailer: fakeMailer().mailer,
    stripe: () => null,
    now: () => now,
  };
  for (const who of people) {
    await pool.query(
      `INSERT INTO ks_prospects (email, name, company, source, status, consent_type, consent_source, consent_at, consent_expires_at, country)
       VALUES ($1, $2, 'Sample Brokerage', 'crm', 'lead', 'implied_publication', 'Published on the brokerage website', $3, $3::timestamptz + interval '12 months', 'CA')`,
      [`${who}@brokers.example`, `${who[0]!.toUpperCase()}${who.slice(1)} Sample`, now],
    );
  }
});
afterAll(async () => { await pool?.end(); });

describe("the Keystone broker email flow", () => {
  it("is created once, as a draft flow with seven templates, and starts people a set number a day", async () => {
    const r = await request(app()).post("/api/ops/marketing/flows/keystone-brokers").set(staff());
    expect(r.status).toBe(201);
    flowId = r.body.sequence.id;
    expect(r.body.sequence).toMatchObject({ kind: "flow", status: "draft", from_name: "Todd at Keystone" });
    expect(r.body.sequence.steps).toHaveLength(7);
    expect((await request(app()).post("/api/ops/marketing/flows/keystone-brokers").set(staff())).body.created).toBe(false);
    await pool.query(`UPDATE ks_mkt_sequences SET daily_new = 4 WHERE id = $1`, [flowId]);
    const en = await request(app()).post(`/api/ops/marketing/sequences/${flowId}/enroll`).set(staff()).send({ filters: {} });
    expect(en.body).toMatchObject({ ok: true, enrolled: 5 });
    await request(app()).patch(`/api/ops/marketing/sequences/${flowId}`).set(staff()).send({ status: "active" });
    const firsts = (await pool.query(`SELECT next_send_at FROM ks_mkt_enrollments WHERE sequence_id = $1 ORDER BY next_send_at`, [flowId])).rows.map((x: any) => x.next_send_at.toISOString());
    expect(firsts.filter((d: string) => d === now.toISOString())).toHaveLength(4);
    expect(firsts[4]).toBe(inSendingHours(new Date(now.getTime() + DAY)).toISOString());
  });

  it("sends the first email from Todd, four today and the fifth tomorrow", async () => {
    await runFlows(deps);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((s) => s.from))).toEqual(new Set(["Todd at Keystone"]));
    expect(sent[0]!.subject).toBe("Software built by commercial brokers, for commercial brokers");
    now = at(1); await runFlows(deps);
    expect(sent).toHaveLength(5);
  });

  it("opens, clicks and a mail filter's click each lead to the right next email", async () => {
    await event("opener", "open", at(1, 1));
    await event("clicker", "open", at(1, 1));
    await event("clicker", "click", at(1, 2));
    await event("scanner", "click", new Date(at(0).getTime() + 20_000)); // 20 seconds after it was sent
    sent.length = 0;
    now = at(1, 3); await runFlows(deps);
    expect(keysSent()).toEqual(["clicker:Want a 20-mi"]);
    expect((await enrolment("clicker")).status).toBe("completed");
    expect((await enrolment("opener")).flow_next).toBe("o1");
    expect((await enrolment("scanner")).track).toBe("none");
    await flushTimelineOutbox(deps);
    const clicks = timeline.flatMap((t) => t.events.filter((e: any) => e.type === "flow_clicked").map((e: any) => t.email));
    expect(clicks).toEqual(["clicker@brokers.example"]);

    sent.length = 0;
    now = at(3, 1); await runFlows(deps); // Thursday: two business days after Tuesday's open
    expect(keysSent()).toEqual(["opener:A deal in Ke"]);
  });

  it("a reply stops the flow; everyone else who never opened gets the week-1 email", async () => {
    await pool.query(`UPDATE ks_prospects SET last_replied_at = $2 WHERE email = $1`, ["replier@brokers.example", at(2)]);
    sent.length = 0;
    now = at(8, 1); await runFlows(deps);
    expect(keysSent().sort()).toEqual(["quiet:One login in", "scanner:One login in"]);
    expect((await enrolment("replier")).status).toBe("stopped");
    const list = await request(app()).get("/api/ops/marketing/sequences").set(staff());
    expect(list.body.sequences.find((s: any) => s.id === flowId)).toMatchObject({ opened: 1, clicked: 1 });
  });
});
