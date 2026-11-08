// KS_OPS_KB_v5 - feature-by-feature articles: the client app, applications and documents.
import type { SeedArticle } from "./index.js";

export const FEATURES_CLIENT: SeedArticle[] = [
  {
    slug: "client-save-and-resume",
    title: "Clients can stop and finish their application later",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Progress is saved at every step, so a client never starts over.",
    body: `
Every step of the application is saved as soon as the client moves on.

## How a client picks up where they left off
1. They open your client app (or the link you sent) on any device.
2. They sign in with the code texted to their mobile.
3. The app opens at the step they stopped on, with everything they already entered.

## If a client is stuck
- Send them the link again from the contact in **CRM**. See [Send a client the application link](kb:send-application-link).
- Clients who start and don't finish get an automatic reminder text when your phone line is set up. See [Abandoned-application follow-up](kb:abandoned-application-follow-up).
`,
  },
  {
    slug: "client-sign-in-text-code-passkey",
    title: "How clients sign in: text code, Face ID and passkeys",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "No passwords for clients: a texted code the first time, then Face ID or a passkey.",
    body: `
## First time
1. The client enters their mobile number.
2. They get a 6-digit code by text and type it in.

## After that
On a phone, the app offers Face ID, fingerprint or a passkey, so they can sign in with one tap.

## If the code doesn't arrive
- Check the number has the right area code and is a mobile, not a landline.
- Wait a minute and choose **Send again**. Codes are limited per hour to stop abuse.
- If texting is still being approved by the carriers for your brokerage, codes still go out from Keystone's verification service.
`,
  },
  {
    slug: "client-portal-home",
    title: "The client portal: what clients see after applying",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Each application's stage, the client's to-do list and anything waiting for a signature.",
    body: `
After submitting, clients land on their portal home. It shows:
- **Each application** with its current stage in plain words.
- **What they still need to do**: documents to upload, forms to fill in, questions from a lender.
- **Anything waiting for their signature**.
- **Messages** from your team, with read receipts.

When you move a deal or ask for something, the portal updates straight away, and the client gets a text if they opted in to updates.
`,
  },
  {
    slug: "client-document-upload",
    title: "How clients upload documents",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Camera, files, or share from Photos, Files and Mail. Uploads keep going in the background.",
    body: `
Clients can add documents:
- **With the camera**: the app straightens and crops the page.
- **From files** on a computer or phone.
- **By sharing** from Photos, Files or Mail on an iPhone, straight into the app.

Large uploads continue in the background if the client switches apps.

## What happens next
- Each file is read automatically (see [Uploads, OCR and document sorting](kb:documents-and-ocr)).
- The same file can't be uploaded twice.
- If you reject a document, the client is told why and what to send instead. See [Accept or reject a document](kb:accept-reject-documents).
`,
  },
  {
    slug: "client-follow-up-forms",
    title: "Follow-up forms clients fill in",
    category: "Client app and applications",
    audience: "all_staff",
    plans: [],
    summary: "Net worth, CRA authorization, collateral, debts, advisors and lender questions.",
    body: `
Besides documents, you can ask a client to complete a form in their portal:
- **Personal net worth statement**
- **CRA authorization**
- **Equipment collateral** and **real-estate collateral**
- **Debt schedule** (what the business already owes)
- **Professional advisors** (accountant, lawyer)
- **Lender questions** from a specific lender
- **Product questions** for the product you are applying for

## Ask for a form
1. Open the deal and choose **Request items**.
2. Tick the forms you need and send.

The client sees them on their to-do list. Answers land on the deal when they submit.
`,
  },
  {
    slug: "client-e-signing",
    title: "Clients sign inside the app",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "The application, fee agreement and term sheet are signed in the client app.",
    body: `
Clients sign without printing anything:
- the **application** at the end of step 6,
- your **fee agreement**, if you use one,
- the **term sheet** after they accept an offer.

Each signer gets their own signing link, so co-owners and guarantors can sign separately.

Your plan includes a number of signings each month; see [E-signing: what's included](kb:e-signing-allowance). E-signing is switched on with you during onboarding.
`,
  },
  {
    slug: "client-chat-with-advisor",
    title: "Clients chat with their advisor in the app",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Two-way messages with read receipts, saved to the deal.",
    body: `
Clients can message your team from the **Messages** tab in the client app. Your team answers from the deal or from **Communications** in the portal.

- Messages are saved on the contact's timeline.
- Both sides see when a message has been read.
- If the client doesn't open the app, a text lets them know there's a new message (when they opted in to texts).
`,
  },
  {
    slug: "client-book-a-call",
    title: "Clients book a call from the app",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "A 30-minute phone or video call with their advisor, added to both calendars.",
    body: `
Clients choose **Book a call**, pick a time that suits them, and choose phone or video. The meeting lands in your calendar and theirs.

## What you need
Your team's Microsoft 365 or Google calendars connected. See [Connect your email and calendar](kb:connect-email-and-calendar).

## Who the call is with
The client's own advisor if they have one, otherwise the next free person on the team.
`,
  },
  {
    slug: "client-ai-assistant",
    title: "The assistant in the client app",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Answers questions about the client's own file and what to do next.",
    body: `
Your assistant (with the name you gave it) helps clients in the app. It can:
- tell them their application's stage and what is left to do,
- help with a confusing form field,
- explain why a document was rejected, or what an offer means,
- show which signatures are still waiting,
- send them the link to finish their application.

It only sees the signed-in client's own file. When a question needs a person, it hands over to your team.

Each plan includes a number of assistant chats a month. See [Allowances, usage and overage](kb:allowances-usage-and-overage).
`,
  },
  {
    slug: "client-loan-calculator",
    title: "Loan calculator",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "A payment estimate with the full schedule, for clients and staff.",
    body: `
Clients find the calculator on the **More** tab of the client app; staff have the same calculator in the portal.

1. Enter the amount, the rate and the term.
2. See the payment and the full schedule, payment by payment.

The result is an estimate. The lender's offer sets the real terms.
`,
  },
  {
    slug: "client-text-updates-and-push",
    title: "Text updates and app notifications for clients",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Clients choose text updates; the store apps also send notifications.",
    body: `
## Text updates
On the sign-in screen, clients tick whether they want updates by text: stage changes, document requests and signing reminders. They can reply STOP at any time.

## App notifications
In your branded app from the App Store or Google Play, clients get notifications for new messages, requests and stage changes. When a notification can't be delivered, a text is sent instead (if they opted in).
`,
  },
  {
    slug: "client-refer-a-business",
    title: "Clients can refer another business owner",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "A referral from inside the client app becomes a lead for your team.",
    body: `
In the client app, **Refer a business owner** lets a client pass on someone who may need financing. They enter the person's name and phone or email.

The referral arrives in **Leads** as a new contact, linked to the client who referred them, so you can thank them.
`,
  },
  {
    slug: "client-report-a-problem",
    title: "Clients can report a problem from the app",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Reports land in the staff Issues inbox, with the client and screen attached.",
    body: `
Clients choose **Report a problem** from the More tab, describe what went wrong and send it.

Staff see every report in the **Issues** inbox, with who sent it and where they were in the app. Reply to the client from there, then mark it resolved.
`,
  },
  {
    slug: "client-edit-details",
    title: "Clients update their own contact details",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "Changes made in the app show on the contact in the portal.",
    body: `
Clients can change their email, phone and address under **My details** in the app. The change is saved on their contact in the portal and appears on the timeline, so your team can see what changed and when.
`,
  },
  {
    slug: "accountant-upload-link",
    title: "Let a client's accountant upload financials",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "The client names their accountant, who gets a secure upload link.",
    body: `
Many clients don't keep their financial statements; their accountant does.

1. In the app, the client names their accountant and adds an email.
2. The accountant gets a secure link to upload the statements directly. No sign-in needed.
3. The files land on the client's application.

You can also send the link yourself from the deal.
`,
  },
  {
    slug: "client-several-applications",
    title: "One client, several applications",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "A client can hold and start more than one application.",
    body: `
A client who needs more than one facility (for example a line of credit and equipment financing) can start a new application from their portal home. Each one has its own stage, documents and lender submissions. Details they already gave, such as owners and business information, are filled in for them.
`,
  },
  {
    slug: "reactivate-file-on-hold",
    title: "Put a file on hold, and let the client restart it",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Hold parks a deal; the client can reactivate it from the app.",
    body: `
Move a deal to **Hold** when the client needs time (for example, waiting on year-end statements). Add a reason; the client sees it.

When they are ready, the client chooses **Reactivate** in the app, and the deal returns to your pipeline with a task for its owner.
`,
  },
  {
    slug: "client-app-languages",
    title: "Client app in English, French and Spanish",
    category: "Client app and applications",
    audience: "admins",
    plans: [],
    summary: "Choose which languages your clients can use.",
    body: `
1. Open **Settings** > **Company**.
2. Under **Client languages**, tick English, French and/or Spanish.

Clients then choose their language in the app. Sign-in codes and consent wording follow their choice. Texts and emails your staff write yourselves are sent as written.
`,
  },
  {
    slug: "client-web-app",
    title: "The client app in a browser",
    category: "Client app and applications",
    audience: "public",
    plans: [],
    summary: "The same app works in any browser and can be added to the home screen.",
    body: `
Clients don't have to download anything. The client app runs in any modern browser at your client web address, and can be added to a phone's home screen like an app. It is the same app as the one in the stores, with the same sign-in and the same data.
`,
  },
  {
    slug: "abandoned-application-follow-up",
    title: "Abandoned-application follow-up",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Applicants who start and don't finish get a reminder text, and you get a task.",
    body: `
When someone starts an application and stops, Keystone:
1. sends them a friendly text with a link back to where they stopped, and
2. creates a follow-up task for the owner (or the team).

It respects quiet hours and the person's text consent. It needs your business phone line to be set up.
`,
  },
  {
    slug: "leads-and-website-leads",
    title: "Leads and website leads",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "New enquiries from your website, assistant, referrals and forms, in one list.",
    body: `
**Leads** lists people who enquired but haven't applied yet: website forms, assistant chats, client referrals, lead forms and ad leads.

## Work a lead
1. Open it to see where it came from and what they asked.
2. Call, text or email from the lead.
3. Send the application link, or mark it not a fit with a reason.

Speed matters: the **Speed to lead** report shows how fast each person responds.
`,
  },
  {
    slug: "credit-readiness-check",
    title: "Run a credit readiness check for a prospect",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "A quick readiness score, then send the application link.",
    body: `
Use **Credit readiness** when a prospect asks "would I qualify?".

1. Enter a few answers: time in business, monthly revenue, credit range, amount needed.
2. Keystone gives a readiness score and the documents they will need.
3. Choose **Send application link** to get them started.

The check is a guide, not a credit decision, and doesn't pull a credit report.
`,
  },
  {
    slug: "issues-inbox",
    title: "The client Issues inbox",
    category: "Getting support",
    audience: "all_staff",
    plans: [],
    summary: "Every problem clients report from the app, in one list.",
    body: `
Open **Issues** to see reports sent from the client app. Each shows the client, what they wrote and where they were in the app.

1. Open a report.
2. Reply to the client (it goes to their app messages).
3. Mark it **Resolved**.

If something is wrong with Keystone itself, send a support request too. See [Get help and contact Keystone support](kb:get-help-and-contact-support).
`,
  },
  {
    slug: "broker-file-import",
    title: "Import a partner broker's file",
    category: "Pipeline",
    audience: "all_staff",
    plans: ["growth", "pro"],
    summary: "Turn a broker's file package into a new application.",
    body: `
When a partner broker sends you a file, don't retype it.

1. Open **Broker imports** and upload the package (PDFs or a zip).
2. Keystone reads the documents and pre-fills a new application.
3. Check the details and create the deal. It is marked as coming from that broker, for commission.

Brokers can also upload through their own portal. See [The broker portal](kb:broker-portal).
`,
  },
  {
    slug: "suggested-next-action",
    title: "Suggested next action on each deal",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Each file shows what should happen next.",
    body: `
At the top of each deal, Keystone suggests the next step, for example "2 documents still missing", "send to lenders" or "offer waiting for the client". Choose it to jump straight there. It updates as the deal moves.
`,
  },
  {
    slug: "notes-and-mentions",
    title: "Notes and @mentions",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Notes on a deal or contact; mention a teammate to notify them.",
    body: `
1. Open the deal's **Notes** tab (or a contact's timeline).
2. Write the note. Type **@** and a name to mention a teammate.
3. Save. Mentioned people get a notification.

Notes are internal: clients never see them.
`,
  },
  {
    slug: "where-a-deal-came-from",
    title: "See where a deal came from",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Lender, broker, referrer, website or ad: the origin panel on each deal.",
    body: `
Each deal shows its origin: a lender that sent it, a partner broker, a referrer, the website or assistant, or (on Pro, with Google Ads connected) the ad and keyword. The origin drives commission and referral reports, so it is set automatically and kept on the deal.
`,
  },
  {
    slug: "hold-and-decline-notices",
    title: "Tell clients why a file is on hold or declined",
    category: "Pipeline",
    audience: "all_staff",
    plans: [],
    summary: "Choose a reason when you move a deal to Hold or Rejected.",
    body: `
When you move a deal to **Hold** or **Rejected**, pick a reason and add a note if you like. The client sees a plain-English explanation in their portal and gets a text if they opted in. Decline reasons also feed the **Decline reasons** report.
`,
  },
  {
    slug: "deals-sent-by-lenders",
    title: "Deals sent to you by lenders",
    category: "Lenders",
    audience: "all_staff",
    plans: [],
    summary: "Lenders pass on files they couldn't place; you accept or decline each one.",
    body: `
Lenders can upload files they declined through their lender portal. Each arrives as a card on your pipeline marked **From lender**.

1. Open the card and review the file.
2. Choose **Accept** to make it a deal, or **Decline** with a reason.

The lender sees your answer in their portal.
`,
  },
  {
    slug: "accept-reject-documents",
    title: "Accept or reject a document",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "Reject with a reason; the client is told exactly what to replace.",
    body: `
1. Open the deal's **Documents** tab.
2. Choose **Accept** or **Reject** on the document.
3. When rejecting, pick a reason (blurry, wrong period, missing pages, wrong document) or write one.

The client sees the reason and an upload button for the replacement. The checklist updates when the new file arrives.
`,
  },
  {
    slug: "document-checklist",
    title: "The document checklist",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "Required documents per lender product, for staff and for the client.",
    body: `
Each lender product lists the documents it needs. When a deal is matched to a product, the checklist shows what's in and what's missing. The client sees the same list as "what you still need".

Set required documents on each product in **Lenders**. See [Add lenders and their products](kb:add-lenders-and-products).
`,
  },
  {
    slug: "missing-months-and-duplicates",
    title: "Missing bank statement months and duplicate uploads",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "See which months are covered, and stop the same file twice.",
    body: `
## Missing months
After bank statements are read, the Documents tab shows which months they cover and highlights gaps. Request the missing months in one click.

## Duplicates
If someone uploads a file that's already on the deal, Keystone blocks it and says so. The fraud checks separately look for the same document on *another* application.
`,
  },
  {
    slug: "email-attachments-filed",
    title: "Email attachments filed to the contact automatically",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "Attachments in connected inboxes are saved to the matching contact.",
    body: `
When your Microsoft 365 mailbox is connected, attachments from a known contact are saved to that contact in Keystone, so documents emailed by clients don't get lost in someone's inbox. Move them to a deal from the contact's documents.
`,
  },
  {
    slug: "client-folders-onedrive-drive",
    title: "Client folders in OneDrive or Google Drive",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "A shared folder per client, created for you.",
    body: `
With Microsoft 365 or Google connected, Keystone creates a folder for each client in OneDrive or Google Drive, shared with your team. Files stay in sync with the client's documents in Keystone.
`,
  },
  {
    slug: "staff-library",
    title: "The staff Library",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "Shared team files with preview, share links, versions and a recycle bin.",
    body: `
**Library** is your team's shared drive inside Keystone (on Microsoft 365):
- preview files without downloading,
- share a link, or create an upload link for someone outside,
- see version history,
- restore deleted files from the recycle bin for 30 days.
`,
  },
  {
    slug: "collateral-library",
    title: "Collateral: marketing PDFs to attach to emails",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: [],
    summary: "Keep brochures and one-pagers ready to attach.",
    body: `
Admins add marketing PDFs (product sheets, brochures) in **Settings** > **Collateral**. Staff attach them to any email from the attach menu, so everyone sends the current version.
`,
  },
  {
    slug: "storage-allowance",
    title: "Storage: how much you have and what happens when it's full",
    category: "Plans and billing",
    audience: "admins",
    plans: [],
    summary: "Pooled across seats, with warnings at 80% and 100%.",
    body: `
Storage is shared by everyone in your brokerage: 10 GB per seat on Starter, 25 GB on Growth and 50 GB on Pro.

- Admins get a warning at 80% and at 100%.
- Add more in 50 GB blocks ($10 a month each) from **Settings** > **Plan**.
- See usage on the same page.
`,
  },
  {
    slug: "ipad-document-markup",
    title: "Mark up a document on the iPad",
    category: "Documents and OCR",
    audience: "all_staff",
    plans: ["growth", "pro"],
    summary: "Annotate with Apple Pencil and save it back to the deal.",
    body: `
In the iPad app, open a document and choose **Markup**. Highlight, write or sign with your finger or Apple Pencil, then **Save**. The marked-up copy is saved on the deal next to the original.
`,
  },
];
