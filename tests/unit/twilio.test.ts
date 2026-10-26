// KS_OPS_TWILIO_AUTO_v1 - every Twilio call against tests/unit/twilioFake.ts: sub-account creation, settings hand-over
// to the workflow, address and bundle, toll-free verification and A2P 10DLC, status updates, retries, idempotency and
// the sub-account lifecycle (suspend, reactivate, close after retention). Nothing leaves the process.
import { describe, expect, it, vi } from "vitest";
import { ensureAddress, ensureBundle, ensureSubaccount, MASTER_MISSING, pointVoiceApp, serverSettings, subCreds, type TwilioDeps } from "../../src/twilio/account.js";
import { desiredStatus, refreshTexting, syncAccountStatuses } from "../../src/twilio/lifecycle.js";
import { isUsLocal, linesFrom, plainStatus, pushTexting, submitTexting } from "../../src/twilio/texting.js";
import { plainTwilioError, TwilioError } from "../../src/twilio/http.js";
import { normalizeBusinessNumber, signupSchema } from "../../src/licensees/validation.js";
import { optInPage } from "../../src/routes/textingOptIn.js";
import { twilioSettingsForWorkflow, startRun, advanceRun, handleCallback } from "../../src/provisioning/machine.js";
import { phoneNumbers, twilioBundle, type ExecCtx } from "../../src/provisioning/executors.js";
import { twilioSettings, type RunnerConfig, type RunnerDeps } from "../../src/provisioning/runner/runner.js";
import type { LicenseeRow } from "../../src/licensees/repo.js";
import { encryptionKey, encryptSecret } from "../../src/lib/crypto.js";
import { FakeTwilio, MASTER_SID, MASTER_TOKEN, memoryTwilioStore } from "./twilioFake.js";
import { configuredEnv, licensee, LICENSEE_ID, licenseeDb, machine } from "./provisioningFakes.js";
import { fakeMailer } from "../helpers.js";

const DAY = 86_400_000;
const SERVER = "https://ks-prairie-server.azurewebsites.net";

function ready(over: Partial<LicenseeRow> = {}) {
  return licensee({
    address_line1: "100 Main St SW", address_line2: "Suite 4", city: "Calgary", postal_code: "T2P 1P6", province_state: "AB",
    business_number: "123456789", business_type: "corporation", contact_title: "Owner", website: "https://prairie.example",
    server_url: SERVER, client_url: "https://ks-prairie-client.azurestaticapps.net", status: "active",
    ops_key_encrypted: encryptSecret("ops-key", encryptionKey("a".repeat(64))!), ...over,
  });
}

