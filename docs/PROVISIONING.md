# Provisioning a Keystone brokerage (shared hosting)

Since 2026-11-03 (KS_SHARED_HOSTING_v1) every brokerage runs on **one shared Keystone server, with its own database**.
Nothing in Azure is created per brokerage any more:

- **Once**, Todd runs `scripts/provision-shared.sh`. It makes the shared resource group and everything in it (below).
- **Per brokerage**, KS-Ops does everything itself after payment or a staff free trial, and shows each step in plain
  words on `/ops/provisioning`: it makes the brokerage's database and login role, writes its registry entry, asks the
  shared server to load it and set up its tables, publishes its staff portal and client app, and adds its addresses.

The old layout (a resource group `ks-<code>` with its own servers and Postgres per brokerage) is retired. Its script is
kept, for reference only, as `scripts/legacy/provision-licensee.sh`.

## The layout

| Resource | Name | What it is |
| --- | --- | --- |
| Resource group | `ks-shared` | canadacentral |
| App Service plan | `ks-shared-plan` | Linux, `P0v3` by default (Basic or higher is needed for custom domains) |
| Web app | `ks-shared-server` | KS-server, every brokerage (multi-brokerage mode: `KS_CONTROL_DATABASE_URL` is set) |
| Web app | `ks-shared-agent` | KS-Agent (Maya), every brokerage |
| Web app | `ks-shared-web` | the web host in this repository (`web-host/`): serves every brokerage's staff portal and client app from blob storage, chosen by host name |
| Postgres flexible server | `ks-shared-pg` | Postgres 17; only the `vector` extension is allowed |
| Database | `ks_control` | the brokerage registry, table `ks_tenants` (KS-Ops owns it) |
| Database (one per brokerage) | `ks_<code>` | made by KS-Ops; only the role `ks_<code>_app` can connect to it |
| Storage account | `ksshared<suffix>` | private container `sites`: `sites/<code>/portal/...` and `sites/<code>/client/...` |

KS-Ops itself is unchanged: its own App Service and its own database.

How the pieces find a brokerage: requests carry `X-KS-Tenant: <code>` (KS-Agent, the native apps, KS-Ops's own calls)
or arrive on the brokerage's own host name (`<code>.api.<KS_DOMAIN>` for the server, `<code>.portal.<KS_DOMAIN>` and
`<code>.app.<KS_DOMAIN>` for the web apps), matched against `ks_tenants`. Unknown hosts get a 404, cancelled brokerages
a 410.

### The registry (`ks_tenants` in `ks_control`)

