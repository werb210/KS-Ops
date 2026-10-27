// KS_OPS_AUTO_PROVISION_v1 - the provisioning state machine.
//
// A run has one row per step (pending -> running -> done | failed | blocked, or manual when staff mark it done).
// advanceRun() works on the first step that is not done or manual:
//   - a "service" step runs here (executors.ts); done moves on in the same pass, wait/blocked sets next_attempt_at;
//   - a "workflow" step starts the KS-Ops GitHub Actions workflow once for every workflow step still to do, with a
//     one-off callback token; the workflow reports each step back (handleCallback). No report within
//     WORKFLOW_TIMEOUT_MS fails the step.
// A failed step stops the run (status failed) and emails sales once; "Retry step" puts it (and anything after it that
// failed) back to pending. Missing credentials stop the run before anything is changed (status waiting_for_setup,
// with a checklist), and it starts by itself once they are there.
// Dry runs change nothing: every step logs what it would do (steps.ts describePlan) and is marked done; the workflow,
// when it can be started, runs with dry_run=true and only prints its plan.
import type { Deps } from "../deps.js";
import { salesEmail } from "../config.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { matchesHash, newSecret, sha256Hex } from "../lib/crypto.js";
import { audit, getLicensee, rotateOpsKey, type LicenseeRow } from "../licensees/repo.js";
import { allowedServerHostSuffixes } from "../config.js";
import { autoProvisionEnabled, callbackBaseUrl, githubTokenConfigured, serviceSetupMissing, teardownEnabled, workflowSetupItems, type SetupItem } from "./config.js";
import { SERVICE_EXECUTORS, type Executor, type StepOutcome } from "./executors.js";
import { describePlan, stepDef, stepsFor, WORKFLOW_FILES, type RunKind } from "./steps.js";
import type { ProvisioningStore, RunRow, StepRow } from "./store.js";
import type { TwilioStore } from "../twilio/store.js";
import type { TwilioHttp } from "../twilio/http.js";
import { serverSettings } from "../twilio/account.js";
import { twilioSummary } from "../twilio/view.js";
import { workspaceAppSettings } from "../workspace/apps.js"; // KS_OPS_WORKSPACE_APPS
import { workspaceSummary } from "../workspace/status.js";

export const WORKFLOW_TIMEOUT_MS = 4 * 60 * 60_000;
export const CALLBACK_TOKEN_TTL_MS = WORKFLOW_TIMEOUT_MS + 30 * 60_000;
const SETUP_RECHECK_MS = 30 * 60_000;
const WORKFLOW_SETUP_RECHECK_MS = 6 * 60 * 60_000;
const MAX_STEPS_PER_PASS = 24;

export type MachineDeps = Pick<Deps, "db" | "fetch" | "mailer" | "now"> & {
  store: ProvisioningStore;
  /** Starts a KS-Ops workflow (github.ts dispatchWorkflow in production). */
  dispatch: (file: string, inputs: Record<string, string>) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  executors?: Record<string, Executor>;
  twilioStore?: TwilioStore; // KS_OPS_TWILIO_AUTO_v1 - tests replace them
  twilioHttp?: TwilioHttp;
};

const isFinished = (s: StepRow) => s.status === "done" || s.status === "manual";
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

// ---------------------------------------------------------------------------------------------------------------------
// Starting runs

export type StartResult = { run: RunRow; created: boolean };

export async function startRun(
  deps: MachineDeps,
  licenseeId: string,
  kind: RunKind,
  trigger: string,
  opts: { dryRun?: boolean; region?: string; by?: string } = {},
): Promise<StartResult> {
  const res = await deps.store.createRun({
    licensee_id: licenseeId,
    kind,
    trigger,
    dry_run: opts.dryRun === true,
    region: opts.region || "canadacentral",
    created_by: opts.by ?? "ks-ops",
  });
  if (res.created) {
    await deps.store.log(res.run.id, null, "info", `${opts.dryRun ? "dry run" : kind} started (${trigger}) by ${opts.by ?? "ks-ops"}`);
    await audit(deps.db, opts.by ?? "ks-ops", `licensee.${kind}_started`, licenseeId, { run_id: res.run.id, trigger, dry_run: opts.dryRun === true });
  }
  return res;
}