function setup(l: LicenseeRow, envExtra: Record<string, string> = {}) {
  const tw = new FakeTwilio();
  const store = memoryTwilioStore();
  const { db, state } = licenseeDb(l);
  const { mailer, sent } = fakeMailer();
  const server: Array<{ url: string; body: any }> = [];
  let now = new Date("2026-10-26T12:00:00Z");
  const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const s = String(url);
    if (/twilio\.com\//.test(s)) return tw.fetch(s, init);
    server.push({ url: s, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const deps: TwilioDeps = { db, fetch: fetchImpl as unknown as typeof fetch, mailer, now: () => now, env: configuredEnv(envExtra), twilioStore: store };
  return { tw, store, db, state, sent, server, deps, tick: (ms: number) => { now = new Date(now.getTime() + ms); }, audits: () => db.calls.filter((c) => /INSERT INTO staff_audit/.test(c.sql)).map((c) => String(c.params[1])) };
}

describe("Twilio sub-account", () => {
  it("is blocked with what to do until Keystone's master account is set", async () => {
    const t = setup(ready(), { KS_TWILIO_ACCOUNT_SID: "", KS_TWILIO_AUTH_TOKEN: "" });
    expect(await ensureSubaccount(t.deps, ready())).toEqual({ kind: "blocked", message: MASTER_MISSING });
    expect(t.tw.calls).toHaveLength(0);
  });

  it("creates the sub-account, API key, dialler app and sign-in code service once, stored encrypted", async () => {
    const t = setup(ready());
    const r = await ensureSubaccount(t.deps, ready());
    expect(r.kind).toBe("done");
    const row = (await t.store.get(LICENSEE_ID))!;
    expect(row.subaccount_sid).toMatch(/^AC/);
    expect(row.auth_token_encrypted).toMatch(/^v1:/);
    expect(row.auth_token_encrypted).not.toContain("tok-");
    expect(row.api_key_secret_encrypted).toMatch(/^v1:/);
    expect(t.tw.accounts.get(row.subaccount_sid)).toMatchObject({ friendly_name: "Keystone - Prairie Capital (prairie)", parent: MASTER_SID });
    // The keys, app and Verify service live inside the sub-account, made with its own credentials.
    for (const c of t.tw.creates(/Keys|Applications|Services/)) expect(c.account).toBe(row.subaccount_sid);
    expect(t.tw.apps.get(row.twiml_app_sid!)!.voice_url).toBe(`${SERVER}/api/webhooks/twilio/voice/twiml`);
    expect(t.audits()).toContain("licensee.twilio_subaccount_created");

    // Again: nothing new is made.
    const before = t.tw.creates(/./).length;
    expect((await ensureSubaccount(t.deps, ready())).kind).toBe("done");
    expect(t.tw.creates(/./).length).toBe(before);
  });

  it("finds the sub-account made earlier when its row was lost, instead of making a second one", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const first = (await t.store.get(LICENSEE_ID))!.subaccount_sid;
    t.store.rows.clear();
    await ensureSubaccount(t.deps, ready());
    expect((await t.store.get(LICENSEE_ID))!.subaccount_sid).toBe(first);
    expect([...t.tw.accounts.values()].filter((a) => a.parent === MASTER_SID)).toHaveLength(1);
    expect(t.audits()).toContain("licensee.twilio_subaccount_found");
  });

  it("remakes an API key deleted in the console, and retries Twilio's own errors", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const row = (await t.store.get(LICENSEE_ID))!;
    t.tw.keys.delete(row.api_key_sid!);
    await ensureSubaccount(t.deps, ready());
    expect((await t.store.get(LICENSEE_ID))!.api_key_sid).not.toBe(row.api_key_sid);

    const t2 = setup(ready());
    t2.tw.failNext(/Accounts\.json$/, 503, 0, "Service unavailable", 1, "GET");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await ensureSubaccount(t2.deps, ready());
    expect(r.kind).toBe("wait");
    expect(err).toHaveBeenCalledWith("[twilio] sub-account setup failed", expect.objectContaining({ status: 503 }));
    expect((await ensureSubaccount(t2.deps, ready())).kind).toBe("done");
    err.mockRestore();
  });

  it("a refused credential fails with a plain sentence for staff", async () => {
    const t = setup(ready(), { KS_TWILIO_AUTH_TOKEN: "wrong" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await ensureSubaccount(t.deps, ready());
    expect(r).toMatchObject({ kind: "failed" });
    expect((r as { message: string }).message).toMatch(/refused the account credentials.*KS_TWILIO_AUTH_TOKEN.*Twilio error 20003/);
    expect((r as { message: string }).message).not.toContain("wrong");
    err.mockRestore();
  });
});

describe("address and bundle", () => {
  it("an incomplete address fails with what to add", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const r = await ensureAddress(t.deps, ready({ address_line1: null, postal_code: null }));
    expect(r).toEqual({ kind: "failed", message: expect.stringMatching(/incomplete \(street address, postal or ZIP code\)/) });
  });

  it("registers the address once in the sub-account", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const r = await ensureAddress(t.deps, ready());
    expect(r.kind).toBe("done");
    const ad = (await t.store.get(LICENSEE_ID))!.address_sid!;
    expect(t.tw.addresses.get(ad)).toMatchObject({ customer_name: "Prairie Capital Ltd.", street: "100 Main St SW", region: "AB", iso_country: "CA" });
    await ensureAddress(t.deps, ready());
    t.store.rows.get(LICENSEE_ID)!.address_sid = null; // lost: found again by name and street
    await ensureAddress(t.deps, ready());
    expect(t.tw.addresses.size).toBe(1);
  });

  it("no bundle when Twilio's rules need none (Canada and the US today)", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const r = await ensureBundle(t.deps, ready(), null);
    expect(r).toMatchObject({ kind: "done", output: { bundle_required: false } });
    expect(t.tw.calls.filter((c) => /Regulations/.test(c.path)).map((c) => c.params.NumberType)).toEqual(["local", "toll-free"]);
    expect(t.tw.bundles.size).toBe(0);
  });

  it("when a bundle is required: made from the sign-up and the address, submitted, waited for, then approved", async () => {
    const t = setup(ready());
    t.tw.regulations.set("CA local", {
      sid: "RN1",
      requirements: {
        end_user: [{ type: "business", fields: ["business_name", "business_registration_number"] }],
        supporting_document: [[{ name: "Address proof", accepted_documents: [{ type: "address_proof_doc", name: "Business address", fields: ["address_sids"] }] }]],
      },
    });
    await ensureSubaccount(t.deps, ready());
    await ensureAddress(t.deps, ready());
    const r = await ensureBundle(t.deps, ready(), new Date());
    expect(r.kind).toBe("wait");
    const row = (await t.store.get(LICENSEE_ID))!;
    const b = t.tw.bundles.get(row.bundle_sid!)!;
    expect(b.status).toBe("pending-review");
    expect(b.items).toHaveLength(2);
    expect([...t.tw.endUsers.values()][0].attributes).toEqual({ business_name: "Prairie Capital Ltd.", business_registration_number: "123456789" });
    expect([...t.tw.docs.values()][0].attributes).toEqual({ address_sids: [row.address_sid] });
    // Still in review: waits again, makes nothing new.
    expect((await ensureBundle(t.deps, ready(), new Date())).kind).toBe("wait");
    expect(t.tw.bundles.size).toBe(1);
    b.status = "twilio-approved";
    expect(await ensureBundle(t.deps, ready(), new Date())).toMatchObject({ kind: "done", output: { bundle_sid: row.bundle_sid } });
  });

  it("a rejected bundle fails with Twilio's reasons; a document upload is left to a person", async () => {
    const t = setup(ready());
    t.tw.regulations.set("CA local", { sid: "RN1", requirements: { end_user: [{ fields: ["business_name"] }], supporting_document: [[{ name: "Address proof", accepted_documents: [{ type: "d", fields: ["address_sids"] }] }]] } });
    await ensureSubaccount(t.deps, ready());
    await ensureAddress(t.deps, ready());
    await ensureBundle(t.deps, ready(), new Date());
    t.tw.bundles.get((await t.store.get(LICENSEE_ID))!.bundle_sid!)!.status = "twilio-rejected";
    const r = await ensureBundle(t.deps, ready(), new Date());
    expect(r).toMatchObject({ kind: "failed", message: expect.stringMatching(/rejected .*Business name does not match the document/) });

    const u = setup(ready());
    u.tw.regulations.set("CA local", { sid: "RN2", requirements: { end_user: [{ fields: ["business_name"] }], supporting_document: [[{ name: "Business registration", accepted_documents: [{ type: "reg", fields: ["document_number", "business_name"] }] }]] } });
    await ensureSubaccount(u.deps, ready());
    await ensureAddress(u.deps, ready());
    const r2 = await ensureBundle(u.deps, ready(), new Date());
    expect(r2).toMatchObject({ kind: "failed", message: expect.stringMatching(/an uploaded document \(Business registration\).*Mark done manually/) });
  });

  it("the bundle step gives up after 14 days in review", async () => {
    const t = setup(ready());
    t.tw.regulations.set("CA local", { sid: "RN1", requirements: { end_user: [{ fields: ["business_name"] }], supporting_document: [] } });
    await ensureSubaccount(t.deps, ready());
    await ensureAddress(t.deps, ready());
    const start = new Date("2026-10-26T12:00:00Z");
    await ensureBundle(t.deps, ready(), start);
    t.tick(15 * DAY);
    expect(await ensureBundle(t.deps, ready(), start)).toMatchObject({ kind: "failed", message: expect.stringMatching(/after 14 days/) });
  });

  it("points the dialler app at the server once it has an address", async () => {
    const t = setup(ready({ server_url: null }));
    await ensureSubaccount(t.deps, ready({ server_url: null }));
    const app = (await t.store.get(LICENSEE_ID))!.twiml_app_sid!;
    expect(t.tw.apps.get(app)!.voice_url).toBeNull();
    expect((await pointVoiceApp(t.deps, ready())).kind).toBe("done");
    expect(t.tw.apps.get(app)!.voice_url).toBe(`${SERVER}/api/webhooks/twilio/voice/twiml`);
    const n = t.tw.calls.length;
    await pointVoiceApp(t.deps, ready());
    expect(t.tw.calls.length).toBe(n); // already pointed: no call
  });
});

