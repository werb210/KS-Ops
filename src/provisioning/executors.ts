// KS_OPS_AUTO_PROVISION_v1 - the steps KS-Ops runs itself (the Azure and GitHub steps run in the workflow). Each one
// is safe to run again: it checks before it changes, and the licensee's server ignores a repeat.
import type { Deps } from "../deps.js";
import { salesEmail } from "../config.js";
import { bodies } from "../lib/email.js";
import { audit, getLicensee, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";
import { pushPlan, queueStatusPush } from "../sync/planPush.js";
import { crmLicenseeStatus } from "../crm/triggers.js";
import type { RunRow, StepRow } from "./store.js";
import { ensureAddress, ensureBundle, ensureSubaccount, pointVoiceApp, twilioOf, type TwilioOutcome } from "../twilio/account.js"; // KS_OPS_TWILIO_AUTO_v1
import { linesFrom, plainStatus, submitTexting, pushTexting } from "../twilio/texting.js";
import type { TwilioStore } from "../twilio/store.js";
import type { TwilioHttp } from "../twilio/http.js";

export type StepOutcome =
  | { kind: "done"; output?: Record<string, unknown>; message?: string }
  | { kind: "wait"; retryMs: number; message: string }
  | { kind: "blocked"; retryMs: number; message: string }
  | { kind: "failed"; error: string };

export type ExecDeps = Pick<Deps, "db" | "fetch" | "mailer" | "now"> & { env?: NodeJS.ProcessEnv; twilioStore?: TwilioStore; twilioHttp?: TwilioHttp };
export type ExecCtx = {
  deps: ExecDeps;
  run: RunRow;
  step: StepRow;
  licensee: LicenseeRow;
  /** Every step's output so far (e.g. azure_resources reports agent_url). */
  outputs: Record<string, Record<string, unknown>>;
  log: (message: string, level?: "info" | "warn" | "error") => Promise<void>;
};
export type Executor = (ctx: ExecCtx) => Promise<StepOutcome>;

const MIN = 60_000;
export const HEALTH_TIMEOUT_MS = 60 * MIN;
export const SERVER_CALL_TIMEOUT_MS = 30 * MIN;
const DAY = 24 * 60 * MIN;

const trim = (u: string | null | undefined) => String(u ?? "").replace(/\/+$/, "");

/** Fails the step once it has been retrying for longer than `limitMs`, otherwise waits `retryMs`. */
function waitOrFail(ctx: ExecCtx, limitMs: number, retryMs: number, message: string): StepOutcome {
  const started = ctx.step.started_at ? new Date(ctx.step.started_at).getTime() : ctx.deps.now().getTime();
  if (ctx.deps.now().getTime() - started > limitMs) return { kind: "failed", error: `${message} (gave up after ${Math.round(limitMs / MIN)} minutes)` };
  return { kind: "wait", retryMs, message };
}

async function probe(fetchImpl: typeof fetch, url: string, check: (status: number, body: string) => boolean): Promise<string | null> {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { "Cache-Control": "no-cache" } });
    const body = await r.text().catch(() => "");
    return check(r.status, body) ? null : `${url} answered ${r.status}`;
  } catch (err) {
    return `${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const jsonOk = (status: number, body: string) => {
  if (status !== 200) return false;
  try {
    const j = JSON.parse(body);
    return j?.status === "ok" || j?.ok === true;
  } catch {
    return false;
  }
};
// A Static Web App answers 200 with Azure's placeholder page before the first deploy; the built apps have #root.
const appPage = (status: number, body: string) => status === 200 && /id=["']root["']/.test(body);

export const health: Executor = async (ctx) => {
  const l = ctx.licensee;
  if (!l.server_url || !l.portal_url || !l.client_url) {
    return { kind: "failed", error: "The licensee has no server, portal or client address yet (the Azure step reports them)." };
  }
  const reported = String(ctx.outputs.azure_resources?.agent_url ?? "");
  const agentUrl = /^https:\/\//.test(reported) ? trim(reported) : trim(l.server_url).replace(/-server\./, "-agent.");
  const problems = (
    await Promise.all([
      probe(ctx.deps.fetch, `${trim(l.server_url)}/health`, jsonOk),
      agentUrl !== trim(l.server_url) ? probe(ctx.deps.fetch, `${agentUrl}/health`, (s) => s === 200) : Promise.resolve(null),
      probe(ctx.deps.fetch, `${trim(l.portal_url)}/`, appPage),
      probe(ctx.deps.fetch, `${trim(l.client_url)}/`, appPage),
    ])
  ).filter((p): p is string => Boolean(p));
  if (!problems.length) return { kind: "done", message: "server, assistant, portal and client all answer" };
  return waitOrFail(ctx, HEALTH_TIMEOUT_MS, MIN, `not answering yet: ${problems.join("; ")}`);
};

/** The status a newly running copy gets: trial during a staff free trial, otherwise active. */
export function liveStatusFor(l: Pick<LicenseeRow, "admin_trial_started_at" | "admin_trial_ended_at">): "trial" | "active" {
  return l.admin_trial_started_at && !l.admin_trial_ended_at ? "trial" : "active";
}

export const configure: Executor = async (ctx) => {
  const l = ctx.licensee;
  if (l.status === "provisioning") {
    const to = liveStatusFor(l);
    const r = await ctx.deps.db.query(
      "UPDATE licensees SET status = $2, updated_at = now() WHERE id = $1 AND status = 'provisioning' RETURNING id",
      [l.id, to],
    );
    if (r.rows.length) {
      await audit(ctx.deps.db, "ks-ops provisioning", "licensee.status_changed", l.id, { from: "provisioning", to, run_id: ctx.run.id });
      await queueStatusPush(ctx.deps.db, l.id, "provisioning", to, "ks-ops provisioning");
      await crmLicenseeStatus(ctx.deps, { ...l, status: to }, "provisioning", to, ctx.deps.now(), "ks-ops provisioning");
      await ctx.log(`status provisioning -> ${to}`);
    }
  }
  // The push carries the plan, status, add-ons, beta flags and (KS-Ops v15) the sign-up branding.
  const res = await pushPlan(ctx.deps, l.id, "ks-ops provisioning");
  if (res.ok) return { kind: "done", message: "plan, branding and flags pushed" };
  return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, MIN, `plan push failed: ${res.error}`);
};

export const adminUser: Executor = async (ctx) => {
  const l = ctx.licensee;
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return { kind: "failed", error: "No server address or ops key on the licensee." };
  try {
    const r = await ctx.deps.fetch(`${trim(l.server_url)}/api/provision/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops provisioning" },
      body: JSON.stringify({ name: l.contact_name, email: l.contact_email, phone: l.contact_phone }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) {
      return {
        kind: "done",
        output: { created: body.created === true, user_id: body.user_id ?? null },
        message: body.created ? `admin ${l.contact_email} created` : `admin ${l.contact_email} already existed`,
      };
    }
    if (r.status === 404) return { kind: "failed", error: "The licensee's KS-server has no /api/provision/admin (deploy KS-server v15 or later)." };
    if (r.status === 400 || r.status === 409) return { kind: "failed", error: `KS-server refused the admin: ${String(body.error ?? r.status)} ${String(body.message ?? "")}`.trim() };
    return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, MIN, `KS-server answered ${r.status}`);
  } catch (err) {
    return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, MIN, err instanceof Error ? err.message : String(err));
  }
};

