// KS_OPS_KB_v5 - feature-by-feature articles: fraud checks, underwriting tools and lenders.
import type { SeedArticle } from "./index.js";

const fraud = (slug: string, title: string, plans: SeedArticle["plans"], summary: string, body: string): SeedArticle => ({
  slug, title, category: "Fraud protection", audience: "all_staff", plans, summary, body,
});

export const FEATURES_UNDERWRITING: SeedArticle[] = [
  fraud("fraud-results-explained", "Reading fraud results: red, amber, green and \"not set up\"", [],
    "What each result means and what to do about it.", `
Each fraud check gives one of four results, always with reasons:
- **Green**: nothing found.
- **Amber**: something worth a look. Read the reason and decide.
- **Red**: a strong sign of a problem. Don't send the file to lenders until you've checked it.
- **Not set up**: the outside service this check uses isn't connected. It is never counted as a pass.

On Pro, the results roll up into one 0-100 score. See [Fraud score and lender pre-screen](kb:fraud-score-and-pre-screen).

Fraud results are internal. Clients never see them.
`),
  fraud("fraud-document-tamper-scan", "Fraud check: document tamper scan", [],
    "Looks for edited PDFs and images.", `
Every uploaded document is checked for signs of editing: editing software in the file's history, re-saves after creation, mixed fonts, and text pasted over a scanned image.

**What to do with a red result:** ask the client for the original (for bank statements, a download straight from online banking), and compare.
`),
  fraud("fraud-statement-math-check", "Fraud check: bank statement math", [],
    "Re-adds every transaction and checks the balances.", `
Keystone re-adds each transaction and checks the running and closing balances. Edited statements often break the math: a changed deposit no longer adds up to the closing balance.

A failure shows the line where the numbers stop adding up.
`),
  fraud("fraud-statement-vs-bank-data", "Fraud check: statements vs live bank data", [],
    "Compares uploaded statements with the client's connected bank account.", `
When the client connects their bank (view-only), Keystone compares the uploaded statements with what the bank reports. Any difference in deposits or balances is flagged.

This needs the Bank Connect add-on, switched on by Keystone. Without it, this check shows **Not set up**.
`),
  fraud("fraud-duplicate-documents", "Fraud check: the same document on another application", [],
    "Finds the same file, ID or void cheque used elsewhere.", `
Keystone checks whether a document, ID image or void cheque on this deal also appears on a different application in your brokerage. Reused documents are a common sign of identity or application fraud.

The result links to the other application so you can compare.
`),
  fraud("fraud-revenue-vs-deposits", "Fraud check: reported revenue vs bank deposits", [],
    "Does the revenue on the application match the money coming in?", `
Keystone compares the revenue the client reported with the deposits on their bank statements. A large gap (for example, reported revenue of $80,000 a month with $20,000 in deposits) is flagged with the numbers side by side.
`),
  fraud("fraud-business-reality-check", "Fraud check: is the business real?", ["growth", "pro"],
    "Registration, directors, mail-drop addresses, and website and phone age.", `
Checks that the business looks real:
- the age of its website domain and phone line,
- mail-drop or virtual-office addresses,
- federal registration and directors (needs Keystone to connect the Corporations Canada service).

Parts that aren't connected show **Not set up** rather than passing.
`),
  fraud("fraud-phone-email-risk", "Fraud check: phone and email risk", ["growth", "pro"],
    "Internet phone lines, throwaway emails and brand-new domains.", `
Flags:
- internet (VoIP) phone numbers instead of mobiles or business lines,
- disposable email addresses,
- email domains registered very recently,
- a name that doesn't match the email.

Each lookup has a small cost, included in your plan.
`),
  fraud("fraud-id-checks", "Fraud check: ID documents", ["growth", "pro"],
    "Name and date-of-birth match, photos of screens, reused ID images.", `
Checks the ID the client uploaded:
- the name and date of birth match the application,
- the photo isn't a picture of a screen,
- the same ID image hasn't been used on another application.

Growth includes 10 ID and selfie checks a month and Pro includes 30; each extra check is $4.00 on your next bill.
`),
  fraud("fraud-device-location", "Fraud check: device and location", ["pro"],
    "VPNs, many businesses from one device, applications from outside your region.", `
Looks at how the application was made: a VPN or proxy, several different businesses applying from the same device, or an application from far outside the regions you serve.
`),
  fraud("fraud-behaviour-signals", "Fraud check: application behaviour", ["pro"],
    "Pasted ID numbers, impossibly fast applications, copied answers.", `
Flags behaviour that real applicants rarely show: identity numbers pasted rather than typed, an application completed impossibly fast, or answers copied word for word from another application.
`),
  fraud("fraud-loan-stacking", "Fraud check: loan stacking", ["pro"],
    "Finds undisclosed advances and daily or weekly lender debits.", `
Scans bank transactions for cash advances and daily or weekly lender withdrawals the client didn't disclose. Each one is listed with the lender name (where recognised), amount and frequency, so you can ask the client about it before you submit.
`),
  fraud("fraud-network-map", "Fraud check: the fraud network map", ["pro"],
    "Links applications that share a phone, email, address, bank account, device or director.", `
Draws a map of any other applications that share details with this one: phone, email, address, bank account, device or director. Rings of linked applications are a strong sign of organised fraud.
`),
  fraud("fraud-inside-job-alerts", "Inside-job alerts", ["pro"],
    "Admins are told when staff change banking details, export in bulk or approve their own file.", `
Admins get an alert when a staff member:
- changes a client's banking details,
- exports a large amount of data,
- approves or advances their own file,
- works at very unusual hours.

Alerts are a prompt to check, not an accusation; every action is also in the audit log.
`),
  fraud("fraud-score-and-pre-screen", "Fraud score and lender pre-screen", ["pro"],
    "One 0-100 score with reasons, and a summary you can add to the lender package.", `
On Pro, all checks combine into one score from 0 (low risk) to 100, with the reasons in plain English. The score says how many checks it is based on; checks that aren't set up don't count.

Tick **Include fraud pre-screen** when you send a lender package to add a short summary for the lender. Internal notes are never included.
`),
  {
    slug: "banking-analysis",
    title: "Banking analysis",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "Balances, deposits, NSFs, a three-month trend and warning signs, from the statements.",
    body: `
Once bank statements are uploaded, the **Banking Analysis** tab shows:
- average and lowest daily balance,
- monthly deposits and withdrawals,
- NSFs and overdrafts,
- a three-month trend chart,
- warning signs such as lender debits or large one-off deposits.

It also flags statements whose numbers don't add up or whose pages are missing.
`,
  },
  {
    slug: "financials-tab",
    title: "Financials pulled from statements and T2 returns",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "Key figures read from financial statements, ready for you to check.",
    body: `
When financial statements or T2 returns are uploaded, Keystone reads the key figures (revenue, net income, assets, liabilities, equity) into the **Financials** tab. Check them and correct anything misread; your corrections are kept.
`,
  },
  {
    slug: "credit-summary",
    title: "Write a credit summary",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "A six-section summary drafted for you to edit and export.",
    body: `
1. Open the deal's **Credit Summary** tab.
2. Choose **Draft**. Keystone writes the six sections from the file: the business, the request, financials, banking, collateral and risks.
3. Edit any section.
4. Export it as a PDF, or include it in the lender package.
`,
  },
  {
    slug: "company-research-pack",
    title: "Company research pack",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "Public background on the applicant's company, with a source for each fact.",
    body: `
From a deal or company, choose **Research**. Keystone gathers public information about the business (what it does, its web presence, news) and lists the source of every fact so you can check it.
`,
  },
  {
    slug: "collateral-section",
    title: "Collateral on the credit file",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "Capture equipment and real-estate collateral and summarise it.",
    body: `
Collateral the client describes on their forms appears in the deal's collateral section. Add or edit items (type, value, liens), and the total feeds the credit summary and lender package.
`,
  },
  {
    slug: "usd-cad-conversion",
    title: "US-dollar deals and the exchange rate",
    category: "Underwriting",
    audience: "all_staff",
    plans: [],
    summary: "USD amounts use the Bank of Canada's daily rate.",
    body: `
For a deal in US dollars, Keystone shows the Canadian-dollar equivalent using the Bank of Canada's daily rate, and records which rate it used.
`,
  },
  {
    slug: "lender-questions",
    title: "Send a lender's questions to the client",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Collect answers on the file instead of by email.",
    body: `
1. On the deal, open **Lenders** and choose the lender.
2. Add their questions and choose **Send to client**.
3. The client answers in their portal; the answers appear on the deal, ready to send back to the lender.
`,
  },
  {
    slug: "funding-conditions",
    title: "Funding conditions checklist",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Track what the lender needs before funding.",
    body: `
After an offer is accepted, add the lender's conditions (insurance certificate, void cheque, signed guarantee, and so on) to the deal's funding checklist. Use a template for common conditions, or add them from the lender's offer. Tick each one off as it arrives; the deal shows what's left.
`,
  },
  {
    slug: "quotes-for-clients",
    title: "Send a client a quote with options",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Put two or three options in front of the client and let them choose.",
    body: `
1. On the deal, open **Quotes** and choose **New quote**.
2. Add each option: amount, term, rate or payment, and any notes.
3. Choose **Send to client**. They see the options in their portal and pick one.
`,
  },
  {
    slug: "active-contracts",
    title: "Active contracts and renewals",
    category: "CRM",
    audience: "all_staff",
    plans: [],
    summary: "Track funded deals, balances and when clients are due for renewal.",
    body: `
Funded deals become active contracts on the contact. Each shows the lender, amount, start date, term and (where the lender reports it) the balance. Keystone reminds the owner before a contract matures, so you can offer a renewal or top-up.
`,
  },
  {
    slug: "lender-matching",
    title: "How lender matching works",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Ranks the products that fit a deal and lists missing inputs.",
    body: `
On the deal's **Lenders** tab, Keystone ranks your lenders' products against the deal: amount, country and province, industry, time in business, revenue and credit. Products that don't fit say why. If an input is missing (for example revenue), it tells you, because the match improves once it's filled in.

Ask the assistant "why does this lender fit?" for a plain-English explanation.
`,
  },
  {
    slug: "submission-tracking",
    title: "Track and resend lender submissions",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "See what went to whom and when, catch bounces, and send again.",
    body: `
The deal's **Lenders** tab lists every submission: lender, date, who sent it and the package contents. Bounced emails are flagged with the reason (with a Microsoft 365 send-as mailbox). Choose **Resend** to send the same package again, or rebuild it if documents changed.
`,
  },
  {
    slug: "lender-api-submission",
    title: "Submit to a lender by API",
    category: "Lenders",
    audience: "admins",
    plans: [],
    summary: "Send a deal straight into a lender's system where the lender offers an API.",
    body: `
For lenders that offer an API, Keystone can send the deal directly instead of by email. Set it up on the lender in **Lenders** > **Connection** with the details the lender gives you. Lenders without an API keep using the email package.
`,
  },
  {
    slug: "fee-agreements",
    title: "Fee agreements",
    category: "Lenders",
    audience: "admins",
    plans: [],
    summary: "Have the client sign your fee agreement inside the app.",
    body: `
Set your fee agreement once during onboarding. When a deal needs it, the client signs it in the app, and the signed copy is kept on the deal. With QuickBooks connected, an invoice is created when it's signed and marked paid when the deal funds. See [Connect QuickBooks Online](kb:quickbooks-online).
`,
  },
];