describe("settings for the licensee's KS-server", () => {
  it("holds every Twilio setting KS-server reads, decrypted only for the workflow", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    await ensureAddress(t.deps, ready());
    const r = await serverSettings(t.deps, ready());
    expect(r.ok).toBe(true);
    const s = (r as { settings: Record<string, string> }).settings;
    expect(Object.keys(s).sort()).toEqual(["KS_SERVER_URL", "TWILIO_ACCOUNT_SID", "TWILIO_ADDRESS_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID", "TWILIO_VOICE_APP_SID"]);
    expect(s.TWILIO_AUTH_TOKEN).toBe(t.tw.accounts.get(s.TWILIO_ACCOUNT_SID)!.auth_token);
    expect(s.TWILIO_API_SECRET).toBe(`secret-${s.TWILIO_API_KEY}`);
    expect(subCreds(await t.store.get(LICENSEE_ID), t.deps.env)!.accountSid).toBe(s.TWILIO_ACCOUNT_SID);
  });

  it("the workflow gets them only while its twilio_settings step runs, and writes them to the App Service masked", async () => {
    const t = setup(ready({ status: "provisioning", server_url: null }));
    const m = machine(ready({ status: "provisioning", server_url: null }), {
      executors: Object.fromEntries(["twilio_account", "twilio_address"].map((k) => [k, vi.fn(async () => ({ kind: "done" as const }))])),
      twilioStore: t.store,
      db: t.db,
    });
    await ensureSubaccount(t.deps, ready());
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id); // the two Twilio steps (faked), then the workflow starts at azure_resources
    let r = (await m.store.getRun(run.id))!;
    expect(r.workflow_steps.slice(0, 2)).toEqual(["azure_resources", "twilio_settings"]);
    expect(await twilioSettingsForWorkflow(m.deps, r)).toEqual({ ok: false, status: 409, error: "not_now" });
    await handleCallback(m.deps, r, { step: "azure_resources", status: "done", output: {} });
    await handleCallback(m.deps, r, { step: "twilio_settings", status: "running" });
    r = (await m.store.getRun(run.id))!;
    const got = await twilioSettingsForWorkflow(m.deps, r);
    expect(got.ok).toBe(true);

    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const logs: string[] = [];
    const deps = {
      exec, log: (x: string) => logs.push(x), env: {}, sleep: async () => {}, now: () => new Date(), readFile: async () => "", tempFile: (n: string) => n,
      fetch: vi.fn(async () => new Response(JSON.stringify({ settings: (got as { settings: Record<string, string> }).settings }), { status: 200 })),
    } as unknown as RunnerDeps;
    const cfg = { opsUrl: "https://ks-ops.example.test", runId: run.id, token: "t", steps: [], dryRun: false, owner: "werb210", ghToken: "g", mode: "provision" } as RunnerConfig;
    await twilioSettings(deps, cfg, { code: "prairie" } as never);
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(0, 7)).toEqual(["webapp", "config", "appsettings", "set", "-g", "ks-prairie", "-n"]);
    expect(args).toContain("ks-prairie-server");
    expect(args.some((a) => a.startsWith("TWILIO_VERIFY_SERVICE_SID=VA"))).toBe(true);
    const settings = (got as { settings: Record<string, string> }).settings;
    expect(logs).toContain(`::add-mask::${settings.TWILIO_AUTH_TOKEN}`);
    expect(logs).toContain(`::add-mask::${settings.TWILIO_API_SECRET}`);
    expect(logs.join("\n")).not.toMatch(new RegExp(`Twilio settings written.*${settings.TWILIO_AUTH_TOKEN}`));
  });
});

