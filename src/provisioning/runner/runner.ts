// KS_OPS_AUTO_PROVISION_v1 - the workflow side of automatic provisioning. Runs inside the KS-Ops GitHub Actions
// workflows (provision-licensee.yml / teardown-licensee.yml) after `azure/login` signed in with the federated
// credential. It does the Azure and GitHub steps and reports each one back to KS-Ops with the run's one-off token.
//
// Everything outside (az, gh, the GitHub REST API, KS-Ops) goes through RunnerDeps, so the unit tests replace it all.
// Every step is safe to run again. With DRY_RUN=true nothing is called but KS-Ops: each step prints what it would do.
import { APP_REPOS, describePlan, ENVIRONMENT_SETTINGS, GENERATED_AGENT_SECRETS, GENERATED_SERVER_SECRETS, registryEntry, resourceNames, type RunKind } from "../steps.js";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<ExecResult>;

export type RunnerDeps = {
  exec: Exec;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  readFile: (path: string) => Promise<string>;
  tempFile: (name: string) => string;
};

export type RunnerConfig = {
  mode: RunKind;
  opsUrl: string;
  runId: string;
  token: string;
  steps: string[];
  dryRun: boolean;
  owner: string;
  ghToken: string;
};

export type Context = {
  run_id: string;
  kind: RunKind;
  dry_run: boolean;
  steps: string[];
  region: string;
  licensee_id: string;
  code: string;
  company_name: string;
  assistant_name: string;
  website: string;
  plan: string;
  contact_email: string;
};

const GH = "https://api.github.com";
const MIN = 60_000;
export const CHECKS_TIMEOUT_MS = 60 * MIN;
export const DEPLOY_TIMEOUT_MS = 75 * MIN;
const POLL_MS = 20_000;

export class StepError extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// Config and KS-Ops calls

