# Keystone's QuickBooks Online (Stripe to QuickBooks)

Keystone collects licensee payments through Stripe and records them in **Keystone's own** QuickBooks Online company.
This is separate from each licensee's own QuickBooks (set up per licensee by `provision-licensee.sh` with `QBO_*`
settings on their KS-server).

## How licensees pay

- **Bank debit** (Canadian pre-authorized debit, Stripe `acss_debit`) is the default. Checkout is opened with
  `allowed_payment_method_types: ["acss_debit", "card"]` and the PAD mandate options Stripe needs
  (`payment_schedule: combined` - the subscription on its schedule plus overage invoices when they happen -,
  `interval_description`, `transaction_type: business`, `verification_method: automatic`). Card stays in the same
  Checkout as a fallback for someone without a Canadian bank account.
- **Card** when the licensee chose it: Checkout offers card only.
- The choice is `payment_method` (`acss_debit` | `card`) on the licensee: from the website sign-up, staff create, or
  `PATCH /api/ops/licensees/:id { "payment_method": "card" }`. It applies to the next Checkout.
- Checkout saves the bank debit or card on the subscription; KS-Ops copies it to the customer's
  `invoice_settings.default_payment_method` (on `checkout.session.completed` and `customer.subscription.*`), so usage
  overage and other one-off invoices are collected automatically too.
- Stripe: turn on **ACSS Debit** under Settings > Payment methods (live and test). A bank debit settles in a few
  business days: the licensee moves to `provisioning` on `checkout.session.async_payment_succeeded`, as before.
- Stripe API 2026-09-30 (stripe-node 23) replaced Checkout's `payment_method_types` with
  `allowed_payment_method_types`, a filter on the methods enabled in the Stripe account. Stripe decides the order
  Checkout shows them in.

## Settings on the ks-ops app

