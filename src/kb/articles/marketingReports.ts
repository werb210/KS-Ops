import type { SeedArticle } from "./index.js";

export const MARKETING_AND_REPORTS: SeedArticle[] = [
  {
    slug: "email-and-text-campaigns",
    title: "Email and text campaigns",
    category: "Marketing",
    audience: "all_staff",
    plans: [],
    summary: "Send marketing email and texts to a segment, with consent and unsubscribe handled.",
    body: `
Open **Marketing** (Admins and the Marketing role).

## Send a campaign
1. Pick a saved segment. See [Tags and saved segments](kb:tags-and-segments).
2. Write the email or text. Use merge fields such as first name.
3. Send now or schedule it.

## Built in
- **Unsubscribes** are handled for you, and only contacts with consent get marketing texts. Text campaigns are for Canadian numbers.
- **Text then email**: if a marketing text gets no click or reply in 36 hours, a follow-up email goes out.
- **Tracked links**: short links in texts, with clicks recorded.

## Monthly limits on each plan
| | Starter | Growth | Pro |
| Campaign emails a month | 500 | 1,000 | 2,500 |
| People one text campaign can reach | 50 | 250 | 500 |

> Need more? The [Marketing add-on](kb:marketing-add-on) raises these limits.
`,
  },
  {
    slug: "sequences-and-automations",
    title: "Sequences and automations",
    category: "Marketing",
    audience: "all_staff",
    plans: [],
    summary: "Drip campaigns that stop when people reply, and workflows that run on their own.",
    body: `
## Sequences
A sequence is a series of emails and texts sent over days or weeks. It stops when the contact replies and respects quiet hours.
- Sequences running at once: Starter 2, Growth 5, Pro 10. The Marketing add-on removes the limit.

## Automations (Growth and Pro)
Build workflows in a visual builder.
- **Triggers**: a stage change, a rejected document, a client message, a missed call, a new contact or a booking.
- **Actions**: send a text or template email, create a task, set the owner, add a tag or a note, post to team chat, notify a client or staff member, wait, or branch on a condition.
- **Describe it in a sentence** and AI drafts the workflow for you to check.

Admins and the Marketing role edit automations; Staff can view them.
`,
  },
  {
    slug: "marketing-add-on",
    title: "The Marketing add-on",
    category: "Marketing",
    audience: "public",
    plans: [],
    summary: "Higher campaign limits and advanced marketing tools for $49 a month, on any plan.",
    body: `
Every plan can market to its own client list. The **Marketing add-on** raises the limits and adds the advanced tools.

## Price
**$49 CAD a month**, flat, one per brokerage, on any plan. Pro does not include it. Both free trials include it.

## What it adds
- **10,000 more campaign emails** each month. Beyond that, $10 for each further 10,000.
- **1,000 marketing texts** a month that don't count against your plan's texts.
- Text campaigns to up to 1,000 people at once.
- **Unlimited sequences**, unlimited website lead forms and full visitor history.
- **Website kit**: lead forms, the AI chat widget and the tracking script for your own website.
- Lead scoring, subject-line A/B tests, send at each person's best time, and a campaign report that follows applications and funded deals.
- Session replay and the full Google Ads tools for plans that don't already have them.

Admins plus up to 3 people with the Marketing role use the advanced tools. To add it, ask from **Get help** or talk to the Keystone team.
`,
  },
  {
    slug: "dashboard-and-reports",
    title: "Dashboard and reports",
    category: "Reports",
    audience: "all_staff",
    plans: [],
    summary: "Key numbers on every plan; 47 ready-made reports and custom reports on Growth and Pro.",
    body: `
## Dashboard (every plan)
A board of cards you can move and resize. Starter has key numbers, the pipeline, drop-offs, document issues and team. Growth and Pro can add every card.

## Reports (Growth and Pro)
Open **Reports** for 47 ready-made reports, including pipeline by stage, visits to funded, funnel and drop-offs, lender scorecard, speed to lead, won vs lost, call outcomes, commission, revenue forecast, decline reasons, document turnaround and staff activity.

- **Custom report**: build your own.
- **Goals**: set and track team goals.
- **Commission**: commission receivable, by month, and broker payouts.

## Monday summary
A weekly business summary email every Monday.
`,
  },
  {
    slug: "your-ai-assistant",
    title: "Your own AI assistant",
    category: "AI assistant",
    audience: "admins",
    plans: [],
    summary: "Name it, train it on your products, and see the monthly chat allowance.",
    body: `
Your brokerage has its own AI assistant, with the name you choose. It helps website visitors, clients and staff.

- **Visitors**: answers questions, gives a readiness score, lists the documents they'll need, captures the lead and hands over to a person.
- **Clients**: application status, their to-do list, help with form fields and signatures.
- **Staff**: pipeline questions, finding contacts, notes and tasks, email drafts, summaries, lender-match reasons and a daily briefing. It asks before sending anything.

## Train and tune it
1. Open **Settings** > **AI Knowledge**.
2. Add text, web pages and files about your products. Your lender products and marketing material sync in by themselves.
3. Adjust its tone and behaviour under tuning.

## Chat allowance
Starter 200 chats a month, Growth 1,000, Pro unlimited, shared by the brokerage.

> Ask Maya in **Get help** is different: it is Keystone's support assistant, it only answers questions about using Keystone, and it never counts against your chat allowance.
`,
  },
];
