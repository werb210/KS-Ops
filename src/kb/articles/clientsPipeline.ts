import type { SeedArticle } from "./index.js";

export const CLIENTS_AND_PIPELINE: SeedArticle[] = [
  {
    slug: "client-application-wizard",
    title: "How clients apply: the six-step application",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "What your clients see in your branded client app, step by step.",
    body: `
Clients apply in your own branded client app, on a phone or in any browser.

## The six steps
1. **Business**: the business name, address, industry and how long it has operated.
2. **Owners**: each owner and guarantor.
3. **Funding**: how much they need and what it is for.
4. **Financials**: revenue and the key numbers.
5. **Documents**: bank statements, financial statements and ID, from the camera or files.
6. **Review and sign**: they check everything and sign inside the app.

## Things clients like
- **Save and resume**: progress is saved at every step, so they can stop and come back later.
- **No passwords**: they sign in with a code sent to their mobile, then Face ID or a passkey on their phone.
- **Their own portal**: after applying they see the stage of each application, what they still need to do and anything waiting for their signature.
- **Chat with you**: two-way messages with read receipts.

> E-signing needs your signing account to be set up. Keystone does this with you during onboarding.
`,
  },
  {
    slug: "send-application-link",
    title: "Send a client the application link",
    category: "Client app and applications",
    audience: "all_staff",
    plans: [],
    summary: "Get a prospect started, and help a client who stopped part way.",
    body: `
## Send the link
1. Open the contact in **CRM**.
2. Send them your client app's web address (it is in your welcome email) by text or email from the contact.
3. They sign in with their mobile number and start the application.

## A client stopped part way
- Their progress is saved. They sign in again with the same mobile number and carry on where they left off.
- Applicants who started but did not finish can get an automatic follow-up text, and you get a follow-up task. This needs your business phone number.

## Check readiness first
Use the **credit readiness check** to give a prospect a quick readiness score, then send them the application link from the result.
`,
  },
  {
    slug: "request-documents-and-forms",
    title: "Ask a client for documents or forms",
    category: "Client app and applications",
    audience: "all_staff",
    plans: [],
    summary: "Request items from the client and see what is still missing.",
    body: `
## Request an item
1. Open the deal from the **Pipeline**.
2. In the deal, request the document or form you need. The client sees it straight away in their portal as something to do.
3. When they upload or fill it in, it appears on the deal.

## Forms you can ask for
Personal net worth, CRA authorization, equipment and real-estate collateral, a debt list, professional advisors, lender questions and product questions.

## Let the accountant upload
The client can name their accountant. The accountant gets a link to upload financial statements directly, with no account needed.

> The **document checklist** shows what each lender product needs, both to you and to the client as "what you still need".
`,
  },
  {
    slug: "pipeline-stages",
    title: "Pipeline stages and moving deals",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "The stages every deal moves through, plus Hold and Fraud.",
    body: `
Every application is a card on the **Pipeline**. Drag a card to move it to the next stage.

## The stages
1. **Received**: a new application.
2. **In Review**: you are checking it.
3. **Documents Required**: waiting on the client.
4. **Additional Steps**: anything else before lenders see it.
5. **Off to Lender**: the package has gone out.
6. **Offer**: a lender has made an offer.
7. **Accepted**: the client accepted.
8. **Rejected**: declined.

**Hold** and **Fraud** are parking stages. A file on hold can be reactivated by the client.

## What happens when a deal moves
- The client sees the new stage in their portal and can get a notification.
- Hold and decline notices tell the client why.
- Automations can run on a stage change (Growth and Pro). See [Sequences and automations](kb:sequences-and-automations).
`,
  },
  {
    slug: "the-application-file",
    title: "Inside a deal: the application file",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "The tabs on each deal and what they are for.",
    body: `
Open any card on the **Pipeline** to see the whole file on one screen.

- **Application**: everything the client entered.
- **Banking Analysis**: balances, deposits, NSFs, a three-month trend and warning signs, read from the bank statements.
- **Financials**: figures read from financial statements and T2 returns, ready to check.
- **Documents**: every upload, sorted. See [Uploads, OCR and document sorting](kb:documents-and-ocr).
- **Credit Summary**: a six-section summary drafted for you to edit and export.
- **Notes**: notes with @mentions. People you mention are notified.
- **Lenders**: matching and submissions. See [Match a deal and send a lender package](kb:send-lender-package).
- **PGI**: Personal Guarantee Insurance for this client.

Each file also shows a **suggested next action** and **where it came from** (a lender, broker, referrer or the website).
`,
  },
  {
    slug: "offers-and-acceptance",
    title: "Record offers and get them accepted",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Add a lender's offer, let the client accept it, and send the term sheet for signing.",
    body: `
1. Open the deal and add the lender's offer: amount, rate, term and conditions.
2. Move the deal to **Offer**. The client sees the offer in their portal.
3. The client accepts it in the app.
4. The term sheet goes to the client for signing. Each e-signature request counts toward your signing allowance. See [E-signing: what's included](kb:e-signing-allowance).
5. Move the deal to **Accepted** when it is done.

> If a fee agreement applies, the client signs it in the app too. With QuickBooks connected, an invoice is created when they sign. See [Connect QuickBooks Online](kb:quickbooks-online).
`,
  },
  {
    slug: "documents-and-ocr",
    title: "Uploads, OCR and document sorting",
    category: "Documents and OCR",
    audience: "public",
    plans: [],
    summary: "How Keystone reads, sorts and checks every document.",
    body: `
Every document a client or staff member uploads is read automatically.

- **OCR on upload**: bank statements and financial statements are read as they arrive, so the numbers fill the Banking Analysis and Financials tabs.
- **Automatic sorting**: Keystone spots what each upload is and warns you when it was filed in the wrong category.
- **Missing months**: you see which months the bank statements cover and which are missing.
- **No duplicates**: the same file can't be uploaded twice.
- **Checklist**: the documents each lender product needs, shown to you and to the client.

## Accept or reject a document
1. Open the deal and go to **Documents**.
2. Accept it, or reject it with a reason.
3. The client is told what to replace and why.

> Documents count toward your pooled storage. See [Allowances, usage and overage](kb:allowances-usage-and-overage).
`,
  },
  {
    slug: "fraud-checks-by-plan",
    title: "Fraud checks and which plan has them",
    category: "Fraud protection",
    audience: "public",
    plans: [],
    summary: "Every fraud check, what it looks for, and the plan it comes with.",
    body: `
Every check gives a red, amber or green result with plain-English reasons. A check that isn't set up says "not set up". It never counts as a pass.

## Every plan
- **Document tamper scan**: editing software, re-saves, mixed fonts, text pasted over a scan.
- **Bank statement math check**: re-adds every transaction and checks the balances.
- **Duplicate document check**: the same file, ID or void cheque on another application.
- **Revenue vs bank deposits**: reported revenue compared with money actually deposited.

## Growth and Pro add
- **Business reality check**: website and phone-line age and mail-drop addresses. Address verification by an outside service is coming soon.
- **Phone and email risk**: internet phone lines, throwaway emails, brand-new domains.
- **ID checks**: name and date of birth on the ID, photos of screens, reused ID images. Verification by an outside ID service is coming soon.

## Pro adds
- **Device and location check**, **application behaviour signals**, **loan stacking detector**, **fraud network map**, **shared fraud watchlist** (see [Join the shared fraud watchlist](kb:shared-fraud-watchlist)), **inside-job alerts** and the **fraud score and lender pre-screen**.
- **Call voice check** (cloned or synthetic voices) is coming soon.
`,
  },
  {
    slug: "shared-fraud-watchlist",
    title: "Join the shared fraud watchlist",
    category: "Fraud protection",
    audience: "admins",
    plans: ["pro"],
    summary: "Check applicants against confirmed fraud from other Keystone brokerages, using hashed data only.",
    body: `
The shared watchlist warns you when an applicant matches confirmed fraud reported by another Keystone brokerage. Only scrambled (hashed) values are shared, never names or numbers, and only between brokerages that opted in.

## Opt in
1. Open **Settings** > **Company**.
2. Turn on the **shared fraud watchlist**.

## How it works
- When you move a file to **Fraud** and confirm it, its hashed details are shared.
- If you restore the file out of Fraud, they are withdrawn.
- Turning the watchlist off deletes everything your brokerage shared.

> The watchlist is on Pro, or during a Pro trial.
`,
  },
];