describe("texting registration", () => {
  async function provisioned(l = ready(), envExtra: Record<string, string> = {}) {
    const t = setup(l, envExtra);
    await ensureSubaccount(t.deps, l);
    await ensureAddress(t.deps, l);
    const sub = (await t.store.get(LICENSEE_ID))!.subaccount_sid;
    return { ...t, sub };
  }

  it("knows US local lines from Canadian and toll-free ones", () => {
    expect(isUsLocal("+12125550100")).toBe(true);
    expect(isUsLocal("+14035550100")).toBe(false);
    expect(isUsLocal("+18665550100")).toBe(false);
    expect(linesFrom([{ kind: "main", status: "bought", number: "+14035550100" }, { kind: "toll_free", status: "already_had", number: "+18665550100" }])).toEqual({ local: "+14035550100", tollFree: "+18665550100" });
  });

  it("submits toll-free verification with the sign-up details and the client app's opt-in; Canada needs no 10DLC", async () => {
    const t = await provisioned();
    t.tw.addNumber(t.sub, "+18665550100");
    const [tf, a2p] = await submitTexting(t.deps, ready(), { local: "+14035550100", tollFree: "+18665550100" });
    expect(tf).toMatchObject({ kind: "toll_free", status: "pending", phone_number: "+18665550100" });
    expect(a2p).toMatchObject({ kind: "a2p_10dlc", status: "not_needed" });
    const v = [...t.tw.tfv.values()][0];
    expect(v.account).toBe(t.sub);
    expect(v.params).toMatchObject({
      BusinessName: "Prairie Capital Ltd.", BusinessWebsite: "https://prairie.example", BusinessRegistrationNumber: "123456789",
      BusinessRegistrationType: "CRA", BusinessCountry: "CA", BusinessStateProvinceRegion: "AB", OptInType: "WEB_FORM",
      UseCaseCategories: ["ACCOUNT_NOTIFICATIONS", "CUSTOMER_CARE"], BusinessContactPhone: "+14035550199", EntityType: "PRIVATE_PROFIT",
      OptInImageUrls: "https://ks-ops.example.test/api/public/texting-opt-in/prairie", NotificationEmail: "sales@example.test",
    });
    expect(String(v.params.UseCaseSummary)).toContain("Text me updates about my application");
    expect(plainStatus(tf)).toBe("Texting from your toll-free line +18665550100: approval pending with carriers (usually 3-10 business days). Until then, texts to US mobiles wait; Canadian mobiles get texts from your business line.");
    // Again: the same verification, nothing new.
    await submitTexting(t.deps, ready(), { local: "+14035550100", tollFree: "+18665550100" });
    expect(t.tw.tfv.size).toBe(1);
  });

  it("missing details wait as needs_info and sales is told what to add", async () => {
    const l = ready({ business_number: null, contact_title: null });
    const t = await provisioned(l);
    const [tf] = await submitTexting(t.deps, l, { local: "+14035550100", tollFree: "+18665550100" });
    expect(tf).toMatchObject({ status: "needs_info", reason: "missing the business number, the contact's job title" });
    expect(t.tw.tfv.size).toBe(0);
    expect(t.sent.some((m) => /Texting registration needs attention/.test(m.subject) && /Resubmit texting/.test(m.text))).toBe(true);
  });

  it("Starter has no toll-free line: US texts are explained, not attempted", async () => {
    const l = ready({ plan: "starter" });
    const t = await provisioned(l);
    const [tf] = await submitTexting(t.deps, l, { local: "+14035550100", tollFree: null });
    expect(tf.status).toBe("not_needed");
    expect(plainStatus(tf)).toMatch(/plan has no toll-free line, so texts to US mobiles cannot be sent/);
  });

  it("status updates: approved, or rejected with the reason; a rejection that can be edited is resubmitted", async () => {
    const t = await provisioned();
    t.tw.addNumber(t.sub, "+18665550100");
    await submitTexting(t.deps, ready(), { local: "+14035550100", tollFree: "+18665550100" });
    const v = [...t.tw.tfv.values()][0];
    v.status = "TWILIO_REJECTED";
    v.rejection_reason = "Opt-in not clear";
    v.edit_allowed = true;
    t.tick(3 * 60 * 60_000);
    expect(await refreshTexting(t.deps)).toMatchObject({ checked: 1 });
    const rej = (await t.store.registration(LICENSEE_ID, "toll_free"))!;
    expect(rej).toMatchObject({ status: "rejected", reason: "Opt-in not clear", pushed_status: "rejected" });
    expect(t.server.some((s) => s.url === `${SERVER}/api/provision/texting` && s.body.registrations.some((r: any) => r.status === "rejected" && /Opt-in not clear/.test(r.message)))).toBe(true);
    // Fixed and resubmitted: the same verification is edited.
    const [again] = await submitTexting(t.deps, ready(), { local: "+14035550100", tollFree: "+18665550100" });
    expect(again.status).toBe("pending");
    expect(v.edited).toBe(true);
    expect(t.tw.tfv.size).toBe(1);
    v.status = "TWILIO_APPROVED";
    t.tick(3 * 60 * 60_000);
    await refreshTexting(t.deps);
    expect((await t.store.registration(LICENSEE_ID, "toll_free"))!).toMatchObject({ status: "approved", next_check_at: null });
    expect(t.audits().filter((a) => a === "licensee.texting_status").length).toBeGreaterThanOrEqual(3);
  });

  it("A2P 10DLC for a US line: ISV profile, trust product, brand and messaging service; the campaign once the brand is approved", async () => {
    const isv = `BU${"9".repeat(32)}`;
    const l = ready({ country: "US", province_state: "NY", postal_code: "10001", business_number: "12-3456789" });
    const t = await provisioned(l, { KS_TWILIO_ISV_PROFILE_SID: isv });
    const pn = t.tw.addNumber(t.sub, "+12125550100");
    const [, a2p] = await submitTexting(t.deps, l, { local: "+12125550100", tollFree: null });
    expect(a2p).toMatchObject({ kind: "a2p_10dlc", status: "pending" });
    const profile = t.tw.profiles.get(a2p.customer_profile_sid!)!;
    expect(profile).toMatchObject({ policy_sid: "RNdfbf3fae0e1107f8aded0e7cead80bf5", status: "pending-review", account: t.sub });
    expect(profile.entities).toContain(isv);
    expect(profile.entities).toHaveLength(4);
    const biz = [...t.tw.endUsers.values()].find((e) => e.type === "customer_profile_business_information")!;
    expect(biz.attributes).toMatchObject({ business_registration_identifier: "EIN", business_registration_number: "12-3456789", business_type: "Corporation", website_url: "https://prairie.example" });
    expect(t.tw.products.get(a2p.trust_product_sid!)!.entities).toContain(a2p.customer_profile_sid);
    expect(t.tw.services.get(a2p.messaging_service_sid!)!.numbers).toEqual([pn]);
    expect(t.tw.campaigns.size).toBe(0);

    // Brand approved: the next check registers the campaign.
    t.tw.brands.get(a2p.brand_sid!)!.status = "APPROVED";
    t.tick(3 * 60 * 60_000);
    await refreshTexting(t.deps);
    const withCampaign = (await t.store.registration(LICENSEE_ID, "a2p_10dlc"))!;
    const c = t.tw.campaigns.get(withCampaign.campaign_sid!)!;
    expect(c.params).toMatchObject({ UsAppToPersonUsecase: "ACCOUNT_NOTIFICATION", HasEmbeddedLinks: "true" });
    expect(c.params.MessageSamples).toHaveLength(2);
    c.campaign_status = "VERIFIED";
    t.tick(3 * 60 * 60_000);
    await refreshTexting(t.deps);
    expect((await t.store.registration(LICENSEE_ID, "a2p_10dlc"))!.status).toBe("approved");
    // Idempotent: asking again makes nothing new.
    const n = t.tw.creates(/./).length;
    await submitTexting(t.deps, l, { local: "+12125550100", tollFree: null });
    expect(t.tw.creates(/./).length).toBe(n);
  });

  it("A2P waits for Keystone's ISV profile; a failed brand is rejected with the reason", async () => {
    const l = ready({ country: "US", province_state: "NY", postal_code: "10001", business_number: "123456789" });
    const t = await provisioned(l);
    const [, a2p] = await submitTexting(t.deps, l, { local: "+12125550100", tollFree: null });
    expect(a2p).toMatchObject({ status: "needs_info", reason: expect.stringMatching(/KS_TWILIO_ISV_PROFILE_SID/) });

    const u = await provisioned(l, { KS_TWILIO_ISV_PROFILE_SID: `BU${"9".repeat(32)}` });
    u.tw.addNumber(u.sub, "+12125550100");
    const [, b] = await submitTexting(u.deps, l, { local: "+12125550100", tollFree: null });
    Object.assign(u.tw.brands.get(b.brand_sid!)!, { status: "FAILED", failure_reason: "Tax ID does not match" });
    u.tick(3 * 60 * 60_000);
    await refreshTexting(u.deps);
    expect(await u.store.registration(LICENSEE_ID, "a2p_10dlc")).toMatchObject({ status: "rejected", reason: "brand not approved: Tax ID does not match" });
  });

  it("a push the server refuses is kept and tried again", async () => {
    const t = await provisioned();
    await submitTexting(t.deps, ready(), { local: "+14035550100", tollFree: null });
    t.deps.fetch = vi.fn(async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await pushTexting(t.deps, ready())).toEqual({ ok: false, error: "KS-server answered 503" });
    expect((await t.store.unpushedRegistrations(10)).length).toBe(2);
  });

  it("the opt-in page shows the consent box and its exact wording", () => {
    const html = optInPage({ company_name: "Prairie <Capital>", client_url: "https://c.example", website: null });
    expect(html).toContain("Prairie &lt;Capital&gt;");
    expect(html).toContain("Reply STOP to opt out, HELP for help. Not required to apply.");
    expect(html).toContain("starts unticked");
  });
});

