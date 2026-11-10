// KS_OPS_NUMBER_PORTING_v1 against a real Postgres: a brokerage keeps its existing number. The licensee's KS-server
// (faked through fetch) relays the request, the letter is signed, staff move it through every status, the owner is
// emailed each time, and completion attaches the number on the server. The account number and PIN are only ever
// stored encrypted. Test numbers only (555).
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { Deps } from "../../src/deps.js";
import { fakeMailer, jsonResponse, staffToken } from "../helpers.js";
import { freshPool } from "./db.js";

let pool: pg.Pool;
let now = new Date("2026-11-10T15:00:00Z");
const mail = fakeMailer();
const attachCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let attachStatus: "attached" | "not_in_account" = "not_in_account";
const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
  if (url === "https://ks-port.example.test/api/provision/ported-numbers") {
    const body = JSON.parse(String(init.body));
    attachCalls.push({ url, headers: init.headers as Record<string, string>, body });
    return jsonResponse({
      ok: true,
      results: body.numbers.map((n: any) => attachStatus === "attached"
        ? { phone_number: n.phone_number, status: "attached", kind: "direct", released: n.temporary_number, release_after: "2026-12-01T15:00:00.000Z" }
        : { phone_number: n.phone_number, status: "failed", error: "not_in_account", message: "Twilio does not show it in the account yet." }),
    });
  }
  return new Response("unexpected", { status: 500 });
});

let deps: Deps;
const app = () => createApp(deps);
const staff = () => ({ Authorization: `Bearer ${staffToken()}` });
const PDF = Buffer.from("%PDF-1.4\n% test bill\n").toString("base64");
const ACCOUNT = "880012345678";
const PIN = "2468";

let id = "";
let opsKey = "";
let rid = "";

beforeAll(async () => {
  pool = await freshPool();
  deps = { db: pool, fetch: fetchImpl as unknown as typeof fetch, mailer: mail.mailer, stripe: () => null, now: () => now };
  const res = await request(app()).post("/api/ops/licensees").set(staff()).send({
    company_name: "Porting Co", legal_name: "Porting Co Ltd.", company_code: "porting-co",
    contact_name: "Pat Owner", contact_email: "pat@porting.example", contact_phone: "403-555-0170",
    plan: "growth", billing: "monthly", support_level: "email", seats: 3, country: "CA", status: "active",
  });
  expect(res.status).toBe(201);
  id = res.body.licensee.id;
  opsKey = res.body.ops_key;
  await pool.query("UPDATE licensees SET server_url = 'https://ks-port.example.test' WHERE id = $1", [id]);
});
afterAll(async () => {
  await pool.end();
});

const relay = (path: string) => request(app()).post(`/api/licensees/${id}/port-requests${path}`).set("X-KS-Ops-Key", opsKey);
const goodRequest = () => ({
  company_name: "Porting Co", carrier: "telus", account_number: ACCOUNT, pin: PIN, account_name: "Porting Co Ltd.",
  service_address: { line1: "200 Test Avenue SW", city: "Calgary", region: "ab", postal_code: "t2p 1a1", country: "CA" },
  numbers: [{ phone_number: "(403) 555-0188", number_type: "mobile", user_id: "u-bea", assignee_name: "Bea Broker", temporary_number: "+14035550111" }],
  bill: { filename: "telus-bill.pdf", content_type: "application/pdf", data_base64: PDF },
  forwarding_tested: true,
  requested_by: { id: "u-admin", name: "Ana Admin", email: "ana@porting.example" },
});

