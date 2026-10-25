# Provisioning a Keystone licensee

> **Automatic now.** After payment (or a staff free trial) KS-Ops runs all of this by itself: see
> [AUTO_PROVISIONING.md](AUTO_PROVISIONING.md) and `/ops/provisioning`. This page is the manual path, still used when
> automatic setup is not configured yet or a step has to be done by hand.

Each licensee (brokerage) gets its own copy of Keystone: KS-server, KS-Agent, KS-Portal and KS-Client, with its own
Postgres database, all in one Azure resource group named `ks-<company code>`. `scripts/provision-licensee.sh` creates
it. The script is safe to run again: what exists is kept, and the secrets already saved in the apps are reused.

## Before you start

1. The licensee exists in KS-Ops (signed up on the website, or added by staff) and its status is `provisioning`.
2. You are signed in to Azure (`az login`) with the Keystone subscription selected (`az account set -s <id>`).
3. You have `openssl` and `curl`.
4. `KS_OPS_URL` is set to the KS-Ops base address (https). It is required: the script has no default, so a licensee
   is never pointed at the wrong KS-Ops.
5. Optional but recommended: a KS-Ops staff token in `OPS_TOKEN` (from the staff portal, or the break-glass
   `OPS_ADMIN_TOKEN`). With it the script makes the licensee's ops key and saves the new addresses in KS-Ops.

## Run it

```bash
KS_OPS_URL=https://<ks-ops address> \
KS_LICENSEE_ID=<licensee id from KS-Ops> \
OPS_TOKEN=<staff token> \
KS_PLAN=growth \
OPENAI_API_KEY=<key> \
QBO_CLIENT_ID=<Intuit client id> QBO_CLIENT_SECRET=<Intuit client secret> QBO_ENVIRONMENT=production \
CREATE_DEPLOY_SP=1 \
scripts/provision-licensee.sh northwind canadacentral
```

What it creates (names use the company code):

| Resource | Name | Notes |
| --- | --- | --- |
| Resource group | `ks-northwind` | in the region you give |
| Postgres flexible server | `ks-northwind-pg`, database `ks` | Burstable `Standard_B1ms`, Postgres 17; firewall allows only the two web apps' outbound addresses |
| App Service plan | `ks-northwind-plan` | Linux `B1` |
| Web app (KS-server) | `ks-northwind-server` | Node 22, startup `node dist/index.js`, HTTPS only, always on |
| Web app (KS-Agent) | `ks-northwind-agent` | same plan and settings |
| Static Web App (KS-Portal) | `ks-northwind-portal` | Free, in `SWA_LOCATION` (default `eastus2`) |
| Static Web App (KS-Client) | `ks-northwind-client` | Free, in `SWA_LOCATION` |

App settings it writes:

- **KS-server:** `DATABASE_URL` (generated), `JWT_SECRET` and `OTP_HASH_SALT` (generated once, then kept),
  `KS_SERVER_URL`, `KS_PORTAL_URL`, `KS_CLIENT_URL`, `KS_OPS_URL`, `KS_LICENSEE_ID`, `KS_OPS_KEY`, `MAYA_URL` (the
  agent), `KS_PLAN` (first run only), `OPENAI_API_KEY` when given, `NODE_ENV=production`.
  QuickBooks Online fee invoices: `QBO_TOKEN_ENCRYPTION_KEY` (generated once, then kept) and `QBO_ENVIRONMENT`
  (`sandbox` unless given) always; `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` and `QBO_REDIRECT_URI` (default
  `<KS-server>/api/quickbooks/oauth/callback`) when `QBO_CLIENT_ID` is given. Without `QBO_CLIENT_ID` QuickBooks
  stays off. The script prints the redirect URI to add to the licensee's Intuit app (see KS-server
  `docs/QUICKBOOKS.md`).
