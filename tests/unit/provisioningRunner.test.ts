// KS_OPS_AUTO_PROVISION_v1 - the workflow side, with az, gh, the GitHub API and KS-Ops all faked.
import { describe, expect, it, vi } from "vitest";
import {
  azureDelete, azureResources, deployOne, ensureRegistry, githubEnvironments, preflightMissing, readConfig, runWorkflow,
  type Context, type ExecResult, type RunnerConfig, type RunnerDeps,
} from "../../src/provisioning/runner/runner.js";

const RUN = "33333333-3333-4333-8333-333333333333";
const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  mode: "provision", opsUrl: "https://ks-ops.example.test", runId: RUN, token: "cb-token", steps: [], dryRun: false,
  owner: "werb210", ghToken: "ghs_app_token", ...over,
});
const context: Context = {
  run_id: RUN, kind: "provision", dry_run: false, steps: [], region: "canadacentral", licensee_id: "11111111-1111-4111-8111-111111111111",
  code: "prairie", company_name: "Prairie Capital", assistant_name: "Maya", website: "https://prairie.example", plan: "growth",
  contact_email: "dana@prairie.example",
};

type Route = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;

function runnerDeps(opts: { exec?: (cmd: string, args: string[], o?: { env?: Record<string, string>; input?: string }) => ExecResult; routes?: Route[]; env?: Record<string, string> } = {}) {
  const logs: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const exec = vi.fn(async (cmd: string, args: string[], o?: { env?: Record<string, string>; input?: string }) => opts.exec?.(cmd, args, o) ?? { code: 0, stdout: "", stderr: "" });
  const fetchImpl = vi.fn(async (u: string | URL, init: RequestInit = {}) => {
    const url = String(u);
    if (url.startsWith("https://ks-ops.example.test/api/provisioning/callback/")) {
      if (url.endsWith("/context")) return new Response(JSON.stringify(context));
      if (url.endsWith("/ops-key")) return new Response(JSON.stringify({ ops_key: "ksops_secret_key" }));
      reports.push(JSON.parse(String(init.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true }));
    }
    for (const r of opts.routes ?? []) {
      const hit = r(url, init);
      if (hit) return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), { status: hit.status ?? 200 });
    }
    return new Response(JSON.stringify({ message: `no fake for ${init.method ?? "GET"} ${url}` }), { status: 599 });
  });
  const deps: RunnerDeps = {
    exec,
    fetch: fetchImpl as unknown as typeof fetch,
    env: { AZURE_CLIENT_ID: "c", AZURE_TENANT_ID: "t", AZURE_SUBSCRIPTION_ID: "s", OPENAI_API_KEY: "sk-test", AZURE_LOGIN_OUTCOME: "success", ...(opts.env ?? {}) },
    log: (m) => logs.push(m),
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
    readFile: async () => JSON.stringify({ server_url: "https://ks-prairie-server.azurewebsites.net", agent_url: "https://ks-prairie-agent.azurewebsites.net", portal_url: "https://ks-prairie-portal.azurestaticapps.net", client_url: "https://ks-prairie-client.azurestaticapps.net", resource_group: "ks-prairie", deploy_client_id: "dep-client" }),
    tempFile: (n) => `/tmp/x/${n}`,
  };
  return { deps, exec, fetch: fetchImpl, logs, reports };
}