One row per brokerage: `code`, `licensee_id`, `status` (follows the licensee's KS-Ops status every 5 minutes), its host
names (`api_hosts`, `portal_hosts`, `client_hosts`, lowercase, no port), `database_name`, and two encrypted columns:

- `database_url_enc`: the connection string for `ks_<code>_app`.
- `env_enc`: a JSON object of the brokerage's own settings, exactly what used to be in its own App Service settings:
  `JWT_SECRET`, `JWT_REFRESH_SECRET`, `OTP_HASH_SALT`, `QBO_TOKEN_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY`,
  `WATCH_PUSH_ENCRYPTION_KEY`, `LENDER_CREDENTIALS_ENCRYPTION_KEY` (made once and kept), `KS_LICENSEE_ID`, `KS_OPS_KEY`,
  `KS_OPS_URL`, `KS_PLAN` (first run only), `KS_SERVER_URL`, `KS_PORTAL_URL`, `KS_CLIENT_URL`, `CLIENT_URL`,
  `PUBLIC_BASE_URL`, `PUBLIC_SERVER_URL`, `MAYA_URL`, `QBO_ENVIRONMENT`, every `TWILIO_*` of its sub-account, and
  `KS_M365_*` / `KS_GOOGLE_*` / `KS_OAUTH_BROKER_URL`.

Encryption (the same in every repository): AES-256-GCM with the key SHA-256(`KS_TENANT_KEY`), stored as
`v1:<iv base64>:<auth tag base64>:<ciphertext base64>`. KS-Ops writes the registry as `ks_control_owner`; the shared
server, agent and web host only read it, as `ks_control_reader` (SELECT on `ks_tenants` only).

The table is made by `migrations-control/001_ks_tenants.sql`, which KS-Ops applies to `KS_CONTROL_OWNER_DATABASE_URL`
on startup (and `npm run migrate`), as the non-superuser owner. It is safe to run again.

## What Todd sets up once

1. **Sign in to Azure** with the Keystone subscription selected: `az login`, then `az account set -s <subscription id>`.
   You also need `psql`, `openssl` and `curl` on that machine.
2. **Run the one-time script** from a KS-Ops checkout:

   ```bash
   KS_OPS_APP=<ks-ops app name> KS_OPS_RG=<ks-ops resource group> \
   OPENAI_API_KEY=<key> SENDGRID_API_KEY=<key> \
   ALLOW_MY_IP=1 CREATE_DEPLOY_SP=1 \
   scripts/provision-shared.sh
   ```

   It makes everything in the table above, allows only the three shared apps and KS-Ops through the Postgres firewall
   (and this machine while it runs, with `ALLOW_MY_IP=1`), makes `ks_control` with its two roles, makes `ks_tenants`,
   writes the shared apps' settings, and (with `KS_OPS_APP` / `KS_OPS_RG`) writes KS-Ops's settings straight to the
   KS-Ops app. Anything it cannot write for you is printed once in the **COPY THIS NOW** block: the Postgres admin
   password (keep it in the password manager), the storage connection string, and the deploy service principal.
   Running it again keeps what exists; give `PG_ADMIN_PASSWORD` again so it can check the roles.
3. **GitHub secrets.**
   - KS-Portal and KS-Client: repository secret `KS_SITES_STORAGE_CONNECTION_STRING` (printed by the script). Their
     deploy uploads each brokerage's `dist/` to `sites/<code>/portal/` or `sites/<code>/client/`.
   - KS-server, KS-Agent and KS-Ops: secret `AZURE_CREDENTIALS` in the GitHub environment `ks-shared` (the `ks-shared-deploy` JSON from `CREATE_DEPLOY_SP=1`). The
     "Deploy the shared web host" workflow uses it to deploy `web-host/` to `ks-shared-web`. Then run that workflow once
     (Actions > Deploy the shared web host > Run workflow).
   - KS-server and KS-Agent: their one shared deploy to `ks-shared-server` / `ks-shared-agent` (see those repositories).
4. **Keystone's domain.** Choose the domain brokerage addresses live under (for example `keystone.example`) and set it
   as `KS_DOMAIN` on KS-Ops. Without it KS-Ops makes no host names and adds no custom domains (the provisioning page says
   so), and a brokerage's staff portal and client app cannot be opened, because the web host finds each one by its
   host name.
5. **DNS for each new brokerage.** When a brokerage is set up, its run on `/ops/provisioning` shows a **Custom domains**
   box with the exact DNS records (a CNAME and a TXT `asuid.` record per address) and the `az` commands (add the host
   name, make the free managed certificate, bind it). KS-Ops holds no Azure credential, so a person runs those
   commands once per brokerage; the `custom_domains` step checks every 15 minutes and finishes by itself when every
   address answers over https.
6. **Check it.** `/ops/provisioning` shows no "Waiting for manual setup" box. Start a **dry run** for any licensee: its
   log lists every step as "would: ...".

The GitHub App and the KS-Ops GitHub environments `ks-ops-provisioning` / `ks-ops-teardown` (AUTO_PROVISIONING.md) are
still used, for the KS-Portal and KS-Client steps only. They no longer need any Azure variable or `OPENAI_API_KEY`, and
the `keystone-provisioning` Azure app registration and its federated credentials are no longer used by provisioning.

## Settings on each app

### KS-Ops (`ks-ops`): new settings

| Setting | Value |
| --- | --- |
| `KS_CONTROL_OWNER_DATABASE_URL` | `postgresql://ks_control_owner:<password>@ks-shared-pg.postgres.database.azure.com:5432/ks_control?sslmode=require` |
| `KS_SHARED_PG_ADMIN_URL` | the `ks-shared-pg` admin, database `postgres` (`...:5432/postgres?sslmode=require`). Makes and drops `ks_<code>` and `ks_<code>_app` |
| `KS_TENANT_KEY` | the same value as on the three shared apps (the script makes it) |
| `KS_OPS_SERVICE_KEY` | the same value as on `ks-shared-server` |
| `KS_SHARED_SERVER_URL` | `https://ks-shared-server.azurewebsites.net` (KS-Ops calls `/api/ops/tenants/reload` and `/api/ops/tenants/<code>/migrate` there) |
| `KS_SHARED_AGENT_URL` | `https://ks-shared-agent.azurewebsites.net` (each brokerage's `MAYA_URL`) |
| `KS_DOMAIN` | Keystone's domain for brokerage addresses (step 4) |
| `KS_SITES_STORAGE_CONNECTION_STRING` | the storage account; the purge deletes `sites/<code>/` |

The existing KS-Ops settings stay (`OPS_ENCRYPTION_KEY`, `KS_OPS_PUBLIC_URL`, the GitHub token, Twilio, Microsoft 365 /
Google, QuickBooks and so on). `OPS_ALLOWED_SERVER_HOST_SUFFIXES` automatically includes `.<KS_DOMAIN>`.

### `ks-shared-server` (KS-server)

| Setting | Value |
| --- | --- |
| `KS_CONTROL_DATABASE_URL` | `ks_control` as `ks_control_reader`. Setting it switches on multi-brokerage mode |
| `KS_TENANT_KEY` | decrypts each brokerage's database address and settings |
| `KS_OPS_SERVICE_KEY` | authorises KS-Ops's reload and migrate calls (`X-KS-Ops-Service-Key`) |
| `OPENAI_API_KEY`, `SENDGRID_API_KEY`, `AZURE_STORAGE_CONNECTION_STRING` | Keystone-wide; a brokerage's own value with the same name wins |
| `NODE_ENV` | `production` |

### `ks-shared-agent` (KS-Agent)

| Setting | Value |
| --- | --- |
| `KS_CONTROL_DATABASE_URL` | `ks_control` as `ks_control_reader` |
| `KS_TENANT_KEY` | the same key (it signs service JWTs with each brokerage's own `JWT_SECRET`) |
| `SERVER_URL` | `https://ks-shared-server.azurewebsites.net` |
| `OPENAI_API_KEY` | Keystone-wide |
| `NODE_ENV` | `production` |

### `ks-shared-web` (the web host, `web-host/`)

| Setting | Value |
| --- | --- |
| `KS_CONTROL_DATABASE_URL` | `ks_control` as `ks_control_reader` |
| `KS_SITES_STORAGE_CONNECTION_STRING` | the storage account with the `sites` container |

It streams `sites/<code>/<portal or client>/<path>` for the host's brokerage, falls back to `index.html` for app routes,
caches hashed assets for a year and `index.html` not at all, sends the build's `staticwebapp.config.json` headers (CSP
and so on) as Static Web Apps did, never serves that file itself, and refuses any path that tries to leave the site's
folder. `/healthz` answers without a brokerage.

## What KS-Ops does per brokerage

The provisioning run (`/ops/provisioning`, every step safe to run again; "Retry step" and "Mark done manually" are on
the page):

| Step | Where | What |
| --- | --- | --- |
| `twilio_account`, `twilio_address` | KS-Ops | the brokerage's Twilio sub-account and business address |
| `database` | KS-Ops | `CREATE ROLE ks_<code>_app` (random password), `CREATE DATABASE ks_<code>`, `REVOKE ALL ... FROM PUBLIC`, `GRANT CONNECT, TEMPORARY` to that role only, `USAGE, CREATE` on its `public` schema, `CREATE EXTENSION IF NOT EXISTS vector`. Names are checked and quoted; the password is kept on a re-run |
| `tenant_registry` | KS-Ops | the `ks_tenants` row: host names and the encrypted settings (above); the licensee's server, portal and client addresses |
| `twilio_settings`, `workspace_apps` | KS-Ops | the Twilio and Microsoft 365 / Google values, into the same encrypted settings |
| `shared_server` | KS-Ops | `POST /api/ops/tenants/reload`, then `POST /api/ops/tenants/<code>/migrate` on the shared server |
| `github_environments`, `deploy_registry`, `deploy` | GitHub workflow | KS-Portal and KS-Client only: the `ks-<code>` environment (VITE_* variables), the `deploy/licensees.json` entry, the build and upload to `sites/<code>/` |
| `custom_domains` | KS-Ops + a person | the DNS records and `az` commands on the page; done when every address answers over https. Skipped (and said so) without `KS_DOMAIN` |
| `health`, `configure`, `admin_user`, `welcome_email` | KS-Ops | as before, against the brokerage's address (every call carries `X-KS-Tenant: <code>`) |
| `twilio_voice`, `twilio_bundle`, `phone_numbers`, `texting_registration` | KS-Ops | as before |

The registry's code rule allows 2 to 31 characters; a 32-character company code stops at `database` with a plain
message (change the code, then Retry step).

### Removal after cancellation (the purge)

When a cancelled brokerage's 180-day hold is over and its data purge is marked done, and `KS_TEARDOWN_ENABLED=true`,
the teardown run checks the retention rules on the brokerage's server (as before), removes it from KS-Portal and
KS-Client (registry entry and environment), then:

1. `database_drop`: `DROP DATABASE ks_<code> WITH (FORCE)` and `DROP ROLE ks_<code>_app`;
2. `sites_delete`: deletes every blob under `sites/<code>/`;
3. `tenant_delete`: deletes the `ks_tenants` row and tells the shared server to reload.

Until then, export works as today.

## Twilio: what Todd sets up once (not per licensee)

Everything Twilio for each licensee is automatic (KS_OPS_TWILIO_AUTO_v1): its own sub-account, the voice and sign-in
settings on its server, its business address, a regulatory bundle when Twilio asks for one, its phone numbers, and its
texting registration. Only these Keystone-level things need a person, once:

1. **Upgrade Keystone's Twilio account to a paid account** (sub-accounts, numbers and registrations do not work on a
   trial account). Twilio console > Admin > Account billing.
2. **Give KS-Ops the master account's keys.** Twilio console > Account info: copy the Account SID (starts with `AC`) and
   Auth Token. In Azure, on the `ks-ops` App Service > Settings > Environment variables, add `KS_TWILIO_ACCOUNT_SID` and
   `KS_TWILIO_AUTH_TOKEN`. Until they are there, new set-ups wait in "Waiting for manual setup" and nothing is made.
3. **Register Keystone as an ISV in Trust Hub** (only needed for licensees with a US business line). Twilio console >
   Trust Hub > Customer profiles > create the **Primary Business Profile** for Boreal / Keystone (business type "ISV
   Reseller or Partner"), with the business number, address and an authorized contact, and submit it. Twilio reviews it
   (usually a few business days). When it shows **Twilio Approved**, copy its id (starts with `BU`) into the `ks-ops`
   setting `KS_TWILIO_ISV_PROFILE_SID`. Until then, US texting registrations wait as "needs info" and say why.
4. **Optional:** `KS_TWILIO_NOTIFICATION_EMAIL`, where Twilio sends registration notices (default: the sales inbox).

What still takes time, and why: Twilio and the phone carriers review texting registrations themselves. Toll-free
verification and US A2P 10DLC approval usually take 3 to 10 business days, and a regulatory bundle (if Twilio ever asks
for one) 1 to 3. KS-Ops checks every 2 hours, shows the status in plain words on `/ops/provisioning` and on the
brokerage's Settings > Phone lines page, and emails sales if something is turned down or missing. Calls work straight
away; until texting is approved, texts to US mobiles wait and Canadian mobiles get texts from the business line.

If a registration is turned down: read the reason on `/ops/provisioning`, correct the licensee's details in KS-Ops
(business number, website, address, contact's job title), then press **Resubmit texting**.

## Microsoft 365 and Google Workspace: what Todd sets up once (not per licensee)

Keystone has **one** Microsoft app and **one** Google sign-in client for every brokerage (KS_OPS_WORKSPACE_APPS). Nobody
registers an app per brokerage and Keystone staff type nothing per brokerage:

- During provisioning, the `workspace_apps` step writes Keystone's keys into the brokerage's encrypted settings in the
  registry (`ks_tenants.env_enc`): `KS_M365_CLIENT_ID`, `KS_M365_CLIENT_SECRET`, `KS_GOOGLE_OAUTH_CLIENT_ID`,
  `KS_GOOGLE_OAUTH_CLIENT_SECRET` and `KS_OAUTH_BROKER_URL`. The shared server reads them for that brokerage.
- The brokerage's admin opens **Settings > Connections** in their staff portal and clicks **Connect Microsoft 365**.
  Microsoft asks a Microsoft 365 administrator to approve Keystone once for the whole company. Keystone saves the
  company's tenant itself. If the person clicking is not a Microsoft 365 administrator, the page gives them a link to
  send to one.
- After that, each staff member clicks **Connect Microsoft 365** (or **Connect Google**) in My Profile. One click each.

### Why there is one redirect address (the redirect broker)

Microsoft allows at most 256 redirect URIs on an app, and the limit cannot be raised. Wildcards are discouraged and are
not available for every account type. Each licensee server needs three: mail connect, the admin's approval, and staff
sign-in. Google only accepts redirect URIs on domains you have verified, and `*.azurewebsites.net` can never be
verified. Adding addresses for every new licensee would also be a manual step each time.

So both apps list **one** redirect URI per provider, on KS-Ops:

- `https://<KS-Ops address>/api/oauth/callback/microsoft`
- `https://<KS-Ops address>/api/oauth/callback/google`

How a sign-in reaches the right licensee:

1. The licensee's server puts its licensee id, an expiry and its own one-time value in the OAuth `state`, signed with
   its ops key.
2. KS-Ops checks the signature against that licensee's ops key and checks the expiry.
3. KS-Ops sends the browser on to the licensee's server address from **KS-Ops's own records**, never from the `state`.
4. The licensee's server checks everything again and finishes the sign-in. KS-Ops never sees a token.

### Microsoft 365: the Keystone app (checklist)

1. **Create the multi-tenant app in Keystone's own Entra tenant.**
   1. Go to entra.microsoft.com and sign in to Keystone's tenant, not a brokerage's.
   2. Go to Identity > Applications > App registrations > **New registration**.
   3. Name: **Keystone**. Brokerage admins see this name on Microsoft's approval screen.
   4. Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant -
      Multitenant)**.
   5. Redirect URI: platform **Web**, `https://<KS-Ops address>/api/oauth/callback/microsoft`.
2. **Redirect URIs** (Authentication > Web). Keep exactly the one above. The development server needs no entry when it
   uses the broker. If you run it without `KS_OAUTH_BROKER_URL`, also add its own three addresses:
   - `https://<dev KS-server>/api/o365-oauth/callback`
   - `https://<dev KS-server>/api/o365-oauth/admin-consent/callback`
   - `https://<dev KS-server>/api/auth/sso/microsoft/callback`

   Leave "Allow public client flows" set to **No**.
3. **Client secret.** Go to Certificates & secrets > New client secret, choose 24 months and copy the **Value**. Put a
   reminder in the calendar about one month before it expires. To renew it, see "Existing licensees and renewing a
   key" below.
4. **API permissions.** Go to API permissions > Add a permission > Microsoft Graph and add exactly the permissions
   below. Do **not** press "Grant admin consent" here: each brokerage's admin grants them in their own company with
   the Connect button.
   - **Delegated** (each person's own mail, calendar and files): `User.Read`, `Mail.ReadWrite`,
     `Mail.ReadWrite.Shared`, `Mail.Send`, `Mail.Send.Shared`, `Calendars.ReadWrite`, `Calendars.Read.Shared`,
     `Tasks.ReadWrite`, `Contacts.ReadWrite`, `MailboxSettings.ReadWrite`, `Presence.Read`, `Files.ReadWrite`,
     `offline_access`. Add `openid`, `email` and `profile` too, for staff sign-in with Microsoft.
   - **Application** (work done without a signed-in person):
     - `User.Read.All`: find a staff member's or shared mailbox's account.
     - `Mail.ReadWrite`: read the shared mailboxes (incoming documents, bounced lender email), and build large lender
       emails.
     - `Mail.Send`: lender packages and notices from the shared mailbox.
     - `Calendars.ReadWrite`: client bookings, free/busy and invites.
     - `OnlineMeetings.ReadWrite.All`: turn on recording for Teams meetings booked from the CRM.
     - `OnlineMeetingTranscript.Read.All` and `OnlineMeetingRecording.Read.All`: file transcripts and recordings on
       the contact.

   This is the same list KS-server checks (`src/modules/o365/m365App.ts`). Its Connections page shows any permission
   that a company has not granted.
5. **Branding & properties.** Add the logo, home page, terms of service and privacy statement links. Set the
   **Publisher domain** to Keystone's own verified domain.
6. **Verify the publisher.** With a verified publisher, brokerage admins see a blue "verified" badge on the approval
   screen. Many companies block unverified multi-tenant apps.
   1. Enroll Keystone (Boreal) in the Microsoft AI Cloud Partner Program in Partner Center and finish its business
      verification. You get a **Partner ID**.
   2. In the app registration, go to Branding & properties > Publisher verification > **Add Partner ID**. The person
      doing this needs multi-factor sign-in, must be an admin of the app, and must have an email on the publisher
      domain.
   3. Wait for the "Verified" mark to appear on the app.
7. **Set the keys on KS-Ops** (Azure > the `ks-ops` App Service > Settings > Environment variables):
   - `KS_M365_CLIENT_ID`: Application (client) ID.
   - `KS_M365_CLIENT_SECRET`: the secret value.
   - `KS_OPS_PUBLIC_URL`: must be the address used in the redirect URI above. Alternatively, set
     `KS_OAUTH_BROKER_URL` to `https://<that address>/api/oauth/callback`.
8. **Optional, for Teams transcripts and recordings without a signed-in person.** Microsoft also needs an
   "application access policy" in each company that wants this. Their Teams admin creates it once in Teams PowerShell
   (`New-CsApplicationAccessPolicy` / `Grant-CsApplicationAccessPolicy`) for Keystone's client ID. Mail, calendar,
   bookings and shared mailboxes do not need it.

### Google Workspace: the Keystone client (checklist)

KS-server `docs/GOOGLE_WORKSPACE.md` (sections 3.1 to 3.6) has the details. Differences for the one-client setup:

1. **Give KS-Ops an address on a domain Keystone owns**, for example `ops.<keystone domain>`, as a custom domain on the
   `ks-ops` App Service. Verify that domain in Google Search Console. Google refuses redirect URIs on unverified
   domains, and `azurewebsites.net` can never be verified.
2. **OAuth consent screen** (Google Auth Platform > Branding and Audience):
   - User type **External**.
   - App name **Keystone**, with the support email, logo, home page, privacy policy and terms links.
   - Under **Authorized domains**, add the domain from step 1 and the website's domain.
   - Scopes: `openid`, `email`, `profile`, `gmail.send`, `calendar.events`, `tasks`, `drive.file`. **No**
     `gmail.readonly` yet: Gmail inbox reading stays off until the CASA assessment (step 6).
3. **OAuth client** (Credentials > Create credentials > OAuth client ID, type *Web application*):
   - **One** authorized redirect URI: `https://<KS-Ops address>/api/oauth/callback/google`.
   - No JavaScript origins.
4. **Verification.** Publish the app and submit it for Google's verification. Brand verification and sensitive
   scopes are free and take a few days to a few weeks. Answer Google's emails at `borealfinancial@gmail.com`. Until
   it is verified, people see an "unverified app" warning, and at most 100 users can use it.
5. **Set the keys on KS-Ops:** `KS_GOOGLE_OAUTH_CLIENT_ID` and `KS_GOOGLE_OAUTH_CLIENT_SECRET`.
6. **Later: Gmail inbox reading (restricted scope, CASA).** Leave `KS_GOOGLE_GMAIL_READ_ENABLED` unset on KS-Ops until
   Google has approved it. Then:
   1. Add `https://www.googleapis.com/auth/gmail.readonly` to the consent screen's scopes (only this one; never
      `gmail.modify` or full mail access) and submit for restricted-scope verification, with a demo video of client
      email reaching the CRM timeline and the portal's Gmail inbox.
   2. Google asks for a **CASA Tier 2** security assessment by an App Defense Alliance lab. Published Tier 2 prices
      were about US$540 to US$1,500 (TAC Security about $540 to $720) and it takes about 1 to 3 weeks; Tier 3, only if
      Google asks, is about $4,500 to $8,000. The lab sends Google a letter of validation. Both the verification and
      the assessment are renewed **every 12 months** (Google emails about 90 days before; set your own reminder too).
   3. Once approved, set `KS_GOOGLE_GMAIL_READ_ENABLED=true` on KS-Ops. The `workspace_apps` step writes it, with the
      Google keys, into each new brokerage's settings; for existing brokerages use "refresh settings" (below).
   4. Each Google user reconnects once (My Profile > Reconnect Google). Settings > Connections counts who still has to.
   Until then every server shows "Gmail inbox reading is pending Google's security review". KS-server
   `docs/GOOGLE_WORKSPACE.md` section 5 has the details, and the optional Gmail push (Pub/Sub) setup.

There is no "connect the whole domain" option for Google: Keystone does not use domain-wide delegation. Each person
connects their own account with one click.

### Existing licensees and renewing a key

New licensees get the keys during provisioning. If KS-Ops did not have them yet, the `workspace_apps` step says so in
the run's log; set them on KS-Ops and press **Retry step**.

After a key is renewed on KS-Ops (or `KS_GOOGLE_GMAIL_READ_ENABLED` changes), write the new values into each
brokerage's settings once, with a staff token:

```bash
curl -X POST -H "Authorization: Bearer <staff token>" \
  https://<KS-Ops address>/api/ops/provisioning/tenants/<licensee id>/refresh-settings
```

It writes the Twilio and Microsoft 365 / Google values again and tells the shared server to reload (it would pick
them up within 60 seconds anyway). Nothing is restarted.

A server that still has its own `MSAL_CLIENT_ID` / `MSAL_CLIENT_SECRET` (and `MSAL_TENANT_ID`) keeps using them, so
Boreal's own server and existing staff sign-ins are not disturbed.

### Check it

1. Sign in to a brokerage's staff portal as an Admin and open **Settings > Connections**.
2. Click **Connect Microsoft 365** and approve as that company's Microsoft 365 admin. The page shows "Connected to
   <company domain or tenant> by <admin> on <date>", the permissions, and the last successful sync.
3. On `/ops/provisioning`, open that licensee's run. "Microsoft 365 and Google Workspace" shows the same status.

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

- **Custom domains need a person** once per brokerage (DNS records and three `az` commands per address, shown on the
  page), because KS-Ops holds no Azure credential. A brokerage's own address (for example `apply.<their domain>`) can be
  added to its `client_hosts` in `ks_tenants` and bound the same way; KS-Ops keeps hosts added by hand.
- **Brokerages set up the old way** (resource group `ks-<code>`) are not moved automatically. Moving one means copying
  its database into `ks_<code>`, writing its registry entry, and deleting its resource group by hand
  (`scripts/legacy/provision-licensee.sh` documents the old names). A teardown run no longer deletes old resource groups.
- **Runs started before this change** that are still open have the old step names; cancel them and start a new run.
- **`SENDGRID_FROM`, `SENDGRID_REPLY_TO` and `SIGNNOW_*`** per brokerage are not written by KS-Ops (it never wrote them);
  until they are, the shared server's Keystone-wide values apply.
- **App store builds per brokerage** (branded iPhone, iPad and Android apps) are separate: KS-Client's "Build licensee
  apps" workflow (`docs/LICENSEE_APPS.md` in KS-Client).

## Facebook and Instagram lead ads (KS_META_LEAD_ADS_v1)

One Meta app for all of Keystone, created at developers.facebook.com with the Keystone business account.

1. Create a **Business** app named "Keystone". Add the **Facebook Login for Business** and **Webhooks** products.
2. Facebook Login > Settings > Valid OAuth Redirect URIs: `https://<KS-Ops address>/api/oauth/callback/meta`.
3. Webhooks > Page > Subscribe to **leadgen**. Callback URL: `https://<KS-Ops address>/api/webhooks/meta/leadgen`. Verify token: a long random value.
4. App Review: request **leads_retrieval**, **pages_manage_metadata**, **pages_show_list**, **pages_read_engagement** and **business_management** (Advanced access). Business verification is required first.
5. KS-Ops settings: `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`.
6. KS-server (shared app settings, Keystone-wide): `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).

Each brokerage then connects its Pages in Settings > Connections. Its KS-server registers the Pages here, and KS-Ops passes each lead webhook only to the brokerage that owns the Page.
