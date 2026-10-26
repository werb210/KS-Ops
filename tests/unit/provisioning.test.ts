// KS_OPS_AUTO_PROVISION_v1 - the provisioning state machine, its service steps, the status token and the dry-run plan.
// Azure, GitHub and the licensee's servers are all faked: nothing leaves the process.
import { describe, expect, it, vi } from "vitest";
import { encryptionKey, encryptSecret, sha256Hex } from "../../src/lib/crypto.js";
import {
  acceptableUrl, advanceDueRuns, advanceRun, startProvisioningQuietly, handleCallback, markStepDone, publicStatus, retryStep, runForCallback, startRun,
  WORKFLOW_TIMEOUT_MS,
} from "../../src/provisioning/machine.js";
import { adminUser, health, liveStatusFor, phoneNumbers, phoneRequest, retentionGate, welcomeMail, type ExecCtx, type Executor } from "../../src/provisioning/executors.js";
import { serviceSetupMissing } from "../../src/provisioning/config.js";
import { describePlan, PROVISION_STEPS, registryEntry } from "../../src/provisioning/steps.js";
import { licenseeIdFromStatusToken, statusTokenFor } from "../../src/provisioning/statusToken.js";
import { configuredEnv, licensee, LICENSEE_ID, machine } from "./provisioningFakes.js";

const WORKFLOW_STEPS = PROVISION_STEPS.filter((s) => s.where === "workflow").map((s) => s.key);
const okExecutors = (): Record<string, Executor> => ({
  twilio_account: vi.fn(async () => ({ kind: "done" as const })), // KS_OPS_TWILIO_AUTO_v1
  twilio_address: vi.fn(async () => ({ kind: "done" as const })),
  twilio_voice: vi.fn(async () => ({ kind: "done" as const })),
  twilio_bundle: vi.fn(async () => ({ kind: "done" as const })),
  texting_registration: vi.fn(async () => ({ kind: "done" as const })),
  health: vi.fn(async () => ({ kind: "done" as const })),
  configure: vi.fn(async () => ({ kind: "done" as const })),
  admin_user: vi.fn(async () => ({ kind: "done" as const, output: { created: true } })),
  welcome_email: vi.fn(async () => ({ kind: "done" as const })),
  phone_numbers: vi.fn(async () => ({ kind: "done" as const })), // KS_OPS_PHONE_PROVISIONING
});

/** Plays the workflow: reports every step it was given as done (with the addresses for azure_resources). */
async function workflowReportsAllDone(m: ReturnType<typeof machine>, runId: string) {
  const run = (await m.store.getRun(runId))!;
  for (const step of run.workflow_steps) {
    const r = await handleCallback(m.deps, (await m.store.getRun(runId))!, {
      step,
      status: "done",
      output: step === "azure_resources"
        ? { server_url: "https://ks-prairie-server.azurewebsites.net", agent_url: "https://ks-prairie-agent.azurewebsites.net", portal_url: "https://ks-prairie-portal.azurestaticapps.net", client_url: "https://ks-prairie-client.azurestaticapps.net" }
        : {},
    });
    expect(r).toEqual({ ok: true });
  }
}

describe("status token", () => {
  it("round-trips to the licensee id and is 43 url-safe characters", () => {
    const t = statusTokenFor(LICENSEE_ID)!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(licenseeIdFromStatusToken(t)).toBe(LICENSEE_ID);
  });

  it("refuses a changed token, another licensee's id with the wrong MAC, and junk", () => {
    const t = statusTokenFor(LICENSEE_ID)!;
    const flipped = t.slice(0, 30) + (t[30] === "A" ? "B" : "A") + t.slice(31);
    expect(licenseeIdFromStatusToken(flipped)).toBeNull();
    const other = statusTokenFor("22222222-2222-4222-8222-222222222222")!;
    expect(licenseeIdFromStatusToken(other.slice(0, 22) + t.slice(22))).toBeNull();
    expect(licenseeIdFromStatusToken(LICENSEE_ID)).toBeNull();
    expect(licenseeIdFromStatusToken(undefined)).toBeNull();
  });
});

