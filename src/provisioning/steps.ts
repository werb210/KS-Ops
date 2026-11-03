// KS_OPS_AUTO_PROVISION_v1 - the steps of a licensee's automatic setup and teardown, and the names everything gets.
// KS_SHARED_HOSTING_v1 - every brokerage now runs on the one shared server (resource group ks-shared) with its own
// database ks_<code> on ks-shared-pg and its row in the registry (ks_tenants). Nothing is created in Azure per
// brokerage: KS-Ops makes the database and role, writes the registry (its encrypted env holds what used to be the
// brokerage's own App Service settings), and asks the shared server to reload and migrate.
//
// "workflow" steps run in the KS-Ops GitHub Actions workflow (.github/workflows/provision-licensee.yml or
// teardown-licensee.yml), which holds the cross-repository GitHub token; it reports each step back to KS-Ops. They now
// only touch KS-Portal and KS-Client (their web builds are still made per brokerage). "service" steps run here in
// KS-Ops. Every step is safe to run again.
import { defaultHosts, SHARED } from "../tenants/config.js";
import { azCommands, bindingsFor } from "../tenants/domains.js";

export type RunKind = "provision" | "teardown";
export type StepWhere = "workflow" | "service";
export type StepDef = { key: string; where: StepWhere; label: string; publicLabel: string };

export const PROVISION_STEPS: readonly StepDef[] = [
  // KS_OPS_TWILIO_AUTO_v1 - first, so the brokerage's env has its Twilio settings before the shared server serves it
  // (sign-in codes need the Verify service). Bundles and texting come after the sign-in email.
  { key: "twilio_account", where: "service", label: "Create the licensee's Twilio sub-account (API key, dialler app, sign-in code service)", publicLabel: "Setting up your phone system" },
  { key: "twilio_address", where: "service", label: "Register the business address in the Twilio sub-account", publicLabel: "Setting up your phone system" },
  { key: "database", where: "service", label: "Create the brokerage's own database and login role on the shared Postgres server", publicLabel: "Creating your database" },
  { key: "tenant_registry", where: "service", label: "Write the brokerage's registry entry: its addresses and its own secrets and settings (encrypted)", publicLabel: "Securing your system" },
  { key: "twilio_settings", where: "service", label: "Add the Twilio settings (sub-account, API key, dialler app, sign-in codes, address) to the brokerage's settings", publicLabel: "Securing your system" },
  // KS_OPS_WORKSPACE_APPS - Keystone's one Microsoft 365 app and one Google client: no per-brokerage registration.
  { key: "workspace_apps", where: "service", label: "Add Keystone's Microsoft 365 and Google Workspace app keys (and the sign-in redirect address) to the brokerage's settings", publicLabel: "Securing your system" },
  { key: "shared_server", where: "service", label: "Ask the shared server to load the new brokerage and set up its database tables", publicLabel: "Installing Keystone" },
  { key: "github_environments", where: "workflow", label: "Create the GitHub environment ks-<code> in KS-Portal and KS-Client (the web build settings)", publicLabel: "Preparing your apps" },
  { key: "deploy_registry", where: "workflow", label: "Add the brokerage to deploy/licensees.json in KS-Portal and KS-Client (pull request, merged when CI passes)", publicLabel: "Preparing your apps" },
  { key: "deploy", where: "workflow", label: "Build and publish the brokerage's staff portal and client app", publicLabel: "Installing Keystone" },
  { key: "custom_domains", where: "service", label: "Add the brokerage's addresses as custom domains (with free certificates) on the shared server and web host", publicLabel: "Checking everything is running" },
  { key: "health", where: "service", label: "Wait until the server, assistant, staff portal and client app answer", publicLabel: "Checking everything is running" },
  { key: "configure", where: "service", label: "Push the plan, branding and feature flags, and set the status", publicLabel: "Applying your plan and branding" },
  { key: "admin_user", where: "service", label: "Create the licensee's admin user on the shared server", publicLabel: "Creating your admin account" },
  { key: "welcome_email", where: "service", label: "Email the admin their sign-in link", publicLabel: "Sending your sign-in details" },
  // KS_OPS_PHONE_PROVISIONING - last, so a number that cannot be bought yet never holds up the sign-in email.
  { key: "twilio_voice", where: "service", label: "Point the dialler's Twilio app at the brokerage's server address", publicLabel: "Setting up your phone lines" },
  { key: "twilio_bundle", where: "service", label: "Regulatory bundle for buying numbers, when Twilio's rules ask for one (waits for Twilio's approval)", publicLabel: "Setting up your phone lines" },
  { key: "phone_numbers", where: "service", label: "Buy the business line (and the toll-free line on Growth and Pro) in the licensee's Twilio account, pointed at their server address", publicLabel: "Setting up your phone lines" },
  { key: "texting_registration", where: "service", label: "Submit texting registration: toll-free verification, and US A2P 10DLC for a US business line (carriers approve later)", publicLabel: "Setting up your phone lines" },
];

