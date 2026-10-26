# Automatic provisioning

When a licensee pays through Stripe Checkout, or staff start a free trial for a licensee that has no copy yet, KS-Ops
sets up the licensee's own Keystone copy by itself. Staff follow it on `/ops/provisioning`. When a cancelled licensee's
data purge has run, a matching teardown can remove the copy, but only once the retention rules allow it.

Until the one-time setup below is done, nothing breaks: runs wait in **waiting for manual setup**, sales is emailed the
checklist once, and `scripts/provision-licensee.sh` still works by hand (see `PROVISIONING.md`).

## How it works

```
Stripe checkout.session.completed ─┐
Staff free trial (/ops/trials)  ───┼─> KS-Ops provisioning run (Postgres: provisioning_runs / _steps / _logs)
Staff "Start" on /ops/provisioning ┘          │
                                              │ twilio_account   the licensee's Twilio sub-account (API key, dialler app, Verify service)
                                              │ twilio_address   its business address in Twilio
                                              │ 1. starts the GitHub Actions workflow in KS-Ops (one API call)
                                              v
                 KS-Ops workflow provision-licensee.yml  (GitHub environment ks-ops-provisioning)
                 Azure sign-in with a federated credential: no Azure secret is stored anywhere
                   azure_resources      scripts/provision-licensee.sh <code> canadacentral, DEPLOY_IDENTITY=1
                   twilio_settings      Twilio settings from KS-Ops (one-off token, masked) -> the KS-server app settings
                   secrets              checks every generated key is stored on the two web apps
                   github_environments  ks-<code> in KS-server, KS-Agent, KS-Portal, KS-Client (secrets + variables)
                   deploy_registry      pull request to deploy/licensees.json in each, merged when CI passes
                   deploy               runs each repository's deploy workflow for this licensee and waits
                 each step is reported back to KS-Ops with the run's one-off token
                                              v
                 KS-Ops (service steps)
                   health               server, assistant, portal and client answer
                   configure            status provisioning -> active (or trial), plan + branding + flags pushed
                   admin_user           POST /api/provision/admin on the new KS-server
                   welcome_email        sign-in link emailed to the contact
                   twilio_voice         the dialler app's voice URL -> the new server
                   twilio_bundle        a regulatory bundle only if Twilio's rules ask for one (waits for approval)
                   phone_numbers        POST /api/provision/phone-numbers: business line (+ toll-free on Growth/Pro) via Twilio
                   texting_registration toll-free verification; US A2P 10DLC for a US line (status followed every 2 h)
```

Why this design:

- **KS-Ops never holds an Azure credential.** KS-Ops is a public web service (sign-ups, webhooks). The power to create
  resources lives only in a GitHub Actions job that runs the fixed workflow on `main`, signs in to Azure with OIDC
  (federated credential, no client secret), and can be required to run in a protected GitHub environment.
- **KS-Ops's own GitHub credential is tiny**: Actions read and write on the KS-Ops repository only, to start that
  workflow. The token that writes to the four app repositories exists only inside the workflow.
- **Secrets never pass through KS-Ops or its database.** The database password, JWT secrets and encryption keys are
  made by the script and stored straight into the App Service settings; the Static Web Apps tokens go straight into the
  GitHub environments (through `gh secret set`, via stdin, masked in the log). KS-Ops stores only the licensee's ops
  key, encrypted, as before.
- **The licensee's deploy workflows sign in with a per-licensee managed identity** (`ks-<code>-deploy`, Website
  Contributor on `ks-<code>` only) through a federated credential for the `ks-<code>` environment. No
  `AZURE_CREDENTIALS` JSON is ever made.
- **Every step is idempotent and resumable.** Each step's status, attempts, error and output are stored; a run picks up
  at the first unfinished step. "Retry step" and "Mark done manually" are on the page.

### What each run records

`provisioning_runs` (status `waiting_for_setup`, `running`, `blocked`, `failed`, `done`, `cancelled`),
`provisioning_steps` (per step `pending`, `running`, `done`, `failed`, `blocked`, `manual`, with attempts, error and
output) and `provisioning_logs`. A failed step emails `KS_SALES_EMAIL` once (again after each retry that fails).

### The website

Stripe's success page now carries `p=<token>`. The thank-you page polls `GET /api/public/provisioning/<token>` and shows
"We're setting up your system" with progress, then the sign-in button for the staff portal and "an email is on its way".
The token is opaque: the licensee id plus a 128-bit MAC made with `OPS_ENCRYPTION_KEY`; it reveals only progress
labels and, once ready, the public portal address.

### Twilio (KS_OPS_TWILIO_AUTO_v1)

- **Sub-account**: "Keystone - <company> (<code>)" under `KS_TWILIO_ACCOUNT_SID`. Its auth token and API key secret
  are stored encrypted (`licensee_twilio`, `OPS_ENCRYPTION_KEY`). Found again by name if the row is ever lost.