export function welcomeMail(l: LicenseeRow) {
  const first = l.contact_name.trim().split(/\s+/)[0] || l.contact_name;
  const portal = trim(l.portal_url);
  return {
    to: [l.contact_email],
    subject: `${l.company_name}: your Keystone system is ready`,
    ...bodies([
      `Hi ${first},`,
      `Your Keystone system for ${l.company_name} is set up and ready to use.`,
      [
        `Sign in to your staff portal: ${portal}`,
        `Use your email (${l.contact_email}) or your mobile number. We'll send you a one-time code; there is no password to remember.`,
        `Your company code is "${l.company_code}". Your team enters it the first time they open the Keystone apps.`,
        ...(l.client_url ? [`Your clients apply at: ${trim(l.client_url)}`] : []),
      ].join("\n"),
      "You are the admin. Once you're in, add your lenders and invite your team from Settings.",
      `If anything looks wrong, reply to this email or write to ${salesEmail()}.`,
      "The Keystone team",
    ]),
  };
}

export const welcomeEmail: Executor = async (ctx) => {
  const l = ctx.licensee;
  if (!l.portal_url) return { kind: "failed", error: "The licensee has no portal address." };
  const r = await ctx.deps.mailer(welcomeMail(l));
  if (r.ok) return { kind: "done", output: { sent_to: l.contact_email }, message: `sign-in email sent to ${l.contact_email}` };
  return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, 5 * MIN, `email not sent: ${r.error ?? "unknown error"}`);
};

/** KS_OPS_PHONE_PROVISIONING - what the licensee's server is asked for: the area code of the contact's phone (North
 *  American numbers only), the province or state, and the country. */
