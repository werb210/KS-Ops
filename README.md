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
| `KS_SALES_EMAIL` | no | sales inbox for sign-ups and payments (default `keystone@boreal.financial`) |
| `KS_SUPPORT_EMAIL` | no | where new tickets are announced (default: the sales inbox) |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_SEND_AS` | no | email through Microsoft Graph |
| `SENDGRID_API_KEY`, `SENDGRID_FROM`, `SENDGRID_FROM_NAME` | no | email through SendGrid when Graph is not set; with neither, emails are only logged |
| `OPS_WORKERS` | no | `off` stops the background jobs (they never run under `NODE_ENV=test`) |
| `TRUST_PROXY_HOPS` | no | proxies in front of the app (default 1, Azure App Service) |

Stripe webhook events to send: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`,
`invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`.

How they are handled:
- A sign-up moves to `provisioning` (and the welcome emails go out) only when the Checkout is paid
  (`payment_status` `paid` or `no_payment_required`, or `async_payment_succeeded` for delayed methods).
  `async_payment_failed` and `expired` leave it in `pending_payment` and email the contact a resume link.
- A subscription id on file is never replaced while that subscription is still live in Stripe; the new one is logged,
  audited and reported to sales. Staff Checkout answers 409 `subscription_exists` in that case.
- `invoice.paid` only moves `past_due` back to `active`, and only for invoices of the licensee's own subscription.
- Status changes (Stripe or staff) to `trial`, `active`, `past_due`, `suspended` or `cancelled` are pushed to the
  licensee's server with its plan: `PUT {server_url}/api/plan { plan, extra_storage_blocks, status }`.

## API

All routes are under `/api`. Errors are JSON; form errors are `{ errors: { field: "message" } }`.

**Public (Keystone website)** — CORS for `PUBLIC_SITE_URL`
- `GET /api/public/plans` — plans, support levels, extra storage, overage, trial, currency
- `GET /api/public/company-code-available?code=` — `{ available, reason?: invalid|reserved|taken, message? }`
- `POST /api/public/signup` — rate limited (10 an hour per address), honeypot `website_url`, Turnstile when set.
  201 `{ licensee_id, signup_token, checkout_url, message? }`, 400 `{ errors }`, 409 `{ errors: { company_code: "taken" } }`
- `GET /api/public/signup/:licensee_id/status?token=` — `{ status, company_name }`
- `POST /api/public/signup/:licensee_id/checkout?token=` — a new Stripe Checkout link for a sign-up still in
  `pending_payment` (10 per 15 minutes per address): 200 `{ checkout_url }`, 404 wrong id/token, 409
  `not_pending_payment`, 503 `billing_not_configured`, 502 `checkout_failed`

**Directory (Keystone apps)** — `GET /api/directory/:code`, 30 a minute per address. Resolves only licensees that are
`trial`, `active` or `past_due` and have a server address; otherwise 404 `{ error: "unknown_company" }`.

**From a licensee's KS-server** — header `X-KS-Ops-Key`
- `POST /api/licensees/:id/usage-reports` — one report per month; a report replaces the stored one only if it was
  generated at the same time or later
- `POST /api/licensees/:id/requests` — upgrade or storage request
- `POST /api/licensees/:id/tickets` — support ticket from a licensee admin
- `POST /api/licensees/:id/purged` — the server reports a cancelled licensee's data was deleted (accepted on or after
  the purge date, 409 before)
- Usage reports with `generated_at` more than 5 minutes in the future are refused (400). Overage is billed from
  KS-Ops's own plan and seats (pooled, with the trial bonus during a trial), not from the report's `overage`.

**Staff (BF staff portal, KS silo)** — `Authorization: Bearer <token>`
- `POST /api/ops/auth/exchange { bfToken }` — Admin users only; returns `{ token, expires_in, user }` (1 hour).
  `GET /api/ops/auth/me` returns who the token belongs to.
- `GET /api/ops/licensees` (`?status=&q=`), `POST /api/ops/licensees`, `GET /api/ops/licensees/:id`,
  `PATCH /api/ops/licensees/:id` (plan, extra storage and live status changes are pushed to the licensee's server;
  plan, seat, support and storage changes update the Stripe subscription), `POST /api/ops/licensees/:id/notes`
- Cancelled licensees: `cancelled_at` is set when the status becomes `cancelled`; `data_purge_on` (cancelled_at +
  180 days) shows on the licensee and in the dashboard's `data_purges`. `POST /api/ops/licensees/:id/purged` marks the
  data purged by hand after that date (status stays `cancelled`, `purged_at` is set; a purged licensee cannot be
  reopened).
- `POST /api/ops/licensees/:id/ops-key` — makes a new key and shows it once
- `POST /api/ops/licensees/:id/sync-usage?period=YYYY-MM` — pull the usage report now
- `GET /api/ops/licensees/:id/invoices`, `POST /api/ops/licensees/:id/invoices/preview?period=YYYY-MM`
- `POST /api/ops/licensees/:id/billing/checkout` — Stripe Checkout link for the subscription (and onboarding fee if unpaid)
- `POST /api/ops/stripe/webhook` — Stripe only (signature checked)
- `GET /api/ops/tickets`, `POST /api/ops/tickets`, `GET /api/ops/tickets/:id`, `PATCH /api/ops/tickets/:id`,
  `POST /api/ops/tickets/:id/messages`
- `GET /api/ops/requests`, `PATCH /api/ops/requests/:id`
- `GET /api/ops/dashboard` — licensees, seats, MRR, active trials, overdue invoices, open tickets and requests

`GET /api/health` reports whether the database answers.

## Background jobs

- Every 5 minutes: push plans that are waiting (`pending_sync`) to licensees' servers.
- Daily: pull usage reports from servers that did not send them, bill overage for finished months (once per licensee
  and month; progress is kept in `overage_billing`, and Stripe is searched by metadata before anything is created, so
  a rerun days later never charges twice), remind past-due licensees every 3 days, cancel website sign-ups unpaid
  after `PENDING_SIGNUP_DAYS` (their company code becomes `exp--<id>` and the old one is kept in
  `released_company_code`).

## Provisioning

`KS_OPS_URL=https://<ks-ops> scripts/provision-licensee.sh <code> <region>` creates a licensee's Azure resources. See `docs/PROVISIONING.md`.
