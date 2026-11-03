# Automatic provisioning

When a licensee pays through Stripe Checkout, or staff start a free trial for a licensee that has no copy yet, KS-Ops
sets the brokerage up on the shared Keystone server by itself. Staff follow it on `/ops/provisioning`. When a cancelled
licensee's data purge has run, a matching teardown removes its database, published apps and registry entry, but only
once the retention rules allow it.

> **KS_SHARED_HOSTING_v1 (2026-11-03).** Brokerages no longer get their own Azure resources: they share
> `ks-shared-server`, `ks-shared-agent` and `ks-shared-web`, each with its own database on `ks-shared-pg`. The layout,
> the one-time script (`scripts/provision-shared.sh`), every setting and the per-brokerage steps are in
> [PROVISIONING.md](PROVISIONING.md). This page covers the run mechanics and the GitHub side.

Until the one-time setup is done, nothing breaks: runs wait in **waiting for manual setup** and sales is emailed the
checklist once.

## How it works

```
Stripe checkout.session.completed ─┐
Staff free trial (/ops/trials)  ───┼─> KS-Ops provisioning run (Postgres: provisioning_runs / _steps / _logs)
Staff "Start" on /ops/provisioning ┘          │
                                              │ twilio_account   the licensee's Twilio sub-account (API key, dialler app, Verify service)
                                              │ twilio_address   its business address in Twilio
                                              │ database         ks_<code> + role ks_<code>_app on ks-shared-pg (KS_SHARED_PG_ADMIN_URL)
                                              │ tenant_registry  its ks_tenants row: host names, encrypted settings (secrets, ops key, addresses)
                                              │ twilio_settings  the Twilio values -> the same encrypted settings
                                              │ workspace_apps   Keystone's Microsoft 365 / Google keys -> the same encrypted settings
                                              │ shared_server    POST /api/ops/tenants/reload and /api/ops/tenants/<code>/migrate
                                              │ 1. starts the GitHub Actions workflow in KS-Ops (one API call)
                                              v
                 KS-Ops workflow provision-licensee.yml  (GitHub environment ks-ops-provisioning; no Azure sign-in)
                   github_environments  ks-<code> in KS-Portal and KS-Client (VITE_* variables)
                   deploy_registry      pull request to deploy/licensees.json in each, merged when CI passes
                   deploy               runs each repository's deploy workflow for this brokerage (build, upload to sites/<code>/)
                 each step is reported back to KS-Ops with the run's one-off token
                                              v
                 KS-Ops (service steps)
                   custom_domains       DNS records + az commands on the page; done when every address answers over https
                   health               server, assistant, portal and client answer
                   configure            status provisioning -> active (or trial), plan + branding + flags pushed
                   admin_user           POST /api/provision/admin on the brokerage's address
                   welcome_email        sign-in link emailed to the contact
                   twilio_voice         the dialler app's voice URL -> the brokerage's address
                   twilio_bundle        a regulatory bundle only if Twilio's rules ask for one (waits for approval)
                   phone_numbers        POST /api/provision/phone-numbers: business line (+ toll-free on Growth/Pro) via Twilio
                   texting_registration toll-free verification; US A2P 10DLC for a US line (status followed every 2 h)
```

Why this design:

