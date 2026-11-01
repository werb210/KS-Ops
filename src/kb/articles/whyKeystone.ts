// KS_OPS_MAYA_TRAINING_v1 - public articles for the website's sales assistant (seed version 2): why brokers switch,
// Keystone next to each general CRM (prices copied from KS-Website src/data/compare.ts, each with its source and the
// day it was checked), compliance, automations, moving over, the apps, lender integrations, contracts, the roadmap and
// the questions brokers ask before they switch. Same rules as every starter article: published prices only, never
// internal costs, never the private line, and anything not built is "coming soon".
import type { SeedArticle } from "./index.js";

const CHECKED = "October 26, 2026";
const VS_NOTE = `Competitor prices are list prices from each company's own public pages, checked ${CHECKED}, in the currency that company shows (we never convert them). Check their sites for current details. Keystone prices are in Canadian dollars; Maya quotes them from the live price list.`;

export const WHY_KEYSTONE: SeedArticle[] = [
  {
    slug: "why-switch-to-keystone",
    title: "Why brokers switch to Keystone",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "One system built for commercial lending: CRM, client app, documents, fraud checks, lenders, phones and compliance, instead of a general CRM plus add-ons.",
    body: `
Keystone is built only for commercial lending and business financing brokerages. Most brokers who switch were running a general CRM (HubSpot, Salesforce, Zoho or Pipedrive) plus separate tools for marketing, calling and texting, e-signing, document collection and fraud checks.

## What changes when you switch
- **One login, one bill.** Pipeline and CRM, a branded client app, document reading (OCR), lender matching and packages, fraud checks, a business phone line with an iPhone dialler, texting, e-signing, automations and an AI assistant are in one system.
- **Built for lending, not adapted to it.** The loan file is already there: banking analysis, figures from financial statements, a credit summary draft, a document checklist per lender product and lender matching on your own lenders.
- **Fraud checks on every application.** Tampered statements, bad statement math, reused documents and revenue that doesn't match deposits are flagged on every plan. See [Fraud checks and which plan has them](kb:fraud-checks-by-plan).
- **Compliance built in.** Your own server and database in Canada, 7-year record retention, legal holds, consent records, quiet hours for texts and an audit log. See [Compliance and security built in](kb:compliance-built-in).
- **Your brand everywhere.** Clients, referrers and lenders only see your name, logo and colours.

## What it costs
Seats are priced per person per month on Starter, Growth or Pro, with call minutes and texts included and pooled across your team. See [Plans compared](kb:plans-compared). Matching Keystone Growth plus the Marketing add-on in a general CRM usually takes three or four separate products: see the comparisons with [HubSpot](kb:keystone-vs-hubspot), [Salesforce](kb:keystone-vs-salesforce), [Zoho](kb:keystone-vs-zoho) and [Pipedrive](kb:keystone-vs-pipedrive), or the full table on the website's Compare page.

## Moving over
Import from HubSpot, Salesforce, Pipedrive or a spreadsheet with a dry run and undo, and your copy is set up within one business day of payment. See [Switching to Keystone](kb:switching-to-keystone).
`,
  },
  {
    slug: "keystone-vs-hubspot",
    title: "Keystone compared with HubSpot",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "What a 5-person brokerage buys from HubSpot to match Keystone Growth with the Marketing add-on, and what HubSpot doesn't do for lending.",
    body: `
HubSpot Sales Hub is common with small brokerages for lead generation and follow-up. To match Keystone Growth with the Marketing add-on for **5 people**, HubSpot's Canadian price calculator lists (billed annually, CAD):

| Product | A month | One-time |
| Sales Hub Professional, 5 seats (CAD $117 a seat) | CAD $585 | CAD $1,950 onboarding |
| Marketing Hub Professional (2,000 marketing contacts) | CAD $1,034 | CAD $3,700 onboarding |
| Marketing SMS add-on (1,000 segments a month) | CAD $100 | |
| Sales and Service SMS add-on (two-way texting) | CAD $100 | |
| **Total** | **CAD $1,819** | **CAD $5,650** |

First year: **CAD $27,478**. HubSpot sends texts only from U.S. phone numbers.

## Keystone for the same team
Keystone Growth for 5 seats plus the Marketing add-on ($49 a month, flat). Maya gives today's figures from the live price list, or see the Pricing page.

## What HubSpot doesn't include for lending
A loan application your clients fill in, a borrower portal (needs Service Hub Professional or Enterprise), bank statements and financials read on upload, fraud checks, lender matching and lender packages.

## Where HubSpot is strong
A large app marketplace and developer tools, and a free tier to start on.

Sources: HubSpot price calculator in CAD (hubspot.com/pricing/bundle), HubSpot Sales Hub features (hubspot.com/products/sales), HubSpot SMS help (knowledge.hubspot.com). ${VS_NOTE}
`,
  },
  {
    slug: "keystone-vs-salesforce",
    title: "Keystone compared with Salesforce",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "What a 5-person brokerage buys from Salesforce to match Keystone Growth with the Marketing add-on, and what Salesforce doesn't do for lending.",
    body: `
Salesforce Sales Cloud is the most widely used CRM, and brokers usually customise it for lending. To match Keystone Growth with the Marketing add-on for **5 people**, Salesforce's Canadian site lists (in USD, billed annually):

| Product | A month |
| Sales Cloud Pro Suite, 5 seats (USD $100 a seat) | USD $500 |
| Marketing Cloud Account Engagement Growth+ (up to 10,000 contacts) | USD $1,250 |
| Sales Dialer, 5 users (from USD $5 a user) | from USD $25 |
| Marketing SMS | from USD $2 per 1,000 credits, plus set-up Salesforce doesn't price publicly |
| **Total** | **from USD $1,775** |

First year: **from USD $21,300**. Salesforce publishes no onboarding fee.

## Keystone for the same team
Keystone Growth for 5 seats plus the Marketing add-on ($49 a month, flat), in Canadian dollars. Maya gives today's figures from the live price list.

## What Salesforce doesn't include for lending
A branded loan application, document reading on upload, fraud checks, lender matching and lender packages. Customer and partner portals are sold as separate licences.

## Where Salesforce is strong
It can be customised for almost anything, if you have an administrator to build it.

Sources: Salesforce Canada Sales Cloud pricing, Marketing Cloud Account Engagement pricing and Sales Cloud add-on pricing (salesforce.com). ${VS_NOTE}
`,
  },
  {
    slug: "keystone-vs-zoho",
    title: "Keystone compared with Zoho CRM",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Zoho is lower cost per seat; what it takes to match Keystone, and what Zoho doesn't do for lending.",
    body: `
Zoho CRM is a low-cost general CRM that tops some finance-broker lists. To match Keystone Growth with the Marketing add-on for **5 people**, Zoho lists (billed annually):

| Product | A month |
| Zoho CRM Professional, 5 seats (CAD $31 a seat) | CAD $155 |
| Zoho Marketing Automation Professional (1,000 contacts) | from CAD $27 |
| Zoho Voice Standard (calls and texts; call and text charges extra) | from USD $49 |
| **Total** | **from CAD $182 + USD $49** |

## The honest answer
Zoho costs less per seat. What you add on top is the lending work Keystone already does: a branded loan application and client app, bank statements and financials read on upload, fraud checks, lender matching and lender packages, and calls and texts included in the seat price. Zoho's portals are custom portals, not built for loan applicants.

## Keystone for the same team
Keystone Growth for 5 seats plus the Marketing add-on ($49 a month, flat). Maya gives today's figures from the live price list.

Sources: Zoho CRM pricing, Zoho Marketing Automation pricing and Zoho Voice pricing (zoho.com). ${VS_NOTE}
`,
  },
  {
    slug: "keystone-vs-pipedrive",
    title: "Keystone compared with Pipedrive",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Pipedrive is a simple sales pipeline; what it takes to match Keystone, and what Pipedrive doesn't do for lending.",
    body: `
Pipedrive is a simple visual pipeline many small brokerages start on. To match Keystone Growth with the Marketing add-on for **5 people**, Pipedrive's Canadian pricing lists (billed annually):

| Product | A month |
| Premium, 5 seats (CAD $79 a seat) | CAD $395 |
| Campaigns add-on (rises with your contacts) | from CAD $13.33 |
| Calling and texting app from the Pipedrive Marketplace | priced by the app's maker |
| **Total** | **from CAD $408.33**, plus calling |

Bulk texting, email A/B tests and Google Ads conversion sync aren't stated on Pipedrive's pricing page.

## The honest answer
Pipedrive costs less per seat for a pipeline. Keystone adds what a lending brokerage needs around it: the branded loan application and client app, document reading, fraud checks, lender matching and packages, a business phone line with minutes and texts included, and 7-year record retention in Canada.

## Keystone for the same team
Keystone Growth for 5 seats plus the Marketing add-on ($49 a month, flat). Maya gives today's figures from the live price list.

Sources: Pipedrive pricing (pipedrive.com/en/pricing), Pipedrive calling help (support.pipedrive.com). ${VS_NOTE}
`,
  },
  {
    slug: "compliance-built-in",
    title: "Compliance and security built in",
    category: "Security and privacy",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Everything Keystone enforces: Canadian hosting, your own database, retention, legal holds, consent, texting rules, recording notices, audit log and sign-in security.",
    body: `
Keystone gives you the tools; your brokerage stays responsible for how it collects and uses client information.

## Where your data lives
- Your **own server and database** in Microsoft Azure **Canada Central**, never shared with another brokerage.
- Encrypted connections (HTTPS) and encrypted storage. **SIN and SSN** are encrypted separately (AES-256) and **deleted once everyone has signed**.

## Records
- **7-year retention**: applications, documents, signed agreements, lender packages and the audit log are locked for 7 years after the file closes. The server refuses earlier deletes.
- **Legal holds** on an application, contact or company. Nothing under a hold can be deleted.
- Nothing is deleted automatically after 7 years: an Admin decides.
- **Export everything** as one zip, even after cancelling.

## Privacy and consent
- **Consent records**: how and when each contact agreed to be contacted, and where it came from.
- **Privacy requests** (access, correction, deletion) recorded with a 30-day due date, for PIPEDA and Quebec's Law 25. A deletion keeps records the 7-year rule or a legal hold protects, and opts the person out of marketing.
- **Quebec**: the client app waits for consent before loading Google tags for visitors in Quebec.
- Cookie choices are recorded, with the visitor's address kept only as a scrambled hash.

## Texting and calling rules
- **CASL**: marketing texts go only to people with express consent, or implied consent that hasn't expired (2 years after a transaction, 6 months after an enquiry), and never to anyone who opted out. Bulk marketing texts go to Canadian mobiles only.
- **STOP, UNSUBSCRIBE and similar replies** opt a person out of texts from every part of the system; START opts them back in.
- **Quiet hours**: automations and sequences hold messages until the allowed hours in your brokerage's time zone.
- **US texting**: texts to US mobiles go from your own toll-free line once its verification is approved (or your US line once A2P 10DLC registration is approved). Until then they wait instead of going out unregistered.
- **Call recording notice**: callers hear a notice before a recorded call connects.
- Blocked numbers never ring your staff.

## Signing in and access
- No passwords: a code sent to the phone, plus **passkeys** and **Face ID** on the apps.
- Admins can **require a passkey or two-step sign-in** for staff, see every signed-in device and sign people out everywhere.
- **Single sign-on** with Microsoft or Google work accounts on Pro.
- Fixed roles (Admin, Staff, Marketing, Ops), and **teams and record visibility** on Growth and Pro.
- An **audit log** of sign-ins, user and role changes, pipeline moves, uploads, exports and holds, with who and when.

## Fraud checks
Every application is checked before it goes to a lender. See [Fraud checks and which plan has them](kb:fraud-checks-by-plan).
`,
  },
  {
    slug: "automations-for-brokers",
    title: "Automations, sequences and task queues",
    category: "Marketing",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Workflows that text, email, create tasks and move deals for you; drip sequences that stop on reply; shared task queues and lead rotation.",
    body: `
## Automations (Growth and Pro)
A visual workflow builder. Something happens, Keystone acts.
- **Triggers**: a deal changes stage, a document is rejected, a client sends a message, a call is missed, a new contact is added, a client books a call.
- **Actions**: send a text or a template email, create a task, set the owner, add a tag or a note, post to a team channel, notify the client or your staff, wait, or branch on a condition.
- Describe a workflow in a sentence and the assistant drafts it for you to check.
- Messages respect **quiet hours** in your brokerage's time zone.

## Sequences
Drip campaigns of emails and texts that **stop when the contact replies** and respect quiet hours. The [Marketing add-on](kb:marketing-add-on) makes them unlimited.

## Tasks and queues
- Tasks with due dates, priorities and reminders, synced with Microsoft To Do or Google Tasks.
- **Shared task queues** and a "start N tasks" mode that works through them one by one.
- **Lead rotation**: new website and booking leads get an owner in turn, skipping people who are away.
- After a call, email or meeting, Keystone suggests the follow-up task with your default due time.

## Built-in follow-ups
Applicants who start but don't finish get a reminder text and you get a follow-up task. When a deal funds, Growth and Pro can send a short survey and ask happy clients for a Google review.
`,
  },
  {
    slug: "switching-to-keystone",
    title: "Switching to Keystone: moving your data, team and phones",
    category: "Importing and exporting",
    audience: "public",
    plans: [],
    since: 2,
    summary: "How a brokerage moves over: set-up within one business day, import with a dry run and undo, your lenders, your team and your numbers.",
    body: `
1. **Sign up and pay online.** Your copy is set up within one business day and your sign-in details are emailed to you.
2. **Bring your data.** In **Settings** > **Import data**, import contacts, companies, lenders, lender products, deals, notes and documents from a HubSpot, Salesforce or Pipedrive export or a spreadsheet. Preview the rows, run a dry run, then import. Not right? Undo the whole import. See [Import your data](kb:import-from-hubspot-salesforce-pipedrive).
3. **Add your lenders.** You bring the lenders you already work with; your relationships and terms stay yours.
4. **Invite your team.** Staff sign in to the portal, the iPhone dialler and the iPad app with their work email or mobile number.
5. **Phones.** Keystone sets up a local business number for you (and a toll-free number on Growth and Pro). Moving a number you already have isn't self-serve yet: talk to the Keystone team about it before you switch.
6. **Branding.** Your logo, colours and font are set at sign-up. Your branded client app is published under your own Apple and Google developer accounts; until then clients use the same client portal as a website.

## Help while you switch
Growth and Pro include onboarding help (a one-time onboarding fee) to get your team, lenders and branding in place. Every brokerage gets the help articles and Maya; the Priority, Premium and Dedicated [support levels](kb:support-levels) add live sessions, and Premium and Dedicated add training.

## Your data stays yours
An Admin can download everything as one zip at any time, including after cancelling.
`,
  },
  {
    slug: "mobile-apps-overview",
    title: "Keystone's mobile apps",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    since: 2,
    summary: "A branded client app for iPhone and Android, an iPhone dialler, an Apple Watch app and the staff portal on iPad.",
    body: `
## For your clients
Your brokerage's own app on iPhone and Android, with your name, icon and colours, or the same client portal as a website in any browser: their choice. Clients apply in six steps, upload documents with the camera, sign, chat with you and see what's still needed. See [How clients apply](kb:client-application-wizard).

## For your staff
- **iPhone dialler** (every plan): calls and texts from your business number using the iPhone's own call screen, with the caller's file on screen, call outcomes, voicemail and voice notes.
- **Apple Watch** (Growth and Pro): dial, see calls due, voicemail and quick replies, and take calls without the iPhone.
- **iPad** (every plan): the full staff portal as an app, with calls, Face ID, card scanning and document markup.

## Coming soon
Android apps for staff. The client app already works on Android.
`,
  },
  {
    slug: "lender-integrations-status",
    title: "Lenders: what's connected today",
    category: "Lenders",
    audience: "public",
    plans: [],
    since: 2,
    summary: "How deals reach lenders today (email and download-link packages, the lender portal) and what's coming soon.",
    body: `
## Today
- **Lender matching** ranks your own lenders' products for each deal and lists any missing inputs.
- **Lender packages**: build the package once and email it to the lenders you pick. Large packages go as a secure download link. You can see what went to whom and send again.
- **Lender portal** (every plan): lenders sign in with a text code, keep their details and products up to date, and send you deals they couldn't place.
- **Fraud pre-screen** in the package on Pro.

## Coming soon
- Sending deals straight into a lender's own system through an API.
- Lenders viewing your submitted files inside the lender portal.

Keystone doesn't provide lenders: you bring the ones you already work with.
`,
  },
  {
    slug: "contracts-and-cancelling",
    title: "Contracts, billing and cancelling",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Monthly or yearly billing, how to cancel, and what happens to your data.",
    body: `
- **Billing**: choose monthly or yearly when you sign up. Yearly billing is charged once a year at the lower seat price; monthly billing is charged every month. Onboarding fees (Growth and Pro) are charged once with your first payment.
- **Paying**: Canadian pre-authorized debit (the default) or credit card, through Stripe's secure checkout.
- **Changing plan or seats**: ask from inside the app or talk to the Keystone team. Features a lower plan doesn't include are locked, not deleted.
- **Cancelling**: send a cancellation request from **Get help**. Your data is kept for **180 days** with warning emails, and an Admin can download everything as one zip, before or after cancelling. After that it is deleted, except records inside their 7 years or under a legal hold.

For anything about your agreement, talk to the Keystone team.
`,
  },
  {
    slug: "roadmap-and-feature-requests",
    title: "The roadmap and asking for a feature",
    category: "Getting support",
    audience: "public",
    plans: [],
    since: 2,
    summary: "See what's requested, planned, being built and shipped, +1 the ideas you want, and suggest your own.",
    body: `
The website's **Roadmap** page lists what brokers have asked for, what's planned, what's being built and what has shipped.
- **+1** the ideas you want most. Votes help decide what comes next.
- **Suggest a feature** with the form on the same page. The Keystone team reviews every idea before it appears. Only the idea is shown, never your name or email.
- Want to try new features early? Join the beta programme.
`,
  },
  {
    slug: "questions-before-switching",
    title: "Questions brokers ask before switching",
    category: "Why Keystone",
    audience: "public",
    plans: [],
    since: 2,
    summary: "Straight answers on price, risk, data ownership, training, lenders and what isn't built yet.",
    body: `
## "We already pay for a CRM."
Count everything around it: marketing email, calling and texting, e-signing, document collection and fraud checks are usually separate bills. Keystone's seat price includes call minutes and texts, and the lending tools are built in. See [Why brokers switch](kb:why-switch-to-keystone).

## "It looks expensive per seat."
General CRMs can cost less per seat for a pipeline alone. Compare what you'd buy to match Keystone Growth with the Marketing add-on: see the comparisons with [HubSpot](kb:keystone-vs-hubspot), [Salesforce](kb:keystone-vs-salesforce), [Zoho](kb:keystone-vs-zoho) and [Pipedrive](kb:keystone-vs-pipedrive).

## "Moving our data is risky."
Imports have a preview, a dry run and an undo, and your old system keeps running until you're ready. See [Switching to Keystone](kb:switching-to-keystone).

## "Who owns our data?"
You do. It's in your own database in Canada, and an Admin can download all of it as one zip at any time, including after cancelling.

## "Will my team learn it?"
It's built around the work brokers already do. There are help articles and Maya for every brokerage, onboarding help on Growth and Pro, and training on the Premium and Dedicated support levels.

## "Can we try it first?"
Yes: the self-serve demo on the website, and a 14-day trial of every Pro feature for Starter and Growth customers. See [Free trials and the self-serve demo](kb:free-trials-and-demo).

## "What isn't built yet?"
We say so plainly. See [Coming soon](kb:coming-soon) and the website's roadmap.
`,
  },
];
