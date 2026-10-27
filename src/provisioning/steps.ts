// KS_OPS_AUTO_PROVISION_v1 - the steps of a licensee's automatic setup and teardown, and the names everything gets.
//
// "workflow" steps run in the KS-Ops GitHub Actions workflow (.github/workflows/provision-licensee.yml or
// teardown-licensee.yml), which holds the Azure federated credential and the cross-repository GitHub token; it reports
// each step back to KS-Ops. "service" steps run here in KS-Ops. Every step is safe to run again.

export type RunKind = "provision" | "teardown";
export type StepWhere = "workflow" | "service";
export type StepDef = { key: string; where: StepWhere; label: string; publicLabel: string };

export const PROVISION_STEPS: readonly StepDef[] = [
  // KS_OPS_TWILIO_AUTO_v1 - first, so the server is started with its Twilio settings (it refuses to start in production
  // without a Verify service, and sign-in codes need it). Bundles and texting come after the sign-in email.
  { key: "twilio_account", where: "service", label: "Create the licensee's Twilio sub-account (API key, dialler app, sign-in code service)", publicLabel: "Setting up your phone system" },
  { key: "twilio_address", where: "service", label: "Register the business address in the Twilio sub-account", publicLabel: "Setting up your phone system" },
  { key: "azure_resources", where: "workflow", label: "Create the Azure resources (resource group, Postgres, App Service, Static Web Apps, deploy identity)", publicLabel: "Creating your servers and database" },
  { key: "twilio_settings", where: "workflow", label: "Write the Twilio settings (sub-account, API key, dialler app, sign-in codes, address) to the licensee's KS-server", publicLabel: "Securing your system" },
  // KS_OPS_WORKSPACE_APPS - Keystone's one Microsoft 365 app and one Google client: no per-brokerage registration.
  { key: "workspace_apps", where: "workflow", label: "Write Keystone's Microsoft 365 and Google Workspace app keys (and the sign-in redirect address) to the licensee's KS-server", publicLabel: "Securing your system" },
  { key: "secrets", where: "workflow", label: "Generate the secrets (JWT, encryption and token keys) and check they are stored on the apps", publicLabel: "Securing your system" },
  { key: "github_environments", where: "workflow", label: "Create the GitHub environment ks-<code> in KS-server, KS-Agent, KS-Portal and KS-Client", publicLabel: "Preparing your apps" },
  { key: "deploy_registry", where: "workflow", label: "Add the licensee to deploy/licensees.json in the four app repositories (pull request, merged when CI passes)", publicLabel: "Preparing your apps" },
  { key: "deploy", where: "workflow", label: "Run the four deploy workflows for this licensee", publicLabel: "Installing Keystone" },
  { key: "health", where: "service", label: "Wait until the server, assistant, staff portal and client app answer", publicLabel: "Checking everything is running" },
  { key: "configure", where: "service", label: "Push the plan, branding and feature flags, and set the status", publicLabel: "Applying your plan and branding" },
  { key: "admin_user", where: "service", label: "Create the licensee's admin user on their KS-server", publicLabel: "Creating your admin account" },
  { key: "welcome_email", where: "service", label: "Email the admin their sign-in link", publicLabel: "Sending your sign-in details" },
  // KS_OPS_PHONE_PROVISIONING - last, so a number that cannot be bought yet never holds up the sign-in email.
  { key: "twilio_voice", where: "service", label: "Point the dialler's Twilio app at the licensee's KS-server", publicLabel: "Setting up your phone lines" },
  { key: "twilio_bundle", where: "service", label: "Regulatory bundle for buying numbers, when Twilio's rules ask for one (waits for Twilio's approval)", publicLabel: "Setting up your phone lines" },
  { key: "phone_numbers", where: "service", label: "Buy the business line (and the toll-free line on Growth and Pro) in the licensee's Twilio account, pointed at their KS-server", publicLabel: "Setting up your phone lines" },
  { key: "texting_registration", where: "service", label: "Submit texting registration: toll-free verification, and US A2P 10DLC for a US business line (carriers approve later)", publicLabel: "Setting up your phone lines" },
];

