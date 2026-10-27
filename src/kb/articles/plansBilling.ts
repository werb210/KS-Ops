import type { SeedArticle } from "./index.js";

export const PLANS_AND_BILLING: SeedArticle[] = [
  {
    slug: "plans-compared",
    title: "Plans compared: Starter, Growth and Pro",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    summary: "Seat prices, onboarding fees and what each plan adds. Prices in CAD.",
    body: `
Keystone is licensed per seat. Prices are in Canadian dollars, per seat per month.

| | Starter | Growth | Pro |
| Billed yearly | $49 | $119 | $199 |
| Billed monthly | $59 | $139 | $229 |
| One-time onboarding | none | $750 | $2,000 |
| Minimum seats | 1 | 1 | 2 |

## Every plan
Contacts and pipeline, the branded client app and application wizard, the iPhone dialler and iPad app, Outlook email sync, your AI assistant, the lender portal, PGI referrals, call recording, custom fields, the phone menu, booking pages and the core fraud checks.

## Growth adds
Call recording playback, AI call summaries, voicemail transcription, the Apple Watch app, templates and snippets, automations, the referrer and broker portals, reports, website visitor tracking, a toll-free number, teams and record visibility, and more fraud checks.

## Pro adds
Multiple business lines and a direct line for each person, ad attribution, API access, single sign-on, webhooks and Zapier, and every fraud check.

See also [Allowances, usage and overage](kb:allowances-usage-and-overage) and [Support levels](kb:support-levels).
`,
  },
  {
    slug: "allowances-usage-and-overage",
    title: "Allowances, usage and overage",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    summary: "Minutes, texts, assistant chats and storage included per plan, and what happens if you go over.",
    body: `
Allowances are **per seat** and **pooled** across the brokerage each month.

| Per seat, per month | Starter | Growth | Pro |
| Call minutes | 50 | 500 | 1,500 |
| Texts | 100 | 500 | 1,500 |
| Document storage | 10 GB | 25 GB | 50 GB |

Assistant chats are per brokerage: Starter 200 a month, Growth 1,000, Pro unlimited.

## Going over
Nothing is cut off. Usage over the pool is billed on the next invoice:
- **$0.04** a minute;
- **$0.03** a text;
- extra storage in **50 GB blocks at $10 a month**.

## See your usage
Open **Settings** > **Plan**. **This month** shows minutes, texts, assistant chats and storage against your pool. Bars turn amber at 80% and red at 100%, and Admins get an email as you get close.

> E-signing has its own allowance. See [E-signing: what's included](kb:e-signing-allowance).
`,
  },
  {
    slug: "e-signing-allowance",
    title: "E-signing: what's included",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    summary: "4 signings a month included per brokerage, then $2.50 each.",
    body: `
Clients sign applications, fee agreements and term sheets inside the client app. Referrers and partner brokers sign their agreements the same way.

- Every brokerage includes **4 signings a month**, whatever the plan or number of seats.
- A signing is one signature request sent to one signer. A document with two owners signing is two signings.
- Each signing after that is **$2.50**, on the next month's invoice.
- Signing is never blocked when you go over.

You can see this month's signings in **Settings** > **Plan**.
`,
  },
  {
    slug: "free-trials-and-demo",
    title: "Free trials and the self-serve demo",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    summary: "Try Keystone before you buy, and try Pro features on Starter or Growth.",
    body: `
## The self-serve demo
On the Keystone website, choose **Try it yourself**. You get a private demo for 7 days, with sample data: take an application through to a lender package and see what your clients see.

## The 14-day Pro trial (for Starter and Growth)
Already a customer on Starter or Growth? An Admin can try every Pro feature free for 14 days, once.
1. Open **Settings** > **Plan**.
2. Start the free trial.
3. You get every Pro feature plus 100 bonus minutes and 100 bonus texts per seat, and the Marketing add-on.
4. When it ends you go back to your plan. Nothing you made is deleted. To keep Pro, request an upgrade on the same page.

## A trial set up by Keystone
Talking to the Keystone team? They can start a trial for your brokerage with no payment up front.
`,
  },
  {
    slug: "support-levels",
    title: "Support levels",
    category: "Plans and billing",
    audience: "public",
    plans: [],
    summary: "Email support is free; Priority, Premium and Dedicated add faster replies and live help.",
    body: `
| Level | Price a month | Seats covered | First reply | Live help |
| Email | free | any | 1 business day | none |
| Priority | $199 (+$15 a seat over 10) | 10 | 4 business hours | 2 hours of voice or screen-share sessions a month |
| Premium | $499 (+$30 a seat over 10) | 10 | 1 business hour | 6 hours of sessions a month and a quarterly training call |
| Dedicated | $1,200 (+$40 a seat over 25) | 25 | 30 minutes | 15 hours of sessions a month and new-staff training; 7 am to 9 pm Mountain, with a named contact |

Every level includes the Help Center and Ask Maya. Prices are in CAD. To change your level, send a support request from **Get help**.
`,
  },
  {
    slug: "seats-and-changing-plan",
    title: "Seats, plans and changing plan",
    category: "Plans and billing",
    audience: "admins",
    plans: [],
    summary: "Add seats, upgrade, add storage or change your support level.",
    body: `
## Upgrade your plan
1. Open **Settings** > **Plan**.
2. Compare the plans and choose **Request upgrade**.
3. Keystone confirms by email and the change shows in the portal once it is made. Your subscription is adjusted for the rest of the period.

## Add seats or storage
- **Storage**: on **Settings** > **Plan**, ask to add 50 GB.
- **Seats**: send a support request from **Get help** with how many seats you need.

## Downgrade
Send a support request. Features your new plan doesn't include are locked, not deleted.
`,
  },
  {
    slug: "billing-and-invoices",
    title: "Billing, invoices and payment methods",
    category: "Plans and billing",
    audience: "admins",
    plans: [],
    summary: "How you are billed, how to pay, and what happens if a payment fails.",
    body: `
- You are billed **monthly or yearly** for your seats, support level and any extra storage or add-ons, in CAD.
- Usage over your allowances (minutes, texts, e-signings, campaign emails with the Marketing add-on) is billed on the next month's invoice.
- You pay by **Canadian pre-authorized debit** or by **card**. Invoices are emailed to your billing contact.

## Change how you pay
Send a support request from **Get help**. We'll send you a secure link to set up the new payment method.

## If a payment fails
Your account shows as past due and the billing contact gets a reminder every 3 days until it is paid. An account left unpaid can be suspended, so contact us early if you need time.
`,
  },
  {
    slug: "cancelling-and-your-data",
    title: "Cancelling and what happens to your data",
    category: "Plans and billing",
    audience: "admins",
    plans: [],
    summary: "Your data is kept for 180 days after cancelling, and you can export it all.",
    body: `
1. Send a cancellation request from **Get help**.
2. Before or after cancelling, an Admin can download everything: open **Settings** > **Import data** and choose **Download this portal's data**. It still works after cancelling.
3. Your data is kept for **180 days** after cancelling, and you get warning emails before it is deleted.
4. After 180 days it is deleted, except records that must be kept for 7 years and anything under a legal hold. See [Retention and legal holds](kb:retention-and-legal-holds).
`,
  },
];