export const TEARDOWN_STEPS: readonly StepDef[] = [
  { key: "retention_gate", where: "service", label: "Check the retention rules allow it (cancelled, purged, no records still kept, no legal holds)", publicLabel: "" },
  { key: "deploy_registry_remove", where: "workflow", label: "Remove the brokerage from deploy/licensees.json in KS-Portal and KS-Client", publicLabel: "" },
  { key: "github_environments_remove", where: "workflow", label: "Delete the GitHub environment ks-<code> in KS-Portal and KS-Client", publicLabel: "" },
  { key: "database_drop", where: "service", label: "Delete the brokerage's database and its login role on the shared Postgres server", publicLabel: "" },
  { key: "sites_delete", where: "service", label: "Delete the brokerage's published staff portal and client app (blob folder sites/<code>/)", publicLabel: "" },
  { key: "tenant_delete", where: "service", label: "Delete the brokerage's registry entry and tell the shared server", publicLabel: "" },
  { key: "finish", where: "service", label: "Record the teardown", publicLabel: "" },
];

export function stepsFor(kind: RunKind): readonly StepDef[] {
  return kind === "teardown" ? TEARDOWN_STEPS : PROVISION_STEPS;
}

export function stepDef(kind: RunKind, key: string): StepDef | undefined {
  return stepsFor(kind).find((s) => s.key === key);
}

export const WORKFLOW_FILES: Record<RunKind, string> = {
  provision: "provision-licensee.yml",
  teardown: "teardown-licensee.yml",
};

export const DEFAULT_REGION: string = SHARED.region;

/** The web app repositories still built per brokerage, and the deploy workflow each one runs for one brokerage.
 *  KS-server and KS-Agent are one shared deploy each (no per-brokerage environment or registry entry). */
export const APP_REPOS = [
  { app: "portal", repo: "KS-Portal", workflow: "deploy.yml" },
  { app: "client", repo: "KS-Client", workflow: "azure-static-web-apps.yml" },
] as const;

/** Names used for one brokerage in the shared layout. */
export function resourceNames(code: string) {
  // Not checked here (the plan is shown for any code); the database step refuses a code the registry cannot hold.
  const database = `ks_${code.replace(/-/g, "_")}`;
  const role = `${database}_app`;
  return {
    resourceGroup: SHARED.resourceGroup,
    postgres: SHARED.postgres,
    database,
    role,
    serverApp: SHARED.serverApp,
    agentApp: SHARED.agentApp,
    webApp: SHARED.webApp,
    sitesPrefix: `${code}/`,
    environment: `ks-${code}`,
  };
}

/** The deploy/licensees.json entry, the same line in KS-Portal and KS-Client: the brokerages whose web builds are published. */
export function registryEntry(code: string) {
  return { code, environment: `ks-${code}`, enabled: true, apps: ["portal", "client"] };
}

