// KS_OPS_AUTO_PROVISION_v1 - the workflow side, with gh, the GitHub API and KS-Ops all faked.
// KS_SHARED_HOSTING_v1 - it only touches KS-Portal and KS-Client now, and never signs in to Azure.
import { describe, expect, it, vi } from "vitest";
import {
  deployOne, ensureRegistry, githubEnvironments, preflightMissing, readConfig, RUNNER_STEPS, runWorkflow,
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
  server_url: "https://prairie.api.keystone.test", portal_url: "https://prairie.portal.keystone.test", client_url: "https://prairie.app.keystone.test",
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
    env: { ...(opts.env ?? {}) },
    log: (m) => logs.push(m),
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
    readFile: async () => "{}",
    tempFile: (n) => `/tmp/x/${n}`,
  };
  return { deps, exec, fetch: fetchImpl, logs, reports };
}

describe("workflow runner", () => {
  it("reads its settings and refuses a plain-http KS-Ops", () => {
    expect(readConfig({ KS_OPS_URL: "https://ops.test/", RUN_ID: RUN, CALLBACK_TOKEN: "x", STEPS: "a, b", DRY_RUN: "true" })).toMatchObject({ opsUrl: "https://ops.test", steps: ["a", "b"], dryRun: true, mode: "provision" });
    expect(() => readConfig({ KS_OPS_URL: "http://ops.test", RUN_ID: RUN, CALLBACK_TOKEN: "x" })).toThrow(/https/);
  });

  it("needs only the GitHub credential (no Azure sign-in), and reports it missing instead of changing anything", async () => {
    expect(preflightMissing(cfg({ ghToken: "" }), {})).toEqual(["GITHUB_APP"]);
    expect(preflightMissing(cfg(), {})).toEqual([]);
    const t = runnerDeps();
    expect(await runWorkflow(t.deps, cfg({ ghToken: "", steps: ["github_environments"] }))).toBe(0);
    expect(t.reports).toEqual([{ status: "setup_missing", missing: ["GITHUB_APP"], message: "missing: GITHUB_APP" }]);
    expect(t.exec).not.toHaveBeenCalled();
  });

  it("knows only the web build steps; the Azure and settings steps are KS-Ops's own now", () => {
    expect(Object.keys(RUNNER_STEPS.provision)).toEqual(["github_environments", "deploy_registry", "deploy"]);
    expect(Object.keys(RUNNER_STEPS.teardown)).toEqual(["deploy_registry_remove", "github_environments_remove"]);
  });

  it("a dry run prints the plan, reports each step and calls neither gh nor GitHub", async () => {
    const t = runnerDeps();
    expect(await runWorkflow(t.deps, cfg({ dryRun: true, steps: ["github_environments", "deploy"] }))).toBe(0);
    expect(t.exec).not.toHaveBeenCalled();
    expect(t.fetch.mock.calls.every(([u]) => String(u).startsWith("https://ks-ops.example.test/"))).toBe(true);
    expect(t.reports.filter((r) => r.status === "done").map((r) => r.step)).toEqual(["github_environments", "deploy"]);
    expect(t.logs.some((l) => l.startsWith("would: deploy: KS-Portal - run deploy.yml on main with licensee=prairie"))).toBe(true);
    expect(t.logs).toContain("::add-mask::cb-token");
  });

  it("a failing step is reported failed and stops the run", async () => {
    const t = runnerDeps({ exec: () => ({ code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" }), routes: [(url, init) => (init.method === "PUT" && url.includes("/environments/") ? { status: 200, body: {} } : undefined)] });
    expect(await runWorkflow(t.deps, cfg({ steps: ["github_environments", "deploy_registry"] }))).toBe(1);
    expect(t.reports.at(-1)).toMatchObject({ step: "github_environments", status: "failed", message: expect.stringMatching(/Resource not accessible/) });
    expect(t.reports.some((r) => r.step === "deploy_registry")).toBe(false);
  });

  it("github_environments writes the web build variables for KS-Portal and KS-Client only, and no secret", async () => {
    const envPuts: string[] = [];
    const t = runnerDeps({
      routes: [(url, init) => (init.method === "PUT" && url.includes("/environments/ks-prairie") ? (envPuts.push(url), { status: 200, body: {} }) : undefined)],
    });
    await githubEnvironments(t.deps, cfg(), context);
    expect(envPuts.map((u) => u.split("/")[5])).toEqual(["KS-Portal", "KS-Client"]);
    const gh = t.exec.mock.calls.filter(([c]) => c === "gh");
    const vars = gh.filter(([, a]) => a[0] === "variable").map(([, a]) => `${a[a.indexOf("--repo") + 1]} ${a[2]}=${a[a.indexOf("--body") + 1]}`);
    expect(vars).toContain("werb210/KS-Portal VITE_API_BASE_URL=https://prairie.api.keystone.test");
    expect(vars).toContain("werb210/KS-Portal VITE_APP_URL=https://prairie.portal.keystone.test");
    expect(vars).toContain("werb210/KS-Client VITE_CLIENT_APP_URL=https://prairie.app.keystone.test");
    expect(gh.filter(([, a]) => a[0] === "secret")).toHaveLength(0);
    expect(t.exec.mock.calls.some(([c]) => c === "az")).toBe(false);
  });

  it("github_environments refuses to run before KS-Ops has the brokerage's addresses", async () => {
    const t = runnerDeps();
    await expect(githubEnvironments(t.deps, cfg(), { ...context, portal_url: "" })).rejects.toThrow(/no portal_url/);
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
    expect(file.licensees).toEqual([{ code: "older", enabled: true }, { code: "prairie", environment: "ks-prairie", enabled: true, apps: ["portal", "client"] }]);
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
});