| Variable | Needed | What it is |
| --- | --- | --- |
| `KS_QBO_CLIENT_ID` | yes | Intuit app client id (developer.intuit.com > your app > Keys & credentials) |
| `KS_QBO_CLIENT_SECRET` | yes | Intuit app client secret |
| `KS_QBO_TOKEN_ENCRYPTION_KEY` | yes | 32 bytes as 64 hex characters (`openssl rand -hex 32`) or base64. Encrypts the stored Intuit tokens (AES-256-GCM). Set once; changing it means reconnecting |
| `KS_QBO_ENVIRONMENT` | no | `sandbox` (default) or `production`. Use the matching Intuit keys. Switching needs a reconnect |
| `KS_QBO_REDIRECT_URI` | no | default `https://<ks-ops host>/api/ops/quickbooks/oauth/callback` (from `KS_OPS_PUBLIC_URL`, or Azure's `WEBSITE_HOSTNAME`, or the request) |

Without the first three the feature is off: nothing is queued, the worker does nothing, the status route says what
is missing and connect answers 503. Nothing else changes.

In the Intuit app, add the redirect URI exactly as `GET /api/ops/quickbooks/status` shows it (`redirect_uri`) under
Redirect URIs (Development for sandbox keys, Production for production keys). Scope: Accounting.

## Connecting

Ops admins only (same staff sign-in as the rest of Keystone operations).

- Page: `https://<ks-ops host>/ops/quickbooks`. Paste a KS-Ops staff token (or the break-glass `OPS_ADMIN_TOKEN`);
  it is kept in that browser tab only. Connect, reconnect, disconnect, settings, and the posting queue with "Retry now".
- API:
  - `GET /api/ops/quickbooks/status`
  - `POST /api/ops/quickbooks/connect` -> `{ authorize_url }` (open it in the browser). The state is random,
    single use, stored only as a hash, and expires in 10 minutes.
  - `GET /api/ops/quickbooks/oauth/callback` - Intuit only. Swaps the code for tokens and stores them encrypted.
  - `POST /api/ops/quickbooks/disconnect` - revokes the refresh token at Intuit and deletes the stored tokens.
  - `PATCH /api/ops/quickbooks/settings` `{ tax_code_id, exempt_tax_code_id, income_account_id, deposit_account_id, fee_account_id }`
  - `GET /api/ops/quickbooks/outbox?status=pending|failed|done|skipped`, `POST /api/ops/quickbooks/outbox/:id/retry`

Tokens: the access token is refreshed 5 minutes before it expires (and once on a 401); every refresh stores the new
refresh token Intuit returns. Intuit refresh tokens last about 100 days while in use; if one is refused
(`invalid_grant`), posting waits and the log says to reconnect.

## Settings (QuickBooks ids)

| Setting | Used for | When empty |
| --- | --- | --- |
| `tax_code_id` | the tax code on invoice lines when Stripe charged tax (e.g. GST or HST) | a taxed invoice is not posted (it waits, with the error "set tax_code_id") |
| `exempt_tax_code_id` | lines when Stripe charged no tax; Stripe fee lines | no tax code is sent (fine for a company without sales tax) |
| `income_account_id` | the Income account of the items KS-Ops creates | the first Income account |
| `deposit_account_id` | where payments are deposited (e.g. a "Stripe clearing" bank account); refunds and fees are paid from it | payments go to Undeposited Funds, refunds become credit memos, fees are skipped |
| `fee_account_id` | the expense account for Stripe fees | fees are skipped |

## What gets posted

Stripe webhook events (add them to the webhook at `/api/ops/stripe/webhook`; signatures are checked as before):
`invoice.finalized`, `invoice.paid`, `charge.refunded`.

| Stripe | QuickBooks | Key (idempotency) |
| --- | --- | --- |
| invoice (finalized or paid) | **Invoice** for the licensee's Customer. `DocNumber` = Stripe invoice number | Stripe invoice id |
| invoice paid | **Payment** for `amount_paid`, linked to that invoice; `PaymentRefNum` = payment intent | Stripe invoice id |
| invoice paid | **Expense** (Purchase) for the Stripe fee, vendor "Stripe", from `deposit_account_id` to `fee_account_id` | Stripe invoice id |
| charge refunded | **Refund Receipt** (or Credit Memo without `deposit_account_id`), one per Stripe refund | Stripe refund id |

- Customer: found by company name, then by contact email, otherwise created (`DisplayName` = company name; if that
  name is used by a vendor, "name (company code)"). Remembered per QuickBooks company.
- Invoice lines, from the Stripe lines (prices recognised from `stripe_prices`): "Keystone seats", "Keystone support"
  (support and support seats), "Keystone extra storage", "Keystone onboarding", "Keystone usage overage" (overage
  invoices), "Keystone other charges" (anything else, e.g. prorations of unknown prices). These Service items are
  created on first use. Stripe discounts become one discount line. Tax: `TxnTaxDetail.TotalTax` = Stripe's tax, lines
  coded `tax_code_id`. If lines - discount + tax do not equal Stripe's total, a line for the difference is added and a
  warning logged, so QuickBooks matches what Stripe charged. A different total computed by QuickBooks is logged.
- Refunds of a taxed invoice are entered tax-inclusive with `tax_code_id`.
- Not posted (marked `skipped`, with a note): invoices with nothing charged (trials, $0), invoices with a negative
  total (credits), payments of $0, fees when fee posting is not set up, failed or cancelled refunds.

Reliability:
- Everything goes through `qbo_outbox`; the worker posts due rows every minute (invoices first).
- One row per key above: a repeated or replayed webhook only refreshes a row that is still waiting. Each QuickBooks
  create also sends a `requestid` made from the same key, and an invoice is looked up by its number first, so a
  crash between QuickBooks answering and KS-Ops saving does not make a second document.
- A payment whose invoice is not posted yet posts the invoice first.
- Failures are logged (`[qbo] posting ...`) with the QuickBooks error, kept in `last_error`, and retried after 1 min,
  5 min, 30 min, 2 h, 12 h, then daily. Nothing is dropped. "Retry now" on the page (or the retry route) sends one again,
  including a skipped one (for example after setting `fee_account_id`).
- While configured but not connected, rows wait untouched and go once someone connects.

## Not covered

- Disputes / chargebacks, Stripe payouts (moving money from the clearing account to the bank), and partial payments
  of one invoice (one Payment for `amount_paid` per invoice).
- Multi-currency: amounts are posted in the QuickBooks home currency (Keystone bills in CAD).
- Not tested against a real QuickBooks company yet: check the first sandbox postings (tax especially) before production.
