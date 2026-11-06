// KS_OPS_ONBOARDING_v1 - the sign-up team roster, the click-to-sign licence agreement, the provisioning steps that wait
// for it, create and invite the team and email the owner, and the website routes. The database is a fake that answers
// by SQL content; the brokerage's server is faked through fetch; nothing leaves the process.
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { encryptionKey, encryptSecret, sha256Hex } from "../../src/lib/crypto.js";
import { createMailer } from "../../src/lib/email.js";
import { AGREEMENT_VERSION, renderAgreement } from "../../src/onboarding/agreement.js";
import { brokerInviteMail, ownerOnboardingMail, quickGuide } from "../../src/onboarding/emails.js";
import { normalizeNanpMobile, parseTeam, teamLocked, type TeamRow } from "../../src/onboarding/team.js";
import type { ExecCtx } from "../../src/provisioning/executors.js";
import { licenceAgreement, onboardingEmail, teamUsers } from "../../src/provisioning/onboardingSteps.js";
import { PROVISION_STEPS } from "../../src/provisioning/steps.js";
import { PROVISIONING_PAGE_HTML } from "../../src/routes/opsProvisioningPage.js";
import { fakeDb, fakeMailer, licenseeRow, makeDeps, staffToken, validSignup } from "../helpers.js";
import { licensee, memoryStore } from "./provisioningFakes.js";

const OWNER = { contact_name: "Nora North", contact_email: "nora@northwind.example", contact_phone: "(403) 555-0199" };
const bea = { full_name: "Bea Broker", email: "bea@northwind.example", phone: "1-587-555-0101", role: "Broker" };
const mo = { full_name: "Mo Marketer", email: "Mo@Northwind.example", phone: "+1 (587) 555-0102", role: "Marketing" };

afterEach(() => {
  delete process.env.KS_ONBOARDING_BOOKING_URL;
  delete process.env.KS_SUPPORT_PHONE;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_FROM;
});

describe("mobile numbers", () => {
  it("stores Canadian and US mobiles as E.164, treating a leading 1 on 11 digits as the country code", () => {
    expect(normalizeNanpMobile("(403) 555-0199")).toBe("+14035550199");
    expect(normalizeNanpMobile("1 403 555 0199")).toBe("+14035550199");
    expect(normalizeNanpMobile("+1-403-555-0199")).toBe("+14035550199");
    expect(normalizeNanpMobile("14035550199")).toBe("+14035550199");
  });

  it("refuses numbers that cannot be North American mobiles", () => {
    expect(normalizeNanpMobile("1035550199")).toBeNull(); // area codes never start with 1
    expect(normalizeNanpMobile("4031550199")).toBeNull(); // nor do exchanges
    expect(normalizeNanpMobile("24035550199")).toBeNull(); // 11 digits not starting with 1
    expect(normalizeNanpMobile("+44 20 7946 0958")).toBeNull();
    expect(normalizeNanpMobile("403-555-019")).toBeNull();
    expect(normalizeNanpMobile("call me")).toBeNull();
  });
});

