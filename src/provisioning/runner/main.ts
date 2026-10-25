// KS_OPS_AUTO_PROVISION_v1 - entry point for the provisioning workflow: `npx tsx src/provisioning/runner/main.ts`.
// Reads its settings from the environment the workflow sets (see .github/workflows/provision-licensee.yml).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig, runWorkflow, type Exec } from "./runner.js";

const exec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...(opts?.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      // provision-licensee.sh prints progress (never a secret with KS_NONINTERACTIVE=1); pass it to the Actions log.
      if (cmd === "bash") process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (cmd === "bash") process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts?.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });

const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), "ks-provision-"));

runWorkflow(
  {
    exec,
    fetch,
    env: process.env,
    log: (m) => console.log(m),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    readFile: async (p) => readFileSync(p, "utf8"),
    tempFile: (name) => path.join(dir, name),
  },
  readConfig(process.env),
)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