export function phoneRequest(l: Pick<LicenseeRow, "contact_phone" | "province_state" | "country">) {
  const digits = String(l.contact_phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const areaCode = ten.length === 10 && /^[2-9]/.test(ten) && !/^8(00|33|44|55|66|77|88)/.test(ten) ? ten.slice(0, 3) : "";
  const region = /^[A-Z]{2}$/.test(String(l.province_state ?? "").trim().toUpperCase()) ? String(l.province_state).trim().toUpperCase() : "";
  return { area_code: areaCode || undefined, region: region || undefined, country: String(l.country ?? "").toUpperCase() === "US" ? "US" : "CA" };
}

const PHONE_TWILIO_SETUP = "Connect Twilio on the licensee's KS-server first: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (a Keystone subaccount for this licensee) and KS_SERVER_URL in its App Service settings, then press Retry step. Checked again every 6 hours.";

/**
 * KS_OPS_PHONE_PROVISIONING - asks the licensee's KS-server to buy its business line (every plan) and toll-free line
 * (Growth and Pro) through its own Twilio account. The server does the Twilio calls (it owns the account whose token
 * signs the webhooks) and is safe to ask again. Twilio not connected there yet: blocked with what to do, retried every
 * 6 hours. A Twilio address / bundle requirement: failed with the explanation (emailed to sales). Other errors: retried.
 */
export const phoneNumbers: Executor = async (ctx) => {
  const l = ctx.licensee;
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return { kind: "failed", error: "No server address or ops key on the licensee." };
  // KS_OPS_TWILIO_AUTO_v1 - the address and (approved) bundle made in the licensee's sub-account go with the request;
  // KS-server keeps them for every later purchase too.
  const tw = await twilioOf(ctx.deps).store.get(l.id).catch((err) => {
    console.error("[provisioning] twilio row not read", { licensee: l.id, message: err instanceof Error ? err.message : String(err) });
    return null;
  });
  const body = {
    ...phoneRequest(l),
    ...(tw?.address_sid ? { address_sid: tw.address_sid } : {}),
    ...(tw?.bundle_sid && /approved/.test(String(tw.bundle_status)) ? { bundle_sid: tw.bundle_sid } : {}),
  };
  let r: Response;
  try {
    r = await ctx.deps.fetch(`${trim(l.server_url)}/api/provision/phone-numbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops provisioning" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[provisioning] phone numbers request failed", { licensee: l.id, message });
    return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, 5 * MIN, `phone numbers: ${message}`);
  }
  const json = (await r.json().catch(() => ({}))) as { error?: string; message?: string; results?: Array<Record<string, unknown>> };
  if (r.status === 404) return { kind: "failed", error: "The licensee's KS-server has no /api/provision/phone-numbers (deploy a newer KS-server)." };
  if (r.status === 503 && (json.error === "twilio_not_configured" || json.error === "server_url_not_set")) {
    await ctx.log(`phone numbers: ${json.message ?? json.error}`, "warn");
    return { kind: "blocked", retryMs: 6 * 60 * MIN, message: PHONE_TWILIO_SETUP };
  }
  if (!r.ok) {
    console.error("[provisioning] phone numbers refused", { licensee: l.id, status: r.status, error: json.error, message: json.message });
    return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, 5 * MIN, `phone numbers: KS-server answered ${r.status} ${json.error ?? ""}`.trim());
  }
  const results = Array.isArray(json.results) ? json.results : [];
  const lines = results.map((x) => `${String(x.kind)}: ${String(x.status)}${x.number ? ` ${String(x.number)}` : ""}${x.message ? ` - ${String(x.message)}` : ""}`);
  for (const line of lines) await ctx.log(`phone numbers: ${line}`, /failed/.test(line) ? "warn" : "info");
  const failed = results.filter((x) => x.status === "failed");
  if (!failed.length) return { kind: "done", output: { results }, message: lines.join("; ") || "nothing to buy" };
  console.error("[provisioning] phone numbers not bought", { licensee: l.id, failed });
  const regulatory = failed.find((x) => x.error === "regulatory_requirement");
  if (regulatory) return { kind: "failed", error: `Twilio needs a registered address or regulatory bundle before it sells this number: ${String(regulatory.message ?? "")}`.trim() };
  return waitOrFail(ctx, SERVER_CALL_TIMEOUT_MS, 10 * MIN, `phone numbers not bought: ${failed.map((x) => `${String(x.kind)} (${String(x.message ?? x.error ?? "unknown")})`).join("; ")}`);
};

// KS_OPS_TWILIO_AUTO_v1 - the Twilio steps. A missing Keystone-level setting blocks (checked every 6 hours) with what to
// do; Twilio's own hiccups are retried; anything that needs a person fails with a plain sentence (emailed to sales).
function fromTwilio(ctx: ExecCtx, o: TwilioOutcome, limitMs = SERVER_CALL_TIMEOUT_MS): StepOutcome {
  if (o.kind === "done") return { kind: "done", message: o.message, output: o.output };
  if (o.kind === "blocked") return { kind: "blocked", retryMs: 6 * 60 * MIN, message: o.message };
  if (o.kind === "failed") return { kind: "failed", error: o.message };
  return waitOrFail(ctx, limitMs, o.retryMs, o.message);
}
const twilioLog = (ctx: ExecCtx) => (m: string) => ctx.log(m);

export const twilioAccount: Executor = async (ctx) => fromTwilio(ctx, await ensureSubaccount(ctx.deps, ctx.licensee, twilioLog(ctx)));
export const twilioAddress: Executor = async (ctx) => fromTwilio(ctx, await ensureAddress(ctx.deps, ctx.licensee, twilioLog(ctx)));
export const twilioVoice: Executor = async (ctx) => fromTwilio(ctx, await pointVoiceApp(ctx.deps, ctx.licensee));
export const twilioBundle: Executor = async (ctx) => {
  const started = ctx.step.started_at ? new Date(ctx.step.started_at) : null;
  // The bundle waits up to 14 days for Twilio; ensureBundle decides when to give up.
  return fromTwilio(ctx, await ensureBundle(ctx.deps, ctx.licensee, started, twilioLog(ctx)), 15 * DAY);
};

/** Submits texting registration and pushes the status to the licensee's server. Done once submitted: approval by the
 *  carriers takes days and is followed by the worker, never holding the run. */
export const textingRegistration: Executor = async (ctx) => {
  const lines = linesFrom(ctx.outputs.phone_numbers?.results);
  const rows = await submitTexting(ctx.deps, ctx.licensee, lines, (m) => ctx.log(m));
  for (const r of rows) await ctx.log(`texting: ${plainStatus(r)}`, r.status === "needs_info" || r.status === "rejected" ? "warn" : "info");
  const pushed = await pushTexting(ctx.deps, ctx.licensee);
  if (!pushed.ok) await ctx.log(`texting status not pushed to the server yet (${pushed.error}); the worker tries again`, "warn");
  return { kind: "done", output: { texting: rows.map((r) => ({ kind: r.kind, status: r.status })) }, message: rows.map((r) => `${r.kind}: ${r.status}`).join("; ") };
};

/**
 * Teardown is refused unless the licensee is cancelled and its own KS-server confirms nothing must be kept:
 * GET /api/provision/teardown-check answers { deletable, reason, ... } from KS-server v14's retention data (purged,
 * no retention_archive, no open legal holds). A server that cannot be asked means no teardown. Re-checked daily.
 */
export const retentionGate: Executor = async (ctx) => {
  const l = ctx.licensee;
  if (l.status !== "cancelled") return { kind: "blocked", retryMs: DAY, message: `The licensee is ${l.status}, not cancelled.` };
  if (!l.purged_at) return { kind: "blocked", retryMs: DAY, message: "The cancellation purge has not run yet." };
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return { kind: "blocked", retryMs: DAY, message: "No server address or ops key, so the retention rules cannot be checked. Mark this step done by hand only after checking there is no data." };
  try {
    const r = await ctx.deps.fetch(`${trim(l.server_url)}/api/provision/teardown-check`, {
      headers: { "X-KS-Ops-Key": key },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) return { kind: "blocked", retryMs: DAY, message: `KS-server teardown check answered ${r.status}; teardown refused.` };
    if (body.deletable === true) return { kind: "done", output: { check: body }, message: "retention rules allow teardown" };
    return { kind: "blocked", retryMs: DAY, message: `Retention rules refuse teardown: ${String(body.reason ?? "records are still kept")}${body.kept_until ? ` (kept until ${String(body.kept_until)})` : ""}.` };
  } catch (err) {
    return { kind: "blocked", retryMs: DAY, message: `KS-server teardown check failed (${err instanceof Error ? err.message : String(err)}); teardown refused.` };
  }
};

export const finishTeardown: Executor = async (ctx) => {
  await audit(ctx.deps.db, "ks-ops provisioning", "licensee.torn_down", ctx.licensee.id, { run_id: ctx.run.id });
  await ctx.deps.db.query(
    "UPDATE licensees SET plan_sync_status = 'synced', plan_sync_next_at = NULL, updated_at = now() WHERE id = $1",
    [ctx.licensee.id],
  );
  return { kind: "done", message: "teardown recorded" };
};

export const SERVICE_EXECUTORS: Record<string, Executor> = {
  health,
  configure,
  admin_user: adminUser,
  welcome_email: welcomeEmail,
  phone_numbers: phoneNumbers, // KS_OPS_PHONE_PROVISIONING
  twilio_account: twilioAccount, // KS_OPS_TWILIO_AUTO_v1
  twilio_address: twilioAddress,
  twilio_voice: twilioVoice,
  twilio_bundle: twilioBundle,
  texting_registration: textingRegistration,
  retention_gate: retentionGate,
  finish: finishTeardown,
};

/** Re-reads the licensee (steps change it). */
export async function freshLicensee(deps: Pick<Deps, "db">, id: string): Promise<LicenseeRow | null> {
  return getLicensee(deps.db, id);
}