describe("keeping an existing number (real Postgres)", () => {
  it("needs the licensee's ops key", async () => {
    expect((await request(app()).post(`/api/licensees/${id}/port-requests/list`).send({})).status).toBe(401);
  });

  it("explains what is missing, field by field", async () => {
    const r = await relay("").send({ ...goodRequest(), carrier: "other", account_number: "", numbers: [{ phone_number: "1-800-555-0100", number_type: "local" }], bill: { filename: "x.txt", content_type: "text/plain", data_base64: Buffer.from("hello there").toString("base64") } });
    expect(r.status).toBe(400);
    expect(r.body.errors).toMatchObject({ account_number: expect.stringContaining("account number") });
    const r2 = await relay("").send({ ...goodRequest(), carrier: "other", numbers: [{ phone_number: "1-800-555-0100", number_type: "local" }], bill: { filename: "x.txt", content_type: "text/plain", data_base64: Buffer.from("hello there").toString("base64") } });
    expect(r2.body.errors).toMatchObject({ carrier_other: expect.any(String), "numbers.0.number_type": expect.stringContaining("toll-free"), bill: expect.stringContaining("PDF") });
  });

  it("saves a draft with the account number and PIN encrypted, and shows them masked", async () => {
    const r = await relay("").send(goodRequest());
    expect(r.status).toBe(201);
    rid = r.body.request.id;
    expect(r.body.request).toMatchObject({ status: "draft", account_number_masked: "••••5678", pin_on_file: true, needs_signature: true, carrier_label: "Telus" });
    expect(r.body.request.numbers[0]).toMatchObject({ phone_number: "+14035550188", assignee_name: "Bea Broker", temporary_number: "+14035550111" });
    expect(r.body.request.numbers[0].forwarding_tested_at).toBeTruthy();
    expect(r.body.loa.text).toContain(ACCOUNT);
    expect(r.body.loa.text).not.toContain(PIN);
    expect(JSON.stringify(r.body)).not.toContain(PIN);
    const row = (await pool.query("SELECT * FROM port_requests WHERE id = $1", [rid])).rows[0];
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
    expect(JSON.stringify(row)).not.toContain(PIN);
    expect(row.account_number_encrypted).toMatch(/^v1:/);
    // The same number cannot be in two open requests.
    expect((await relay("").send(goodRequest())).body.errors["numbers.0.phone_number"]).toMatch(/already being transferred/);
    // Support hears about it.
    expect(mail.sent.at(-1)!.subject).toMatch(/Number transfer requested: Porting Co/);
    expect(mail.sent.at(-1)!.text).not.toContain(ACCOUNT);
  });

  it("signing the letter makes it ready, emails the owner from support, and keeps the signature record", async () => {
    const loa = await relay(`/${rid}/loa`).send({});
    expect(loa.status).toBe(200);
    expect((await relay(`/${rid}/sign`).send({ signer_name: "Pat Owner", signer_title: "President", agree: true, sha256: "0".repeat(64) })).status).toBe(409);
    const s = await relay(`/${rid}/sign`).send({ signer_name: "Pat Owner", signer_title: "President", agree: true, sha256: loa.body.sha256, signer_email: "pat@porting.example", ip: "203.0.113.5", user_agent: "Test" });
    expect(s.status).toBe(200);
    expect(s.body.request).toMatchObject({ status: "ready_to_submit", needs_signature: false, loa: { signer_name: "Pat Owner", expired: false } });
    const sig = (await pool.query("SELECT * FROM port_request_loas WHERE port_request_id = $1", [rid])).rows[0];
    expect(sig).toMatchObject({ ip: "203.0.113.5", text_sha256: loa.body.sha256, version: loa.body.version });
    expect(sig.rendered_text_encrypted).not.toContain(ACCOUNT);
    const m = mail.sent.at(-1)!;
    expect(m.to).toEqual(["pat@porting.example", "ana@porting.example"]);
    expect(m.from?.email).toBe("support@keystonecrm.online");
    expect(m.text).toContain("keep the call forwarding on");
  });

  it("staff see everything Twilio asks for, and every view is audited", async () => {
    const list = await request(app()).get("/api/ops/porting").set(staff());
    expect(list.status).toBe(200);
    expect(list.body.requests[0]).toMatchObject({ id: rid, status: "ready_to_submit", company_code: "porting-co", next: expect.arrayContaining(["submitted"]) });
    expect(JSON.stringify(list.body)).not.toContain(ACCOUNT);
    const d = await request(app()).get(`/api/ops/porting/${rid}`).set(staff());
    const fields = Object.fromEntries(d.body.checklist.fields);
    expect(fields).toMatchObject({ "Account number": ACCOUNT, "Account PIN": PIN, "Current carrier": "Telus", "Service address line 1": "200 Test Avenue SW", "Postal / ZIP code": "T2P 1A1", "Province / state": "AB" });
    expect(d.body.checklist.where).toMatch(/porting request form/);
    const audits = (await pool.query("SELECT action FROM staff_audit WHERE licensee_id = $1", [id])).rows.map((x) => x.action);
    expect(audits).toContain("port_request.details_viewed");
    const bill = await request(app()).get(`/api/ops/porting/${rid}/bill`).set(staff());
    expect(bill.status).toBe(200);
    expect(bill.headers["content-type"]).toMatch(/application\/pdf/);
    const loa = await request(app()).get(`/api/ops/porting/${rid}/loa`).set(staff());
    expect(loa.text).toContain("Pat Owner, President");
    expect(loa.text).toContain(ACCOUNT);
    expect(loa.text).not.toContain(PIN);
    expect((await request(app()).get("/ops/porting")).text).toContain("Number transfers");
  });

  it("refuses moves that skip steps, and needs a reason or a date where it matters", async () => {
    const move = (body: Record<string, unknown>) => request(app()).post(`/api/ops/porting/${rid}/status`).set(staff()).send(body);
    expect((await move({ status: "completed" })).status).toBe(409);
    expect((await move({ status: "rejected" })).body.error).toBe("reason_required");
  });

  it("an old letter goes back to the brokerage to sign again", async () => {
    now = new Date("2026-12-15T15:00:00Z");
    const r = await request(app()).post(`/api/ops/porting/${rid}/status`).set(staff()).send({ status: "submitted" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("loa_expired");
    expect((await pool.query("SELECT status FROM port_requests WHERE id = $1", [rid])).rows[0].status).toBe("draft");
    expect(mail.sent.at(-1)!.subject).toMatch(/Please sign again/);
    const loa = await relay(`/${rid}/loa`).send({});
    const s = await relay(`/${rid}/sign`).send({ signer_name: "Pat Owner", signer_title: "President", agree: true, sha256: loa.body.sha256 });
    expect(s.body.request.status).toBe("ready_to_submit");
  });

  it("submitted, carrier approval (90 minutes), scheduled with the FOC date - the owner is emailed each time", async () => {
    const move = (body: Record<string, unknown>) => request(app()).post(`/api/ops/porting/${rid}/status`).set(staff()).send(body);
    const sub = await move({ status: "submitted", twilio_reference: "TICKET-1234" });
    expect(sub.status).toBe(200);
    expect(sub.body.emailed).toBe(true);
    expect(mail.sent.at(-1)!.subject).toMatch(/Submitted/);
    expect((await relay(`/${rid}/cancel`).send({ by: "Ana" })).status).toBe(409); // with the carrier now
    const cap = await move({ status: "carrier_approval_pending" });
    expect(cap.status).toBe(200);
    expect(mail.sent.at(-1)!.subject).toMatch(/within 90 minutes/);
    expect(mail.sent.at(-1)!.text).toMatch(/approve it within 90 minutes/);
    expect((await move({ status: "scheduled", foc_date: "next week" })).body.error).toBe("foc_required");
    const sch = await move({ status: "scheduled", foc_date: "2026-12-22" });
    expect(sch.status).toBe(200);
    expect(mail.sent.at(-1)!.text).toContain("2026-12-22");
    const ev = (await pool.query("SELECT to_status, emailed_at FROM port_request_events WHERE port_request_id = $1 ORDER BY id", [rid])).rows;
    expect(ev.map((e) => e.to_status)).toEqual(["draft", "ready_to_submit", "draft", "ready_to_submit", "submitted", "carrier_approval_pending", "scheduled"]);
    expect(ev.slice(1).every((e) => e.emailed_at)).toBe(true);
  });

  it("completion waits until the brokerage's server has the number, then attaches it and tells the owner to turn off forwarding", async () => {
    const move = () => request(app()).post(`/api/ops/porting/${rid}/status`).set(staff()).send({ status: "completed" });
    const notYet = await move();
    expect(notYet.status).toBe(409);
    expect(notYet.body.message).toMatch(/not show it in the account yet/);
    expect((await pool.query("SELECT status, attach_error FROM port_requests WHERE id = $1", [rid])).rows[0]).toMatchObject({ status: "scheduled", attach_error: expect.any(String) });
    attachStatus = "attached";
    const done = await move();
    expect(done.status).toBe(200);
    const call = attachCalls.at(-1)!;
    expect(call.headers["X-KS-Ops-Key"]).toBe(opsKey);
    expect(call.headers["X-KS-Tenant"]).toBe("porting-co");
    expect(call.body).toMatchObject({ port_request_id: rid, grace_days: 7, numbers: [{ phone_number: "+14035550188", number_type: "mobile", user_id: "u-bea", temporary_number: "+14035550111" }] });
    const m = mail.sent.at(-1)!;
    expect(m.subject).toMatch(/now rings in Keystone/);
    expect(m.text).toMatch(/turn off the call forwarding/i);
    expect(m.text).toContain("can text Canadian mobiles straight away");
    const list = await relay("/list").send({});
    expect(list.body.requests[0]).toMatchObject({ status: "completed", status_label: "Transferred" });
    expect(list.body.requests[0].numbers[0].attached_at).toBeTruthy();
  });
});