describe("team roster", () => {
  it("puts the owner first as Admin, skips the owner's own row from the website and normalises the rest", () => {
    const r = parseTeam([{ ...OWNER, full_name: "Nora North", email: "NORA@northwind.example", phone: "4035550199", role: "Admin" }, bea, mo], OWNER, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.members).toEqual([
      { full_name: "Nora North", email: "nora@northwind.example", phone_e164: "+14035550199", role: "Admin", is_owner: true },
      { full_name: "Bea Broker", email: "bea@northwind.example", phone_e164: "+15875550101", role: "Broker", is_owner: false },
      { full_name: "Mo Marketer", email: "mo@northwind.example", phone_e164: "+15875550102", role: "Marketing", is_owner: false },
    ]);
  });

  it("never has more people than seats (the owner takes one)", () => {
    const r = parseTeam([bea, mo], OWNER, 2);
    expect(r).toMatchObject({ ok: false, errors: { team: expect.stringContaining("up to 2 people including yourself") } });
    expect(parseTeam([], OWNER, 1).ok).toBe(true);
    expect(parseTeam(undefined, OWNER, 1).ok).toBe(true);
  });

  it("explains each bad row, numbered as the person sees it", () => {
    const r = parseTeam([{ full_name: "X", email: "nope", phone: "555", role: "Lender" }, { ...bea, email: OWNER.contact_email }], OWNER, 5);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({
      "team.2.full_name": "Enter the person's full name.",
      "team.2.email": "Enter a valid email address.",
      "team.2.phone": expect.stringContaining("mobile number"),
      "team.2.role": "Choose Broker, Marketing or Admin.",
      "team.3.email": "Row 1 already uses this email.",
      team: expect.any(String),
    });
    expect(parseTeam([bea, { ...mo, phone: bea.phone }], OWNER, 5)).toMatchObject({ ok: false, errors: { "team.3.phone": "Row 2 already uses this mobile number." } });
    expect(parseTeam("not a list", OWNER, 5)).toMatchObject({ ok: false });
  });

  it("is locked once the team step has started, and open again after it failed", async () => {
    const store = memoryStore();
    expect(await teamLocked(store, "L1")).toBe(false);
    const { run } = await store.createRun({ licensee_id: "L1", kind: "provision", trigger: "t", dry_run: false, region: "x", created_by: "t" });
    expect(await teamLocked(store, "L1")).toBe(false);
    await store.updateStep(run.id, "team_users", { status: "running" });
    expect(await teamLocked(store, "L1")).toBe(true);
    await store.updateStep(run.id, "team_users", { status: "failed" });
    expect(await teamLocked(store, "L1")).toBe(false);
    await store.updateStep(run.id, "team_users", { status: "done" });
    expect(await teamLocked(store, "L1")).toBe(true);
  });
});