describe("workflow runner", () => {
  it("reads its settings and refuses a plain-http KS-Ops", () => {
    expect(readConfig({ KS_OPS_URL: "https://ops.test/", RUN_ID: RUN, CALLBACK_TOKEN: "x", STEPS: "a, b", DRY_RUN: "true" })).toMatchObject({ opsUrl: "https://ops.test", steps: ["a", "b"], dryRun: true, mode: "provision" });
    expect(() => readConfig({ KS_OPS_URL: "http://ops.test", RUN_ID: RUN, CALLBACK_TOKEN: "x" })).toThrow(/https/);
  });

  it("reports missing settings instead of changing anything", async () => {
    expect(preflightMissing(cfg({ ghToken: "" }), {})).toEqual(["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "GITHUB_APP", "OPENAI_API_KEY"]);
    const t = runnerDeps({ env: { AZURE_LOGIN_OUTCOME: "failure" } });
    expect(await runWorkflow(t.deps, cfg({ steps: ["azure_resources"] }))).toBe(0);
    expect(t.reports).toEqual([{ status: "setup_missing", missing: ["AZURE_LOGIN"], message: "missing: AZURE_LOGIN" }]);
    expect(t.exec).not.toHaveBeenCalled();
  });

  it("a dry run prints the plan, reports each step and calls neither az nor GitHub", async () => {
    const t = runnerDeps();
    expect(await runWorkflow(t.deps, cfg({ dryRun: true, steps: ["azure_resources", "deploy"] }))).toBe(0);
    expect(t.exec).not.toHaveBeenCalled();
    expect(t.fetch.mock.calls.every(([u]) => String(u).startsWith("https://ks-ops.example.test/"))).toBe(true);
    expect(t.reports.filter((r) => r.status === "done").map((r) => r.step)).toEqual(["azure_resources", "deploy"]);
    expect(t.logs.some((l) => l.startsWith("would: deploy: KS-server - run deploy.yml on main with licensee=prairie"))).toBe(true);
    expect(t.logs).toContain("::add-mask::cb-token");
  });

  it("azure_resources runs provision-licensee.sh with the ops key, the deploy identity and no secret printing", async () => {
    const t = runnerDeps();
    const out = await azureResources(t.deps, cfg(), context);
    const [cmd, args, opts] = t.exec.mock.calls[0];
    expect(cmd).toBe("bash");
    expect(args).toEqual(["scripts/provision-licensee.sh", "prairie", "canadacentral"]);
    expect(opts?.env).toMatchObject({ KS_OPS_KEY: "ksops_secret_key", DEPLOY_IDENTITY: "1", KS_NONINTERACTIVE: "1", KS_PLAN: "growth", DEPLOY_IDENTITY_REPOS: "werb210/KS-server,werb210/KS-Agent" });
    expect(t.logs).toContain("::add-mask::ksops_secret_key");
    expect(out).toMatchObject({ server_url: "https://ks-prairie-server.azurewebsites.net", deploy_client_id: "dep-client" });
  });

  it("a failing step is reported failed and stops the run", async () => {
    const t = runnerDeps({ exec: () => ({ code: 1, stdout: "", stderr: "QuotaExceeded in canadacentral" }) });
    expect(await runWorkflow(t.deps, cfg({ steps: ["azure_resources", "secrets"] }))).toBe(1);
    expect(t.reports.at(-1)).toMatchObject({ step: "azure_resources", status: "failed", message: expect.stringMatching(/QuotaExceeded/) });
    expect(t.reports.some((r) => r.step === "secrets")).toBe(false);
  });

  it("github_environments writes variables in the open and secrets only through stdin", async () => {
    const az = (args: string[]) => {
      const a = args.join(" ");
      if (a.includes("account show")) return JSON.stringify({ t: "tenant-1", s: "sub-1" });
      if (a.includes("identity show")) return "dep-client";
      if (a.includes("secrets list")) return a.includes("portal") ? "swa-portal-token" : "swa-client-token";
      if (a.includes("-portal")) return "ks-prairie-portal.azurestaticapps.net";
      if (a.includes("-client")) return "ks-prairie-client.azurestaticapps.net";
      if (a.includes("-agent")) return "ks-prairie-agent.azurewebsites.net";
      return "ks-prairie-server.azurewebsites.net";
    };
    const envPuts: string[] = [];
    const t = runnerDeps({
      exec: (cmd, args) => ({ code: 0, stdout: cmd === "az" ? az(args) : "", stderr: "" }),
      routes: [(url, init) => (init.method === "PUT" && url.includes("/environments/ks-prairie") ? (envPuts.push(url), { status: 200, body: {} }) : undefined)],
    });
    await githubEnvironments(t.deps, cfg(), context);
    expect(envPuts.map((u) => u.split("/")[5])).toEqual(["KS-server", "KS-Agent", "KS-Portal", "KS-Client"]);
    const gh = t.exec.mock.calls.filter(([c]) => c === "gh");
    const vars = gh.filter(([, a]) => a[0] === "variable").map(([, a]) => `${a[a.indexOf("--repo") + 1]} ${a[2]}=${a[a.indexOf("--body") + 1]}`);
    expect(vars).toContain("werb210/KS-server AZURE_CLIENT_ID=dep-client");
    expect(vars).toContain("werb210/KS-Agent AZURE_WEBAPP_NAME=ks-prairie-agent");
    expect(vars).toContain("werb210/KS-Portal VITE_API_BASE_URL=https://ks-prairie-server.azurewebsites.net");
    expect(vars).toContain("werb210/KS-Client VITE_CLIENT_APP_URL=https://ks-prairie-client.azurestaticapps.net");
    const secrets = gh.filter(([, a]) => a[0] === "secret");
    expect(secrets).toHaveLength(2);
    for (const [, args, o] of secrets) {
      expect(args.join(" ")).not.toContain("swa-");
      expect(o?.input).toMatch(/^swa-(portal|client)-token$/);
      expect(o?.env).toEqual({ GH_TOKEN: "ghs_app_token" });
    }
    expect(t.logs).toContain("::add-mask::swa-portal-token");
  });

  const registry = (licensees: unknown[]) => ({ content: Buffer.from(JSON.stringify({ $comment: "x", licensees })).toString("base64"), sha: "blob1" });

  it("registry: nothing to do when the licensee is already listed", async () => {
    const t = runnerDeps({ routes: [(url) => (url.includes("/contents/deploy/licensees.json") ? { body: registry([{ code: "prairie", enabled: true }]) } : undefined)] });
    expect(await ensureRegistry(t.deps, cfg(), "KS-server", "prairie", true)).toEqual({ repo: "KS-server", changed: false });
  });

  it("registry: opens a pull request, waits for CI and merges it with [skip ci]", async () => {
    let committed: any = null;
    let merge: any = null;
    let checksCalls = 0;
    const t = runnerDeps({
      routes: [
        (url, init) => (url.includes("/contents/deploy/licensees.json?ref=main") ? { body: registry([{ code: "older", enabled: true }]) } : init.method === "PUT" && url.includes("/contents/") ? ((committed = JSON.parse(String(init.body))), { status: 200, body: { commit: { sha: "head1" } } }) : undefined),
        (url) => (url.endsWith("/git/ref/heads/main") ? { body: { object: { sha: "main1" } } } : undefined),
        (url, init) => (url.endsWith("/git/refs") && init.method === "POST" ? { status: 201, body: {} } : undefined),
        (url, init) => (url.includes("/pulls?state=open") ? { body: [] } : url.endsWith("/pulls") && init.method === "POST" ? { status: 201, body: { number: 7, html_url: "https://github.com/werb210/KS-server/pull/7" } } : undefined),
        (url) => (url.includes("/commits/head1/check-runs") ? { body: { check_runs: ++checksCalls < 2 ? [{ name: "ci", status: "in_progress", conclusion: null }] : [{ name: "ci", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "skipped" }] } } : undefined),
        (url, init) => (url.endsWith("/pulls/7/merge") ? ((merge = JSON.parse(String(init.body))), { status: 200, body: { merged: true } }) : undefined),
      ],
    });
    const r = await ensureRegistry(t.deps, cfg(), "KS-server", "prairie", true);
    expect(r).toEqual({ repo: "KS-server", changed: true, pull_request: "https://github.com/werb210/KS-server/pull/7" });
    const file = JSON.parse(Buffer.from(committed.content, "base64").toString("utf8"));
    expect(file.$comment).toBe("x");
    expect(file.licensees).toEqual([{ code: "older", enabled: true }, { code: "prairie", environment: "ks-prairie", enabled: true, apps: ["server", "agent", "portal", "client"] }]);
    expect(committed).toMatchObject({ branch: "provision/prairie", sha: "blob1" });
    expect(merge).toMatchObject({ merge_method: "squash", sha: "head1", commit_title: expect.stringContaining("[skip ci]") });
    expect(checksCalls).toBe(2);
  });

  it("registry: a failed CI check stops the step with the check's name", async () => {
    const t = runnerDeps({
      routes: [
        (url, init) => (url.includes("/contents/deploy/licensees.json?ref=main") ? { body: registry([]) } : init.method === "PUT" && url.includes("/contents/") ? { body: { commit: { sha: "h2" } } } : undefined),
        (url) => (url.endsWith("/git/ref/heads/main") ? { body: { object: { sha: "m" } } } : undefined),
        (url) => (url.endsWith("/git/refs") ? { status: 422, body: {} } : undefined),
        (url) => (url.includes("/git/refs/heads/provision") ? { body: {} } : undefined),
        (url) => (url.includes("/pulls?state=open") ? { body: [{ number: 9, html_url: "pr9" }] } : undefined),
        (url) => (url.includes("/check-runs") ? { body: { check_runs: [{ name: "Integration", status: "completed", conclusion: "failure", html_url: "run1" }] } } : undefined),
      ],
    });
    await expect(ensureRegistry(t.deps, cfg(), "KS-Agent", "prairie", false)).resolves.toEqual({ repo: "KS-Agent", changed: false });
    await expect(ensureRegistry(t.deps, cfg(), "KS-Agent", "prairie", true)).rejects.toThrow(/CI failed in werb210\/KS-Agent: Integration \(failure\)/);
  });

  it("deploy: starts the workflow for this licensee and waits for its deploy job", async () => {
    let jobState = "in_progress";
    const t = runnerDeps({
      routes: [
        (url, init) => (url.endsWith("/actions/workflows/deploy.yml/dispatches") ? (expect(JSON.parse(String(init.body))).toEqual({ ref: "main", inputs: { licensee: "prairie" } }), { status: 204 }) : undefined),
        (url) => (url.includes("/actions/workflows/deploy.yml/runs?event=workflow_dispatch") ? { body: { workflow_runs: [{ id: 5, html_url: "r5" }] } } : undefined),
        (url) => {
          if (!url.endsWith("/actions/runs/5/jobs?per_page=100")) return undefined;
          const body = { jobs: [{ name: "build-and-deploy", status: "completed", conclusion: "skipped" }, { name: "deploy prairie", status: jobState, conclusion: jobState === "completed" ? "success" : null, html_url: "job1" }] };
          jobState = "completed";
          return { body };
        },
      ],
    });
    expect(await deployOne(t.deps, cfg(), "KS-server", "deploy.yml", "prairie")).toBe("job1");
  });

  it("teardown never deletes a resource group that is not tagged for this licensee", async () => {
    const t = runnerDeps({ exec: (_c, args) => ({ code: 0, stdout: args.includes("exists") ? "true" : args.includes("show") ? "someone-else" : "", stderr: "" }) });
    await expect(azureDelete(t.deps, cfg({ mode: "teardown" }), context)).rejects.toThrow(/not tagged keystone-licensee=prairie/);
    expect(t.exec.mock.calls.some(([, a]) => a.includes("delete"))).toBe(false);
  });
});
