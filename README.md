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
| `TURNSTILE_SECRET` | no | when set, sign-ups need a Cloudflare Turnstile token |
| `KS_SALES_EMAIL` | no | sales inbox for sign-ups and payments (default `keystone@boreal.financial`) |
| `KS_SUPPORT_EMAIL` | no | where new tickets are announced (default: the sales inbox) |
| `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `MS_GRAPH_SEND_AS` | no | email through Microsoft Graph |
| `SENDGRID_API_KEY`, `SENDGRID_FROM`, `SENDGRID_FROM_NAME` | no | email through SendGrid when Graph is not set; with neither, emails are only logged |
| `OPS_WORKERS` | no | `off` stops the background jobs (they never run under `NODE_ENV=test`) |
| `TRUST_PROXY_HOPS` | no | proxies in front of the app (default 1, Azure App Service) |

Stripe webhook events to send: `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`,
`invoice.updated`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`.

## API

All routes are under `/api`. Errors are JSON; form errors are `{ errors: { field: "message" } }`.

**Public (Keystone website)** — CORS for `PUBLIC_SITE_URL`
- `GET /api/public/plans` — plans, support levels, extra storage, overage, trial, currency
- `GET /api/public/company-code-available?code=` — `{ available, reason?: invalid|reserved|taken, message? }`
- `POST /api/public/signup` — rate limited (10 an hour per address), honeypot `website_url`, Turnstile when set.
  201 `{ licensee_id, signup_token, checkout_url, message? }`, 400 `{ errors }`, 409 `{ errors: { company_code: "taken" } }`
- `GET /api/public/signup/:licensee_id/status?token=` — `{ status, company_name }`

**Directory (Keystone apps)** — `GET /api/directory/:code`, 30 a minute per address. Resolves only licensees that are
`trial`, `active` or `past_due` and have a server address; otherwise 404 `{ error: "unknown_company" }`.

**From a licensee's KS-server** — header `X-KS-Ops-Key`
- `POST /api/licensees/:id/usage-reports` — one report per month; a report replaces the stored one only if it was
  generated at the same time or later
- `POST /api/licensees/:id/requests` — upgrade or storage request
- `POST /api/licensees/:id/tickets` — support ticket from a licensee admin

**Staff (BF staff portal, KS silo)** — `Authorization: Bearer <token>`
- `POST /api/ops/auth/exchange { bfToken }` — Admin users only; returns `{ token, expires_in, user }` (1 hour).
  `GET /api/ops/auth/me` returns who the token belongs to.
- `GET /api/ops/licensees` (`?status=&q=`), `POST /api/ops/licensees`, `GET /api/ops/licensees/:id`,
  `PATCH /api/ops/licensees/:id` (plan and extra storage changes are pushed to the licensee's server; plan, seat,
  support and storage changes update the Stripe subscription), `POST /api/ops/licensees/:id/notes`
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
  and month), remind past-due licensees every 3 days.

## Provisioning

`scripts/provision-licensee.sh <code> <region>` creates a licensee's Azure resources. See `docs/PROVISIONING.md`.
