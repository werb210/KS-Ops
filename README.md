# KS-Ops

Keystone operations: the one central service Boreal runs for every Keystone licensee. It keeps licensee records,
plans and prices, Stripe billing, usage reports, support tickets and upgrade requests; takes sign-ups from the
Keystone website; and answers the company-code directory the Keystone apps use to find a licensee's server.
Boreal staff use it through the KS silo of Boreal's staff portal.

The shared contract with KS-server, the apps and the website is `KEYSTONE_CONTRACTS.md` (Keystone workstreams).

## Run it locally

```bash
npm ci
createdb ks_ops                      # or any Postgres database
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ks_ops
export OPS_JWT_SECRET=$(openssl rand -hex 32) OPS_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm run dev                          # migrations run on startup; listens on PORT (8080)
```

Tests:

```bash
npm run typecheck
npm run test:ci                      # unit tests, no database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ks_ops_test npm run test:integration
```

Stripe, once per Stripe account (test or live): `STRIPE_SECRET_KEY=sk_... DATABASE_URL=... npm run stripe:setup`.
It creates the products and prices from `src/pricing.ts` and saves their ids in the `stripe_prices` table. Run it
again after a price changes.

## Environment

| Variable | Needed | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no | default 8080 |
| `OPS_JWT_SECRET` | yes | 32+ characters; signs staff tokens |
| `OPS_ENCRYPTION_KEY` | yes | 32 bytes as 64 hex characters (or base64); encrypts each licensee's ops key (AES-256-GCM) |
| `OPS_ADMIN_TOKEN` | no | 32+ characters; break-glass staff bearer token |
| `BF_SERVER_URL` | yes | Boreal's BF-Server, e.g. `https://server.boreal.financial`; staff sign-in checks `/api/auth/me` there |
| `OPS_ALLOWED_ORIGINS` | yes | comma-separated origins of the BF staff portal, e.g. `https://staff.boreal.financial` |
| `PUBLIC_SITE_URL` | yes | the Keystone website origin(s), comma-separated; the first is used for Stripe success/cancel pages |
| `STRIPE_SECRET_KEY` | for billing | without it billing endpoints answer 503 `billing_not_configured` and sign-ups get no payment link |
| `STRIPE_WEBHOOK_SECRET` | for billing | signing secret of the webhook pointing at `/api/ops/stripe/webhook` |
| `TURNSTILE_SECRET` | in production | sign-ups need a Cloudflare Turnstile token. With `NODE_ENV=production` and no secret, `POST /api/public/signup` answers 503 `signup_not_configured` |
| `SIGNUP_TURNSTILE_OPTIONAL` | no | `true` lets production take sign-ups without `TURNSTILE_SECRET` |
| `OPS_ADMIN_EMAILS` | recommended | comma-separated emails (case-insensitive) allowed into Keystone operations. Unset: any BF-Server Admin with an email (a warning is logged at startup). Accounts without an email (service principals) are always refused |
| `OPS_ALLOWED_SERVER_HOST_SUFFIXES` | no | where a licensee's `server_url` may point (default `.azurewebsites.net,.azurestaticapps.net`; `*` allows any host). Server, client and portal addresses must be https |
| `PENDING_SIGNUP_DAYS` | no | website sign-ups still unpaid after this many days are cancelled and their company code released (default 7) |
| `KS_SALES_EMAIL` | no | sales inbox for sign-ups and payments (default `sales@keystonecrm.online`) |
| `KS_SUPPORT_EMAIL` | no | where new tickets are announced (default `support@keystonecrm.online`); also the From and reply-to address of the team invites and the owner's onboarding email (with SendGrid it must be a verified sender) |
| `KS_ONBOARDING_BOOKING_URL` | recommended | KS_OPS_ONBOARDING_v1: the https booking page for the owner's Microsoft Teams setup session (e.g. a Microsoft Bookings page). Unset: the onboarding email asks the owner to reply to book |
| `KS_ONBOARDING_CONTACT_NAME` | no | the person introduced as the onboarding contact (default `Todd Werboweski`) |
| `KS_SUPPORT_PHONE` | no | Keystone's support line, shown in the onboarding emails when set. Never a person's own mobile |
| `KS_PORT_RELEASE_GRACE_DAYS` | no | KS_OPS_NUMBER_PORTING_v1: days the temporary Keystone number keeps working after a brokerage's own number finishes transferring in (default 7, at most 90). The owner is told to turn off call forwarding before then |
| `KS_LICENSOR_LEGAL_NAME` | no | the company named as licensor in the licence agreement (default `2630108 Alberta Ltd.`) |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_SEND_AS` | no | email through Microsoft Graph |
| `SENDGRID_API_KEY`, `SENDGRID_FROM`, `SENDGRID_FROM_NAME` | no | email through SendGrid when Graph is not set; with neither, emails are only logged |
| `DEMO_SMS_ENABLED` | no | `true` texts the demo link as well as emailing it. Off by default (the link is emailed only; the mobile number is still kept) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `KS_SMS_FROM` | no | with `DEMO_SMS_ENABLED=true`, texts the demo link (`KS_SMS_FROM` is the sending number in +1 format; `TWILIO_MESSAGING_SERVICE_SID` can replace it) |
| `KS_TWILIO_ACCOUNT_SID`, `KS_TWILIO_AUTH_TOKEN` | for provisioning | Keystone's master Twilio account (paid). Each licensee gets its own sub-account under it, made automatically; without these, new set-ups wait in "Waiting for manual setup" (KS_OPS_TWILIO_AUTO_v1, see `docs/PROVISIONING.md`) |
| `KS_TWILIO_ISV_PROFILE_SID` | for US texting | Keystone's approved ISV primary customer profile in Twilio Trust Hub (`BU...`), attached to each licensee's A2P 10DLC registration. Without it US local-line registrations wait as "needs info" |
| `KS_TWILIO_NOTIFICATION_EMAIL` | no | where Twilio sends registration notices (default: the sales inbox) |
| `KS_OPS_PUBLIC_URL` | recommended | this server's public https address, used for uploaded-logo links (falls back to Azure's `WEBSITE_HOSTNAME`, then the request's host) |
| `KS_CONTROL_OWNER_DATABASE_URL` | for provisioning | the brokerage registry: database `ks_control` on `ks-shared-pg` as `ks_control_owner`. Its migrations (`migrations-control/`) run on startup (KS_SHARED_HOSTING_v1, `docs/PROVISIONING.md`) |
| `KS_TENANT_KEY` | for provisioning | encrypts each brokerage's database address and settings in the registry; the same value as on the shared server, agent and web host |
| `KS_SHARED_PG_ADMIN_URL` | for provisioning | the `ks-shared-pg` admin (database `postgres`): makes and drops each brokerage's database and role |
| `KS_SHARED_SERVER_URL`, `KS_SHARED_AGENT_URL` | for provisioning | the shared KS-server and KS-Agent addresses (https) |
| `KS_OPS_SERVICE_KEY` | for provisioning | sent as `X-KS-Ops-Service-Key` to the shared server's `/api/ops/tenants` routes; the same value as on `ks-shared-server` |
| `KS_DOMAIN` | recommended | Keystone's domain for brokerage addresses (`<code>.api.<domain>`, `<code>.portal.<domain>`, `<code>.app.<domain>`). Without it no host names or custom domains are made, and the web apps cannot be opened |
| `KS_SITES_STORAGE_CONNECTION_STRING` | for teardown | the `ksshared<suffix>` storage account; the purge deletes `sites/<code>/` |
| `BF_CRM_URL` | no | BF-Server for the Keystone CRM (KS silo), default `https://server.boreal.financial`. Demo sign-ups (lead -> demo started -> demo finished, with progress and a summary note), website sign-ups and licensees (signed up -> paying, payments and status changes) are pushed to `POST {BF_CRM_URL}/api/ks/crm/upsert` (licensee pushes include `company.support_level`). Licensee support tickets and their follow-ups go to `POST {BF_CRM_URL}/api/ks/support/ingest` through the same outbox (required: `external_id`, `subject`, `message`, `message_id`, `licensee`, `requester`; 404/503 there = not deployed yet: retried every 6 h, logged once; 400/422 = rejected: logged with details, given up after 6 tries) |
| `BF_CRM_KEY` | for the CRM | the same value as `KS_OPS_CRM_KEY` on BF-Server (sent as `X-KS-Ops-Key`). Unset: nothing is pushed (logged once at startup). Pushes wait in `crm_outbox` and are retried after 1 min, 5 min, 30 min, 2 h, 12 h, then daily until BF-Server accepts them |
| `KS_M365_CLIENT_ID`, `KS_M365_CLIENT_SECRET` | for Microsoft 365 | Keystone's one multi-tenant Entra app (KS_OPS_WORKSPACE_APPS). Written to every licensee's KS-server by the `workspace_apps` provisioning step; the brokerage's admin then connects in one click. See `docs/PROVISIONING.md` |
| `KS_GOOGLE_OAUTH_CLIENT_ID`, `KS_GOOGLE_OAUTH_CLIENT_SECRET` | for Google Workspace | Keystone's one Google OAuth client, written to every licensee's KS-server the same way |
| `KS_GOOGLE_GMAIL_READ_ENABLED` | only after Google's CASA approval | `true` switches Gmail inbox reading on for every licensee (written with the Google keys); unset = off ("pending Google's security review") |
| `KS_OAUTH_BROKER_URL` | no | the redirect broker's base address, default `{KS_OPS_PUBLIC_URL}/api/oauth/callback`. Microsoft and Google send every sign-in to `/microsoft` or `/google` under it, and KS-Ops forwards it to the right licensee's server (signed state, address from KS-Ops's records) |
| `KS_QBO_CLIENT_ID`, `KS_QBO_CLIENT_SECRET`, `KS_QBO_TOKEN_ENCRYPTION_KEY` | for Keystone's QuickBooks | Keystone's own QuickBooks Online (Stripe invoices, payments, refunds and fees posted there). The key is 32 bytes (64 hex characters). Unset: off. See `docs/QUICKBOOKS.md` |
| `KS_QBO_ENVIRONMENT` | no | `sandbox` (default) or `production` |
| `KS_QBO_REDIRECT_URI` | no | default `https://<ks-ops host>/api/ops/quickbooks/oauth/callback` (host from `KS_OPS_PUBLIC_URL` or Azure's `WEBSITE_HOSTNAME`); register it in the Intuit app |
| `OPENAI_API_KEY` | for AI help | KS_OPS_KB_v1: Keystone's own key for the knowledge base's semantic search, Ask Maya (portal support assistant) and the website sales assistant. Unset: full-text search only, and both assistants answer with the closest articles. Never counts against a licensee's AI allowance |
| `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL` | no | default `gpt-4o-mini` (as KS-Agent) and `text-embedding-3-small` |
| `KS_HELP_LICENSEE_DAILY_LIMIT` | no | Ask Maya questions a day per licensee (default 300; also 30 an hour per person) |
| `KS_SALES_ASSISTANT_DAILY_LIMIT` | no | website assistant questions a day in all (default 3,000; also 40 a day per browser, 20 per 10 minutes per address) |
| `OPS_WORKERS` | no | `off` stops the background jobs (they never run under `NODE_ENV=test`) |
| `TRUST_PROXY_HOPS` | no | proxies in front of the app (default 1, Azure App Service) |
| `BI_SERVER_URL` | for PGI referrals | the insurance partner's server (Boreal Insurance BI-Server), e.g. `https://bi-server-<id>.canadacentral-01.azurewebsites.net`. Every live licensee is made a PGI referral source there (20% referral fee) and its credentials are pushed to the licensee's server (`PUT /api/pgi/link`) |
| `BI_KEYSTONE_OPS_KEY` | for PGI referrals | the same value as `BI_KEYSTONE_OPS_KEY` on BI-Server (sent as `X-BI-Keystone-Key`). Without these two the PGI link worker does nothing |
| `KS_STAFF_DIRECTORY_PEPPER` | recommended | keys every staff-directory hash once more before it is stored. Set it once and never change it (stored hashes would stop matching until every KS-server pushes again, within six hours) |
| `KS_WATCHLIST_OPS_PEPPER` | recommended | keys every shared-watchlist hash once more before it is stored, so a copy of this database alone is useless. Set it once and never change it (stored hashes would stop matching) |

Stripe webhook events to send: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`,
`invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, and
`charge.refunded` (for QuickBooks).

Payment methods: Checkout offers Canadian pre-authorized debit (`acss_debit`, with the PAD mandate) by default and
card as the alternative; a licensee whose `payment_method` is `card` gets card only. Turn on ACSS Debit in Stripe.
After Checkout (and whenever the subscription's `default_payment_method` changes) that payment method is also set as
the Stripe customer's `invoice_settings.default_payment_method`, so usage-overage and other one-off invoices collect
automatically. The last one set is kept in `licensees.stripe_default_payment_method`; a Stripe failure is logged and
audited (`stripe.default_payment_method_failed`) and tried again on the next subscription event.

How they are handled:
- A sign-up moves to `provisioning` (and the welcome emails go out) only when the Checkout is paid
  (`payment_status` `paid` or `no_payment_required`, or `async_payment_succeeded` for delayed methods).
  `async_payment_failed` and `expired` leave it in `pending_payment` and email the contact a resume link.
- A subscription id on file is never replaced while that subscription is still live in Stripe; the new one is logged,
  audited and reported to sales. Staff Checkout answers 409 `subscription_exists` in that case.
- `invoice.paid` only moves `past_due` back to `active`, and only for invoices of the licensee's own subscription.
- Status changes (Stripe or staff) to `trial`, `active`, `past_due`, `suspended` or `cancelled` are pushed to the
  licensee's server with its plan: `PUT {server_url}/api/plan { plan, extra_storage_blocks, status, addons }`.
- Add-ons (`addons`, e.g. `{ "bank_connect": true }`) are not plan features: Keystone staff switch them on for one
  licensee with `PATCH /api/ops/licensees/:id { "addons": { "bank_connect": true } }` (or `false`), which is audited
  and pushed like a plan change. They are never listed in `/api/public/plans` and the licensee cannot change them.
  `bank_connect` = the applicant Connect Bank (View-Only) step, the staff request item, fraud check 3 and Flinks.
- Marketing add-on (KS_OPS_MARKETING_ADDON, Todd Oct 26): CAD $49 a month, flat, one per brokerage, any plan (Pro does
  not include it). Chosen at sign-up (`marketing_addon: true` on `POST /api/public/signup`) or switched on/off by staff
  with `PATCH /api/ops/licensees/:id { "addons": { "marketing": true } }` (audited, pushed as `addons.marketing`, and the
  Stripe subscription gets or loses its flat `marketing_addon:<interval>` line, 12 x on annual). Unlike `bank_connect`
  it is public: `/api/public/plans` lists `marketing_addon` (what it adds), each plan's `marketing` limits (campaign
  emails 500 / 1,000 / 2,500 a month, text-to-many 50 / 250 / 500, sequences 2 / 5 / 10, visitor history 30 / 90 / 365
  days, 1 lead form) and `signings` (4 a month per brokerage, $2.50 each over). Both trials include the add-on (the
  licensee's server turns it on during either trial; KS-Ops bills overage with its allowance while a trial applies).
- Overage (after a month's final usage report, worked out from KS-Ops's own plan, seats and add-ons): extra minutes
  ($0.04), texts ($0.03; with the add-on up to 1,000 marketing texts are not counted), signings over 4 ($2.50) and, with
  the add-on, campaign emails over the plan's + 10,000 ($10 per 10,000 or part). Monthly subscriptions: the lines wait as
  pending invoice items and go on the next month's subscription invoice (`overage_billing.status` `pending_next_invoice`).
  Annual subscriptions get their own overage invoice as before. QuickBooks posts the add-on and extra campaign emails to
  "Keystone Marketing add-on", extra signings to "Keystone e-signing", minutes and texts to "Keystone usage overage".

## API

All routes are under `/api`. Errors are JSON; form errors are `{ errors: { field: "message" } }`.

**Public (Keystone website)** — CORS for `PUBLIC_SITE_URL`
- `GET /api/public/plans` — plans, support levels, extra storage, overage, trial, currency
- `GET /api/public/company-code-available?code=` — `{ available, reason?: invalid|reserved|taken, message? }`
- `POST /api/public/signup` — rate limited (10 an hour per address), honeypot `website_url`, Turnstile when set.
  201 `{ licensee_id, signup_token, checkout_url, message? }`, 400 `{ errors }`, 409 `{ errors: { company_code: "taken" } }`
- `GET /api/public/signup/:licensee_id/status?token=` — `{ status, company_name }`
- Sign-up v13 fields: the address as `address_line1`, `address_line2` (optional), `city`, `postal_code` (Canadian postal
  code or US ZIP, checked against `country`); `mailing_address` is still accepted from older clients and is always
  written as one line made from the parts. `accent_color` and `background_color` (optional, `#RRGGBB`) next to
  `primary_color`. `logo_file: { content_type, data_base64, filename? }` - PNG, JPG or SVG up to 500 KB (checked by its
  bytes; SVGs with scripts or links are refused), stored in `licensee_logos` and linked from `logo_url`
- Sign-up v18 (KS_OPS_TWILIO_AUTO_v1, for texting registration): `business_number` (CRA business number, 9 digits with
  an optional program account like `123456789RC0001`, or a US EIN `12-3456789`; checked against `country`),
  `business_type` (`corporation`, `llc`, `partnership`, `sole_proprietor`, `non_profit`, `cooperative`) and
  `contact_title` (the contact's job title). Optional for older clients; staff can add them with PATCH
- Sign-up v14: `font_family` (optional) - a font family name only (letters, numbers, spaces, dashes; 60 at most), e.g.
  `Lato`. Stored in `licensees.font_family` next to the colours and returned by the directory like `primary_color`
- Branding sync (KS_OPS_v15): every plan push (`PUT {server_url}/api/plan`) also carries
  `branding: { primary_color, accent_color, background_color, font_family, logo_url }` ("" = not set). A staff edit of
  any of those (or of `server_url`) pushes straight away. The licensee's server applies a field only until their admin
  changes it on the Company page; after that the admin's value wins
- `POST /api/public/brand-scan { url }` — "Use my website" on the sign-up branding step (10 per 10 minutes per
  address). Reads the brokerage's home page and up to 3 of its same-site style sheets and returns
  `{ ok, url, site_name, logo: { source_url, content_type, data_base64, filename } | null, logo_candidates, favicon_url,
  colors: { theme_color, variables, palette, body_background }, fonts: { body, headings, google, font_faces },
  suggestions: { primary_color, accent_color, background_color, font: { family, source } } }`. Nothing is saved: the
  website pre-fills the form and sends a chosen logo as the normal `logo_file`. SSRF guards (`src/lib/safeFetch.ts`):
  http/https on ports 80/443 only, no credentials in the address, every DNS answer must be public (private, loopback,
  link-local, CGNAT, multicast and reserved ranges refused, IPv4-mapped/NAT64 included) and the connection goes to the
  checked address, at most 3 redirects each checked again, 6 s per request, 15 s per scan, size limits (1.5 MB page,
  400 KB per style sheet, 500 KB per logo). Errors: 400 `bad_url`/`blocked`, 422 `not_html`, 502 `fetch_failed`,
  504 `timeout`, each with a `message` for the person
- `GET /api/public/logos/:key` — an uploaded logo (image only, `Content-Security-Policy: default-src 'none'`)
- `POST /api/public/demo/prefill { demo_id, key }` — the name, email, company and phone a prospect gave for their demo,
  for the website's sign-up and contact forms. The key comes from `{site}/signup#demo=<id>&k=<key>` links (in the demo
  emails and the demo's `open` answer as `signup_url`); it is an HMAC of the id, and travels in the #fragment only
- `POST /api/public/signup/:licensee_id/checkout?token=` — a new Stripe Checkout link for a sign-up still in
  `pending_payment` (10 per 15 minutes per address): 200 `{ checkout_url }`, 404 wrong id/token, 409
  `not_pending_payment`, 503 `billing_not_configured`, 502 `checkout_failed`

**Directory (Keystone apps)** — `GET /api/directory/:code`, 30 a minute per address. Resolves only licensees that are
`trial`, `active` or `past_due` and have a server address; otherwise 404 `{ error: "unknown_company" }`. Since
KS_STAFF_DIRECTORY_v1 the apps only use it behind "Enter company code instead".

**Staff directory (Keystone apps)** — `POST /api/staff-directory/lookup { identifier }` (a work email or a North
American mobile number). Always 200 `{ matches: [{ name, server_url }] }` (empty when nothing matches or the
identifier is unusable), held to at least 400 ms, 10 per 15 minutes per address and 6 an hour per identifier. Only
live licensees (`trial`, `active`, `past_due`) with a server address are returned. KS-server pushes its staff list
(hashes only, see `src/staffDirectory.ts`) to `POST /api/licensees/:id/staff-directory`.

**From a licensee's KS-server** — header `X-KS-Ops-Key`
- `POST /api/licensees/:id/usage-reports` — one report per month; a report replaces the stored one only if it was
  generated at the same time or later
- `POST /api/licensees/:id/requests` — upgrade or storage request
- `POST /api/licensees/:id/tickets` — support ticket from a licensee admin
- `POST /api/licensees/:id/tickets/:ticketId/messages` — follow-up on one of the licensee's tickets (reopens a waiting/resolved ticket)
- `POST /api/licensees/:id/staff-directory` — `{ entries: [{ kind: "email" | "phone", hash }] }`, the full list of the
  licensee's active staff; replaces the previous list
- `POST /api/licensees/:id/watchlist/opt-in` `{ opt_in }` — shared fraud watchlist on/off; off deletes everything the
  licensee shared
- `POST /api/licensees/:id/watchlist/report` `{ application_ref, entries: [{ kind, hash }] }` — replace one confirmed-fraud
  file's entries (403 `watchlist_not_opted_in` until opted in). kind: phone, email, business_number, address,
  bank_account, person; hash: 64 hex characters (HMAC made on the licensee's server with `KS_WATCHLIST_PEPPER`)
- `POST /api/licensees/:id/watchlist/withdraw` `{ application_ref }` — the file was restored out of Fraud
- `POST /api/licensees/:id/watchlist/check` `{ entries }` -> `{ matches: [{ kind, hash, brokerages, reports }] }` — reports
  by OTHER opted-in licensees only. No personal data is ever sent or stored, only hashes
- `POST /api/licensees/:id/purged` — the server reports a cancelled licensee's data was deleted (accepted on or after
  the purge date, 409 before)
- KS_OPS_NUMBER_PORTING_v1 "Keep your existing phone number" (relayed by KS-server's `/api/port-requests`; bodies carry
  the carrier account number and PIN, which are stored encrypted with `OPS_ENCRYPTION_KEY` and never logged):
  `POST /api/licensees/:id/port-requests` (create; the bill as base64, PDF/PNG/JPG up to 7 MB),
  `POST .../port-requests/list`, `POST .../port-requests/:rid/loa`, `.../sign`, `.../forwarding`, `.../cancel`
- Usage reports with `generated_at` more than 5 minutes in the future are refused (400). Overage is billed from
  KS-Ops's own plan and seats (pooled, with the trial bonus during a trial), not from the report's `overage`.

**Staff (BF staff portal, KS silo)** — `Authorization: Bearer <token>`
- KS_OPS_NUMBER_PORTING_v1 number transfers, on the page `/ops/porting`: `GET /api/ops/porting?status=`,
  `GET /api/ops/porting/:id` (the Twilio checklist, account number and PIN in clear; audited), `GET .../bill`,
  `GET .../loa` (signed letter, HTML), `POST .../status { status, foc_date?, reason?, twilio_port_sid?, twilio_reference? }`.
  Statuses: draft -> ready_to_submit (letter signed) -> submitted -> carrier_approval_pending -> scheduled (FOC date)
  -> completed / rejected (reason) / cancelled. Each change emails the owner from the support address; "approve the
  carrier's text" also texts the owner when `TWILIO_*`/`KS_SMS_FROM` are set. Submitting with a letter over 30 days old
  sends it back to the brokerage to sign again. Completed calls the brokerage's `POST /api/provision/ported-numbers`,
  which attaches the number and releases the temporary number after `KS_PORT_RELEASE_GRACE_DAYS`; texting is then
  registered through `src/twilio/texting.ts` (toll-free verification, US A2P 10DLC; Canadian numbers need none).
- `POST /api/ops/auth/exchange { bfToken }` — Admin users only; returns `{ token, expires_in, user }` (1 hour).
  `GET /api/ops/auth/me` returns who the token belongs to.
- `GET /api/ops/licensees` (`?status=&q=`), `POST /api/ops/licensees`, `GET /api/ops/licensees/:id`,
  `PATCH /api/ops/licensees/:id` (plan, extra storage, add-ons and live status changes are pushed to the licensee's server;
  plan, seat, support and storage changes update the Stripe subscription), `POST /api/ops/licensees/:id/notes`
- Cancelled licensees: `cancelled_at` is set when the status becomes `cancelled`; `data_purge_on` (cancelled_at +
  180 days) shows on the licensee and in the dashboard's `data_purges`. `POST /api/ops/licensees/:id/purged` marks the
  data purged by hand after that date (status stays `cancelled`, `purged_at` is set; a purged licensee cannot be
  reopened).
- `POST /api/ops/licensees/:id/ops-key` — makes a new key and shows it once
- `GET /api/ops/watchlist` — shared watchlist totals: licensees sharing, files, entries (never the hashes)
- `POST /api/ops/licensees/:id/sync-usage?period=YYYY-MM` — pull the usage report now
- `GET /api/ops/licensees/:id/invoices`, `POST /api/ops/licensees/:id/invoices/preview?period=YYYY-MM`
- `POST /api/ops/licensees/:id/billing/checkout` — Stripe Checkout link for the subscription (and onboarding fee if unpaid)
- `POST /api/ops/stripe/webhook` — Stripe only (signature checked)
- `GET /api/ops/quickbooks/status`, `POST /api/ops/quickbooks/connect`, `POST /api/ops/quickbooks/disconnect`,
  `PATCH /api/ops/quickbooks/settings`, `GET /api/ops/quickbooks/outbox`, `POST /api/ops/quickbooks/outbox/:id/retry`;
  `GET /api/ops/quickbooks/oauth/callback` (Intuit only); page `GET /ops/quickbooks`. See `docs/QUICKBOOKS.md`
- `GET /api/ops/tickets`, `POST /api/ops/tickets`, `GET /api/ops/tickets/:id`, `PATCH /api/ops/tickets/:id`,
  `POST /api/ops/tickets/:id/messages`
- `GET /api/ops/requests`, `PATCH /api/ops/requests/:id`
- `GET /api/ops/dashboard` — licensees, seats, MRR, active trials, overdue invoices, open tickets and requests
- Free trial (staff only, no payment up front): `POST /api/ops/trials { licensee_id }` or `{ licensee: {...new
  prospect...} }`, `GET /api/ops/trials`; page `GET /ops/trials`. Days 1-14 free with every Pro feature; days 15-28
  billed at the Starter monthly price (a Stripe subscription with `trial_end` = day 15 and `collection_method:
  send_invoice`, so no card or bank account is needed to start), still with Pro features (the plan pushed to the
  licensee's server is `pro`); then Starter unless a plan was chosen (`PATCH /api/ops/licensees/:id { plan }`). Who
  started it is kept on the licensee (`admin_trial_*`) and in `staff_audit`; the contact is emailed the dates, and again
  when it ends. One per licensee; refused for a licensee with a live subscription

**Knowledge base and Keystone Maya (KS_OPS_KB_v1)** — one help library for every licensee, edited on `GET /ops/kb`
(staff token). Articles: title, category, Markdown body with images, plans (empty = every plan), audience (`public` =
website too, `all_staff`, `admins`), draft/published, last updated. Search is Postgres full text fused with OpenAI
embeddings (stored as `real[]`, no pgvector) when `OPENAI_API_KEY` is set. The starter library (`src/kb/articles/`) is
loaded once on startup and by `npm run migrate`.
- Staff: `GET|POST /api/ops/kb/articles`, `GET|PATCH|DELETE /api/ops/kb/articles/:id`, `POST /api/ops/kb/images`,
  `POST /api/ops/kb/preview`, `GET /api/ops/kb/categories`, `GET /api/ops/kb/report?days=` (questions with no good answer)
- Public: `GET /api/public/kb/articles?q=&category=`, `GET /api/public/kb/articles/:slug`, `GET /api/public/kb/categories`,
  `GET /api/public/kb/images/:id`, `POST /api/public/assistant/chat`, `POST /api/public/assistant/lead` (consent required;
  `wants: live_demo | person` emails `KS_SALES_EMAIL` and adds `task` to the CRM upsert - BF-Server must read `task` to
  create it; the follow-up is always in the note too)
- From a licensee's KS-server (`X-KS-Ops-Key`): `POST /api/licensees/:id/kb/search`, `/kb/article`, `/kb/categories`,
  `/kb/ask` (Ask Maya: answers from the KB with citations, uses only this licensee's plan/usage/connections, offers
  "Contact support" when it can't help)

`GET /api/health` reports whether the database answers.

## Background jobs

- Every 30 seconds: Keystone prospect marketing (campaign sends, sequence steps, CRM timeline; the prospect sync every
  2 minutes, the reply mailbox every 5, the Keystone CRM pull every 10).
- Every minute: post queued Stripe invoices, payments, fees and refunds to Keystone's QuickBooks (`qbo_outbox`).
- Every 5 minutes: end staff free trials whose 28 days are up, then push plans that are waiting (`pending_sync`) to
  licensees' servers.
- Daily: pull usage reports from servers that did not send them, bill overage for finished months (once per licensee
  and month; progress is kept in `overage_billing`, and Stripe is searched by metadata before anything is created, so
  a rerun days later never charges twice), remind past-due licensees every 3 days, cancel website sign-ups unpaid
  after `PENDING_SIGNUP_DAYS` (their company code becomes `exp--<id>` and the old one is kept in
  `released_company_code`).

## Prospect marketing (KS_OPS_PROSPECT_MARKETING_v1)

Email marketing to prospective licensees, run from the staff portal's Keystone silo > Marketing (staff API under
`/api/ops/marketing/*`, see `src/routes/opsMarketing.ts`).

- Prospects (`ks_prospects`, one per email) are synced every 2 minutes from demo sign-ups, beta sign-ups, the website
  assistant's lead form and licensees, and every 10 minutes from the Keystone CRM on BF-Server
  (`GET /api/ks/marketing/contacts`); staff can add or import them. Each carries a status (lead, demo booked, trial,
  customer, lost), its sources, plan interest, country and province/state, and the consent we hold.
- Consent (CASL / CAN-SPAM, `src/marketing/consent.ts`): express; implied by an inquiry (6 months); implied by a
  subscription (while it runs, then 2 years); implied by a published business email (12-month review); US business
  contacts under CAN-SPAM opt-out. Nobody without valid consent is emailed: they are listed as blocked with the reason.
  The suppression list (unsubscribed, hard bounce, spam report, opted out in the CRM, staff) is checked at queue time
  and again right before every email.
- Every email has the Keystone layout and a fixed footer: why they get it, the sender (business and legal name), the
  mailing address (`KS_MARKETING_ADDRESS`, default Boreal's business address), a contact address and an unsubscribe
  link, plus `List-Unsubscribe` and `List-Unsubscribe-Post` (one-click). `GET/POST /api/public/marketing/unsubscribe`.
- Campaigns: send now or schedule (up to 90 days), test send (max 5 addresses, marked [Test]). Sequences: steps of
  "wait N days, send template"; an enrolment stops when the prospect replies, signs up or books a demo after enrolling,
  unsubscribes or loses consent.
- Tracking: SendGrid Event Webhook to `POST /api/public/marketing/sendgrid-events` (signed with
  `KS_MARKETING_WEBHOOK_PUBLIC_KEY`, or `?token=KS_MARKETING_WEBHOOK_TOKEN`). Opens, clicks, bounces, spam reports and
  unsubscribes go on the prospect's timeline here and on the Keystone CRM contact on BF-Server
  (`POST /api/ks/marketing/events`, through `ks_mkt_timeline_outbox`).
- Replies: the reply mailbox (`KS_MARKETING_REPLY_MAILBOX`, default `MS_GRAPH_SEND_AS`) is checked every 5 minutes when
  the Graph app has Mail.Read; staff can also click "Mark replied".

| Variable | Needed | What it is |
| --- | --- | --- |
| `KS_MARKETING_FROM` | yes, once the domain is chosen | marketing From address on an authenticated SendGrid domain. Until set, `SENDGRID_FROM` is used and the portal shows a warning |
| `KS_MARKETING_FROM_NAME` | no | default `Keystone` |
| `KS_MARKETING_REPLY_TO` | no | default `KS_SALES_EMAIL` |
| `KS_MARKETING_BUSINESS_NAME` / `KS_MARKETING_LEGAL_NAME` | no | footer sender identification (default `Keystone` / `2630108 Alberta Ltd.`) |
| `KS_MARKETING_ADDRESS` | recommended | footer mailing address (default `450 Sparling Crt SW, Edmonton, AB T6X 1G9, Canada`) |
| `KS_MARKETING_SENDGRID_API_KEY` | no | a separate SendGrid key (e.g. a Keystone subuser); default `SENDGRID_API_KEY` |
| `KS_MARKETING_WEBHOOK_PUBLIC_KEY` | for tracking | the Signed Event Webhook verification key |
| `KS_MARKETING_WEBHOOK_TOKEN` | alternative | 24+ character token in the webhook URL instead of the signature |
| `KS_MARKETING_UNSUBSCRIBE_SECRET` | no | signs unsubscribe links (default `OPS_JWT_SECRET`) |
| `KS_MARKETING_REPLY_MAILBOX` | no | mailbox checked for replies (default `MS_GRAPH_SEND_AS`) |
| `KS_OPS_PUBLIC_URL` | yes | KS-Ops's public address, used in unsubscribe links |

## Provisioning

Every brokerage runs on Keystone's one shared server with its own database (KS_SHARED_HOSTING_v1).
`scripts/provision-shared.sh` makes the shared Azure resources once; after that KS-Ops sets up each brokerage itself
on `/ops/provisioning` (its database `ks_<code>`, its role, its `ks_tenants` registry entry, its web builds).
`web-host/` is the shared web host (`ks-shared-web`). See `docs/PROVISIONING.md`. The old per-brokerage script is kept
as `scripts/legacy/provision-licensee.sh`.