describe("dry-run plan", () => {
  it("lists every provisioning change with the script's names, in Canada Central", () => {
    const plan = describePlan("provision", "northwind");
    expect(plan[0]).toMatch(/^twilio_account: .*Keystone - <company> \(northwind\)/); // KS_OPS_TWILIO_AUTO_v1
    expect(plan.find((l) => l.startsWith("azure_resources:"))).toContain("scripts/provision-licensee.sh northwind canadacentral");
    expect(plan.join("\n")).toContain("ks-northwind-pg");
    expect(plan.join("\n")).toContain("ks-northwind-deploy");
    expect(plan.join("\n")).toContain(JSON.stringify(registryEntry("northwind")));
    for (const s of PROVISION_STEPS) expect(plan.some((l) => l.startsWith(`${s.key}:`))).toBe(true);
  });

  it("teardown starts with the retention check and only deletes the licensee's own resource group", () => {
    const plan = describePlan("teardown", "northwind");
    expect(plan[0]).toMatch(/^retention_gate:/);
    expect(plan.join("\n")).toContain("az group delete -n ks-northwind ");
  });
});

describe("setup checklist", () => {
  it("lists what KS-Ops lacks and is empty once configured", () => {
    const missing = serviceSetupMissing("provision", { NODE_ENV: "test" });
    expect(missing.map((m) => m.key)).toEqual(["KS_PROVISION_GITHUB_TOKEN", "OPS_ENCRYPTION_KEY", "KS_OPS_PUBLIC_URL", "KS_TWILIO_ACCOUNT_SID"]);
    expect(serviceSetupMissing("provision", configuredEnv())).toEqual([]);
    expect(serviceSetupMissing("teardown", configuredEnv()).map((m) => m.key)).toEqual(["KS_TEARDOWN_ENABLED"]);
    expect(serviceSetupMissing("teardown", configuredEnv({ KS_TEARDOWN_ENABLED: "true" }))).toEqual([]);
  });
});