describe("sub-account lifecycle", () => {
  it("follows the licensee: suspended, reactivated, kept while cancelled numbers are released, then suspended", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    expect(desiredStatus({ status: "active", cancelled_at: null }, now)).toBe("active");
    expect(desiredStatus({ status: "past_due", cancelled_at: null }, now)).toBe("active");
    expect(desiredStatus({ status: "suspended", cancelled_at: null }, now)).toBe("suspended");
    expect(desiredStatus({ status: "cancelled", cancelled_at: new Date(now.getTime() - 10 * DAY) }, now)).toBe("active");
    expect(desiredStatus({ status: "cancelled", cancelled_at: new Date(now.getTime() - 40 * DAY) }, now)).toBe("suspended");
    expect(desiredStatus({ status: "cancelled", cancelled_at: new Date(now.getTime() - 181 * DAY) }, now)).toBe("closed");
    expect(desiredStatus({ status: "pending_payment", cancelled_at: null }, now)).toBeNull();
  });

  it("suspends on suspension and reactivates after, audited", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const sid = (await t.store.get(LICENSEE_ID))!.subaccount_sid;
    t.state.l = { ...t.state.l, status: "suspended" };
    expect((await syncAccountStatuses(t.deps)).changed).toEqual(["prairie:suspended"]);
    expect(t.tw.accounts.get(sid)!.status).toBe("suspended");
    expect(await syncAccountStatuses(t.deps)).toEqual({ changed: [], noticed: [], failed: [] });
    t.state.l = { ...t.state.l, status: "active" };
    await syncAccountStatuses(t.deps);
    expect(t.tw.accounts.get(sid)!.status).toBe("active");
    expect(t.audits()).toEqual(expect.arrayContaining(["licensee.twilio_subaccount_suspended", "licensee.twilio_subaccount_reactivated"]));
  });

  it("closes only after the retention period, 7 days after telling sales, never silently", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const sid = (await t.store.get(LICENSEE_ID))!.subaccount_sid;
    t.state.l = { ...t.state.l, status: "cancelled", cancelled_at: new Date(new Date("2026-10-26T12:00:00Z").getTime() - 181 * DAY) };
    const first = await syncAccountStatuses(t.deps);
    expect(first.noticed).toEqual(["prairie"]);
    expect(t.tw.accounts.get(sid)!.status).toBe("active");
    expect(t.sent.find((m) => /will be closed on 2026-11-02/.test(m.subject))).toBeTruthy();
    t.tick(3 * DAY);
    await syncAccountStatuses(t.deps);
    expect(t.tw.accounts.get(sid)!.status).toBe("active");
    t.tick(5 * DAY);
    await syncAccountStatuses(t.deps);
    expect(t.tw.accounts.get(sid)!.status).toBe("closed");
    expect(t.audits()).toEqual(expect.arrayContaining(["licensee.twilio_close_scheduled", "licensee.twilio_subaccount_closed"]));
    expect(t.sent.some((m) => /closed$/.test(m.subject))).toBe(true);
    expect(await t.store.listOpen()).toEqual([]);
    // A closed sub-account is never used again by provisioning.
    expect(await ensureSubaccount(t.deps, ready())).toMatchObject({ kind: "failed", message: expect.stringMatching(/was closed/) });
  });

  it("a Twilio failure while changing status is logged and audited, and tried again next time", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    t.state.l = { ...t.state.l, status: "suspended" };
    t.tw.failNext(/Accounts\/AC\w+\.json$/, 500, 20500, "Internal error");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await syncAccountStatuses(t.deps)).failed).toEqual(["prairie"]);
    expect(err).toHaveBeenCalledWith("[twilio] sub-account status change failed", expect.objectContaining({ code: 20500 }));
    expect(t.audits()).toContain("licensee.twilio_status_failed");
    expect((await syncAccountStatuses(t.deps)).changed).toEqual(["prairie:suspended"]);
    err.mockRestore();
  });
});

