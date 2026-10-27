import type { SeedArticle } from "./index.js";

export const LENDERS_AND_CRM: SeedArticle[] = [
  {
    slug: "add-lenders-and-products",
    title: "Add lenders and their products",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Your own lenders and products power matching and the document checklist.",
    body: `
Keystone uses **your** lenders. Add each lender and the products they offer.

## Add a lender
1. Open **Lenders** in the sidebar.
2. Add the lender's name, contacts and the email address packages go to.
3. Add each product: amount range, countries, categories, and the documents it needs.

## Let lenders keep it current
Invite a lender to the **lender portal**. They sign in with a text code, keep their own company details and products up to date, and upload product sheets. They can also send you deals they could not place; each one arrives as a card for you to accept or decline.

> Lenders do not review your submitted files inside the lender portal. Packages go to them by email or as a download link.
`,
  },
  {
    slug: "send-lender-package",
    title: "Match a deal and send a lender package",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Find the products that fit, build the package once and send it to the lenders you pick.",
    body: `
## Match
1. Open the deal and go to **Lenders**.
2. Keystone ranks the products that fit the deal and lists any missing inputs. The assistant can explain why a lender fits or doesn't.

## Send
1. Pick the lenders.
2. Build the package: the application, the documents and, on Pro, the fraud pre-screen summary.
3. Send it. Each lender gets an email; large packages go as a secure download link.
4. Move the deal to **Off to Lender**.

## Track and resend
- See what went to whom and when, and send again if you need to.
- With Microsoft 365 connected, emails that bounce are flagged with the reason.

> Sending straight into a lender's own system through an API is coming soon.
`,
  },
  {
    slug: "contacts-companies-timeline",
    title: "Contacts, companies and the timeline",
    category: "CRM",
    audience: "all_staff",
    plans: [],
    summary: "Everything about a borrower, referrer or lender in one place.",
    body: `
Open **CRM** to see your contacts and companies.

- **Timeline**: every call, text, email, meeting, note and document for the contact, newest first.
- **People on a company**: applicants, partners, guarantors and advisors from applications are added and linked for you.
- **Owner and lifecycle**: who owns the contact, their lead status and lifecycle stage.
- **Consent**: how and when the contact agreed to be contacted (for CASL).
- **AI summary**: a short brief on the person or company, using their own website.

## Add a contact
- Add one by hand from **CRM**, scan a business card with the iPhone dialler or the iPad app, or import a spreadsheet. See [Import your data](kb:import-from-hubspot-salesforce-pipedrive).
`,
  },
  {
    slug: "tags-and-segments",
    title: "Tags and saved segments",
    category: "CRM",
    audience: "all_staff",
    plans: [],
    summary: "Label contacts, tag in bulk, and save filters you reuse.",
    body: `
## Tags
- **Shared tags** everyone uses, **custom tags** your Admins add, and **system tags** Keystone adds for you.
- Tag one contact from their record, or select many in the list and tag them in bulk.

## Saved segments
1. Filter the contact list (for example: tag, owner, lifecycle stage).
2. Save the filter as a segment.
3. Use the segment for lists and for campaigns. See [Email and text campaigns](kb:email-and-text-campaigns).
`,
  },
  {
    slug: "find-and-merge-duplicates",
    title: "Find and merge duplicates, and clean up data",
    category: "CRM",
    audience: "all_staff",
    plans: [],
    summary: "Merge duplicate contacts and companies, and fix messy data in batches you can undo.",
    body: `
## Merge duplicates
1. In **CRM**, open the duplicates view. Keystone lists contacts and companies that look like the same one.
2. Pick the record to keep and merge. The timeline, deals and documents move to the record you keep.

Records under a legal hold are protected: a merge never deletes anything a hold covers. See [Retention and legal holds](kb:retention-and-legal-holds).

## Clean up data
1. Run **Clean up data**. Keystone scans for messy data such as badly formatted phone numbers and names.
2. Review the suggested fixes and apply them.
3. Changed your mind? Undo the whole batch.
`,
  },
  {
    slug: "custom-fields",
    title: "Custom fields",
    category: "CRM",
    audience: "admins",
    plans: [],
    summary: "Add your own fields to contacts, companies and deals.",
    body: `
Add the fields your brokerage needs, such as a licence number, a renewal date or an equipment type.

## Add a field
1. Open **Settings** > **Properties**.
2. Choose the record type: contact, company or deal.
3. Name the field and pick its type: text, number, date, a list of choices, a checkbox, an email, a phone number or a web address.
4. Save. The field appears on every record of that type.

Custom fields work in lists and filters, in exports and in imports (match a spreadsheet column to the field). They are on every plan.
`,
  },
  {
    slug: "pgi-referrals",
    title: "Personal Guarantee Insurance referrals",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Refer clients for Personal Guarantee Insurance and earn a 20% referral fee.",
    body: `
Clients who sign a personal guarantee can protect themselves with Personal Guarantee Insurance (PGI), through Keystone's insurance partner.

## How it works
1. A client can ask for PGI on step 6 of the application, or you can refer them from the **PGI** tab on the deal.
2. The referral goes to the insurance partner, who quotes and binds the policy.
3. Track every referral in **PGI referrals** in the sidebar.
4. When a policy binds, your brokerage earns a **20% referral fee**.

PGI referrals are on every plan. Keystone links your brokerage to the partner for you.
`,
  },
];