describe("provisioning state machine", () => {
  it("waits for manual setup when credentials are missing, changes nothing and tells sales once", async () => {
    const m = machine(licensee(), { executors: okExecutors() }, { NODE_ENV: "test", KS_SALES_EMAIL: "sales@example.test" });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    await advanceRun(m.deps, run.id);
    const after = (await m.store.getRun(run.id))!;
    expect(after.status).toBe("waiting_for_setup");
    expect(after.setup_missing.map((x) => x.key)).toContain("KS_PROVISION_GITHUB_TOKEN");
    expect(m.dispatch).not.toHaveBeenCalled();
    const notices = m.sent.filter((s) => /waiting for configuration/.test(s.subject));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toMatch(/1\. KS-Ops app setting KS_PROVISION_GITHUB_TOKEN/);
  });

  it("starts the workflow once for all Azure and GitHub steps, then runs the service steps to the end", async () => {
    const ex = okExecutors();
    const m = machine(licensee(), { executors: ex });
    const { run, created } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    expect(created).toBe(true);
    // A second trigger (webhook redelivery) gets the same run.
    expect((await startRun(m.deps, LICENSEE_ID, "provision", "checkout")).created).toBe(false);

    await advanceRun(m.deps, run.id);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    const [file, inputs] = m.dispatch.mock.calls[0];
    expect(file).toBe("provision-licensee.yml");
    expect(inputs).toMatchObject({ run_id: run.id, code: "prairie", steps: WORKFLOW_STEPS.join(","), ks_ops_url: "https://ks-ops.example.test", dry_run: "false" });
    expect((await m.store.getRun(run.id))!.callback_token_hash).toBe(sha256Hex(inputs.callback_token));

    // While the workflow works, advancing again does not start it twice.
    await advanceRun(m.deps, run.id);
    expect(m.dispatch).toHaveBeenCalledTimes(1);

    await workflowReportsAllDone(m, run.id);
    expect(m.state.l.server_url).toBe("https://ks-prairie-server.azurewebsites.net");
    const done = (await advanceRun(m.deps, run.id))!;
    expect(done.status).toBe("done");
    for (const k of ["health", "configure", "admin_user", "welcome_email"]) expect(ex[k]).toHaveBeenCalledTimes(1);
    expect((await m.store.steps(run.id)).every((s) => s.status === "done")).toBe(true);
    // The callback token is gone once the run is done.
    expect(await runForCallback(m.deps, run.id, inputs.callback_token)).toBeNull();
  });

  it("only accepts the run's own unexpired token, for steps the workflow was given", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    const token = m.dispatch.mock.calls[0][1].callback_token;
    expect(await runForCallback(m.deps, run.id, "wrong")).toBeNull();
    const ok = (await runForCallback(m.deps, run.id, token))!;
    expect(ok.id).toBe(run.id);
    expect(await handleCallback(m.deps, ok, { step: "health", status: "done" })).toEqual({ ok: false, status: 400, error: "unknown_step" });
    m.tick(WORKFLOW_TIMEOUT_MS + 60 * 60_000);
    expect(await runForCallback(m.deps, run.id, token)).toBeNull();
  });

  it("refuses addresses that are not https on an allowed host", () => {
    expect(acceptableUrl("https://ks-x-server.azurewebsites.net/")).toBe("https://ks-x-server.azurewebsites.net");
    expect(acceptableUrl("http://ks-x-server.azurewebsites.net")).toBeNull();
    expect(acceptableUrl("https://evil.example.com")).toBeNull();
  });

  it("fails a workflow step that never reports back, and emails sales once", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    m.tick(WORKFLOW_TIMEOUT_MS + 1000);
    const failed = (await advanceRun(m.deps, run.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toMatch(/^azure_resources: no report from the GitHub workflow/);
    await advanceRun(m.deps, run.id);
    expect(m.sent.filter((s) => /needs attention/.test(s.subject))).toHaveLength(1);
  });

  it("a failed step stops the run; Retry step runs it again and the run carries on", async () => {
    let healthy = false;
    const ex = { ...okExecutors(), health: vi.fn(async () => (healthy ? { kind: "done" as const } : { kind: "failed" as const, error: "portal answered 500" })) };
    const m = machine(licensee(), { executors: ex });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    await workflowReportsAllDone(m, run.id);
    const failed = (await advanceRun(m.deps, run.id))!;
    expect(failed.status).toBe("failed");
    expect((await m.store.steps(run.id)).find((s) => s.step === "health")).toMatchObject({ status: "failed", last_error: "portal answered 500", attempts: 1 });
    expect(m.sent.find((s) => /needs attention/.test(s.subject))!.text).toMatch(/health: portal answered 500/);

    healthy = true;
    const retried = await retryStep(m.deps, run.id, "health", "staff@example.test");
    expect(retried.ok).toBe(true);
    const done = (await advanceRun(m.deps, run.id))!;
    expect(done.status).toBe("done");
    expect((await m.store.steps(run.id)).find((s) => s.step === "health")!.attempts).toBe(2);
    // The workflow steps that were done are not run again.
    expect(m.dispatch).toHaveBeenCalledTimes(1);
  });

  it("Retry on a workflow step starts the workflow again for that step and the ones after it", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    const r1 = (await m.store.getRun(run.id))!;
    await handleCallback(m.deps, r1, { step: "azure_resources", status: "done", output: {} });
    await handleCallback(m.deps, r1, { step: "twilio_settings", status: "done" });
    await handleCallback(m.deps, r1, { step: "secrets", status: "done" });
    await handleCallback(m.deps, r1, { step: "github_environments", status: "failed", message: "GitHub create environment: 403" });
    expect((await m.store.getRun(run.id))!.status).toBe("failed");
    await retryStep(m.deps, run.id, "github_environments", "staff");
    await advanceRun(m.deps, run.id);
    expect(m.dispatch).toHaveBeenCalledTimes(2);
    expect(m.dispatch.mock.calls[1][1].steps).toBe("github_environments,deploy_registry,deploy");
  });

  it("Mark done manually skips a step and the run carries on", async () => {
    const ex = { ...okExecutors(), admin_user: vi.fn(async () => ({ kind: "failed" as const, error: "KS-server too old" })) };
    const m = machine(licensee(), { executors: ex });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    await workflowReportsAllDone(m, run.id);
    expect((await advanceRun(m.deps, run.id))!.status).toBe("failed");
    const r = await markStepDone(m.deps, run.id, "admin_user", "todd@example.test", "created the admin in the portal");
    expect(r.ok).toBe(true);
    expect((await advanceRun(m.deps, run.id))!.status).toBe("done");
    expect((await m.store.steps(run.id)).find((s) => s.step === "admin_user")).toMatchObject({ status: "manual", done_by: "todd@example.test" });
  });

  it("the workflow reporting missing settings puts the run back to waiting for setup", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    await handleCallback(m.deps, (await m.store.getRun(run.id))!, { status: "setup_missing", missing: ["AZURE_CLIENT_ID", "OPENAI_API_KEY", "nonsense"] });
    const after = (await m.store.getRun(run.id))!;
    expect(after.status).toBe("waiting_for_setup");
    expect(after.setup_missing.map((x) => x.key)).toEqual(["AZURE_CLIENT_ID", "OPENAI_API_KEY"]);
    expect(after.callback_token_hash).toBeNull();
    expect((await m.store.steps(run.id)).find((s) => s.step === "azure_resources")!.status).toBe("pending");
  });

  it("a dry run changes nothing: no workflow without GitHub, no service step, every step logs its plan", async () => {
    const ex = okExecutors();
    const m = machine(licensee(), { executors: ex }, { NODE_ENV: "test" });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "staff", { dryRun: true });
    const done = (await advanceRun(m.deps, run.id))!;
    expect(done.status).toBe("done");
    expect(m.dispatch).not.toHaveBeenCalled();
    for (const k of Object.keys(ex)) expect(ex[k]).not.toHaveBeenCalled();
    const lines = m.store.logRows.map((l) => l.message);
    expect(lines.some((l) => l.startsWith("would: azure_resources: scripts/provision-licensee.sh prairie canadacentral"))).toBe(true);
    expect(lines.some((l) => l.startsWith("would: welcome_email:"))).toBe(true);
    expect(m.sent).toHaveLength(0);
  });

  it("starts by itself after payment unless KS_AUTO_PROVISION=off or the licensee already has a copy", async () => {
    const off = machine(licensee(), {}, configuredEnv({ KS_AUTO_PROVISION: "off" }));
    expect(await startProvisioningQuietly(off.deps, licensee(), "checkout")).toBeNull();
    const on = machine(licensee());
    expect(await startProvisioningQuietly(on.deps, licensee({ server_url: "https://x.azurewebsites.net" }), "checkout")).toBeNull();
    expect((await startProvisioningQuietly(on.deps, licensee(), "checkout"))?.trigger).toBe("checkout");
  });

  it("the worker advances due runs", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    expect((await advanceDueRuns(m.deps)).tried).toBe(1);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
  });

  it("the website sees friendly progress, then the portal address once ready", async () => {
    const m = machine(licensee(), { executors: okExecutors() });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    const during = await publicStatus(m.deps, LICENSEE_ID);
    expect(during.state).toBe("setting_up");
    expect(JSON.stringify(during)).not.toMatch(/azure|github|token/i);
    const steps = (during as { steps: Array<{ label: string; status: string }> }).steps;
    expect(steps[0]).toEqual({ label: "Setting up your phone system", status: "done" }); // KS_OPS_TWILIO_AUTO_v1
    expect(steps[1]).toEqual({ label: "Creating your servers and database", status: "in_progress" });
    await workflowReportsAllDone(m, run.id);
    m.state.l = { ...m.state.l, status: "active" };
    await advanceRun(m.deps, run.id);
    const ready = await publicStatus(m.deps, LICENSEE_ID);
    expect(ready).toMatchObject({ state: "ready", portal_url: "https://ks-prairie-portal.azurestaticapps.net", email_sent: true });
  });
});

