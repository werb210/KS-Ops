// KS_OPS_AUTO_PROVISION_v1 - what KS-Ops itself needs before it starts a provisioning workflow. When something is
// missing the run waits in "waiting_for_setup" with this checklist; nothing is created or changed.
//
// KS-Ops holds no Azure credential. It needs a GitHub credential that can start the workflow in KS-Ops (Actions: write
// on that one repository); the cross-repository GitHub token lives in the KS-Ops GitHub environments
// ks-ops-provisioning / ks-ops-teardown, and the workflow reports what is missing there. KS_SHARED_HOSTING_v1 - and the
// shared-layout settings (sharedSetupMissing): the registry, the tenant key, the Postgres admin and the shared server.
import { env, opsPublicUrl } from "../config.js";
import { encryptionKey } from "../lib/crypto.js";
import type { RunKind } from "./steps.js";
import { masterCreds } from "../twilio/config.js";
import { controlOwnerUrl, opsServiceKey, sharedPgAdminUrl, sharedServerUrl, sitesConnectionString, tenantKeySetting } from "../tenants/config.js";

export type SetupItem = { key: string; label: string };

/**
 * KS_SHARED_HOSTING_v1 - what KS-Ops needs to set up (or remove) a brokerage on the shared server. Made once by
 * scripts/provision-shared.sh (docs/PROVISIONING.md); set as KS-Ops app settings.
 */
export function sharedSetupMissing(kind: RunKind = "provision", e: NodeJS.ProcessEnv = process.env): SetupItem[] {
  const out: SetupItem[] = [];
  if (!controlOwnerUrl(e)) {
    out.push({ key: "KS_CONTROL_OWNER_DATABASE_URL", label: "KS-Ops app setting KS_CONTROL_OWNER_DATABASE_URL (database ks_control on ks-shared-pg, role ks_control_owner): where the brokerage registry lives" });
  }
  if (!tenantKeySetting(e)) {
    out.push({ key: "KS_TENANT_KEY", label: "KS-Ops app setting KS_TENANT_KEY (the same value as on ks-shared-server, ks-shared-agent and ks-shared-web): encrypts each brokerage's database address and settings" });
  }
  if (!sharedPgAdminUrl(e)) {
    out.push({ key: "KS_SHARED_PG_ADMIN_URL", label: "KS-Ops app setting KS_SHARED_PG_ADMIN_URL (the ks-shared-pg admin, database postgres): makes and deletes each brokerage's database and role" });
  }
  if (kind === "provision" && !sharedServerUrl(e)) {
    out.push({ key: "KS_SHARED_SERVER_URL", label: "KS-Ops app setting KS_SHARED_SERVER_URL (https address of ks-shared-server): asked to load and migrate each new brokerage" });
  }
  if (!opsServiceKey(e)) {
    out.push({ key: "KS_OPS_SERVICE_KEY", label: "KS-Ops app setting KS_OPS_SERVICE_KEY (the same value as on ks-shared-server): authorises the reload and migrate calls" });
  }
  if (kind === "teardown" && !sitesConnectionString(e)) {
    out.push({ key: "KS_SITES_STORAGE_CONNECTION_STRING", label: "KS-Ops app setting KS_SITES_STORAGE_CONNECTION_STRING (the ksshared<suffix> storage account): deletes the brokerage's published web apps" });
  }
  return out;
}

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
  // KS_OPS_TWILIO_AUTO_v1 - each licensee's KS-server needs its own Twilio sub-account before it can start.
  if (kind === "provision" && !masterCreds(e)) {
    out.push({
      key: "KS_TWILIO_ACCOUNT_SID",
      label: "KS-Ops app settings KS_TWILIO_ACCOUNT_SID and KS_TWILIO_AUTH_TOKEN (Keystone's master Twilio account, a paid account): every licensee gets its own sub-account under it",
    });
  }
  out.push(...sharedSetupMissing(kind, e)); // KS_SHARED_HOSTING_v1
  if (kind === "teardown" && !teardownEnabled(e)) {
    out.push({ key: "KS_TEARDOWN_ENABLED", label: "KS-Ops app setting KS_TEARDOWN_ENABLED=true (teardown deletes the brokerage's database and published apps)" });
  }
  return out;
}

/** Items the workflow may report as missing in its own GitHub environment, with what to do. */
// KS_SHARED_HOSTING_v1 - the workflow no longer signs in to Azure: it only writes to KS-Portal and KS-Client.
export const WORKFLOW_SETUP_LABELS: Record<string, string> = {
  GITHUB_APP: "KS-Ops GitHub environment variable KS_PROVISION_APP_ID + secret KS_PROVISION_APP_PRIVATE_KEY (or secret KS_PROVISION_GH_TOKEN) for KS-Portal and KS-Client",
};

export function workflowSetupItems(keys: unknown): SetupItem[] {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((k) => String(k))
    .filter((k) => k in WORKFLOW_SETUP_LABELS)
    .map((k) => ({ key: k, label: WORKFLOW_SETUP_LABELS[k] }));
}