describe("provisioning steps around Twilio", () => {
  it("the phone step sends the registered address to the licensee's server", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    await ensureAddress(t.deps, ready());
    const ad = (await t.store.get(LICENSEE_ID))!.address_sid;
    const ctx = {
      deps: { ...t.deps, fetch: vi.fn(async (_u: string, init: RequestInit) => { (ctx as any).body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ ok: true, results: [] })); }) as unknown as typeof fetch },
      run: { id: "r1" }, step: { started_at: new Date() }, licensee: ready(), outputs: {}, log: async () => {},
    } as unknown as ExecCtx & { body?: any };
    expect((await phoneNumbers(ctx)).kind).toBe("done");
    expect((ctx as any).body).toMatchObject({ area_code: "403", region: "AB", country: "CA", address_sid: ad });
  });

  it("the bundle step maps Twilio's outcome onto the run", async () => {
    const t = setup(ready());
    await ensureSubaccount(t.deps, ready());
    const ctx = { deps: t.deps, run: { id: "r1" }, step: { started_at: new Date() }, licensee: ready(), outputs: {}, log: async () => {} } as unknown as ExecCtx;
    expect(await twilioBundle(ctx)).toMatchObject({ kind: "done" });
  });

  it("errors read as plain sentences", () => {
    expect(plainTwilioError(new TwilioError("x", 400, 21631, null, "buy a number"))).toBe("Twilio needs a registered business address for this number. (Twilio error 21631, while trying to buy a number)");
    expect(plainTwilioError(new TwilioError("Could not connect", 0, null, null, "create the sub-account"))).toBe("Could not connect (while trying to create the sub-account)");
  });
});