describe("licence agreement", () => {
  const l = licensee({ plan: "growth", seats: 4, billing_interval: "annual", support_level: "premium", extra_storage_blocks: 2, addons: { marketing: true }, company_name: "Prairie Capital", legal_name: "Prairie Capital Ltd." });

  it("is rendered for the licensee: names, plan, seats, add-ons, support and price", () => {
    const doc = renderAgreement(l);
    expect(doc.version).toBe(AGREEMENT_VERSION);
    for (const s of ["Prairie Capital Ltd.", "operating as Prairie Capital", "Plan: Growth", "Seats: 4", "Marketing add-on", "2 extra 50 GB storage block(s)", "Support level: Premium", "billed annually", "$750.00 CAD", "2630108 Alberta Ltd."]) {
      expect(doc.text).toContain(s);
    }
    expect(doc.html).toContain("<li>Plan: Growth</li>");
    expect(doc.sha256).toBe(sha256Hex(doc.text));
    expect(renderAgreement(l).sha256).toBe(doc.sha256); // stable
    expect(renderAgreement({ ...l, seats: 5 }).sha256).not.toBe(doc.sha256);
  });

  it("says what Keystone is and the data rules: software not a lender, data ownership, 7 years, 6-month hold, Alberta law, template", () => {
    const t = renderAgreement(l).text;
    expect(t).toMatch(/Keystone is not a lender/);
    expect(t).toMatch(/belongs to your brokerage/);
    expect(t).toMatch(/7 years/);
    expect(t).toMatch(/6 months \(180 days\)/);
    expect(t).toMatch(/Province of Alberta/);
    expect(t).toMatch(/template that has not yet been reviewed by a lawyer/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Website routes

const LID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "signup-token-0123456789";

function onboardingDb(over: Record<string, unknown> = {}) {
  const state = {
    l: licenseeRow({ id: LID, status: "provisioning", seats: 3, signup_token_hash: sha256Hex(TOKEN), contact_title: "Owner", ...over }),
    team: [] as Record<string, unknown>[],
    agreements: [] as Record<string, unknown>[],
    audits: [] as string[],
  };
  const db = fakeDb([
    [/^SELECT \* FROM licensees WHERE id = \$1/, () => [state.l]],
    [/^SELECT \* FROM licence_agreements WHERE licensee_id = \$1 ORDER BY signed_at DESC/, () => state.agreements.slice(-1)],
    [/^SELECT \* FROM licence_agreements WHERE licensee_id = \$1 AND version = \$2/, (p) => state.agreements.filter((a) => a.version === p[1])],
    [/^INSERT INTO licence_agreements/, (p) => {
      if (state.agreements.some((a) => a.version === p[1])) return [];
      const row = { id: `a${state.agreements.length + 1}`, licensee_id: p[0], version: p[1], signer_name: p[2], signer_title: p[3], signer_email: p[4], ip: p[5], user_agent: p[6], text_sha256: p[7], rendered_text: p[8], signed_at: new Date("2026-11-06T18:00:00Z"), emailed_at: null };
      state.agreements.push(row);
      return [row];
    }],
    [/^UPDATE licence_agreements SET emailed_at/, () => []],
    [/^SELECT \* FROM licensee_team WHERE licensee_id = \$1/, () => state.team],
    [/^WITH gone AS \( DELETE FROM licensee_team/, (p) => {
      state.team = (JSON.parse(String(p[1])) as Record<string, unknown>[]).map((r) => ({ ...r, id: `t${String(r.position)}`, provisioned_at: null, invite_sent_at: null }));
      return [];
    }],
    [/^INSERT INTO staff_audit/, (p) => { state.audits.push(String(p[1])); return []; }],
    [/FROM stripe_prices/, (p) => (p[0] as string[]).map((key) => ({ key, stripe_price_id: `price_${key}` }))],
    [/^INSERT INTO licensees/, () => [state.l]],
  ]);
  return { db, state };
}

const url = (path: string, token = TOKEN) => `/api/public/signup/${LID}/${path}?token=${token}`;

describe("website: licence agreement", () => {
  it("shows the agreement only with the sign-up's token", async () => {
    const { db } = onboardingDb();
    const app = createApp(makeDeps({ db }));
    expect((await request(app).get(url("agreement", "wrong"))).status).toBe(404);
    const res = await request(app).get(url("agreement"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company_name: "Northwind Capital", contact_title: "Owner", version: AGREEMENT_VERSION, signed: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(res.body.html).toContain("Keystone Software Licence Agreement");
  });

  it("records the signature with name, title, email, IP, browser, version and the text's SHA-256, and emails owner and sales once", async () => {
    const { db, state } = onboardingDb();
    const { mailer, sent } = fakeMailer();
    const app = createApp(makeDeps({ db, mailer }));
    const shown = (await request(app).get(url("agreement"))).body;
    expect((await request(app).post(url("agreement")).send({ signer_name: "Nora North", signer_title: "Owner" })).body.errors).toMatchObject({ agree: "Tick the box to agree." });
    const res = await request(app).post(url("agreement")).set("User-Agent", "TestBrowser/1.0").send({ signer_name: " Nora North ", signer_title: "Owner", agree: true, sha256: shown.sha256 });
    expect(res.status).toBe(201);
    expect(res.body.signed).toMatchObject({ signer_name: "Nora North", signer_title: "Owner", version: AGREEMENT_VERSION });
    expect(state.agreements[0]).toMatchObject({ signer_email: "nora@northwind.example", user_agent: "TestBrowser/1.0", text_sha256: shown.sha256, rendered_text: shown.text });
    expect(state.audits).toContain("licensee.agreement_signed");
    const copy = sent.find((m) => /signed Keystone Software Licence Agreement/.test(m.subject))!;
    expect(copy.to).toEqual(["nora@northwind.example", "sales@example.test"]);
    expect(copy.text).toContain(`Text fingerprint (SHA-256): ${shown.sha256}`);
    expect(copy.html).toContain("Signed by: Nora North, Owner");
    // Signing again changes nothing and sends nothing.
    const again = await request(app).post(url("agreement")).send({ signer_name: "Someone Else", signer_title: "CFO", agree: true });
    expect(again.status).toBe(200);
    expect(again.body.signed.signer_name).toBe("Nora North");
    expect(sent.filter((m) => /signed Keystone/.test(m.subject))).toHaveLength(1);
  });

  it("refuses a signature on text the person was not shown", async () => {
    const { db, state } = onboardingDb();
    const res = await request(createApp(makeDeps({ db }))).post(url("agreement")).send({ signer_name: "Nora North", signer_title: "Owner", agree: true, sha256: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("agreement_changed");
    expect(state.agreements).toHaveLength(0);
  });
});

describe("website: team", () => {
  it("shows the owner alone before a roster is saved, then saves and returns the roster", async () => {
    const { db, state } = onboardingDb();
    const app = createApp(makeDeps({ db }));
    const first = await request(app).get(url("team"));
    expect(first.body).toMatchObject({ seats: 3, locked: false, team: [{ email: "nora@northwind.example", role: "Admin", is_owner: true, phone: "+14035550199" }] });
    const put = await request(app).put(url("team")).send({ team: [bea, mo] });
    expect(put.status).toBe(200);
    expect(state.team.map((t) => [t.email, t.role, t.position])).toEqual([
      ["nora@northwind.example", "Admin", 0], ["bea@northwind.example", "Broker", 1], ["mo@northwind.example", "Marketing", 2],
    ]);
    expect((await request(app).put(url("team")).send({ team: [bea, mo, { ...bea, email: "x@y.co", phone: "5875550109" }] })).status).toBe(400);
  });

  it("cannot be changed once the team is invited", async () => {
    const { db } = onboardingDb();
    db.on(/FROM provisioning_runs WHERE licensee_id = \$1 AND kind = \$2 AND NOT dry_run ORDER BY/, () => [{ id: "run1", status: "running" }]);
    db.on(/FROM provisioning_steps WHERE run_id = \$1/, () => [{ step: "team_users", status: "done" }]);
    const res = await request(createApp(makeDeps({ db }))).put(url("team")).send({ team: [bea] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("team_locked");
  });

  it("staff can see the roster and the signature, and edit the roster", async () => {
    const { db, state } = onboardingDb();
    const app = createApp(makeDeps({ db }));
    const auth = { Authorization: `Bearer ${staffToken()}` };
    expect((await request(app).get(`/api/ops/licensees/${LID}/onboarding`)).status).toBe(401);
    const view = await request(app).get(`/api/ops/licensees/${LID}/onboarding`).set(auth);
    expect(view.body).toMatchObject({ seats: 3, locked: false, roster_saved: false, agreement: { signed: null, current_version: AGREEMENT_VERSION } });
    const put = await request(app).put(`/api/ops/licensees/${LID}/team`).set(auth).send({ team: [bea] });
    expect(put.status).toBe(200);
    expect(state.team).toHaveLength(2);
    expect(state.audits).toContain("licensee.team_updated");
  });
});

describe("website: sign-up with a team", () => {
  it("saves the roster with the sign-up, owner first", async () => {
    const { db, state } = onboardingDb({ status: "pending_payment" });
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send({ ...validSignup(), seats: 3, team: [bea, mo] });
    expect(res.status).toBe(201);
    expect(state.team.map((t) => t.email)).toEqual(["nora@northwind.example", "bea@northwind.example", "mo@northwind.example"]);
    expect(state.team[0]).toMatchObject({ is_owner: true, role: "Admin", phone_e164: "+14035550199" });
  });

  it("refuses more people than seats, with the form's other errors", async () => {
    const { db, state } = onboardingDb({ status: "pending_payment" });
    const res = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send({ ...validSignup(), seats: 2, team: [bea, mo], contact_name: "" });
    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({ team: expect.stringContaining("2 seats"), contact_name: expect.any(String) });
    expect(state.team).toHaveLength(0);
    const noTeam = await request(createApp(makeDeps({ db }))).post("/api/public/signup").send({ ...validSignup(), seats: 2 });
    expect(noTeam.status).toBe(201);
    expect(state.team.map((t) => t.email)).toEqual(["nora@northwind.example"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Provisioning steps

const enc = () => encryptSecret("ksops_test-key", encryptionKey()!);
const live = () => licensee({
  server_url: "https://prairie.api.keystone.test",
  portal_url: "https://prairie.portal.keystone.test",
  client_url: "https://prairie.app.keystone.test",
  ops_key_encrypted: enc(),
  signup_token_encrypted: encryptSecret("tok-123", encryptionKey()!),
  support_level: "priority",
});

function stepCtx(l = live(), opts: { team?: Partial<TeamRow>[]; signed?: boolean; fetchImpl?: (url: string, init?: RequestInit) => Response; now?: Date; env?: NodeJS.ProcessEnv } = {}) {
  const state = { l, team: (opts.team ?? []).map((t, i) => ({ id: `t${i}`, position: i, server_user_id: null, provisioned_at: null, invite_sent_at: null, ...t })) as TeamRow[], updates: [] as string[] };
  const db = fakeDb([
    [/^SELECT \* FROM licence_agreements WHERE licensee_id = \$1 ORDER BY/, () => (opts.signed ? [{ version: AGREEMENT_VERSION, signer_name: "Dana Smith", signer_title: "Owner", signed_at: new Date() }] : [])],
    [/^SELECT \* FROM licensee_team WHERE licensee_id = \$1/, () => state.team.map((t) => ({ ...t }))],
    [/^UPDATE licensee_team SET server_user_id = \$2, provisioned_at = \$3/, (p) => {
      Object.assign(state.team.find((t) => t.id === p[0])!, { server_user_id: p[1], provisioned_at: p[2] });
      return [];
    }],
    [/^UPDATE licensee_team SET invite_sent_at = \$2/, (p) => {
      Object.assign(state.team.find((t) => t.id === p[0])!, { invite_sent_at: p[1] });
      return [];
    }],
    [/^UPDATE licensees SET agreement_link_sent_at = \$2/, (p) => { state.l = { ...state.l, agreement_link_sent_at: p[1] as Date }; state.updates.push("link"); return []; }],
    [/^UPDATE licensees SET agreement_reminder_sent_at = \$2/, (p) => { state.l = { ...state.l, agreement_reminder_sent_at: p[1] as Date }; state.updates.push("reminder"); return []; }],
    [/^UPDATE licensees SET onboarding_email_sent_at = \$2/, (p) => { state.l = { ...state.l, onboarding_email_sent_at: p[1] as Date }; return []; }],
  ]);
  const { mailer, sent } = fakeMailer();
  const posts: Array<{ url: string; body: any; headers: Headers }> = [];
  const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
    posts.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
    return opts.fetchImpl ? opts.fetchImpl(String(u), init) : new Response("{}");
  });
  let now = opts.now ?? new Date("2026-11-06T12:00:00Z");
  const ctx = (): ExecCtx => ({
    deps: { db, mailer, fetch: fetchImpl as unknown as typeof fetch, now: () => now, env: { ...process.env, PUBLIC_SITE_URL: "https://www.keystonecrm.online", ...opts.env } },
    run: { id: "r1" } as ExecCtx["run"],
    step: { started_at: new Date("2026-11-06T12:00:00Z") } as ExecCtx["step"],
    licensee: state.l,
    outputs: {},
    log: async () => {},
  });
  return { ctx, state, sent, posts, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const roster = (): Partial<TeamRow>[] => [
  { full_name: "Dana Smith", email: "dana@prairie.example", phone_e164: "+14035550199", role: "Admin", is_owner: true },
  { full_name: "Bea Broker", email: "bea@prairie.example", phone_e164: "+15875550101", role: "Broker", is_owner: false },
  { full_name: "Mo Marketer", email: "mo@prairie.example", phone_e164: "+15875550102", role: "Marketing", is_owner: false },
];

describe("provisioning: licence agreement gate", () => {
  it("sits between the sign-in email and the team invites", () => {
    const keys = PROVISION_STEPS.map((s) => s.key);
    expect(keys.indexOf("licence_agreement")).toBe(keys.indexOf("welcome_email") + 1);
    expect(keys.indexOf("team_users")).toBe(keys.indexOf("licence_agreement") + 1);
    expect(keys.indexOf("onboarding_email")).toBe(keys.indexOf("team_users") + 1);
  });

  it("waits while unsigned: emails the link once, one reminder after 24 hours, then nothing more", async () => {
    const s = stepCtx();
    const first = await licenceAgreement(s.ctx());
    expect(first).toMatchObject({ kind: "wait", message: expect.stringContaining("sign the licence agreement") });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain(`https://www.keystonecrm.online/signup/agreement?l=${s.state.l.id}&t=tok-123`);
    await licenceAgreement(s.ctx());
    s.tick(23 * 3_600_000);
    await licenceAgreement(s.ctx());
    expect(s.sent).toHaveLength(1);
    s.tick(2 * 3_600_000);
    await licenceAgreement(s.ctx());
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1].subject).toMatch(/^Reminder: please sign/);
    s.tick(72 * 3_600_000);
    expect((await licenceAgreement(s.ctx())).kind).toBe("wait"); // never fails by itself
    expect(s.sent).toHaveLength(2);
    expect(s.state.updates).toEqual(["link", "reminder"]);
  });

  it("does not send the link again when the welcome email already had it", async () => {
    const s = stepCtx({ ...live(), agreement_link_sent_at: new Date("2026-11-06T11:00:00Z") });
    await licenceAgreement(s.ctx());
    expect(s.sent).toHaveLength(0);
  });

  it("is done once signed", async () => {
    const s = stepCtx(live(), { signed: true });
    expect(await licenceAgreement(s.ctx())).toMatchObject({ kind: "done", message: expect.stringContaining("signed by Dana Smith") });
    expect(s.sent).toHaveLength(0);
  });
});

describe("provisioning: team users and invites", () => {
  const serverOk = (u: string, init?: RequestInit) => {
    const users = JSON.parse(String(init?.body)).users as Array<{ email: string }>;
    return new Response(JSON.stringify({ ok: true, results: users.map((x, i) => ({ email: x.email, status: i === 0 ? "created" : "existing", user_id: `u-${x.email}` })) }), { status: 200 });
  };

  it("creates everyone but the owner on the brokerage's server and invites each of them once", async () => {
    const s = stepCtx(live(), { team: roster(), fetchImpl: serverOk });
    const out = await teamUsers(s.ctx());
    expect(out).toMatchObject({ kind: "done", output: { created: 1, existing: 1, invited: 2 } });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].url).toBe("https://prairie.api.keystone.test/api/provision/users");
    expect(s.posts[0].headers.get("X-KS-Tenant")).toBe("prairie");
    expect(s.posts[0].headers.get("X-KS-Ops-Key")).toBe("ksops_test-key");
    expect(s.posts[0].body.users).toEqual([
      { name: "Bea Broker", email: "bea@prairie.example", phone: "+15875550101", role: "Broker" },
      { name: "Mo Marketer", email: "mo@prairie.example", phone: "+15875550102", role: "Marketing" },
    ]);
    expect(s.sent.map((m) => m.to[0])).toEqual(["bea@prairie.example", "mo@prairie.example"]);
    // Again: nothing to create, nobody invited twice.
    expect(await teamUsers(s.ctx())).toMatchObject({ kind: "done", output: { created: 0, invited: 0 } });
    expect(s.posts).toHaveLength(1);
    expect(s.sent).toHaveLength(2);
  });

  it("is done straight away when the owner is alone", async () => {
    const s = stepCtx(live(), { team: roster().slice(0, 1) });
    expect((await teamUsers(s.ctx())).kind).toBe("done");
    expect(s.posts).toHaveLength(0);
  });

  it("fails clearly for an old KS-server, and names the people the server refused", async () => {
    const old = stepCtx(live(), { team: roster(), fetchImpl: () => new Response("{}", { status: 404 }) });
    expect(await teamUsers(old.ctx())).toMatchObject({ kind: "failed", error: expect.stringContaining("/api/provision/users") });
    const refused = stepCtx(live(), {
      team: roster(),
      fetchImpl: () => new Response(JSON.stringify({ results: [{ email: "bea@prairie.example", status: "created", user_id: "u1" }, { email: "mo@prairie.example", status: "invalid", error: "invalid_phone" }] })),
    });
    expect(await teamUsers(refused.ctx())).toMatchObject({ kind: "failed", error: expect.stringContaining("Mo Marketer <mo@prairie.example>: invalid_phone") });
    expect(refused.state.team.find((t) => t.email === "bea@prairie.example")!.provisioned_at).toBeTruthy();
    expect(refused.sent).toHaveLength(0);
  });

  it("the invite has the portal link, sign-in by texted code, the quick guide and the wizard", () => {
    const l = live();
    const mail = brokerInviteMail(l, { full_name: "Bea Broker", email: "bea@prairie.example", phone_e164: "+15875550101", role: "Broker", is_owner: false });
    expect(mail.to).toEqual(["bea@prairie.example"]);
    expect(mail.from).toEqual({ email: "support@keystonecrm.online", name: "Keystone Support" });
    for (const s of ["https://prairie.portal.keystone.test", "code texted to your mobile ((587) 555-0101)", "set-up wizard", "Pipeline and applications", "accept each document or reject it", "Lender submission", "Dialler and phone", "Maya"]) {
      expect(mail.text).toContain(s);
    }
    expect(mail.text).not.toContain("Marketing: email and text campaigns");
    expect(quickGuide("Marketing", false).some((g) => g.startsWith("Marketing:"))).toBe(true);
  });
});

describe("provisioning: owner onboarding email", () => {
  it("is sent once, from support, introducing the onboarding contact and the team", async () => {
    const s = stepCtx(live(), { team: roster(), env: { KS_ONBOARDING_BOOKING_URL: "https://outlook.office.com/bookwithme/keystone-onboarding" } });
    expect(await onboardingEmail(s.ctx())).toMatchObject({ kind: "done" });
    const mail = s.sent[0];
    expect(mail.to).toEqual(["dana@prairie.example"]);
    expect(mail.from?.email).toBe("support@keystonecrm.online");
    expect(mail.text).toContain("introduce Todd Werboweski");
    expect(mail.text).toContain("one 60-minute setup session with Todd on Microsoft Teams");
    expect(mail.text).toContain("Book a time that suits you here: https://outlook.office.com/bookwithme/keystone-onboarding");
    expect(mail.text).toContain("Bea Broker (Broker), Mo Marketer (Marketing)");
    expect(await onboardingEmail(s.ctx())).toMatchObject({ kind: "done", output: { already_sent: true } });
    expect(s.sent).toHaveLength(1);
  });

  it("scales the Teams sessions with the support level and asks for a reply when there is no booking link", () => {
    const team = roster().slice(0, 1) as TeamRow[];
    const text = (level: "email" | "priority" | "premium" | "dedicated") => ownerOnboardingMail(live() && { ...live(), support_level: level }, team).text;
    expect(text("email")).toContain("one 30-minute kickoff call with Todd on Microsoft Teams");
    expect(text("email")).toContain("Reply to this email with a few times that suit you");
    expect(text("premium")).toContain("two 60-minute setup sessions");
    expect(text("dedicated")).toContain("dedicated onboarding plan. Todd will contact you");
    expect(text("dedicated")).toContain("will be in touch within one business day");
  });

  it("never carries a personal mobile: only the support mailbox and the support line when set", () => {
    process.env.KS_SUPPORT_PHONE = "1-877-555-0142";
    const l = { ...live(), contact_phone: "+14035550199" };
    const mail = ownerOnboardingMail(l, roster() as TeamRow[]);
    expect(mail.text).toContain("Email support@keystonecrm.online or call the Keystone support line at 1-877-555-0142");
    expect(mail.text).not.toMatch(/555-0199|5550199/);
  });
});

describe("email sending address", () => {
  it("SendGrid sends from the given address with a reply-to", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM = "noreply@keystonecrm.online";
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 202 }));
    const send = createMailer(fetchImpl as unknown as typeof fetch);
    expect(await send({ to: ["a@b.co"], subject: "s", text: "t", from: { email: "support@keystonecrm.online", name: "Keystone Support" }, replyTo: "support@keystonecrm.online" })).toEqual({ ok: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body));
    expect(body.from).toEqual({ email: "support@keystonecrm.online", name: "Keystone Support" });
    expect(body.reply_to).toEqual({ email: "support@keystonecrm.online" });
    await send({ to: ["a@b.co"], subject: "s", text: "t" });
    const plain = JSON.parse(String(fetchImpl.mock.calls[1][1]!.body));
    expect(plain.from.email).toBe("noreply@keystonecrm.online");
    expect(plain.reply_to).toBeUndefined();
  });
});

describe("ops provisioning page", () => {
  it("its script parses (a raw newline inside the page's template once broke every button)", () => {
    const js = /<script>([\s\S]*?)<\/script>/.exec(PROVISIONING_PAGE_HTML)![1];
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain("Team and licence agreement");
  });
});
