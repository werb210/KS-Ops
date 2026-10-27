import type { SeedArticle } from "./index.js";

export const SECURITY_AND_DATA: SeedArticle[] = [
  {
    slug: "security-and-data-residency",
    title: "Security and where your data is stored",
    category: "Security and privacy",
    audience: "public",
    plans: [],
    summary: "Your own server and database in Canada, passwordless sign-in, audit log and 7-year retention.",
    body: `
## Your data stays in Canada
Each brokerage gets its **own server and database** in Microsoft Azure, **Canada Central**. Your data is never mixed with another brokerage's.

## Signing in
- No passwords: staff, clients, lenders and referrers sign in with a code sent to their phone.
- Passkeys and Face ID for faster, safer sign-in.
- Admins can require a passkey or two-step sign-in for everyone. See [Sign-in security and your devices](kb:sign-in-security-and-devices).
- Pro adds single sign-on with Microsoft or Google work accounts.

## Records and compliance
- An **audit log** of sign-ins, user and role changes, pipeline moves, uploads, exports and holds, with who and when.
- **7-year retention** for applications, documents, signed agreements, lender packages and the audit log.
- **Legal holds** and **privacy requests** (access, correction, deletion) built in, for PIPEDA and Quebec's Law 25.
- SIN and SSN are encrypted separately and deleted once everyone has signed.
- Contact consent is recorded, and callers hear a notice before a call is recorded.
`,
  },
  {
    slug: "sign-in-security-and-devices",
    title: "Sign-in security and your devices",
    category: "Security and privacy",
    audience: "all_staff",
    plans: [],
    summary: "See where you're signed in, sign out a device, and require strong sign-in.",
    body: `
## Your devices
1. Open **Settings** > **My Profile**.
2. See every device you're signed in on.
3. Sign out one device, or **sign out everywhere** (this one too).

## For Admins: Settings > Security
- See anyone's signed-in devices and sign them out, one device or everywhere. Do this the day someone leaves or loses a phone.
- Turn on **require a passkey or two-step sign-in** for everyone. You can only switch it on from a strong session yourself, so you can't lock yourself out.

Every sign-out and change is in the audit log.
`,
  },
  {
    slug: "single-sign-on",
    title: "Single sign-on with Microsoft or Google",
    category: "Security and privacy",
    audience: "admins",
    plans: ["pro"],
    summary: "Let staff sign in with their Microsoft or Google work account.",
    body: `
Single sign-on is on Pro (and during a Pro trial).

## Turn it on
1. Open **Settings** > **Single sign-on**.
2. Switch on **Sign in with Microsoft**, **Sign in with Google**, or both.
3. Optional: limit it to your company's Microsoft tenant or Google Workspace domain, so only your accounts can sign in.
4. Optional: **require single sign-on** for staff.
5. Save.

Admins can still sign in with a text code or a passkey, so you are never locked out if Microsoft or Google is down.

> A person's work email in Keystone must match their Microsoft or Google account. Check it in **Settings** > **User Management**.
`,
  },
  {
    slug: "privacy-requests",
    title: "Handle a privacy request",
    category: "Security and privacy",
    audience: "admins",
    plans: [],
    summary: "Record and complete access, correction and deletion requests.",
    body: `
When a client asks to see, correct or delete their information:

1. Open **Settings** > **Privacy requests** and record the request on the contact: access, correction or deletion, how it came in and when.
2. **Access**: export the contact's data and send it to them.
3. **Correction**: correct the contact's details from the request.
4. **Deletion**: carry out the deletion. Keystone shows what will be deleted and what must be kept, and why: records under the 7-year retention rule or a legal hold are kept.
5. Close the request as completed or refused, with a note.

Requests are listed by due date, open ones first. Every step is in the audit log.
`,
  },
  {
    slug: "retention-and-legal-holds",
    title: "Retention and legal holds",
    category: "Security and privacy",
    audience: "admins",
    plans: [],
    summary: "What is kept for 7 years, how to put a hold on records, and the retention report.",
    body: `
## 7-year retention
Applications, documents, signed agreements, lender packages and the audit log are locked for **7 years after the file closes**. They can't be deleted before then, even by an Admin.

## Legal holds
1. Open **Settings** > **Retention & legal holds**.
2. Place a hold on an application, contact or company, with a reason.
3. Nothing under a hold can be deleted or merged away until you release it.

## Retention report
The same page lists records past their 7 years that may now be deleted. Nothing is deleted automatically.
`,
  },
  {
    slug: "api-keys",
    title: "API keys and the REST API",
    category: "Integrations and API",
    audience: "admins",
    plans: ["pro"],
    summary: "Connect your own tools to your Keystone data.",
    body: `
API access is on Pro (and during a Pro trial).

## Create a key
1. Open **Settings** > **API**.
2. Choose a name for the key and its scope: **read** or **read and write**.
3. Copy the key now. It is shown **once**; Keystone only keeps a scrambled copy.

## Use it
The same page has the API documentation: the endpoints, examples and the OpenAPI description at a stable address.

## Revoke a key
Revoke it on **Settings** > **API**. It stops working at once. The list shows when each key was last used, so you can spot ones nobody needs.
`,
  },
  {
    slug: "webhooks-and-zapier",
    title: "Webhooks and Zapier",
    category: "Integrations and API",
    audience: "admins",
    plans: ["pro"],
    summary: "Send contacts, deals, stage changes, documents and notes to other tools as they happen.",
    body: `
Webhooks are on Pro (and during a Pro trial).

## Add a webhook
1. Open **Settings** > **Webhooks**.
2. Add the address that should receive events, and pick the events (for example new contacts, new deals, stage changes, documents and notes).
3. Copy the **signing secret**. It is shown once. Use it to check that each delivery really came from Keystone.

## Zapier
In Zapier, create a Zap with **Webhooks by Zapier** > **Catch Hook**, and paste its address into a new webhook here.

## Deliveries
The delivery log keeps 30 days. Failed deliveries are retried, and you can **Resend** any delivery.
`,
  },
  {
    slug: "quickbooks-online",
    title: "Connect QuickBooks Online",
    category: "Integrations and API",
    audience: "admins",
    plans: [],
    summary: "Create fee invoices in your QuickBooks when a client signs, and mark them paid when the deal funds.",
    body: `
1. Open **Settings** > **Company**.
2. Choose **Connect QuickBooks** and sign in to your QuickBooks Online company.
3. Approve the connection.

From then on, when a client signs a fee agreement, an invoice is created in your QuickBooks. When the deal funds, it is marked paid.

To stop, choose **Disconnect** on the same page.
`,
  },
  {
    slug: "import-from-hubspot-salesforce-pipedrive",
    title: "Import your data from HubSpot, Salesforce, Pipedrive or a spreadsheet",
    category: "Importing and exporting",
    audience: "public",
    plans: [],
    summary: "Bring contacts, companies, lenders, deals, notes and documents into Keystone, with a dry run and undo.",
    body: `
Admins import data in **Settings** > **Import data**.

## What you can bring over
Contacts, companies, lenders, lender products, deals, notes and documents, from a **HubSpot**, **Salesforce** or **Pipedrive** export, a spreadsheet (CSV), or a Keystone export.

## Steps
1. **Upload** the export file and say where it came from.
2. **Match columns** to Keystone fields. Keystone suggests the matches; save them to reuse next time. Your custom fields are in the list too.
3. **Preview** the first rows exactly as they will be imported, with any problems on each row.
4. **Check** with a dry run. Nothing is saved; you get a list of problems to fix.
5. **Import**. It runs in the background and shows progress.
6. Not right? **Undo** the whole import.

> Need a starting point? Download the template CSV for each record type on the same page.
`,
  },
  {
    slug: "get-help-and-contact-support",
    title: "Get help and contact Keystone support",
    category: "Getting support",
    audience: "all_staff",
    plans: [],
    summary: "Search the help articles, ask Maya, or send a request to the support team.",
    body: `
Open **Get help** in the sidebar (or **Settings** > **Help**).

1. **Search** the help articles, or browse by category.
2. **Ask Maya**, Keystone's support assistant. Maya answers from these articles and links the ones it used. It can also explain your own plan, allowances and connections.
3. Still stuck? Choose **Contact support**. Your conversation with Maya and the articles you tried are sent with the request, so you don't have to repeat yourself.

## Your requests
The same page lists your company's requests and their status. Choose **Reply** to add more information. Replies from Keystone come by email.

## Urgent?
Mark the request **Urgent - work is stopped**. How fast we reply depends on your [support level](kb:support-levels).
`,
  },
  {
    slug: "coming-soon",
    title: "Coming soon",
    category: "Getting support",
    audience: "public",
    plans: [],
    summary: "Features that are planned but not available yet.",
    body: `
These are planned but **not available yet**. We'll update this page as each one arrives.

- **Hold queue** for callers waiting on the main line (today calls ring the available people, then go to a message or voicemail).
- **Android staff apps** (the dialler and the iPad-style portal app). The client app already works on Android.
- **Gmail inbox reading** inside Keystone. Sending from Gmail works today.
- **Sending deals straight into a lender's own system** through an API. Email and download-link packages work today.
- **Lenders viewing your submitted files** inside the lender portal.
- **Custom roles and permissions** beyond Admin, Staff, Marketing and Ops.
- **Call voice check** for cloned or synthetic voices.
- **Outside ID-verification and address-verification services** for the ID and business reality checks (the in-house checks work today).
- **Taking client payments** through Keystone.
`,
  },
  {
    slug: "how-keystone-compares",
    title: "How Keystone compares with a general CRM",
    category: "Getting started",
    audience: "public",
    plans: [],
    summary: "What a lending brokerage gets in Keystone that a general-purpose CRM needs add-ons for.",
    body: `
General CRMs such as HubSpot, Salesforce and Pipedrive are built for any kind of sales team. Keystone is built only for commercial lending and business financing brokerages, so the lending work is already there.

## Built in, not bolted on
- A **branded client app** with a six-step application, document upload, e-signing and a client portal.
- **OCR and banking analysis** on statements and financials, a credit summary, and missing-month checks.
- **Lender matching** on your own lenders and products, and lender packages sent in one step.
- **Fraud checks** on every application.
- A **dialler, Apple Watch and iPad apps** on your own business numbers.
- Your own **AI assistant** that knows each client's file.
- **Canadian hosting**, 7-year retention and legal holds.

## Moving over
You can import from HubSpot, Salesforce, Pipedrive or a spreadsheet, with a dry run and undo. See [Import your data](kb:import-from-hubspot-salesforce-pipedrive).
`,
  },
];