function ctx(l = licensee(), over: Partial<ExecCtx> = {}, fetchImpl?: (url: string, init?: RequestInit) => Response): ExecCtx {
  const m = machine(l);
  return {
    deps: { ...m.deps, fetch: vi.fn(async (u: string, i?: RequestInit) => (fetchImpl ? fetchImpl(String(u), i) : new Response("{}"))) as unknown as typeof fetch },
    run: { id: "r1" } as ExecCtx["run"],
    step: { started_at: new Date("2026-10-25T12:00:00Z") } as ExecCtx["step"],
    licensee: l,
    outputs: {},
    log: async () => {},
    ...over,
  };
}

const live = licensee({
  server_url: "https://ks-prairie-server.azurewebsites.net",
  portal_url: "https://ks-prairie-portal.azurestaticapps.net",
  client_url: "https://ks-prairie-client.azurestaticapps.net",
});

describe("status page while the phone lines wait", () => {
  it("is ready once the sign-in email is out, even if the phone step is blocked", async () => {
    const ex = { ...okExecutors(), phone_numbers: vi.fn(async () => ({ kind: "blocked" as const, retryMs: 60_000, message: "Connect Twilio" })) };
    const m = machine(licensee(), { executors: ex });
    const { run } = await startRun(m.deps, LICENSEE_ID, "provision", "checkout");
    await advanceRun(m.deps, run.id);
    await workflowReportsAllDone(m, run.id);
    m.state.l = { ...m.state.l, status: "active" };
    const after = (await advanceRun(m.deps, run.id))!;
    expect(after.status).toBe("blocked");
    expect(await publicStatus(m.deps, LICENSEE_ID)).toMatchObject({ state: "ready" });
  });
});