/**
 * Called when a licensee needs its copy set up (paid through Checkout, or a staff free trial started before it had a
 * server). Never throws: a failure here must not break the webhook or the trial; the sales email still goes out.
 */
export async function startProvisioningQuietly(deps: MachineDeps, l: Pick<LicenseeRow, "id" | "server_url">, trigger: string, by = "ks-ops"): Promise<RunRow | null> {
  try {
    if (l.server_url) return null; // already has a copy
    if (!autoProvisionEnabled(deps.env)) return null; // KS_AUTO_PROVISION=off: staff start it from /ops/provisioning
    const { run } = await startRun(deps, l.id, "provision", trigger, { by });
    return run;
  } catch (err) {
    console.error("[provisioning] could not start a run", l.id, errText(err));
    return null;
  }
}

/**
 * The cancellation purge ran (KS-server reported it, or staff marked it). With KS_TEARDOWN_ENABLED=true a teardown run
 * starts; its first step refuses until the licensee's KS-server confirms no record is still kept for retention and no
 * legal hold is open (KS-server v14 keeps those in a read-only archive for up to 7 years), re-checking daily.
 */
export async function requestTeardownAfterPurge(deps: MachineDeps, licenseeId: string, by: string): Promise<RunRow | null> {
  if (!teardownEnabled(deps.env)) return null;
  try {
    return (await startRun(deps, licenseeId, "teardown", "purge", { by })).run;
  } catch (err) {
    console.error("[provisioning] could not start a teardown", licenseeId, errText(err));
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Advancing

async function failRun(deps: MachineDeps, run: RunRow, step: string, error: string): Promise<void> {
  const now = deps.now();
  await deps.store.updateStep(run.id, step, { status: "failed", last_error: error, finished_at: now });
  await deps.store.updateRun(run.id, { status: "failed", last_error: `${step}: ${error}`, next_attempt_at: null });
  await deps.store.log(run.id, step, "error", error);
  await notifyFailure(deps, { ...run, status: "failed", last_error: `${step}: ${error}` });
}

export async function notifyFailure(deps: MachineDeps, run: RunRow): Promise<void> {
  if (run.failure_notified_at || run.dry_run) return;
  const l = await getLicensee(deps.db, run.licensee_id);
  const name = l ? `${l.company_name} (${l.company_code})` : run.licensee_id;
  const page = callbackBaseUrl(deps.env) ? `${callbackBaseUrl(deps.env)}/ops/provisioning` : "/ops/provisioning";
  await sendQuietly(
    deps.mailer,
    {
      to: [salesEmail(deps.env)],
      subject: `Keystone ${run.kind === "teardown" ? "teardown" : "setup"} needs attention: ${name}`,
      ...bodies([
        `The automatic ${run.kind === "teardown" ? "teardown" : "setup"} of ${name} stopped.`,
        `Error: ${run.last_error ?? "unknown"}`,
        `Open ${page} to see the log, then press "Retry step" or "Mark done manually".`,
      ]),
    },
    "provisioning failure notice",
  );
  await deps.store.updateRun(run.id, { failure_notified_at: deps.now() });
}

async function waitForSetup(deps: MachineDeps, run: RunRow, missing: SetupItem[], recheckMs: number): Promise<void> {
  const first = run.status !== "waiting_for_setup";
  await deps.store.updateRun(run.id, { status: "waiting_for_setup", setup_missing: missing, next_attempt_at: later(deps.now(), recheckMs) });
  if (first) await deps.store.log(run.id, null, "warn", `waiting for manual setup: ${missing.map((m) => m.key).join(", ")}`);
  if (!run.setup_notified_at && !run.dry_run) {
    const l = await getLicensee(deps.db, run.licensee_id);
    await sendQuietly(
      deps.mailer,
      {
        to: [salesEmail(deps.env)],
        subject: `Keystone automatic setup is waiting for configuration${l ? `: ${l.company_name}` : ""}`,
        ...bodies([
          `${l ? `${l.company_name} (${l.company_code})` : "A licensee"} is ready to be set up, but automatic setup is not configured yet. Nothing has been created.`,
          "Still needed:\n" + missing.map((m, i) => `${i + 1}. ${m.label}`).join("\n"),
          "See KS-Ops docs/AUTO_PROVISIONING.md. The setup starts by itself once these are in place (or press Retry on /ops/provisioning). Until then you can still run scripts/provision-licensee.sh by hand.",
        ]),
      },
      "provisioning setup notice",
    );
    await deps.store.updateRun(run.id, { setup_notified_at: deps.now() });
  }
}

async function dispatchWorkflowSteps(deps: MachineDeps, run: RunRow, steps: StepRow[], l: LicenseeRow): Promise<void> {
  const todo = steps.filter((s) => !isFinished(s) && stepDef(run.kind, s.step)?.where === "workflow").map((s) => s.step);
  const now = deps.now();
  const token = newSecret(32);
  await deps.store.updateRun(run.id, {
    status: "running",
    setup_missing: [],
    workflow_dispatched_at: now,
    workflow_steps: todo,
    callback_token_hash: sha256Hex(token),
    callback_expires_at: later(now, CALLBACK_TOKEN_TTL_MS),
    next_attempt_at: later(now, 5 * 60_000),
    last_error: null,
  });
  const first = todo[0];
  await deps.store.updateStep(run.id, first, { status: "running", started_at: now, attempts: (steps.find((s) => s.step === first)?.attempts ?? 0) + 1, last_error: null });
  try {
    await deps.dispatch(WORKFLOW_FILES[run.kind], {
      run_id: run.id,
      code: l.company_code,
      steps: todo.join(","),
      ks_ops_url: callbackBaseUrl(deps.env),
      callback_token: token,
      dry_run: run.dry_run ? "true" : "false",
    });
    await deps.store.log(run.id, first, "info", `started the ${WORKFLOW_FILES[run.kind]} workflow for: ${todo.join(", ")}`);
  } catch (err) {
    await deps.store.updateRun(run.id, { workflow_dispatched_at: null, workflow_steps: [], callback_token_hash: null });
    await failRun(deps, run, first, `could not start the GitHub workflow: ${errText(err)}`);
  }
}

/**
 * Moves one run on as far as it can go now. Safe to call at any time and from several places: the run is locked while
 * one caller works on it, and anyone else returns straight away.
 */
export async function advanceRun(deps: MachineDeps, runId: string, opts: { locked?: boolean } = {}): Promise<RunRow | null> {
  if (!opts.locked) {
    if (!(await deps.store.tryLock(runId, deps.now()))) return deps.store.getRun(runId);
    try {
      return await advanceLocked(deps, runId);
    } finally {
      await deps.store.release(runId);
    }
  }
  return advanceLocked(deps, runId);
}

async function advanceLocked(deps: MachineDeps, runId: string): Promise<RunRow | null> {
  let run = await deps.store.getRun(runId);
  if (!run || run.status === "done" || run.status === "cancelled" || run.status === "failed") return run;
  const executors = deps.executors ?? SERVICE_EXECUTORS;

  for (let pass = 0; pass < MAX_STEPS_PER_PASS; pass++) {
    run = (await deps.store.getRun(runId))!;
    if (run.status === "failed" || run.status === "done" || run.status === "cancelled") return run;
    const l = await getLicensee(deps.db, run.licensee_id);
    if (!l) {
      await deps.store.updateRun(run.id, { status: "cancelled", last_error: "licensee deleted", finished_at: deps.now() });
      return deps.store.getRun(runId);
    }
    const steps = await deps.store.steps(run.id);
    const step = steps.find((s) => !isFinished(s));
    if (!step) {
      await deps.store.updateRun(run.id, { status: "done", finished_at: deps.now(), next_attempt_at: null, callback_token_hash: null, last_error: null });
      await deps.store.log(run.id, null, "info", run.dry_run ? "dry run finished: nothing was changed" : `${run.kind} finished`);
      if (!run.dry_run) await audit(deps.db, "ks-ops provisioning", `licensee.${run.kind}_done`, run.licensee_id, { run_id: run.id });
      return deps.store.getRun(runId);
    }
    if (step.status === "failed") {
      await deps.store.updateRun(run.id, { status: "failed", next_attempt_at: null });
      return deps.store.getRun(runId);
    }
    const def = stepDef(run.kind, step.step);
    if (!def) {
      await failRun(deps, run, step.step, "unknown step");
      return deps.store.getRun(runId);
    }

    // Credentials first: nothing is changed until they are there. (A dry run only needs them for the workflow part.)
    const missing = run.dry_run ? [] : serviceSetupMissing(run.kind, deps.env);
    if (missing.length) {
      await waitForSetup(deps, run, missing, SETUP_RECHECK_MS);
      return deps.store.getRun(runId);
    }
    if (run.status === "waiting_for_setup" || run.status === "blocked") {
      await deps.store.updateRun(run.id, { status: "running", setup_missing: [] });
      run = (await deps.store.getRun(runId))!;
    }

    if (run.dry_run && (def.where === "service" || !githubTokenConfigured(deps.env) || !callbackBaseUrl(deps.env))) {
      const plan = describePlan(run.kind, l.company_code, run.region).filter((line) => line.startsWith(`${step.step}:`));
      for (const line of plan) await deps.store.log(run.id, step.step, "info", `would: ${line}`);
      await deps.store.updateStep(run.id, step.step, { status: "done", finished_at: deps.now(), output: { dry_run: true } });
      continue;
    }

    if (def.where === "workflow") {
      const dispatchedAt = run.workflow_dispatched_at ? new Date(run.workflow_dispatched_at).getTime() : 0;
      const inFlight = dispatchedAt && run.workflow_steps.includes(step.step);
      if (inFlight && deps.now().getTime() - dispatchedAt < WORKFLOW_TIMEOUT_MS) {
        await deps.store.updateRun(run.id, { next_attempt_at: later(deps.now(), 5 * 60_000) });
        return deps.store.getRun(runId);
      }
      if (inFlight) {
        await failRun(deps, run, step.step, `no report from the GitHub workflow within ${WORKFLOW_TIMEOUT_MS / 3_600_000} hours (check the Actions tab of KS-Ops)`);
        return deps.store.getRun(runId);
      }
      await dispatchWorkflowSteps(deps, run, steps, l);
      return deps.store.getRun(runId);
    }

    // A service step.
    const exec = executors[step.step];
    if (!exec) {
      await failRun(deps, run, step.step, "no executor for this step");
      return deps.store.getRun(runId);
    }
    const now = deps.now();
    if (step.status !== "running") {
      await deps.store.updateStep(run.id, step.step, { status: "running", started_at: now, attempts: step.attempts + 1, last_error: null });
      await deps.store.log(run.id, step.step, "info", `started: ${def.label}`);
    }
    const current = (await deps.store.steps(run.id)).find((s) => s.step === step.step)!;
    const outputs = Object.fromEntries(steps.map((s) => [s.step, s.output ?? {}]));
    let outcome: StepOutcome;
    try {
      outcome = await exec({
        deps,
        run,
        step: current,
        licensee: l,
        outputs,
        log: (message, level = "info") => deps.store.log(run!.id, step.step, level, message),
      });
    } catch (err) {
      outcome = { kind: "failed", error: errText(err) };
    }
    if (outcome.kind === "done") {
      await deps.store.updateStep(run.id, step.step, { status: "done", finished_at: deps.now(), output: outcome.output ?? {}, last_error: null });
      await deps.store.log(run.id, step.step, "info", `done${outcome.message ? `: ${outcome.message}` : ""}`);
      continue;
    }
    if (outcome.kind === "failed") {
      await failRun(deps, run, step.step, outcome.error);
      return deps.store.getRun(runId);
    }
    const blocked = outcome.kind === "blocked";
    if (current.last_error !== outcome.message) await deps.store.log(run.id, step.step, blocked ? "warn" : "info", outcome.message);
    await deps.store.updateStep(run.id, step.step, { status: blocked ? "blocked" : "running", last_error: outcome.message });
    await deps.store.updateRun(run.id, { status: blocked ? "blocked" : "running", next_attempt_at: later(deps.now(), outcome.retryMs), last_error: blocked ? outcome.message : null });
    return deps.store.getRun(runId);
  }
  await deps.store.updateRun(runId, { next_attempt_at: deps.now() });
  return deps.store.getRun(runId);
}

/** The worker: every run that is due. */
export async function advanceDueRuns(deps: MachineDeps, limit = 20): Promise<{ tried: number }> {
  const ids = await deps.store.claimDue(deps.now(), limit);
  for (const id of ids) {
    try {
      await advanceRun(deps, id, { locked: true });
    } catch (err) {
      console.error("[provisioning] run failed to advance", id, errText(err));
    } finally {
      await deps.store.release(id);
    }
  }
  return { tried: ids.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Staff actions

export type ActionResult = { ok: true; run: RunRow } | { ok: false; status: number; error: string; message: string };

const notFound: ActionResult = { ok: false, status: 404, error: "not_found", message: "That run does not exist." };

/** Retry step: the step, and every step after it that failed or is blocked, go back to pending; the run continues. */
export async function retryStep(deps: MachineDeps, runId: string, stepKey: string | null, actor: string): Promise<ActionResult> {
  const run = await deps.store.getRun(runId);
  if (!run) return notFound;
  if (run.status === "done" || run.status === "cancelled") return { ok: false, status: 409, error: "run_finished", message: "This run is finished; start a new one instead." };
  const steps = await deps.store.steps(run.id);
  const from = stepKey ? steps.find((s) => s.step === stepKey) : steps.find((s) => !isFinished(s));
  if (stepKey && !from) return { ok: false, status: 404, error: "unknown_step", message: "That step is not part of this run." };
  for (const s of steps) {
    const reset = from && (s.step === from.step || (s.position > from.position && (s.status === "failed" || s.status === "blocked" || s.status === "running")));
    if (reset) await deps.store.updateStep(run.id, s.step, { status: "pending", last_error: null, started_at: null, finished_at: null });
  }
  await deps.store.updateRun(run.id, {
    status: "running", last_error: null, next_attempt_at: deps.now(), failure_notified_at: null, setup_notified_at: null,
    workflow_dispatched_at: null, workflow_steps: [], callback_token_hash: null,
  });
  await deps.store.log(run.id, from?.step ?? null, "info", `retry${from ? ` from ${from.step}` : ""} by ${actor}`);
  await audit(deps.db, actor, "licensee.provisioning_retry", run.licensee_id, { run_id: run.id, step: from?.step ?? null });
  return { ok: true, run: (await deps.store.getRun(run.id))! };
}

/** Mark done manually: staff did this step by hand. The run carries on with the next step. */
export async function markStepDone(deps: MachineDeps, runId: string, stepKey: string, actor: string, note: string): Promise<ActionResult> {
  const run = await deps.store.getRun(runId);
  if (!run) return notFound;
  if (run.status === "done" || run.status === "cancelled") return { ok: false, status: 409, error: "run_finished", message: "This run is finished." };
  const step = (await deps.store.steps(run.id)).find((s) => s.step === stepKey);
  if (!step) return { ok: false, status: 404, error: "unknown_step", message: "That step is not part of this run." };
  await deps.store.updateStep(run.id, stepKey, { status: "manual", done_by: actor, finished_at: deps.now(), last_error: null });
  await deps.store.updateRun(run.id, {
    status: "running", next_attempt_at: deps.now(), last_error: null, failure_notified_at: null,
    ...(run.workflow_steps.includes(stepKey) ? { workflow_dispatched_at: null, workflow_steps: [], callback_token_hash: null } : {}),
  });
  await deps.store.log(run.id, stepKey, "warn", `marked done manually by ${actor}${note ? `: ${note}` : ""}`);
  await audit(deps.db, actor, "licensee.provisioning_step_manual", run.licensee_id, { run_id: run.id, step: stepKey, note });
  return { ok: true, run: (await deps.store.getRun(run.id))! };
}

export async function cancelRun(deps: MachineDeps, runId: string, actor: string): Promise<ActionResult> {
  const run = await deps.store.getRun(runId);
  if (!run) return notFound;
  if (run.status === "done" || run.status === "cancelled") return { ok: false, status: 409, error: "run_finished", message: "This run is already finished." };
  await deps.store.updateRun(run.id, { status: "cancelled", finished_at: deps.now(), next_attempt_at: null, callback_token_hash: null });
  await deps.store.log(run.id, null, "warn", `cancelled by ${actor}`);
  await audit(deps.db, actor, "licensee.provisioning_cancelled", run.licensee_id, { run_id: run.id });
  return { ok: true, run: (await deps.store.getRun(run.id))! };
}

// ---------------------------------------------------------------------------------------------------------------------
// The workflow's reports

export type CallbackBody = {
  step?: unknown;
  status?: unknown;
  message?: unknown;
  output?: unknown;
  missing?: unknown;
};

export type CallbackResult = { ok: true } | { ok: false; status: number; error: string };

/** The run, when the bearer token is this run's current, unexpired callback token. */
export async function runForCallback(deps: MachineDeps, runId: string, token: unknown): Promise<RunRow | null> {
  const run = await deps.store.getRun(runId);
  if (!run || !run.callback_token_hash) return null;
  if (!run.callback_expires_at || new Date(run.callback_expires_at).getTime() < deps.now().getTime()) return null;
  if (run.status === "done" || run.status === "cancelled") return null;
  return matchesHash(token, run.callback_token_hash) ? run : null;
}

const OUTPUT_KEYS = ["server_url", "agent_url", "portal_url", "client_url", "resource_group", "deploy_client_id", "pull_requests", "deploys", "dry_run", "written", "not_set_up"];

function cleanOutput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const k of OUTPUT_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v === "string") out[k] = v.slice(0, 500);
    else if ((JSON.stringify(v) ?? "").length <= 4000) out[k] = v;
  }
  return out;
}

/** An address the workflow reported, accepted only on https and an allowed host (OPS_ALLOWED_SERVER_HOST_SUFFIXES). */
export function acceptableUrl(raw: unknown, e: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const suffixes = allowedServerHostSuffixes(e);
  const host = u.hostname.toLowerCase();
  if (!suffixes.includes("*") && !suffixes.some((s) => host.endsWith(s.startsWith(".") ? s : `.${s}`))) return null;
  return `https://${host}`;
}

export async function handleCallback(deps: MachineDeps, run: RunRow, body: CallbackBody): Promise<CallbackResult> {
  const status = String(body.status ?? "");
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "";
  if (status === "setup_missing") {
    const items = workflowSetupItems(body.missing);
    await deps.store.updateRun(run.id, { workflow_dispatched_at: null, workflow_steps: [], callback_token_hash: null });
    const steps = await deps.store.steps(run.id);
    const current = steps.find((s) => s.status === "running");
    if (current) await deps.store.updateStep(run.id, current.step, { status: "pending", attempts: Math.max(0, current.attempts - 1) });
    await waitForSetup(deps, run, items.length ? items : [{ key: "WORKFLOW", label: message || "The provisioning workflow is missing settings." }], WORKFLOW_SETUP_RECHECK_MS);
    return { ok: true };
  }
  const stepKey = String(body.step ?? "");
  if (!run.workflow_steps.includes(stepKey) || stepDef(run.kind, stepKey)?.where !== "workflow") {
    return { ok: false, status: 400, error: "unknown_step" };
  }
  const now = deps.now();
  if (status === "log") {
    if (message) await deps.store.log(run.id, stepKey, "info", message);
    return { ok: true };
  }
  if (status === "running") {
    const s = (await deps.store.steps(run.id)).find((x) => x.step === stepKey);
    if (s && s.status !== "running") await deps.store.updateStep(run.id, stepKey, { status: "running", started_at: now, attempts: s.attempts + 1, last_error: null });
    if (message) await deps.store.log(run.id, stepKey, "info", message);
    return { ok: true };
  }
  if (status === "done") {
    const output = cleanOutput(body.output);
    await deps.store.updateStep(run.id, stepKey, { status: "done", finished_at: now, output, last_error: null });
    await deps.store.log(run.id, stepKey, "info", `done${message ? `: ${message}` : ""}`);
    if (stepKey === "azure_resources" && !run.dry_run) await saveAddresses(deps, run, output);
    // Was this the last step the workflow was given? Then hand back to the worker straight away.
    await deps.store.updateRun(run.id, { next_attempt_at: now });
    return { ok: true };
  }
  if (status === "failed") {
    await failRun(deps, run, stepKey, message || "the workflow reported a failure");
    await deps.store.updateRun(run.id, { callback_token_hash: null });
    return { ok: true };
  }
  return { ok: false, status: 400, error: "unknown_status" };
}

async function saveAddresses(deps: MachineDeps, run: RunRow, output: Record<string, unknown>): Promise<void> {
  const server = acceptableUrl(output.server_url, deps.env);
  const portal = acceptableUrl(output.portal_url, deps.env);
  const client = acceptableUrl(output.client_url, deps.env);
  if (!server || !portal || !client) {
    await deps.store.log(run.id, "azure_resources", "warn", "the reported addresses were not accepted (https on an allowed host); set them on the licensee by hand");
    return;
  }
  await deps.db.query(
    `UPDATE licensees SET server_url = $2, portal_url = $3, client_url = $4,
            plan_sync_status = 'pending_sync', plan_sync_next_at = NULL, updated_at = now()
      WHERE id = $1`,
    [run.licensee_id, server, portal, client],
  );
  await audit(deps.db, "ks-ops provisioning", "licensee.addresses_set", run.licensee_id, { server_url: server, portal_url: portal, client_url: client, run_id: run.id });
}

/** The workflow's request for the licensee's ops key: a new key, made only while azure_resources is running. */
export async function opsKeyForWorkflow(deps: MachineDeps, run: RunRow): Promise<{ ok: true; ops_key: string } | { ok: false; status: number; error: string }> {
  if (run.dry_run) return { ok: false, status: 409, error: "dry_run" };
  const step = (await deps.store.steps(run.id)).find((s) => s.step === "azure_resources");
  if (!step || step.status !== "running") return { ok: false, status: 409, error: "not_now" };
  const key = await rotateOpsKey(deps.db, run.licensee_id);
  await audit(deps.db, "ks-ops provisioning", "licensee.ops_key_rotated", run.licensee_id, { run_id: run.id });
  await deps.store.log(run.id, "azure_resources", "info", "new ops key handed to the workflow");
  return { ok: true, ops_key: key };
}

/** KS_OPS_TWILIO_AUTO_v1 - the licensee's Twilio settings for its KS-server, handed only to the workflow while its
 *  twilio_settings step runs (like the ops key). The workflow writes them to the App Service and masks them. */
export async function twilioSettingsForWorkflow(deps: MachineDeps, run: RunRow): Promise<{ ok: true; settings: Record<string, string> } | { ok: false; status: number; error: string }> {
  if (run.dry_run) return { ok: false, status: 409, error: "dry_run" };
  const step = (await deps.store.steps(run.id)).find((s) => s.step === "twilio_settings");
  if (!step || step.status !== "running") return { ok: false, status: 409, error: "not_now" };
  const l = await getLicensee(deps.db, run.licensee_id);
  if (!l) return { ok: false, status: 404, error: "not_found" };
  const r = await serverSettings(deps, l);
  if (!r.ok) return { ok: false, status: 409, error: r.error };
  await audit(deps.db, "ks-ops provisioning", "licensee.twilio_settings_handed_over", run.licensee_id, { run_id: run.id, names: Object.keys(r.settings) });
  await deps.store.log(run.id, "twilio_settings", "info", `Twilio settings handed to the workflow: ${Object.keys(r.settings).join(", ")}`);
  return r;
}

/** KS_OPS_WORKSPACE_APPS - Keystone's Microsoft 365 / Google app keys for the licensee's KS-server, handed only to the
 *  workflow while its workspace_apps step runs. What KS-Ops does not have yet is logged, not a failure: the copy works
 *  without them and the step can be retried once they are set. */
export async function workspaceSettingsForWorkflow(deps: MachineDeps, run: RunRow): Promise<{ ok: true; settings: Record<string, string>; missing: string[] } | { ok: false; status: number; error: string }> {
  if (run.dry_run) return { ok: false, status: 409, error: "dry_run" };
  const step = (await deps.store.steps(run.id)).find((s) => s.step === "workspace_apps");
  if (!step || step.status !== "running") return { ok: false, status: 409, error: "not_now" };
  const r = workspaceAppSettings(deps.env);
  const names = Object.keys(r.settings);
  if (names.length) {
    await audit(deps.db, "ks-ops provisioning", "licensee.workspace_settings_handed_over", run.licensee_id, { run_id: run.id, names });
    await deps.store.log(run.id, "workspace_apps", "info", `Microsoft 365 / Google app settings handed to the workflow: ${names.join(", ")}`);
  }
  if (r.missing.length) await deps.store.log(run.id, "workspace_apps", "warn", `not set up on KS-Ops yet, so not written: ${r.missing.join("; ")}. Set them on KS-Ops, then Retry this step.`);
  return { ok: true, ...r };
}

/** What the workflow needs to know about the licensee (nothing secret). */
export async function workflowContext(deps: MachineDeps, run: RunRow) {
  const l = await getLicensee(deps.db, run.licensee_id);
  if (!l) return null;
  return {
    run_id: run.id,
    kind: run.kind,
    dry_run: run.dry_run,
    steps: run.workflow_steps,
    region: run.region,
    licensee_id: l.id,
    code: l.company_code,
    company_name: l.company_name,
    assistant_name: l.assistant_name ?? "",
    website: l.website ?? "",
    plan: l.plan,
    contact_email: l.contact_email,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Views

export type PublicState = "waiting_payment" | "setting_up" | "ready" | "needs_attention" | "not_found";

/** What the website's thank-you page shows. No errors, ids or secrets. */
export async function publicStatus(deps: Pick<MachineDeps, "db" | "store">, licenseeId: string) {
  const l = await getLicensee(deps.db, licenseeId);
  if (!l) return { state: "not_found" as PublicState };
  const run = await deps.store.latestRun(l.id, "provision");
  const base = { company_name: l.company_name, company_code: l.company_code };
  if (l.status === "pending_payment") return { ...base, state: "waiting_payment" as PublicState, steps: [] };
  // KS_OPS_PHONE_PROVISIONING - the copy is ready to use once the sign-in email went out; the phone lines step after it
  // (often waiting for Twilio to be connected) does not keep the licensee on the "setting up" page.
  const signInSent = run && run.status !== "done"
    ? (await deps.store.steps(run.id)).some((s) => s.step === "welcome_email" && isFinished(s))
    : false;
  const ready = Boolean(l.portal_url) && (!run || run.status === "done" || signInSent) && l.status !== "provisioning";
  if (ready) {
    return { ...base, state: "ready" as PublicState, portal_url: l.portal_url, email_sent: run ? true : null, steps: [] };
  }
  const labels: Array<{ label: string; status: "done" | "in_progress" | "pending" }> = [];
  if (run) {
    const steps = await deps.store.steps(run.id);
    const seen = new Map<string, "done" | "in_progress" | "pending">();
    for (const s of steps) {
      const label = stepDef(run.kind, s.step)?.publicLabel || s.step;
      const st = isFinished(s) ? "done" : s.status === "pending" ? "pending" : "in_progress";
      const prev = seen.get(label);
      seen.set(label, !prev ? st : prev === "done" && st === "done" ? "done" : prev === "pending" && st === "pending" ? "pending" : "in_progress");
    }
    for (const [label, status] of seen) labels.push({ label, status });
  }
  const attention = run && (run.status === "failed" || run.status === "waiting_for_setup");
  return { ...base, state: (attention ? "needs_attention" : "setting_up") as PublicState, steps: labels };
}

export async function runView(deps: Pick<MachineDeps, "db" | "store" | "fetch" | "env" | "twilioStore" | "twilioHttp">, run: RunRow, logLimit = 200) {
  const [steps, logs, l] = await Promise.all([deps.store.steps(run.id), deps.store.logs(run.id, logLimit), getLicensee(deps.db, run.licensee_id)]);
  const { callback_token_hash, ...rest } = run;
  return {
    ...rest,
    workflow_in_flight: Boolean(callback_token_hash),
    licensee: l ? { id: l.id, company_name: l.company_name, company_code: l.company_code, status: l.status, server_url: l.server_url, portal_url: l.portal_url, client_url: l.client_url } : null,
    steps: steps.map((s) => ({ ...s, label: stepDef(run.kind, s.step)?.label ?? s.step, where: stepDef(run.kind, s.step)?.where ?? "service" })),
    logs,
    // KS_OPS_TWILIO_AUTO_v1 - the sub-account and texting registration, in plain words.
    twilio: run.kind === "provision" && !run.dry_run ? await twilioSummary(deps as MachineDeps, run.licensee_id) : null,
    // KS_OPS_WORKSPACE_APPS - whether the brokerage has connected Microsoft 365 / Google (asked of its KS-server).
    // Asked only for the opened run (logLimit > 0), never for every row of the list.
    workspace: run.kind === "provision" && !run.dry_run && l && logLimit > 0 ? await workspaceSummary(deps as MachineDeps, l) : null,
  };
}

export { stepsFor };
