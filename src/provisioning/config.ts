// KS_OPS_AUTO_PROVISION_v1 - what KS-Ops itself needs before it starts a provisioning workflow. When something is
// missing the run waits in "waiting_for_setup" with this checklist; nothing is created or changed.
//
// KS-Ops holds no Azure credential. It only needs a GitHub credential that can start the workflow in KS-Ops
// (Actions: write on that one repository). The Azure federated credential and the cross-repository GitHub token live
// in the KS-Ops GitHub environments ks-ops-provisioning / ks-ops-teardown; the workflow checks those itself and
// reports what is missing.
import { env, opsPublicUrl } from "../config.js";
import { encryptionKey } from "../lib/crypto.js";
import type { RunKind } from "./steps.js";

export type SetupItem = { key: string; label: string };

export function githubRepo(e: NodeJS.ProcessEnv = process.env): string {
  return env("KS_PROVISION_GITHUB_REPO", e) || "werb210/KS-Ops";
}

export function githubTokenConfigured(e: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env("KS_PROVISION_GITHUB_TOKEN", e)) ||
    Boolean(env("KS_PROVISION_GITHUB_APP_ID", e) && env("KS_PROVISION_GITHUB_APP_PRIVATE_KEY", e));
}

/** KS_AUTO_PROVISION=off stops new runs from starting by themselves (staff can still start one). */
export function autoProvisionEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  const v = env("KS_AUTO_PROVISION", e).toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
}

/** Teardown deletes a licensee's Azure resources, so it is off until KS_TEARDOWN_ENABLED=true. */
export function teardownEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  return env("KS_TEARDOWN_ENABLED", e).toLowerCase() === "true";
}

/** The address the workflow reports back to: KS_OPS_PUBLIC_URL (or Azure's WEBSITE_HOSTNAME). Must be https. */
export function callbackBaseUrl(e: NodeJS.ProcessEnv = process.env): string {
  const url = opsPublicUrl(undefined, e);
  return /^https:\/\//.test(url) ? url : "";
}

/** The KS-Ops-side items still missing for this kind of run (empty = ready). */
export function serviceSetupMissing(kind: RunKind, e: NodeJS.ProcessEnv = process.env): SetupItem[] {
  const out: SetupItem[] = [];
  if (!githubTokenConfigured(e)) {
    out.push({
      key: "KS_PROVISION_GITHUB_TOKEN",
      label: "KS-Ops app setting KS_PROVISION_GITHUB_TOKEN (fine-grained token, Actions: read and write on KS-Ops), or KS_PROVISION_GITHUB_APP_ID + KS_PROVISION_GITHUB_APP_PRIVATE_KEY",
    });
  }
  if (!encryptionKey(env("OPS_ENCRYPTION_KEY", e))) {
    out.push({ key: "OPS_ENCRYPTION_KEY", label: "KS-Ops app setting OPS_ENCRYPTION_KEY (64 hex characters): needed for the licensee's ops key" });
  }
  if (!callbackBaseUrl(e)) {
    out.push({ key: "KS_OPS_PUBLIC_URL", label: "KS-Ops app setting KS_OPS_PUBLIC_URL (https address of KS-Ops) so the workflow can report back" });
  }
  if (kind === "teardown" && !teardownEnabled(e)) {
    out.push({ key: "KS_TEARDOWN_ENABLED", label: "KS-Ops app setting KS_TEARDOWN_ENABLED=true (teardown deletes the licensee's Azure resources)" });
  }
  return out;
}

/** Items the workflow may report as missing in its own GitHub environment, with what to do. */
export const WORKFLOW_SETUP_LABELS: Record<string, string> = {
  AZURE_CLIENT_ID: "KS-Ops GitHub environment variable AZURE_CLIENT_ID (the provisioning app registration's client id)",
  AZURE_TENANT_ID: "KS-Ops GitHub environment variable AZURE_TENANT_ID",
  AZURE_SUBSCRIPTION_ID: "KS-Ops GitHub environment variable AZURE_SUBSCRIPTION_ID",
  GITHUB_APP: "KS-Ops GitHub environment variable KS_PROVISION_APP_ID + secret KS_PROVISION_APP_PRIVATE_KEY (or secret KS_PROVISION_GH_TOKEN) for the four app repositories",
  OPENAI_API_KEY: "KS-Ops GitHub environment secret OPENAI_API_KEY (KS-server will not start without one)",
  AZURE_LOGIN: "Azure sign-in with the federated credential failed: check the app registration's federated credential subject and its roles",
};

export function workflowSetupItems(keys: unknown): SetupItem[] {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((k) => String(k))
    .filter((k) => k in WORKFLOW_SETUP_LABELS)
    .map((k) => ({ key: k, label: WORKFLOW_SETUP_LABELS[k] }));
}