- **Settings on the licensee's KS-server** (written by the workflow's `twilio_settings` step, which fetches them from
  `POST /api/provisioning/callback/<run>/twilio-settings` while that step runs): `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_VOICE_APP_SID`, `TWILIO_VERIFY_SERVICE_SID`,
  `TWILIO_ADDRESS_SID`, `KS_SERVER_URL`. The bundle id (when there is one) goes with the phone-numbers request.
- **Texting**: toll-free verification for the toll-free line (Messaging API); for a US business line, A2P 10DLC through
  the ISV flow (secondary customer profile and A2P trust product in the sub-account, with Keystone's primary profile
  `KS_TWILIO_ISV_PROFILE_SID` attached; brand; messaging service; campaign once the brand is approved). Canadian local
  lines need no registration to text Canadian mobiles. Opt-in proof: `GET /api/public/texting-opt-in/<code>` (the client
  app's "Text me updates" box and wording). Status (needs_info, pending, approved, rejected with the reason) is kept in
  `texting_registrations`, checked every 2 hours, shown on `/ops/provisioning` and pushed to the licensee's KS-server
  (`PUT /api/provision/texting`). Staff: `GET /api/ops/provisioning/twilio/:licenseeId`,
  `POST /api/ops/provisioning/twilio/:licenseeId/texting/resubmit`.
- **Lifecycle** (worker, every 30 minutes): suspended licensee -> sub-account suspended; back to trial/active/past_due ->
  reactivated; cancelled -> kept active 31 days (KS-server releases the numbers after its 30-day grace), then suspended;
  closed only after the 180-day retention period and 7 days after sales is emailed that it will be. Every change is
  audited (`licensee.twilio_*`); a failure is logged with Twilio's code and tried again.

### Teardown

When the cancellation purge is marked done (KS-server reports it, or staff press "Mark purged"), and
`KS_TEARDOWN_ENABLED=true`, a teardown run starts:

1. `retention_gate` (KS-Ops): refuses unless the licensee is cancelled, purged, and its own KS-server's
   `GET /api/provision/teardown-check` says `deletable` (KS-server v14 retention: no `retention_archive` left, no open
   legal holds, nothing still inside its 7 years). A server that cannot be asked means no teardown. Re-checked daily;
   the run shows **blocked** with the reason (for example "kept until 2033-04-01").
2. `deploy_registry_remove`, `github_environments_remove`, `azure_delete` (workflow `teardown-licensee.yml`, GitHub
   environment `ks-ops-teardown`). Only a resource group tagged `keystone-licensee=<code>` is ever deleted.
3. `finish`: audited as `licensee.torn_down`.

### Dry run

- `npm run provision:plan -- <code> [provision|teardown] [region]` prints every change, calls nothing.
- On `/ops/provisioning`, tick **Dry run**: the run logs what each step would do. When GitHub is configured, the
  workflow also runs with `dry_run=true` and only prints its plan (no Azure sign-in, no GitHub writes).

## What Todd sets up once

### 1. Azure: an app registration for provisioning, with federated credentials

In the Azure portal: Microsoft Entra ID > App registrations > New registration, name `keystone-provisioning`.
Single tenant. No redirect URI. **Do not create a client secret.**

Certificates & secrets > Federated credentials > Add credential > "GitHub Actions deploying Azure resources", twice:

| Name | Organization | Repository | Entity type | Environment |
| --- | --- | --- | --- | --- |
| `ks-ops-provisioning` | `werb210` | `KS-Ops` | Environment | `ks-ops-provisioning` |
| `ks-ops-teardown` | `werb210` | `KS-Ops` | Environment | `ks-ops-teardown` |

(Subjects `repo:werb210/KS-Ops:environment:ks-ops-provisioning` and `...:ks-ops-teardown`, issuer
`https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`.)

### 2. Azure: roles and scope

On the Keystone subscription (Subscriptions > the subscription > Access control (IAM) > Add role assignment), for the
`keystone-provisioning` app:

| Role | Scope | Why |
| --- | --- | --- |
| Contributor | the Keystone subscription | create resource groups `ks-<code>`, Postgres, App Service, Static Web Apps, the managed identity and its federated credentials; delete `ks-<code>` on teardown |
| Role Based Access Control Administrator, **with a condition**: may only assign the role *Website Contributor* | the Keystone subscription | give each licensee's deploy identity Website Contributor on its own resource group |

The condition keeps the provisioning app from granting itself or anyone else broader rights. (Portal: "Allow user to
only assign selected roles to selected principals (fewer privileges)" > Website Contributor.) Use a dedicated
subscription for licensees if you can, so this app has no rights over Boreal's other resources.

No Entra ID (Graph) permission is needed: deploy identities are managed identities, not app registrations.

### 3. GitHub: an app (or token) for the four app repositories

Preferred, a GitHub App owned by `werb210`: Settings > Developer settings > GitHub Apps > New GitHub App, name
`keystone-provisioning`, no webhook. Repository permissions:

| Permission | Access | For |
| --- | --- | --- |
| Administration | Read and write | create and delete the `ks-<code>` environments |
| Environments | Read and write | environment secrets and variables |
| Contents | Read and write | the `deploy/licensees.json` branch and commit, and the merge |
| Pull requests | Read and write | open and merge the registry pull request |
| Actions | Read and write | start the deploy workflows and read their jobs; start the KS-Ops workflows |
| Checks | Read | wait for CI on the registry pull request |
| Metadata | Read | required |

Install it on `KS-Ops`, `KS-server`, `KS-Agent`, `KS-Portal` and `KS-Client` only. Generate a private key.

Alternative: a fine-grained personal access token with the same permissions on the same five repositories (it expires,
so set a reminder).

If branch protection on `main` requires reviews, either let the app bypass it (Settings > Rules > bypass list) or the
registry step will wait and fail; then merge the pull request by hand and press "Mark done manually".

### 4. GitHub: the KS-Ops environments

In KS-Ops: Settings > Environments > New environment `ks-ops-provisioning`, then again `ks-ops-teardown`. In each:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `AZURE_CLIENT_ID` | the `keystone-provisioning` app's Application (client) ID |
| Variable | `AZURE_TENANT_ID` | Directory (tenant) ID |
| Variable | `AZURE_SUBSCRIPTION_ID` | the Keystone subscription ID |
| Variable | `KS_PROVISION_APP_ID` | the GitHub App's App ID |
| Secret | `KS_PROVISION_APP_PRIVATE_KEY` | the GitHub App's private key (.pem contents) |
| Secret | `KS_PROVISION_GH_TOKEN` | only if you use a token instead of the app |
| Secret | `OPENAI_API_KEY` | `ks-ops-provisioning` only: written to each licensee's KS-server and KS-Agent (KS-server will not start without one) |

Recommended: on `ks-ops-teardown`, tick **Required reviewers** and add yourself, so every deletion waits for a person.
Optionally limit both environments to the `main` branch (Deployment branches and tags > Selected branches > `main`).

### 5. KS-Ops app settings (the `ks-ops` App Service)

| Setting | Value |
| --- | --- |
| `KS_PROVISION_GITHUB_TOKEN` | fine-grained token with **Actions: read and write on KS-Ops only** (or use the three below) |
| `KS_PROVISION_GITHUB_APP_ID`, `KS_PROVISION_GITHUB_APP_PRIVATE_KEY` | the same GitHub App; KS-Ops makes a one-hour token limited to KS-Ops and `actions: write` |
| `KS_PROVISION_GITHUB_INSTALLATION_ID` | optional (looked up when empty) |
| `KS_OPS_PUBLIC_URL` | `https://<ks-ops host>`: the workflow reports here (falls back to Azure's `WEBSITE_HOSTNAME`) |
| `OPS_ENCRYPTION_KEY` | already set (ops keys and the status-page token need it) |
| `KS_AUTO_PROVISION` | optional; `off` stops runs starting on payment or trial (staff can still start them) |
| `KS_TEARDOWN_ENABLED` | `true` to allow teardown runs (off by default) |
| `KS_PROVISION_GITHUB_REPO`, `KS_PROVISION_GITHUB_REF` | optional; default `werb210/KS-Ops` and `main` |

Also make sure `OPS_ALLOWED_SERVER_HOST_SUFFIXES` covers the licensee hosts (the default `.azurewebsites.net,
.azurestaticapps.net` does): the addresses the workflow reports are only saved when they match.

### 6. Check it

1. `/ops/provisioning` shows no "Waiting for manual setup" box.
2. Start a **dry run** for any licensee: the KS-Ops Actions tab shows "Provision <code> (dry run)", and the run's log
   lists every step as "would: ...".
3. The first real licensee: watch the run; the log links the registry pull requests and deploy jobs.

## What still needs a person

- **Custom domains and DNS** (`portal.<their-domain>`, `apply.<their-domain>`): the copy runs on its
  `*.azurewebsites.net` / `*.azurestaticapps.net` addresses until a domain is added to the Static Web Apps and App
  Service, and the addresses are updated on the licensee and in the `ks-<code>` environment variables.
- **App store builds per licensee** (branded iPhone, iPad and Android apps): KS-Client's "Build licensee apps" workflow
  and its own environment (`docs/LICENSEE_APPS.md` in KS-Client), plus the store listings.
- **Twilio**: nothing per licensee (KS_OPS_TWILIO_AUTO_v1). Todd's one-time Keystone setup (paid master account, its
  keys on KS-Ops, the ISV profile in Trust Hub) is in `PROVISIONING.md`. The carriers' review of texting registrations
  takes days; KS-Ops follows it by itself.
- **The licensee's own Microsoft 365 / Google Workspace and QuickBooks apps** (`VITE_MSAL_*`, `QBO_*`): off until set.
- **Email sending from their domain** and any SPF/DKIM records.
- A step that keeps failing: read the log, fix the cause, then **Retry step**, or do it by hand and **Mark done
  manually** (with a note).
