# Beta programme (KS-Ops)

KS-Ops is the source of truth for Keystone's beta features: the catalogue, who is in each beta, the feedback they
send and the website's beta programme sign-ups. Code marker: `KS_OPS_BETA_v1`.

## Statuses

| Status | Who has it | Who can join or leave |
| --- | --- | --- |
| Private beta | Only licensees staff enrol | Staff only. Licensees cannot see it until enrolled |
| Public beta | Licensees who joined | Any licensee admin on an allowed plan, from the portal's Labs page, while it is open (auto-approved). When closed, a join becomes a request in `requests` |
| Generally available | Every licensee on an allowed plan | Nobody. It cannot be switched off |
| Retired | Nobody | Nobody. Hidden everywhere |

"Plans that may join" limits who can join (and who gets a GA feature). No plans ticked = every plan.

## How Todd adds a new beta feature

1. Open `https://<ks-ops host>/ops/beta` and sign in with a staff token (the same as `/ops/trials`).
2. Choose **New feature**. Give it a key such as `ai_call_notes` (the name developers use in code), a name, a
   description licensee admins will read, a status and the plans that may join. Save.
3. For a private beta, choose **Manage**, search for a licensee and **Enrol**. For a public beta, licensees join from
   their portal (Settings > Labs).
4. Ask a developer to gate the new code with `isEnabled("ai_call_notes")` (KS-server) or `useBetaFlag("ai_call_notes")`
   (KS-Portal). Until that code ships, the flag does nothing.
5. Read feedback under **Manage**. When it is ready, change the status to Generally available; when dropped, Retired.

## How flags reach a licensee

The flags travel with the existing plan push: `PUT {server_url}/api/plan` with `X-KS-Ops-Key`, now carrying
`beta_features` (the licensee's full view of the catalogue, see `src/beta/catalogue.ts`). Enrolling or removing one
licensee pushes at once; a catalogue change marks every live licensee `pending_sync` and the retry worker sends them
within 5 minutes. If the beta tables cannot be read, the plan push still goes, without `beta_features`.

## API

Staff (`/api/ops`, staff token):

- `GET /beta/features`, `POST /beta/features`, `GET|PATCH /beta/features/:key`
- `POST /beta/features/:key/enrolments { licensee_id }`, `DELETE /beta/features/:key/enrolments/:licenseeId`
- `GET /beta/signups`

Licensee server (`/api/licensees/:id`, `X-KS-Ops-Key`):

- `GET /beta` - the licensee's snapshot
- `POST /beta/enrolment { feature_key, action: join|leave, requested_by? }` - answers with the new snapshot
- `POST /beta/feedback { feature_key, message, rating?, author_name?, author_email? }`

Website: `POST /api/public/beta-signup { name, email, brokerage, interests[], message?, turnstile_token?, website_url }`.
Each sign-up is stored, emailed to `KS_SALES_EMAIL` and queued for the Keystone CRM as a website lead (source
`website_signup`, stage `lead` unless the email already belongs to a licensee contact, a `signup` event and a note of
their interests).

Every change is in `staff_audit` (`beta.create`, `beta.update`, `beta.enrol`, `beta.unenrol`, `beta.join`,
`beta.leave`, `beta.join_requested`).