export const TEARDOWN_STEPS: readonly StepDef[] = [
  { key: "retention_gate", where: "service", label: "Check the retention rules allow it (cancelled, purged, no records still kept, no legal holds)", publicLabel: "" },
  { key: "deploy_registry_remove", where: "workflow", label: "Remove the licensee from deploy/licensees.json in the four app repositories", publicLabel: "" },
  { key: "github_environments_remove", where: "workflow", label: "Delete the GitHub environment ks-<code> in the four app repositories", publicLabel: "" },
  { key: "azure_delete", where: "workflow", label: "Delete the Azure resource group ks-<code> and everything in it", publicLabel: "" },
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

export const DEFAULT_REGION = "canadacentral";

/** The four app repositories and the deploy workflow file each one runs per licensee. */
export const APP_REPOS = [
  { app: "server", repo: "KS-server", workflow: "deploy.yml" },
  { app: "agent", repo: "KS-Agent", workflow: "deploy.yml" },
  { app: "portal", repo: "KS-Portal", workflow: "deploy.yml" },
  { app: "client", repo: "KS-Client", workflow: "azure-static-web-apps.yml" },
] as const;

/** Names used for one licensee; the same as scripts/provision-licensee.sh. */
export function resourceNames(code: string) {
  return {
    resourceGroup: `ks-${code}`,
    plan: `ks-${code}-plan`,
    postgres: `ks-${code}-pg`,
    database: "ks",
    serverApp: `ks-${code}-server`,
    agentApp: `ks-${code}-agent`,
    portalSwa: `ks-${code}-portal`,
    clientSwa: `ks-${code}-client`,
    deployIdentity: `ks-${code}-deploy`,
    environment: `ks-${code}`,
  };
}

/** The deploy/licensees.json entry, the same line in all four repositories. */
export function registryEntry(code: string) {
  return { code, environment: `ks-${code}`, enabled: true, apps: ["server", "agent", "portal", "client"] };
}

/** What each GitHub environment holds (names only; values are written by the workflow and never leave it). */
export const ENVIRONMENT_SETTINGS: Record<string, { secrets: string[]; variables: string[] }> = {
  "KS-server": { secrets: [], variables: ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_WEBAPP_NAME"] },
  "KS-Agent": { secrets: [], variables: ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_WEBAPP_NAME"] },
  "KS-Portal": {
    secrets: ["AZURE_STATIC_WEB_APPS_API_TOKEN"],
    variables: ["VITE_API_BASE_URL", "VITE_APP_URL", "VITE_CLIENT_APP_URL", "VITE_MSAL_REDIRECT_URI", "VITE_COMPANY_NAME", "VITE_ASSISTANT_NAME", "VITE_WEBSITE_URL"],
  },
  "KS-Client": {
    secrets: ["AZURE_STATIC_WEB_APPS_API_TOKEN"],
    variables: ["VITE_API_BASE_URL", "VITE_CLIENT_APP_URL", "VITE_COMPANY_NAME", "VITE_WEBSITE_URL"],
  },
};

/** The secrets generated once on the licensee's KS-server (and kept on later runs), and on KS-Agent. */
export const GENERATED_SERVER_SECRETS = [
  "DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET", "OTP_HASH_SALT", "QBO_TOKEN_ENCRYPTION_KEY",
  "GOOGLE_TOKEN_ENCRYPTION_KEY", "WATCH_PUSH_ENCRYPTION_KEY", "KS_OPS_KEY",
] as const;
export const GENERATED_AGENT_SECRETS = ["JWT_SECRET"] as const;

/**
 * The dry-run plan: every change a run would make, in order, as plain lines. Nothing is called. Used by
 * `npm run provision:plan -- <code>` and logged by dry-run runs.
 */
export function describePlan(kind: RunKind, code: string, region = DEFAULT_REGION): string[] {
  const n = resourceNames(code);
  if (kind === "teardown") {
    return [
      `retention_gate: refuse unless the licensee is cancelled and its KS-server's GET /api/provision/teardown-check says deletable (purged, no retention archive, no legal holds)`,
      ...APP_REPOS.map((r) => `deploy_registry_remove: ${r.repo} - pull request removing "${code}" from deploy/licensees.json, merged when CI passes`),
      ...APP_REPOS.map((r) => `github_environments_remove: ${r.repo} - delete environment ${n.environment}`),
      `azure_delete: az group delete -n ${n.resourceGroup} (Postgres ${n.postgres}, apps ${n.serverApp} / ${n.agentApp}, Static Web Apps ${n.portalSwa} / ${n.clientSwa}, identity ${n.deployIdentity})`,
      "finish: audit licensee.torn_down",
    ];
  }
  return [
    "twilio_account: create (or find) the Twilio sub-account \"Keystone - <company> (" + code + ")\" under KS_TWILIO_ACCOUNT_SID, with an API key, the TwiML app \"Keystone dialler\" and a Verify service; credentials stored encrypted in licensee_twilio",
    "twilio_address: register the business address (legal name, street, city, province or state, postal code) in the sub-account (Addresses API)",
    `azure_resources: scripts/provision-licensee.sh ${code} ${region} with DEPLOY_IDENTITY=1 - resource group ${n.resourceGroup} (${region}), ` +
      `Postgres flexible server ${n.postgres} database ${n.database}, App Service plan ${n.plan}, web apps ${n.serverApp} and ${n.agentApp}, ` +
      `Static Web Apps ${n.portalSwa} and ${n.clientSwa}, Postgres firewall for the apps' outbound addresses, ` +
      `managed identity ${n.deployIdentity} (Website Contributor on ${n.resourceGroup}) with federated credentials for the ${n.environment} environments of KS-server and KS-Agent`,
    `twilio_settings: write TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_VOICE_APP_SID, TWILIO_VERIFY_SERVICE_SID, TWILIO_ADDRESS_SID and KS_SERVER_URL to ${n.serverApp}`,
    `workspace_apps: write KS_M365_CLIENT_ID, KS_M365_CLIENT_SECRET, KS_GOOGLE_OAUTH_CLIENT_ID, KS_GOOGLE_OAUTH_CLIENT_SECRET and KS_OAUTH_BROKER_URL (Keystone's apps, from KS-Ops) to ${n.serverApp}; the brokerage's admin then connects Microsoft 365 in one click, and each person connects Google in one click`,
    `secrets: generated once and kept on ${n.serverApp}: ${GENERATED_SERVER_SECRETS.join(", ")}; on ${n.agentApp}: ${GENERATED_AGENT_SECRETS.join(", ")} (the ops key comes from KS-Ops)`,
    ...Object.entries(ENVIRONMENT_SETTINGS).map(
      ([repo, s]) => `github_environments: ${repo} - environment ${n.environment}; secrets: ${s.secrets.join(", ") || "none"}; variables: ${s.variables.join(", ")}`,
    ),
    ...APP_REPOS.map((r) => `deploy_registry: ${r.repo} - pull request adding ${JSON.stringify(registryEntry(code))} to deploy/licensees.json, merged when CI passes`),
    ...APP_REPOS.map((r) => `deploy: ${r.repo} - run ${r.workflow} on main with licensee=${code}, wait for job "deploy ${code}"`),
    `health: GET ${n.serverApp} /health and ${n.agentApp} /health, and the portal and client pages, until they answer`,
    "configure: status provisioning -> trial (staff free trial) or active, then PUT /api/plan (plan, branding, add-ons, beta flags)",
    "admin_user: POST /api/provision/admin on the new KS-server (the contact's email and mobile, role Admin)",
    "welcome_email: email the contact the staff portal link, the company code and how to sign in",
    "twilio_voice: set the TwiML app's voice URL to <server>/api/webhooks/twilio/voice/twiml",
    "twilio_bundle: read Twilio's rules (Regulations API) for the licensee's country and number types; make and submit a regulatory bundle only when one is required, then wait for approval",
    "phone_numbers: POST /api/provision/phone-numbers on the new KS-server (area code from the contact's phone, province or state from the address): a local business line on every plan and a toll-free line on Growth and Pro, bought into the licensee's Twilio account with its voice and SMS webhooks set",
    "texting_registration: toll-free verification for the toll-free line; US A2P 10DLC (secondary customer profile, A2P trust product, brand, messaging service, campaign once the brand is approved) for a US business line; status checked every 2 hours and pushed to PUT /api/provision/texting",
  ];
}
