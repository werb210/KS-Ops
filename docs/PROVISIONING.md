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
| KS-Portal | `AZURE_STATIC_WEB_APPS_API_TOKEN` (required, `ks-<code>-portal`'s token) | `VITE_API_BASE_URL`, `VITE_APP_URL`, `VITE_CLIENT_APP_URL` (required, https); `VITE_WEBSITE_URL`, `VITE_SUPPORT_EMAIL`, `VITE_COMPANY_NAME`, `VITE_ASSISTANT_NAME` (optional) |
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

- During provisioning, the `workspace_apps` step writes Keystone's keys (masked) to the licensee's KS-server:
  `KS_M365_CLIENT_ID`, `KS_M365_CLIENT_SECRET`, `KS_GOOGLE_OAUTH_CLIENT_ID`, `KS_GOOGLE_OAUTH_CLIENT_SECRET` and
  `KS_OAUTH_BROKER_URL`.
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
     `gmail.readonly`: Gmail inbox reading stays off until the CASA assessment.
3. **OAuth client** (Credentials > Create credentials > OAuth client ID, type *Web application*):
   - **One** authorized redirect URI: `https://<KS-Ops address>/api/oauth/callback/google`.
   - No JavaScript origins.
4. **Verification.** Publish the app and submit it for Google's verification. Brand verification and sensitive
   scopes are free and take a few days to a few weeks. Answer Google's emails at `borealfinancial@gmail.com`. Until
   it is verified, people see an "unverified app" warning, and at most 100 users can use it.
5. **Set the keys on KS-Ops:** `KS_GOOGLE_OAUTH_CLIENT_ID` and `KS_GOOGLE_OAUTH_CLIENT_SECRET`.

There is no "connect the whole domain" option for Google: Keystone does not use domain-wide delegation. Each person
connects their own account with one click.

### Existing licensees and renewing a key

New licensees get the keys during provisioning. If KS-Ops did not have them yet, the `workspace_apps` step says so in
the run's log; set them on KS-Ops and press **Retry step**.

A licensee set up before this change, or any licensee after a key is renewed, needs the new values written to its
server once:

```bash
az webapp config appsettings set -g ks-<code> -n ks-<code>-server --settings \
  KS_M365_CLIENT_ID=<id> KS_M365_CLIENT_SECRET=<secret> \
  KS_GOOGLE_OAUTH_CLIENT_ID=<id> KS_GOOGLE_OAUTH_CLIENT_SECRET=<secret> \
  KS_OAUTH_BROKER_URL=https://<KS-Ops address>/api/oauth/callback
```

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