- **KS-Ops never holds an Azure credential.** KS-Ops is a public web service (sign-ups, webhooks). It holds a Postgres
  admin login for `ks-shared-pg` (to make each brokerage's database and role) and the registry owner login, nothing
  that can change Azure resources. The shared resources are made once by a person (`scripts/provision-shared.sh`), and
  custom domains are bound by a person from the commands on the page.
- **KS-Ops's own GitHub credential is tiny**: Actions read and write on the KS-Ops repository only, to start that
  workflow. The token that writes to KS-Portal and KS-Client exists only inside the workflow.
- **Secrets are made in KS-Ops and stored only encrypted**: the database password, JWT secrets and encryption keys go
  straight into the brokerage's registry entry (`ks_tenants`, AES-256-GCM with `KS_TENANT_KEY`), never into KS-Ops's own
  database, a log, a step output or the workflow. The workflow gets no secret at all.
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
- **Settings for the brokerage** (written by the `twilio_settings` step into its encrypted registry settings):
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_VOICE_APP_SID`,
  `TWILIO_VERIFY_SERVICE_SID`, `TWILIO_ADDRESS_SID`, `KS_SERVER_URL`. The bundle id (when there is one) goes with the
  phone-numbers request.
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
2. `deploy_registry_remove`, `github_environments_remove` (workflow `teardown-licensee.yml`, GitHub environment
   `ks-ops-teardown`): KS-Portal and KS-Client only.
3. `database_drop`, `sites_delete`, `tenant_delete` (KS-Ops): the database `ks_<code>` and role `ks_<code>_app`, the
   blobs under `sites/<code>/`, and the `ks_tenants` row (then the shared server reloads). See PROVISIONING.md.
4. `finish`: audited as `licensee.torn_down`.

### Dry run

- `npm run provision:plan -- <code> [provision|teardown] [region]` prints every change, calls nothing.
- On `/ops/provisioning`, tick **Dry run**: the run logs what each step would do. When GitHub is configured, the
  workflow also runs with `dry_run=true` and only prints its plan (no Azure sign-in, no GitHub writes).

## What Todd sets up once

The shared Azure resources and every KS-Ops setting for them: [PROVISIONING.md](PROVISIONING.md), "What Todd sets up
once". The GitHub side, for the KS-Portal and KS-Client steps:

The `keystone-provisioning` Azure app registration, its federated credentials and its roles (sections 1 and 2 of the
earlier version of this page) are no longer used by provisioning; they can be deleted once no brokerage is left on the
old layout.

### 1. GitHub: an app (or token) for KS-Portal and KS-Client

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

Install it on `KS-Ops`, `KS-Portal` and `KS-Client` only. Generate a private key.

Alternative: a fine-grained personal access token with the same permissions on the same three repositories (it
expires, so set a reminder).

If branch protection on `main` requires reviews, either let the app bypass it (Settings > Rules > bypass list) or the
registry step will wait and fail; then merge the pull request by hand and press "Mark done manually".

### 2. GitHub: the KS-Ops environments

In KS-Ops: Settings > Environments > New environment `ks-ops-provisioning`, then again `ks-ops-teardown`. In each:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `KS_PROVISION_APP_ID` | the GitHub App's App ID |
| Secret | `KS_PROVISION_APP_PRIVATE_KEY` | the GitHub App's private key (.pem contents) |
| Secret | `KS_PROVISION_GH_TOKEN` | only if you use a token instead of the app |

The Azure variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) and `OPENAI_API_KEY` are no longer
read and can be removed. `OPENAI_API_KEY` is a setting of the shared server and agent now.

Recommended: on `ks-ops-teardown`, tick **Required reviewers** and add yourself, so every deletion waits for a person.
Optionally limit both environments to the `main` branch (Deployment branches and tags > Selected branches > `main`).

### 3. KS-Ops app settings (the `ks-ops` App Service)

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

Plus the shared-layout settings (`KS_CONTROL_OWNER_DATABASE_URL`, `KS_TENANT_KEY`, `KS_SHARED_PG_ADMIN_URL`,
`KS_SHARED_SERVER_URL`, `KS_SHARED_AGENT_URL`, `KS_OPS_SERVICE_KEY`, `KS_DOMAIN`, `KS_SITES_STORAGE_CONNECTION_STRING`):
see PROVISIONING.md. `OPS_ALLOWED_SERVER_HOST_SUFFIXES` includes `.<KS_DOMAIN>` by itself.

### 4. Check it

1. `/ops/provisioning` shows no "Waiting for manual setup" box.
2. Start a **dry run** for any licensee: the KS-Ops Actions tab shows "Provision <code> (dry run)", and the run's log
   lists every step as "would: ...".
3. The first real licensee: watch the run; the log links the registry pull requests and deploy jobs.

## What still needs a person

- **Custom domains and DNS**: the DNS records and `az` commands for the brokerage's three addresses under `KS_DOMAIN`
  are shown on its run; a person adds the records and runs the commands, and the `custom_domains` step finishes by
  itself. A brokerage's own domain (`apply.<their-domain>`) is added to its `client_hosts` and bound the same way.
- **App store builds per licensee** (branded iPhone, iPad and Android apps): KS-Client's "Build licensee apps" workflow
  and its own environment (`docs/LICENSEE_APPS.md` in KS-Client), plus the store listings.
- **Twilio**: nothing per licensee (KS_OPS_TWILIO_AUTO_v1). Todd's one-time Keystone setup (paid master account, its
  keys on KS-Ops, the ISV profile in Trust Hub) is in `PROVISIONING.md`. The carriers' review of texting registrations
  takes days; KS-Ops follows it by itself.
- **The licensee's own QuickBooks app** (`QBO_*`): off until set.
- **Microsoft 365 / Google Workspace: nothing per licensee.** The `workspace_apps` step writes Keystone's one
  Microsoft app and one Google client into the brokerage's encrypted settings; the brokerage's admin then connects Microsoft 365
  in one click (Settings > Connections) and each person connects Google from My Profile. The opened run on
  `/ops/provisioning` shows whether they have. Todd's one-time setup is in `PROVISIONING.md`.
- **Email sending from their domain** and any SPF/DKIM records.
- A step that keeps failing: read the log, fix the cause, then **Retry step**, or do it by hand and **Mark done
  manually** (with a note).
