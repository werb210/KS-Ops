// KS_OPS_NUMBER_PORTING_v1 - the parts of "Keep your existing phone number" that need no database: checking a request,
// the letter of authorization, the owner's emails, the texting rules on completion, and the routes' guards. The full
// flow against a real Postgres is in tests/integration/porting.test.ts. Test numbers only (555).
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { renderLoa, loaExpired, LOA_VERSION } from "../../src/porting/loa.js";
import { CARRIERS, crossCheck, decodeBill, maskTail, requestSchema, statusMessage, TRANSITIONS } from "../../src/porting/model.js";
import type { PortNumberRow, PortRequestRow } from "../../src/porting/repo.js";
import { portGraceDays, registerTexting, statusMail } from "../../src/porting/service.js";
import { PORTING_PAGE_HTML } from "../../src/routes/opsPortingPage.js";
import { fakeDb, fakeMailer, licenseeRow, makeDeps } from "../helpers.js";
import type { LicenseeRow } from "../../src/licensees/repo.js";

const L = licenseeRow({ legal_name: "Northwind Capital Ltd.", company_name: "Northwind Capital" }) as unknown as LicenseeRow;
const REQ = {
  id: "33333333-3333-4333-8333-333333333333", licensee_id: L.id, status: "draft", carrier: "bell", carrier_other: null,
  account_name: "Northwind Capital Ltd.", account_number_encrypted: "v1:x", account_last4: "4321", pin_encrypted: "v1:y",
  service_line1: "100 Main Street", service_line2: null, service_city: "Calgary", service_region: "AB", service_postal_code: "T2P 1A1",
  service_country: "CA", foc_date: "2026-12-01", status_reason: null, requested_by_email: "ana@northwind.example",
} as unknown as PortRequestRow;
const NUM = (over: Partial<PortNumberRow> = {}) => ({
  id: "n1", port_request_id: REQ.id, phone_number: "+14035550188", number_type: "local", server_user_id: "u-1", assignee_name: "Bea Broker",
  temporary_number: "+14035550111", forwarding_tested_at: null, attached_at: null, attach_status: null, attach_message: null, released_number: null, ...over,
}) as PortNumberRow;

afterEach(() => {
  delete process.env.KS_PORT_RELEASE_GRACE_DAYS;
  vi.restoreAllMocks();
});

describe("checking a request", () => {
  const base = {
    carrier: "rogers", account_number: "12 345 678", account_name: "Northwind Capital Ltd.",
    service_address: { line1: "100 Main Street", city: "Calgary", region: "ab", postal_code: "t2p 1a1", country: "CA" },
    numbers: [{ phone_number: "403.555.0188", number_type: "mobile" }],
    bill: { filename: "bill.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.7 x").toString("base64") },
  };

  it("lists every carrier Todd named, Other last", () => {
    expect(CARRIERS.map((c) => c[1])).toEqual(["Bell", "Rogers", "Telus", "Fido", "Koodo", "Virgin Plus", "Freedom Mobile", "Videotron", "Shaw", "Cogeco", "Eastlink", "SaskTel", "AT&T", "Verizon", "T-Mobile", "Other"]);
  });

  it("normalises numbers and addresses", () => {
    const r = requestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.numbers[0].phone_number).toBe("+14035550188");
    expect(r.data.service_address).toMatchObject({ region: "AB", postal_code: "T2P 1A1" });
    expect(crossCheck(r.data)).toEqual({});
  });

  it("toll-free numbers are typed toll-free and go in their own request", () => {
    const r = requestSchema.parse({ ...base, numbers: [{ phone_number: "18885550142", number_type: "local" }, { phone_number: "4035550188", number_type: "mobile" }] });
    expect(crossCheck(r)).toMatchObject({ "numbers.0.number_type": expect.stringContaining("toll-free"), numbers: expect.stringContaining("own request") });
  });

  it("takes the bill as a PDF, PNG or JPG by its bytes, up to 7 MB", () => {
    expect(decodeBill({ content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4").toString("base64") })).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(decodeBill({ content_type: "image/jpeg", data_base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64") })).toMatchObject({ ok: true, contentType: "image/jpeg" });
    expect(decodeBill({ content_type: "application/pdf", data_base64: Buffer.from("<html>").toString("base64") })).toMatchObject({ ok: false });
    expect(decodeBill({ content_type: "application/pdf", data_base64: Buffer.alloc(7 * 1024 * 1024 + 1, 0x25).toString("base64") })).toMatchObject({ ok: false, error: expect.stringContaining("7 MB") });
  });

  it("shows only the end of an account number", () => {
    expect(maskTail("4321")).toBe("••••4321");
    expect(maskTail("")).toBe("");
  });
});