/** What each GitHub environment holds (names only). The blob upload secret is repository-level, not per brokerage. */
export const ENVIRONMENT_SETTINGS: Record<string, { secrets: string[]; variables: string[] }> = {
  "KS-Portal": {
    secrets: [],
    variables: ["VITE_API_BASE_URL", "VITE_APP_URL", "VITE_CLIENT_APP_URL", "VITE_MSAL_REDIRECT_URI", "VITE_COMPANY_NAME", "VITE_ASSISTANT_NAME", "VITE_WEBSITE_URL"],
  },
  "KS-Client": {
    secrets: [],
    variables: ["VITE_API_BASE_URL", "VITE_CLIENT_APP_URL", "VITE_COMPANY_NAME", "VITE_WEBSITE_URL"],
  },
};

/** The secrets generated once for each brokerage (kept on later runs), stored only in its encrypted env. */
export const GENERATED_SECRETS = [
  "JWT_SECRET", "JWT_REFRESH_SECRET", "OTP_HASH_SALT", "QBO_TOKEN_ENCRYPTION_KEY", "GOOGLE_TOKEN_ENCRYPTION_KEY",
  "WATCH_PUSH_ENCRYPTION_KEY", "LENDER_CREDENTIALS_ENCRYPTION_KEY",
] as const;

/** The non-secret per-brokerage values written by tenant_registry (plus KS_OPS_KEY and the secrets above). */
export const TENANT_SETTINGS = [
  "KS_LICENSEE_ID", "KS_OPS_KEY", "KS_OPS_URL", "KS_PLAN", "KS_SERVER_URL", "KS_PORTAL_URL", "KS_CLIENT_URL", "CLIENT_URL",
  "PUBLIC_BASE_URL", "PUBLIC_SERVER_URL", "MAYA_URL", "QBO_ENVIRONMENT",
] as const;

/**
 * The dry-run plan: every change a run would make, in order, as plain lines. Nothing is called. Used by
 * `npm run provision:plan -- <code>` and logged by dry-run runs.
 */