- **KS-Agent:** `SERVER_URL` (the licensee's KS-server), `JWT_SECRET` (same as KS-server), `OPENAI_API_KEY` when given.

Brand settings (`KS_COMPANY_NAME`, `KS_PRIMARY_COLOR` and so on) are not written: the licensee's admin sets them on
the Company page in their staff portal (KS-server `PUT /api/licensee`).

## After it runs

The script prints the addresses, then the GitHub settings the deploy workflows need. Each of the four app
repositories (KS-server, KS-Agent, KS-Portal, KS-Client) deploys every licensee listed in its `deploy/licensees.json`,
each from its own GitHub environment named `ks-<code>`. The development copy keeps deploying from the repositories'
own (repository-level) secrets and variables, exactly as before.

### 1. Create the GitHub environment `ks-<code>` in each of the four repositories

Settings > Environments > New environment, name `ks-<code>` (e.g. `ks-northwind`). The script prints this name. Add
(secrets under "Environment secrets", the rest under "Environment variables"):

| Repository | Secrets | Variables |
| --- | --- | --- |
| KS-server | `AZURE_CREDENTIALS` (required); `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_TOKEN_ENCRYPTION_KEY` (optional, QuickBooks) | `AZURE_WEBAPP_NAME` (optional, default `ks-<code>-server`); `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI` (optional, QuickBooks) |
| KS-Agent | `AZURE_CREDENTIALS` (required) | `AZURE_WEBAPP_NAME` (optional, default `ks-<code>-agent`) |
| KS-Portal | `AZURE_STATIC_WEB_APPS_API_TOKEN` (required, `ks-<code>-portal`'s token) | `VITE_API_BASE_URL`, `VITE_APP_URL`, `VITE_CLIENT_APP_URL` (required, https); `VITE_MSAL_CLIENT_ID`, `VITE_MSAL_TENANT_ID`, `VITE_MSAL_REDIRECT_URI`, `VITE_MSAL_SCOPES` (Microsoft sign-in, off without a client id); `VITE_WEBSITE_URL`, `VITE_SUPPORT_EMAIL`, `VITE_COMPANY_NAME`, `VITE_ASSISTANT_NAME` (optional) |
| KS-Client | `AZURE_STATIC_WEB_APPS_API_TOKEN` (required, `ks-<code>-client`'s token) | `VITE_API_BASE_URL` (required, https); `VITE_LICENSEE` (optional: a folder under KS-Client `licensees/` for the branded build); `VITE_CLIENT_APP_URL`, `VITE_WEBSITE_URL`, `VITE_SUPPORT_EMAIL`, `VITE_COMPANY_NAME` (optional) |

- `AZURE_CREDENTIALS` is the JSON of the deploy service principal `ks-<code>-deploy` (contributor on `ks-<code>`
  only), printed when the script runs with `CREATE_DEPLOY_SP=1`.
- The `VITE_*` values are compiled into the public JavaScript, so they are variables, not secrets.
- QuickBooks (optional): when the KS-server environment has `QBO_CLIENT_ID`, each deploy writes `QBO_CLIENT_ID`,
  `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (default `sandbox`), and `QBO_REDIRECT_URI` / `QBO_TOKEN_ENCRYPTION_KEY`
  when given, to the licensee's KS-server app settings. If the app has no token key yet, the deploy makes one.
  Without `QBO_CLIENT_ID` the deploy leaves the QuickBooks settings alone (whatever the provisioning script wrote).
- KS-server needs no `DATABASE_URL` in GitHub: it applies its migrations on startup with the `DATABASE_URL` app
  setting the script wrote. (To read it: `az webapp config appsettings list -g ks-<code> -n ks-<code>-server --query
  "[?name=='DATABASE_URL'].value" -o tsv`.)
- If a value is missing from the environment, GitHub would quietly use the repository-level one (the development
  copy's). The deploy jobs refuse that: the licensee's job fails with "Add ... to the GitHub environment 'ks-<code>'"
  and nothing is deployed for it.

Secrets are printed only inside the block marked **COPY THIS NOW**. Run the script again to see them again.

### 2. Add the licensee to `deploy/licensees.json` in each of the four repositories

The same line in all four (the script prints it):

```json
{
  "licensees": [
    { "code": "northwind", "environment": "ks-northwind", "enabled": true, "apps": ["server", "agent", "portal", "client"] }
  ]
}
```

`environment` defaults to `ks-<code>` and `apps` to all four; `enabled: false` keeps an entry without deploying it.
The file holds nothing secret. CI checks it (`node deploy/licensee-matrix.mjs --check`), so merge the change through
a pull request; once merged, that push deploys the licensee.

### 3. Deploy

Every push to `main` whose CI passes deploys the development copy and then every enabled licensee, one job per
licensee; one licensee failing does not stop the others. To deploy one licensee by hand (e.g. the first time): Actions
> the deploy workflow ("Build and deploy Node.js app to Azure Web App" in KS-server, "Build and deploy the assistant
to Azure Web App" in KS-Agent, "deploy" in KS-Portal, "Azure Static Web Apps CI/CD" in KS-Client) > Run workflow on
`main`, with `licensee` set to the code. Left empty, a manual run deploys the development copy and every licensee.

The licensee's iPhone/iPad and Android apps are separate: KS-Client's "Build licensee apps" workflow, with its own
environment named after the `licensees/<key>` folder (see KS-Client `docs/LICENSEE_APPS.md`).

### Postgres firewall

Postgres has no "allow all Azure services" rule. Each run adds a rule per outbound address of the KS-server and
KS-Agent web apps (`possibleOutboundIpAddresses`) and removes any other rule, so run the script again after changing
the App Service plan's size or region (the outbound addresses can change). If KS-Ops cannot make the ops key, or its
answer cannot be read, the script stops with an error rather than continuing without one.

### Then

1. Deploy KS-server, KS-Agent, KS-Portal and KS-Client (step 3 above).
2. If you did not pass `OPS_TOKEN`, open the licensee in KS-Ops, press "Rotate ops key", set the key as `KS_OPS_KEY`
   on `ks-<code>-server`, and save the server, portal and client addresses on the licensee.
3. KS-Ops pushes the licensee's plan to the new server within 5 minutes of it answering.
4. Set the licensee's status to `trial` or `active`. From then on the company code resolves in the apps' directory.

## Keystone's own KS-Ops settings (once, not per licensee)

Keystone invoicing its licensees: Stripe collects (bank debit by default, card as the alternative) and every Stripe
invoice, payment, refund and fee is posted to Keystone's own QuickBooks Online. App settings on the **ks-ops** app
(not on any licensee's apps):

| Setting | Value |
| --- | --- |
| `KS_QBO_CLIENT_ID`, `KS_QBO_CLIENT_SECRET` | Keystone's Intuit app keys (sandbox keys with `KS_QBO_ENVIRONMENT=sandbox`) |
| `KS_QBO_TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32`, set once and kept |
| `KS_QBO_ENVIRONMENT` | `sandbox` (default) or `production` |
| `KS_QBO_REDIRECT_URI` | optional; default `https://<ks-ops host>/api/ops/quickbooks/oauth/callback`, which must be listed in the Intuit app |

Then add `charge.refunded` (and keep `invoice.finalized`, `invoice.paid`) on the Stripe webhook, turn on ACSS Debit
in Stripe, open `https://<ks-ops host>/ops/quickbooks`, connect, and fill in the settings. See `docs/QUICKBOOKS.md`.

## Today's limits

- By hand, creating the four `ks-<code>` GitHub environments, their secrets and variables, and the
  `deploy/licensees.json` entries is done in the GitHub settings (four repositories, same values); the script prints
  all of it. Automatic provisioning does it through the GitHub API (AUTO_PROVISIONING.md).
- `deploy/licensees.json` is kept in each of the four repositories; keep the copies the same.
- Each licensee's portal and client web app are built once per licensee (their addresses are compiled in), so a push
  to `main` takes longer as licensees are added. KS-server and KS-Agent are built once and the same package is
  deployed to every licensee.
- Manual deploys run from `main` only.
- `DEPLOY_IDENTITY=1` (used by automatic provisioning) makes a managed identity with GitHub federated credentials
  instead of a service principal secret: the `ks-<code>` environments of KS-server and KS-Agent then hold the variables
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` instead of the secret `AZURE_CREDENTIALS`. The
  script also makes `JWT_REFRESH_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` and `WATCH_PUSH_ENCRYPTION_KEY` once and keeps
  them.