describe("sign-up business details", () => {
  it("normalises the business number for the country", () => {
    expect(normalizeBusinessNumber("CA", "123 456 789")).toBe("123456789");
    expect(normalizeBusinessNumber("CA", "123456789rc0001")).toBe("123456789RC0001");
    expect(normalizeBusinessNumber("US", "123456789")).toBe("12-3456789");
    expect(normalizeBusinessNumber("US", "12345")).toBeNull();
  });

  it("the sign-up accepts and checks them", () => {
    const base = {
      company_name: "Prairie", legal_name: "Prairie Ltd.", company_code: "prairie", country: "CA", province_state: "AB",
      address_line1: "1 Main", city: "Calgary", postal_code: "T2P1P6", contact_name: "Dana Smith", contact_email: "d@p.example",
      contact_phone: "4035550199", seats: 3, plan: "growth", billing_interval: "monthly", support_level: "email", accept_terms: true, accept_privacy: true,
    };
    const ok = signupSchema.safeParse({ ...base, business_number: "123-456-789", business_type: "Corporation", contact_title: "Owner" });
    expect(ok.success && ok.data).toMatchObject({ business_number: "123456789", business_type: "corporation", contact_title: "Owner" });
    const bad = signupSchema.safeParse({ ...base, business_number: "12" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("9-digit CRA business number");
    expect(signupSchema.safeParse(base).success).toBe(true); // older website builds still work
  });
});

void MASTER_TOKEN;