describe("service steps", () => {
  it("health waits for Azure's placeholder page to become the real app", async () => {
    let deployed = false;
    const c = ctx(live, {}, (url) => {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response(deployed ? '<div id="root"></div>' : "<h1>Congratulations on your new site</h1>", { status: 200 });
    });
    expect((await health(c)).kind).toBe("wait");
    deployed = true;
    expect((await health(c)).kind).toBe("done");
  });

  it("health gives up after an hour", async () => {
    const c = ctx(live, { step: { started_at: new Date("2026-10-25T10:00:00Z") } as ExecCtx["step"] }, () => new Response("", { status: 503 }));
    const r = await health(c);
    expect(r.kind).toBe("failed");
  });

  it("the copy goes live as trial during a staff free trial, otherwise active", () => {
    expect(liveStatusFor({ admin_trial_started_at: new Date(), admin_trial_ended_at: null })).toBe("trial");
    expect(liveStatusFor({ admin_trial_started_at: null, admin_trial_ended_at: null })).toBe("active");
  });

  it("admin user: an old KS-server without the endpoint fails clearly", async () => {
    const withKey = { ...live, ops_key_encrypted: null };
    expect((await adminUser(ctx(withKey))).kind).toBe("failed");
  });

  it("the welcome email has the portal link, the company code and how to sign in", () => {
    const mail = welcomeMail(live);
    expect(mail.to).toEqual(["dana@prairie.example"]);
    expect(mail.text).toContain("https://ks-prairie-portal.azurestaticapps.net");
    expect(mail.text).toContain('"prairie"');
    expect(mail.text).toMatch(/one-time code/);
  });

  // KS_OPS_PHONE_PROVISIONING
  it("phone numbers: area code from the contact's phone, province from the address", () => {
    expect(phoneRequest({ contact_phone: "+1 (403) 555-0100", province_state: "ab", country: "CA" })).toEqual({ area_code: "403", region: "AB", country: "CA" });
    expect(phoneRequest({ contact_phone: "1-888-555-0100", province_state: null, country: "US" })).toEqual({ area_code: undefined, region: undefined, country: "US" });
  });

  it("phone numbers: the licensee's server buys them; the results are logged", async () => {
    const enc = encryptSecret("ksops_test-key", encryptionKey()!);
    const calls: Array<{ url: string; body: unknown; key: unknown }> = [];
    const logs: string[] = [];
    const c = ctx({ ...live, ops_key_encrypted: enc, contact_phone: "+14035550100", province_state: "AB", country: "CA" }, { log: async (m) => { logs.push(m); } }, (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)["X-KS-Ops-Key"] });
      return new Response(JSON.stringify({ ok: true, results: [{ kind: "main", status: "bought", number: "+14035550111" }, { kind: "toll_free", status: "not_in_plan" }] }));
    });
    expect(await phoneNumbers(c)).toMatchObject({ kind: "done", output: { results: [{ kind: "main", status: "bought" }, { kind: "toll_free" }] } });
    expect(calls).toEqual([{ url: "https://ks-prairie-server.azurewebsites.net/api/provision/phone-numbers", body: { area_code: "403", region: "AB", country: "CA" }, key: "ksops_test-key" }]);
    expect(logs).toContain("phone numbers: main: bought +14035550111");
  });

  it("phone numbers: Twilio not connected blocks with what to do; an address requirement fails with the reason", async () => {
    const enc = encryptSecret("ksops_test-key", encryptionKey()!);
    const l = { ...live, ops_key_encrypted: enc };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notSet = ctx(l, {}, () => new Response(JSON.stringify({ ok: false, error: "twilio_not_configured", message: "Twilio is not connected" }), { status: 503 }));
    expect(await phoneNumbers(notSet)).toMatchObject({ kind: "blocked", message: expect.stringMatching(/TWILIO_ACCOUNT_SID/) });
    const regulatory = ctx(l, {}, () => new Response(JSON.stringify({ ok: true, results: [{ kind: "main", status: "failed", error: "regulatory_requirement", message: "Twilio needs a registered business address" }] })));
    expect(await phoneNumbers(regulatory)).toMatchObject({ kind: "failed", error: expect.stringMatching(/registered business address/) });
    const old = ctx(l, {}, () => new Response("not found", { status: 404 }));
    expect(await phoneNumbers(old)).toMatchObject({ kind: "failed", error: expect.stringMatching(/newer KS-server/) });
    const flaky = ctx(l, {}, () => new Response(JSON.stringify({ ok: true, results: [{ kind: "main", status: "failed", error: "twilio_error", message: "Twilio down" }] })));
    expect(await phoneNumbers(flaky)).toMatchObject({ kind: "wait" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("teardown is refused until the licensee is cancelled and purged", async () => {
    expect(await retentionGate(ctx(live))).toMatchObject({ kind: "blocked", message: expect.stringMatching(/not cancelled/) });
    expect(await retentionGate(ctx({ ...live, status: "cancelled" }))).toMatchObject({ kind: "blocked", message: expect.stringMatching(/purge has not run/) });
  });

  it("teardown follows the licensee's KS-server retention check, and refuses when it cannot ask", async () => {
    const enc = encryptSecret("ksops_test-key", encryptionKey()!);
    const cancelled = { ...live, status: "cancelled", purged_at: new Date(), ops_key_encrypted: enc };
    const kept = ctx(cancelled, {}, () => new Response(JSON.stringify({ deletable: false, reason: "records kept for retention", kept_until: "2033-04-01" })));
    expect(await retentionGate(kept)).toMatchObject({ kind: "blocked", message: expect.stringMatching(/2033-04-01/) });
    const ok = ctx(cancelled, {}, () => new Response(JSON.stringify({ deletable: true })));
    expect((await retentionGate(ok)).kind).toBe("done");
    const old = ctx(cancelled, {}, () => new Response("not found", { status: 404 }));
    expect(await retentionGate(old)).toMatchObject({ kind: "blocked", message: expect.stringMatching(/refused/) });
  });
});
