# Provisioning a Keystone licensee

Each licensee (brokerage) gets its own copy of Keystone: KS-server, KS-Agent, KS-Portal and KS-Client, with its own
Postgres database, all in one Azure resource group named `ks-<company code>`. `scripts/provision-licensee.sh` creates
it. The script is safe to run again: what exists is kept, and the secrets already saved in the apps are reused.

## Before you start

1. The licensee exists in KS-Ops (signed up on the website, or added by staff) and its status is `provisioning`.
2. You are signed in to Azure (`az login`) with the Keystone subscription selected (`az account set -s <id>`).
3. You have `openssl` and `curl`.
4. Optional but recommended: a KS-Ops staff token in `OPS_TOKEN` (from the staff portal, or the break-glass
   `OPS_ADMIN_TOKEN`). With it the script makes the licensee's ops key and saves the new addresses in KS-Ops.

## Run it

```bash
KS_OPS_URL=https://<ks-ops address> \
KS_LICENSEE_ID=<licensee id from KS-Ops> \
OPS_TOKEN=<staff token> \
KS_PLAN=growth \
OPENAI_API_KEY=<key> \
CREATE_DEPLOY_SP=1 \
scripts/provision-licensee.sh northwind canadacentral
```

What it creates (names use the company code):

| Resource | Name | Notes |
| --- | --- | --- |
| Resource group | `ks-northwind` | in the region you give |
| Postgres flexible server | `ks-northwind-pg`, database `ks` | Burstable `Standard_B1ms`, Postgres 17, Azure services allowed |
| App Service plan | `ks-northwind-plan` | Linux `B1` |
| Web app (KS-server) | `ks-northwind-server` | Node 22, startup `node dist/index.js`, HTTPS only, always on |
| Web app (KS-Agent) | `ks-northwind-agent` | same plan and settings |
| Static Web App (KS-Portal) | `ks-northwind-portal` | Free, in `SWA_LOCATION` (default `eastus2`) |
| Static Web App (KS-Client) | `ks-northwind-client` | Free, in `SWA_LOCATION` |

App settings it writes:

- **KS-server:** `DATABASE_URL` (generated), `JWT_SECRET` and `OTP_HASH_SALT` (generated once, then kept),
  `KS_SERVER_URL`, `KS_PORTAL_URL`, `KS_CLIENT_URL`, `KS_OPS_URL`, `KS_LICENSEE_ID`, `KS_OPS_KEY`, `MAYA_URL` (the
  agent), `KS_PLAN` (first run only), `OPENAI_API_KEY` when given, `NODE_ENV=production`.
- **KS-Agent:** `SERVER_URL` (the licensee's KS-server), `JWT_SECRET` (same as KS-server), `OPENAI_API_KEY` when given.

Brand settings (`KS_COMPANY_NAME`, `KS_PRIMARY_COLOR` and so on) are not written: the licensee's admin sets them on
the Company page in their staff portal (KS-server `PUT /api/licensee`).

## After it runs

The script prints the addresses, then the GitHub settings each repo's deploy workflow needs:

- **KS-server:** secrets `AZURE_CREDENTIALS`, `DATABASE_URL`; variable `AZURE_WEBAPP_NAME`.
- **KS-Agent:** secret `AZURE_CREDENTIALS`; variable `AZURE_WEBAPP_NAME`.
- **KS-Portal:** secrets `AZURE_STATIC_WEB_APPS_API_TOKEN`, `VITE_API_BASE_URL`, `VITE_APP_URL`,
  `VITE_CLIENT_APP_URL`, `VITE_MSAL_CLIENT_ID`, `VITE_MSAL_TENANT_ID`, `VITE_MSAL_REDIRECT_URI`, `VITE_MSAL_SCOPES`.
- **KS-Client:** secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. Its server address comes from `client-app/.env.production`.

Secrets are printed only inside the block marked **COPY THIS NOW**. Run the script again to see them again.

Then:

1. Deploy KS-server, KS-Agent, KS-Portal and KS-Client.
2. If you did not pass `OPS_TOKEN`, open the licensee in KS-Ops, press "Rotate ops key", set the key as `KS_OPS_KEY`
   on `ks-<code>-server`, and save the server, portal and client addresses on the licensee.
3. KS-Ops pushes the licensee's plan to the new server within 5 minutes of it answering.
4. Set the licensee's status to `trial` or `active`. From then on the company code resolves in the apps' directory.

## Today's limits

- KS-server's and KS-Portal's deploy workflows deploy to the development copy (`ks-server-dev` and the dev Static Web
  App) and read their settings from single repository secrets. Deploying many licensees from one repository needs a
  GitHub environment per licensee (for example `ks-northwind`) holding the values above, and the workflows reading
  `vars.AZURE_WEBAPP_NAME` and environment secrets.
- KS-Client's web build takes its server address from the committed `client-app/.env.production`. A per-licensee
  web build needs that value passed in from the environment instead.
- KS-Agent has no deploy workflow yet; the settings above are what Boreal's agent uses.