export function describePlan(kind: RunKind, code: string, _region: string = DEFAULT_REGION, domain = ""): string[] {
  const n = resourceNames(code);
  if (kind === "teardown") {
    return [
      `retention_gate: refuse unless the licensee is cancelled and its server's GET /api/provision/teardown-check says deletable (purged, no retention archive, no legal holds)`,
      ...APP_REPOS.map((r) => `deploy_registry_remove: ${r.repo} - pull request removing "${code}" from deploy/licensees.json, merged when CI passes`),
      ...APP_REPOS.map((r) => `github_environments_remove: ${r.repo} - delete environment ${n.environment}`),
      `database_drop: on ${n.postgres} (KS_SHARED_PG_ADMIN_URL): DROP DATABASE "${n.database}" WITH (FORCE), then DROP ROLE "${n.role}"`,
      `sites_delete: delete every blob under ${SHARED.sitesContainer}/${n.sitesPrefix} (KS_SITES_STORAGE_CONNECTION_STRING)`,
      `tenant_delete: DELETE FROM ks_tenants WHERE code = '${code}' (ks_control), then POST /api/ops/tenants/reload on the shared server`,
      "finish: audit licensee.torn_down",
    ];
  }
  const hosts = defaultHosts(code, domain);
  const hostLine = domain
    ? `api ${hosts.api.join(", ")}, portal ${hosts.portal.join(", ")}, client ${hosts.client.join(", ")}`
    : "no host names (KS_DOMAIN is not set)";
  return [
    "twilio_account: create (or find) the Twilio sub-account \"Keystone - <company> (" + code + ")\" under KS_TWILIO_ACCOUNT_SID, with an API key, the TwiML app \"Keystone dialler\" and a Verify service; credentials stored encrypted in licensee_twilio",
    "twilio_address: register the business address (legal name, street, city, province or state, postal code) in the sub-account (Addresses API)",
    `database: on ${n.postgres} (KS_SHARED_PG_ADMIN_URL): CREATE ROLE "${n.role}" LOGIN (random password), CREATE DATABASE "${n.database}", REVOKE ALL ON DATABASE FROM PUBLIC, GRANT CONNECT, TEMPORARY to "${n.role}" only, GRANT USAGE, CREATE ON SCHEMA public, CREATE EXTENSION IF NOT EXISTS vector; the connection string is stored encrypted in ks_tenants`,
    `tenant_registry: ks_tenants row "${code}": ${hostLine}; encrypted env with ${TENANT_SETTINGS.join(", ")} and the secrets made once and kept: ${GENERATED_SECRETS.join(", ")}`,
    "twilio_settings: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_VOICE_APP_SID, TWILIO_VERIFY_SERVICE_SID, TWILIO_ADDRESS_SID (and TWILIO_BUNDLE_SID once approved) to the brokerage's encrypted env",
    "workspace_apps: add KS_M365_CLIENT_ID, KS_M365_CLIENT_SECRET, KS_GOOGLE_OAUTH_CLIENT_ID, KS_GOOGLE_OAUTH_CLIENT_SECRET, KS_OAUTH_BROKER_URL and (when set) KS_GOOGLE_GMAIL_READ_ENABLED (Keystone's apps, from KS-Ops) to the brokerage's encrypted env; the brokerage's admin then connects Microsoft 365 in one click, and each person connects Google in one click",
    `shared_server: POST KS_SHARED_SERVER_URL/api/ops/tenants/reload, then /api/ops/tenants/${code}/migrate (X-KS-Ops-Service-Key)`,
    ...Object.entries(ENVIRONMENT_SETTINGS).map(([repo, s]) => `github_environments: ${repo} - environment ${n.environment}; variables: ${s.variables.join(", ")}`),
    ...APP_REPOS.map((r) => `deploy_registry: ${r.repo} - pull request adding ${JSON.stringify(registryEntry(code))} to deploy/licensees.json, merged when CI passes`),
    ...APP_REPOS.map((r) => `deploy: ${r.repo} - run ${r.workflow} on main with licensee=${code} (build, then upload dist/ to ${SHARED.sitesContainer}/${code}/${r.app}/), wait for job "deploy ${code}"`),
    domain
      ? `custom_domains: ${azCommands(bindingsFor(hosts)).length} az commands shown on /ops/provisioning (hostname add, managed certificate, SNI binding) for ${bindingsFor(hosts).map((b) => `${b.host} on ${b.app}`).join(", ")}; done once every host answers over https`
      : "custom_domains: skipped - KS_DOMAIN is not set, so the brokerage has no host names; the provisioning page says so",
    "health: GET the brokerage's server /health and the shared assistant /health, and the portal and client pages, until they answer",
    "configure: status provisioning -> trial (staff free trial) or active, then PUT /api/plan (plan, branding, add-ons, beta flags)",
    "admin_user: POST /api/provision/admin on the brokerage's server address (the contact's email and mobile, role Admin)",
    "welcome_email: email the contact the staff portal link, the company code and how to sign in",
    "twilio_voice: set the TwiML app's voice URL to <server>/api/webhooks/twilio/voice/twiml",
    "twilio_bundle: read Twilio's rules (Regulations API) for the licensee's country and number types; make and submit a regulatory bundle only when one is required, then wait for approval",
    "phone_numbers: POST /api/provision/phone-numbers on the brokerage's server address (area code from the contact's phone, province or state from the address): a local business line on every plan and a toll-free line on Growth and Pro, bought into the licensee's Twilio account with its voice and SMS webhooks set",
    "texting_registration: toll-free verification for the toll-free line; US A2P 10DLC (secondary customer profile, A2P trust product, brand, messaging service, campaign once the brand is approved) for a US business line; status checked every 2 hours and pushed to PUT /api/provision/texting",
  ];
}