export function readConfig(env: Record<string, string | undefined>): RunnerConfig {
  const get = (k: string) => String(env[k] ?? "").trim();
  const opsUrl = get("KS_OPS_URL").replace(/\/+$/, "");
  if (!/^https:\/\//.test(opsUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(opsUrl)) throw new Error("KS_OPS_URL must be https");
  if (!/^[0-9a-f-]{36}$/i.test(get("RUN_ID"))) throw new Error("RUN_ID must be the KS-Ops run id");
  if (!get("CALLBACK_TOKEN")) throw new Error("CALLBACK_TOKEN is missing");
  return {
    mode: get("MODE") === "teardown" ? "teardown" : "provision",
    opsUrl,
    runId: get("RUN_ID"),
    token: get("CALLBACK_TOKEN"),
    steps: get("STEPS").split(",").map((s) => s.trim()).filter(Boolean),
    dryRun: get("DRY_RUN") === "true",
    owner: get("GH_OWNER") || "werb210",
    ghToken: get("GH_TOKEN"),
  };
}

/** What the workflow environment still lacks (keys from config.ts WORKFLOW_SETUP_LABELS). */
export function preflightMissing(cfg: RunnerConfig, env: Record<string, string | undefined>): string[] {
  const has = (k: string) => Boolean(String(env[k] ?? "").trim());
  const missing: string[] = [];
  for (const k of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) if (!has(k)) missing.push(k);
  if (!cfg.ghToken) missing.push("GITHUB_APP");
  if (cfg.mode === "provision" && !has("OPENAI_API_KEY")) missing.push("OPENAI_API_KEY");
  if (!missing.length && String(env.AZURE_LOGIN_OUTCOME ?? "success") !== "success") missing.push("AZURE_LOGIN");
  return missing;
}

async function ops(deps: RunnerDeps, cfg: RunnerConfig, method: string, path: string, body?: unknown): Promise<any> {
  const r = await deps.fetch(`${cfg.opsUrl}/api/provisioning/callback/${cfg.runId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`KS-Ops answered ${r.status} for ${path || "report"}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export async function report(deps: RunnerDeps, cfg: RunnerConfig, body: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await ops(deps, cfg, "POST", "", body);
      return;
    } catch (err) {
      deps.log(`report to KS-Ops failed (try ${i + 1}): ${err instanceof Error ? err.message : String(err)}`);
      if (i < 2) await deps.sleep(5_000);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Hides a secret in the Actions log from here on. */
export function mask(deps: RunnerDeps, secret: string): void {
  if (secret) deps.log(`::add-mask::${secret}`);
}

async function run(deps: RunnerDeps, cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<string> {
  const r = await deps.exec(cmd, args, opts);
  if (r.code !== 0) throw new StepError(`${cmd} ${args.slice(0, 4).join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`);
  return r.stdout.trim();
}

const az = (deps: RunnerDeps, args: string[]) => run(deps, "az", [...args, "--only-show-errors"]);

async function gh(deps: RunnerDeps, cfg: RunnerConfig, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await deps.fetch(`${GH}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${cfg.ghToken}`,
      "User-Agent": "ks-ops-provisioning",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text().catch(() => "");
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
}

function ghOk(res: { status: number; json: any }, what: string): any {
  if (res.status >= 200 && res.status < 300) return res.json;
  throw new StepError(`GitHub ${what}: ${res.status} ${String(res.json?.message ?? "").slice(0, 200)}`);
}

/** The licensee's resource addresses and deploy identity, read from Azure (so any step can run on its own). */
export async function readResources(deps: RunnerDeps, code: string) {
  const n = resourceNames(code);
  const host = async (args: string[]) => `https://${await az(deps, args)}`;
  const [server, agent, portal, client, account, identity] = await Promise.all([
    host(["webapp", "show", "-g", n.resourceGroup, "-n", n.serverApp, "--query", "defaultHostName", "-o", "tsv"]),
    host(["webapp", "show", "-g", n.resourceGroup, "-n", n.agentApp, "--query", "defaultHostName", "-o", "tsv"]),
    host(["staticwebapp", "show", "-g", n.resourceGroup, "-n", n.portalSwa, "--query", "defaultHostname", "-o", "tsv"]),
    host(["staticwebapp", "show", "-g", n.resourceGroup, "-n", n.clientSwa, "--query", "defaultHostname", "-o", "tsv"]),
    az(deps, ["account", "show", "--query", "{t:tenantId,s:id}", "-o", "json"]),
    az(deps, ["identity", "show", "-g", n.resourceGroup, "-n", n.deployIdentity, "--query", "clientId", "-o", "tsv"]),
  ]);
  const acc = JSON.parse(account) as { t: string; s: string };
  return { server_url: server, agent_url: agent, portal_url: portal, client_url: client, tenant_id: acc.t, subscription_id: acc.s, deploy_client_id: identity };
}

// ---------------------------------------------------------------------------------------------------------------------
// Provision steps

export async function azureResources(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const key = await ops(deps, cfg, "POST", "/ops-key");
  const opsKey = String(key.ops_key ?? "");
  if (!opsKey) throw new StepError("KS-Ops did not hand over an ops key");
  mask(deps, opsKey);
  const out = deps.tempFile("provision-output.json");
  await run(deps, "bash", ["scripts/provision-licensee.sh", ctx.code, ctx.region], {
    env: {
      KS_OPS_URL: cfg.opsUrl,
      KS_LICENSEE_ID: ctx.licensee_id,
      KS_OPS_KEY: opsKey,
      KS_PLAN: ctx.plan,
      OPENAI_API_KEY: String(deps.env.OPENAI_API_KEY ?? ""),
      DEPLOY_IDENTITY: "1",
      DEPLOY_IDENTITY_REPOS: APP_REPOS.filter((r) => r.app === "server" || r.app === "agent").map((r) => `${cfg.owner}/${r.repo}`).join(","),
      OUTPUT_JSON: out,
      KS_NONINTERACTIVE: "1",
    },
  });
  const parsed = JSON.parse(await deps.readFile(out)) as Record<string, string>;
  const output: Record<string, unknown> = {};
  for (const k of ["server_url", "agent_url", "portal_url", "client_url", "resource_group", "deploy_client_id"]) if (parsed[k]) output[k] = parsed[k];
  if (!output.server_url || !output.portal_url || !output.client_url) throw new StepError("provision-licensee.sh did not report the addresses");
  return output;
}

/** KS_OPS_TWILIO_AUTO_v1 - writes the licensee's Twilio settings (from KS-Ops, masked here) to its KS-server app. */
export async function twilioSettings(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const n = resourceNames(ctx.code);
  const r = await ops(deps, cfg, "POST", "/twilio-settings");
  const settings = (r?.settings ?? {}) as Record<string, string>;
  const names = Object.keys(settings).filter((k) => /^(TWILIO_[A-Z_]+|KS_SERVER_URL)$/.test(k) && settings[k]);
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY", "TWILIO_API_SECRET", "TWILIO_VOICE_APP_SID", "TWILIO_VERIFY_SERVICE_SID"]) {
    if (!settings[k]) throw new StepError(`KS-Ops did not hand over ${k}`);
  }
  for (const k of names) if (/TOKEN|SECRET/.test(k)) mask(deps, settings[k]);
  await az(deps, ["webapp", "config", "appsettings", "set", "-g", n.resourceGroup, "-n", n.serverApp, "--settings", ...names.map((k) => `${k}=${settings[k]}`), "-o", "none"]);
  deps.log(`${n.serverApp}: Twilio settings written (${names.join(", ")})`);
  return {};
}

export async function secrets(deps: RunnerDeps, _cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const n = resourceNames(ctx.code);
  const names = async (app: string) =>
    new Set((await az(deps, ["webapp", "config", "appsettings", "list", "-g", n.resourceGroup, "-n", app, "--query", "[].name", "-o", "tsv"])).split(/\s+/).filter(Boolean));
  const [server, agent] = await Promise.all([names(n.serverApp), names(n.agentApp)]);
  const missing = [
    ...GENERATED_SERVER_SECRETS.filter((k) => !server.has(k)).map((k) => `${n.serverApp}:${k}`),
    ...GENERATED_AGENT_SECRETS.filter((k) => !agent.has(k)).map((k) => `${n.agentApp}:${k}`),
  ];
  if (missing.length) throw new StepError(`secrets missing from the app settings: ${missing.join(", ")} (retry azure_resources)`);
  return {};
}

/** Variables for each repository's ks-<code> environment. */
export function environmentVariables(ctx: Context, res: Awaited<ReturnType<typeof readResources>>): Record<string, Record<string, string>> {
  const n = resourceNames(ctx.code);
  const azure = { AZURE_CLIENT_ID: res.deploy_client_id, AZURE_TENANT_ID: res.tenant_id, AZURE_SUBSCRIPTION_ID: res.subscription_id };
  const optional = (v: Record<string, string>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x));
  return {
    "KS-server": { ...azure, AZURE_WEBAPP_NAME: n.serverApp },
    "KS-Agent": { ...azure, AZURE_WEBAPP_NAME: n.agentApp },
    "KS-Portal": {
      VITE_API_BASE_URL: res.server_url,
      VITE_APP_URL: res.portal_url,
      VITE_CLIENT_APP_URL: res.client_url,
      VITE_MSAL_REDIRECT_URI: res.portal_url,
      ...optional({ VITE_COMPANY_NAME: ctx.company_name, VITE_ASSISTANT_NAME: ctx.assistant_name, VITE_WEBSITE_URL: /^https:\/\//.test(ctx.website) ? ctx.website : "" }),
    },
    "KS-Client": {
      VITE_API_BASE_URL: res.server_url,
      VITE_CLIENT_APP_URL: res.client_url,
      ...optional({ VITE_COMPANY_NAME: ctx.company_name, VITE_WEBSITE_URL: /^https:\/\//.test(ctx.website) ? ctx.website : "" }),
    },
  };
}

export async function githubEnvironments(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const n = resourceNames(ctx.code);
  const res = await readResources(deps, ctx.code);
  const swa = async (name: string) => az(deps, ["staticwebapp", "secrets", "list", "-g", n.resourceGroup, "-n", name, "--query", "properties.apiKey", "-o", "tsv"]);
  const [portalToken, clientToken] = await Promise.all([swa(n.portalSwa), swa(n.clientSwa)]);
  mask(deps, portalToken);
  mask(deps, clientToken);
  const secretValues: Record<string, Record<string, string>> = {
    "KS-Portal": { AZURE_STATIC_WEB_APPS_API_TOKEN: portalToken },
    "KS-Client": { AZURE_STATIC_WEB_APPS_API_TOKEN: clientToken },
  };
  const vars = environmentVariables(ctx, res);
  const ghEnv = { GH_TOKEN: cfg.ghToken };
  for (const repo of Object.keys(ENVIRONMENT_SETTINGS)) {
    const full = `${cfg.owner}/${repo}`;
    ghOk(await gh(deps, cfg, "PUT", `/repos/${full}/environments/${n.environment}`, {}), `create environment ${n.environment} in ${repo}`);
    for (const [name, value] of Object.entries(vars[repo] ?? {})) {
      await run(deps, "gh", ["variable", "set", name, "--env", n.environment, "--repo", full, "--body", value], { env: ghEnv });
    }
    for (const [name, value] of Object.entries(secretValues[repo] ?? {})) {
      if (!value) throw new StepError(`no value for ${repo} secret ${name}`);
      await run(deps, "gh", ["secret", "set", name, "--env", n.environment, "--repo", full], { env: ghEnv, input: value });
    }
    deps.log(`${repo}: environment ${n.environment} ready`);
  }
  return {};
}

type RegistryResult = { repo: string; changed: boolean; pull_request?: string };

/** Adds (or removes) the licensee in deploy/licensees.json of one repository through a pull request merged after CI. */
export async function ensureRegistry(deps: RunnerDeps, cfg: RunnerConfig, repo: string, code: string, add: boolean): Promise<RegistryResult> {
  const full = `${cfg.owner}/${repo}`;
  const path = "deploy/licensees.json";
  const branch = `${add ? "provision" : "teardown"}/${code}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const file = ghOk(await gh(deps, cfg, "GET", `/repos/${full}/contents/${path}?ref=main`), `read ${path} in ${repo}`);
    const data = JSON.parse(Buffer.from(String(file.content ?? ""), "base64").toString("utf8")) as { licensees?: Array<Record<string, unknown>> };
    const list = Array.isArray(data.licensees) ? data.licensees : [];
    const entry = list.find((l) => l.code === code);
    if (add ? entry && entry.enabled === true : !entry) return { repo, changed: false };
    data.licensees = add ? [...list.filter((l) => l.code !== code), registryEntry(code)] : list.filter((l) => l.code !== code);
    const content = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64");

    const mainRef = ghOk(await gh(deps, cfg, "GET", `/repos/${full}/git/ref/heads/main`), `read main in ${repo}`);
    const mainSha = String(mainRef.object?.sha ?? "");
    const created = await gh(deps, cfg, "POST", `/repos/${full}/git/refs`, { ref: `refs/heads/${branch}`, sha: mainSha });
    if (created.status === 422) ghOk(await gh(deps, cfg, "PATCH", `/repos/${full}/git/refs/heads/${branch}`, { sha: mainSha, force: true }), `reset ${branch} in ${repo}`);
    else ghOk(created, `create ${branch} in ${repo}`);
    const title = add ? `Deploy licensee ${code}` : `Stop deploying licensee ${code}`;
    const putRes = await gh(deps, cfg, "PUT", `/repos/${full}/contents/${path}`, { message: `${title} (KS-Ops automatic provisioning)`, content, sha: file.sha, branch });
    if (putRes.status === 409 || putRes.status === 422) {
      deps.log(`${repo}: main moved while committing (${putRes.status}); trying again`);
      continue;
    }
    const put = ghOk(putRes, `commit ${path} in ${repo}`);
    const headSha = String(put.commit?.sha ?? "");
    const open = ghOk(await gh(deps, cfg, "GET", `/repos/${full}/pulls?state=open&head=${cfg.owner}:${encodeURIComponent(branch)}`), `list pull requests in ${repo}`);
    const pr = Array.isArray(open) && open[0]
      ? open[0]
      : ghOk(
          await gh(deps, cfg, "POST", `/repos/${full}/pulls`, {
            title,
            head: branch,
            base: "main",
            body: `KS-Ops automatic provisioning: ${add ? "adds" : "removes"} \`${code}\` in \`deploy/licensees.json\`. Merged automatically once CI passes. Nothing secret is in this file.`,
          }),
          `open a pull request in ${repo}`,
        );
    deps.log(`${repo}: pull request ${pr.html_url}`);
    await waitForChecks(deps, cfg, full, headSha);
    // [skip ci]: the merge itself starts no deploy; the deploy step runs the deploy workflow for this licensee only.
    const merged = await gh(deps, cfg, "PUT", `/repos/${full}/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha: headSha,
      commit_title: `${title} [skip ci] (#${pr.number})`,
    });
    if (merged.status === 200) return { repo, changed: true, pull_request: String(pr.html_url) };
    deps.log(`${repo}: merge not possible yet (${merged.status} ${String(merged.json?.message ?? "")}); trying again from a fresh main`);
    await deps.sleep(POLL_MS);
  }
  throw new StepError(`could not merge the deploy/licensees.json change in ${repo} after 3 tries`);
}

/** Waits until every check on the commit has finished; throws when one failed. No checks at all after 10 minutes is ok. */
export async function waitForChecks(deps: RunnerDeps, cfg: RunnerConfig, full: string, sha: string): Promise<void> {
  const start = deps.now().getTime();
  for (;;) {
    const r = ghOk(await gh(deps, cfg, "GET", `/repos/${full}/commits/${sha}/check-runs?per_page=100`), `read checks in ${full}`);
    const runs = (Array.isArray(r.check_runs) ? r.check_runs : []) as Array<{ name: string; status: string; conclusion: string | null; html_url?: string }>;
    const elapsed = deps.now().getTime() - start;
    if (runs.length && runs.every((c) => c.status === "completed")) {
      const bad = runs.filter((c) => !["success", "neutral", "skipped"].includes(String(c.conclusion)));
      if (bad.length) throw new StepError(`CI failed in ${full}: ${bad.map((c) => `${c.name} (${c.conclusion}) ${c.html_url ?? ""}`).join(", ")}`);
      return;
    }
    if (!runs.length && elapsed > 10 * MIN) return;
    if (elapsed > CHECKS_TIMEOUT_MS) throw new StepError(`CI in ${full} did not finish within ${CHECKS_TIMEOUT_MS / MIN} minutes`);
    await deps.sleep(POLL_MS);
  }
}

export async function deployRegistry(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context, add = true): Promise<Record<string, unknown>> {
  const results = await Promise.all(APP_REPOS.map((r) => ensureRegistry(deps, cfg, r.repo, ctx.code, add)));
  return { pull_requests: results.filter((r) => r.pull_request).map((r) => r.pull_request) };
}

/** Starts one repository's deploy workflow for this licensee and waits for its "deploy <code>" job. */
export async function deployOne(deps: RunnerDeps, cfg: RunnerConfig, repo: string, workflow: string, code: string): Promise<string> {
  const full = `${cfg.owner}/${repo}`;
  const since = new Date(deps.now().getTime() - 60_000).toISOString();
  const d = await gh(deps, cfg, "POST", `/repos/${full}/actions/workflows/${workflow}/dispatches`, { ref: "main", inputs: { licensee: code } });
  if (d.status !== 204) ghOk(d, `start ${workflow} in ${repo}`);
  const start = deps.now().getTime();
  const jobName = `deploy ${code}`;
  for (;;) {
    await deps.sleep(POLL_MS);
    const runs = ghOk(
      await gh(deps, cfg, "GET", `/repos/${full}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=10&created=${encodeURIComponent(`>=${since}`)}`),
      `list ${workflow} runs in ${repo}`,
    );
    for (const wr of (runs.workflow_runs ?? []) as Array<{ id: number; html_url: string }>) {
      const jobs = ghOk(await gh(deps, cfg, "GET", `/repos/${full}/actions/runs/${wr.id}/jobs?per_page=100`), `list jobs in ${repo}`);
      const job = ((jobs.jobs ?? []) as Array<{ name: string; status: string; conclusion: string | null; html_url: string }>).find((j) => j.name === jobName);
      if (!job) continue;
      if (job.status !== "completed") break;
      if (job.conclusion === "success") return String(job.html_url);
      throw new StepError(`${repo} deploy for ${code} ended ${job.conclusion}: ${job.html_url}`);
    }
    if (deps.now().getTime() - start > DEPLOY_TIMEOUT_MS) throw new StepError(`${repo} deploy for ${code} did not finish within ${DEPLOY_TIMEOUT_MS / MIN} minutes`);
  }
}

export async function deploy(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const urls = await Promise.all(APP_REPOS.map((r) => deployOne(deps, cfg, r.repo, r.workflow, ctx.code)));
  return { deploys: urls };
}

// ---------------------------------------------------------------------------------------------------------------------
// Teardown steps

export async function githubEnvironmentsRemove(deps: RunnerDeps, cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const env = resourceNames(ctx.code).environment;
  for (const r of APP_REPOS) {
    const res = await gh(deps, cfg, "DELETE", `/repos/${cfg.owner}/${r.repo}/environments/${env}`);
    if (res.status !== 204 && res.status !== 404) ghOk(res, `delete environment ${env} in ${r.repo}`);
  }
  return {};
}

export async function azureDelete(deps: RunnerDeps, _cfg: RunnerConfig, ctx: Context): Promise<Record<string, unknown>> {
  const rg = resourceNames(ctx.code).resourceGroup;
  if ((await az(deps, ["group", "exists", "-n", rg])) !== "true") return { resource_group: rg };
  // Only a group provision-licensee.sh made for this very licensee is ever deleted.
  const tag = await az(deps, ["group", "show", "-n", rg, "--query", "tags.\"keystone-licensee\"", "-o", "tsv"]);
  if (tag !== ctx.code) throw new StepError(`resource group ${rg} is not tagged keystone-licensee=${ctx.code}; not deleting it`);
  await az(deps, ["group", "delete", "-n", rg, "--yes"]);
  if ((await az(deps, ["group", "exists", "-n", rg])) === "true") throw new StepError(`resource group ${rg} still exists after the delete`);
  return { resource_group: rg };
}

// ---------------------------------------------------------------------------------------------------------------------

type StepFn = (deps: RunnerDeps, cfg: RunnerConfig, ctx: Context) => Promise<Record<string, unknown>>;

export const RUNNER_STEPS: Record<RunKind, Record<string, StepFn>> = {
  provision: {
    azure_resources: azureResources,
    twilio_settings: twilioSettings, // KS_OPS_TWILIO_AUTO_v1
    secrets,
    github_environments: githubEnvironments,
    deploy_registry: (d, c, x) => deployRegistry(d, c, x, true),
    deploy,
  },
  teardown: {
    deploy_registry_remove: (d, c, x) => deployRegistry(d, c, x, false),
    github_environments_remove: githubEnvironmentsRemove,
    azure_delete: azureDelete,
  },
};

/** The whole workflow run. Returns the exit code (0 also when setup is missing: that is reported, not a failure). */
export async function runWorkflow(deps: RunnerDeps, cfg: RunnerConfig): Promise<number> {
  mask(deps, cfg.token);
  if (cfg.ghToken) mask(deps, cfg.ghToken);
  if (!cfg.dryRun) {
    const missing = preflightMissing(cfg, deps.env);
    if (missing.length) {
      deps.log(`setup missing: ${missing.join(", ")}`);
      await report(deps, cfg, { status: "setup_missing", missing, message: `missing: ${missing.join(", ")}` });
      return 0;
    }
  }
  const ctx = (await ops(deps, cfg, "GET", "/context")) as Context;
  const table = RUNNER_STEPS[cfg.mode];
  for (const step of cfg.steps) {
    const fn = table[step];
    if (!fn) {
      await report(deps, cfg, { step, status: "failed", message: `the workflow does not know step ${step}` });
      return 1;
    }
    await report(deps, cfg, { step, status: "running", message: cfg.dryRun ? "dry run" : "started" });
    try {
      let output: Record<string, unknown>;
      if (cfg.dryRun) {
        const lines = describePlan(cfg.mode, ctx.code, ctx.region).filter((l) => l.startsWith(`${step}:`));
        for (const line of lines) deps.log(`would: ${line}`);
        await report(deps, cfg, { step, status: "log", message: lines.map((l) => `would: ${l}`).join("\n") });
        output = { dry_run: true };
      } else {
        output = await fn(deps, cfg, ctx);
      }
      await report(deps, cfg, { step, status: "done", output });
      deps.log(`${step}: done`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`${step}: failed: ${message}`);
      await report(deps, cfg, { step, status: "failed", message });
      return 1;
    }
  }
  return 0;
}