describe("the letter of authorization", () => {
  it("names the business, the account, the service address and the numbers; never the PIN", () => {
    const doc = renderLoa(L, REQ, [NUM()], "998877664321");
    expect(doc.version).toBe(LOA_VERSION);
    expect(doc.text).toContain("Northwind Capital Ltd.");
    expect(doc.text).toContain("Carrier: Bell");
    expect(doc.text).toContain("Account number: 998877664321");
    expect(doc.text).toContain("100 Main Street, Calgary, AB T2P 1A1, Canada");
    expect(doc.text).toContain("(403) 555-0188");
    expect(doc.text).toContain("on file with Keystone (not shown)");
    expect(doc.text).toContain("90 minutes");
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(renderLoa(L, REQ, [NUM()], "998877664321").sha256).toBe(doc.sha256);
  });

  it("is good for 30 days", () => {
    const signed = { signed_at: new Date("2026-11-01T00:00:00Z") };
    expect(loaExpired(signed, new Date("2026-11-30T00:00:00Z"))).toBe(false);
    expect(loaExpired(signed, new Date("2026-12-02T00:00:00Z"))).toBe(true);
    expect(loaExpired(null, new Date())).toBe(true);
  });
});

describe("the owner's emails", () => {
  it("carrier approval: approve within 90 minutes; from the support address to the owner and the admin who asked", () => {
    const m = statusMail(L, REQ, [NUM()], "carrier_approval_pending")!;
    expect(m.subject).toMatch(/within 90 minutes/);
    expect(m.text).toMatch(/within 90 minutes/);
    expect(m.to).toEqual(["nora@northwind.example", "ana@northwind.example"]);
    expect(m.from).toEqual({ email: "support@keystonecrm.online", name: "Keystone support" });
  });

  it("ready: keep forwarding on, texts are not forwarded; completed: turn forwarding off", () => {
    expect(statusMail(L, REQ, [NUM()], "ready_to_submit")!.text).toMatch(/keep the call forwarding on \(\(403\) 555-0188 -> \(403\) 555-0111\).*Texts cannot be forwarded/s);
    expect(statusMail(L, REQ, [NUM()], "completed")!.text).toMatch(/turn off the call forwarding.*\*73.*##21#/s);
    expect(statusMail(L, { ...REQ, status_reason: "PIN did not match" }, [NUM()], "rejected")!.text).toContain("PIN did not match");
    expect(statusMessage("scheduled", { foc_date: "2026-12-01" })).toContain("2026-12-01");
  });

  it("every status moves somewhere sensible and the final ones stop", () => {
    expect(TRANSITIONS.completed).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.scheduled).toContain("completed");
    expect(TRANSITIONS.ready_to_submit).not.toContain("completed");
  });

  it("the temporary number's grace period is 7 days unless set", () => {
    expect(portGraceDays({} as NodeJS.ProcessEnv)).toBe(7);
    expect(portGraceDays({ KS_PORT_RELEASE_GRACE_DAYS: "14" } as NodeJS.ProcessEnv)).toBe(14);
    expect(portGraceDays({ KS_PORT_RELEASE_GRACE_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(7);
  });
});

describe("texting after the transfer", () => {
  it("Canadian numbers text straight away; a US number on someone's line goes to sales to add to A2P", async () => {
    const mail = fakeMailer();
    const deps = makeDeps({ mailer: mail.mailer });
    const store = { registration: vi.fn(async () => null) };
    const out = await registerTexting({ ...deps, twilioStore: store as any }, L, [NUM(), NUM({ phone_number: "+12125550123", assignee_name: "Uma US" })]);
    expect(out[0]).toContain("can text Canadian mobiles straight away");
    expect(out[1]).toMatch(/A2P 10DLC/);
    expect(mail.sent[0].subject).toMatch(/Texting for transferred numbers/);
    expect(mail.sent[0].text).toContain("(212) 555-0123");
  });
});

describe("routes", () => {
  it("the licensee routes need the ops key; the staff routes need a staff token", async () => {
    const app = createApp(makeDeps({ db: fakeDb() }));
    expect((await request(app).post(`/api/licensees/${L.id}/port-requests`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/licensees/${L.id}/port-requests/list`).set("X-KS-Ops-Key", "wrong").send({})).status).toBe(401);
    expect((await request(app).get("/api/ops/porting")).status).toBe(401);
  });

  it("the page holds no data and writes status in words", () => {
    expect(PORTING_PAGE_HTML).toContain("Number transfers");
    expect(PORTING_PAGE_HTML).toContain("Download the signed letter of authorization");
    expect(PORTING_PAGE_HTML).not.toMatch(/boreal/i);
  });
});
