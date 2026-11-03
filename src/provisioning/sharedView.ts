// KS_SHARED_HOSTING_v1 - what /ops/provisioning shows about a brokerage on the shared server, in plain words: each
// step's status, the database and registry entry, and the custom domains with the exact DNS records and az commands.
import type { LicenseeRow } from "../licensees/repo.js";
import type { RunRow, StepRow } from "./store.js";
import type { SharedDeps } from "../tenants/shared.js";
import { defaultShared } from "../tenants/shared.js";
import { databaseNames, defaultHosts, ksDomain, TENANT_CODE_RE } from "../tenants/config.js";
import { azCommands, bindingsFor, dnsRecords } from "../tenants/domains.js";
import { getTenant, mergeHosts, type TenantRow } from "../tenants/repo.js";
import { NO_DOMAIN_MESSAGE } from "./sharedSteps.js";

export function stepPlainWords(s: Pick<StepRow, "status" | "last_error" | "done_by">): string {
  const why = s.last_error ? s.last_error.replace(/\s+$/, "").replace(/([^.!?])$/, "$1.") : "";
  switch (s.status) {
    case "pending":
      return "Not started yet.";
    case "running":
      return why ? `Working on it. ${why}` : "Working on it.";
    case "done":
      return "Done.";
    case "manual":
      return `Done by hand${s.done_by ? ` by ${s.done_by}` : ""}.`;
    case "blocked":
      return `Waiting. ${why || "It checks again by itself."}`;
    case "failed":
      return `Stopped. ${why} Fix the cause, then press Retry step.`.replace(/\s+/g, " ").trim();
    default:
      return String(s.status);
  }
}

export type SharedSummary = {
  database: { database: string; role: string } | null;
  registry: { state: "present" | "missing" | "unreadable" | "not_configured"; message: string; status?: string; api_hosts?: string[]; portal_hosts?: string[]; client_hosts?: string[] };
  custom_domains: { configured: boolean; domain: string; message: string; dns: string[]; commands: string[] };
};

export async function sharedSummary(
  deps: { env?: NodeJS.ProcessEnv; shared?: SharedDeps },
  run: RunRow,
  l: LicenseeRow,
  steps: StepRow[],
): Promise<SharedSummary> {
  const e = deps.env ?? process.env;
  const code = l.company_code;
  const database = TENANT_CODE_RE.test(code) ? databaseNames(code) : null;

  let row: TenantRow | null = null;
  let registry: SharedSummary["registry"];
  if (!String(e.KS_CONTROL_OWNER_DATABASE_URL ?? "").trim() && !deps.shared) {
    registry = { state: "not_configured", message: "KS_CONTROL_OWNER_DATABASE_URL is not set on KS-Ops, so the registry cannot be read." };
  } else {
    try {
      row = await getTenant((deps.shared ?? defaultShared()).control(), code);
      registry = row
        ? { state: "present", message: `Registry entry "${code}" is there (status ${row.status}).`, status: row.status, api_hosts: row.api_hosts, portal_hosts: row.portal_hosts, client_hosts: row.client_hosts }
        : { state: "missing", message: run.kind === "teardown" ? "No registry entry (already deleted, or never made)." : "No registry entry yet: the database step makes it." };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[provisioning] registry not readable for the page", { code, message });
      registry = { state: "unreadable", message: `The registry could not be read: ${message}` };
    }
  }

  const domain = ksDomain(e);
  let custom_domains: SharedSummary["custom_domains"];
  if (run.kind !== "provision") {
    custom_domains = { configured: Boolean(domain), domain, message: "", dns: [], commands: [] };
  } else if (!domain) {
    custom_domains = { configured: false, domain: "", message: NO_DOMAIN_MESSAGE, dns: [], commands: [] };
  } else {
    const bindings = bindingsFor(mergeHosts(row, defaultHosts(code, domain)));
    const step = steps.find((s) => s.step === "custom_domains");
    const done = step && (step.status === "done" || step.status === "manual");
    custom_domains = {
      configured: true,
      domain,
      message: done
        ? "Every address answers over https with its own certificate."
        : "Add these DNS records at the DNS provider for " + domain + ", then run the commands (signed in to Azure with the Keystone subscription). The custom_domains step checks every 15 minutes and finishes by itself.",
      dns: dnsRecords(bindings),
      commands: azCommands(bindings),
    };
  }
  return { database, registry, custom_domains };
}
