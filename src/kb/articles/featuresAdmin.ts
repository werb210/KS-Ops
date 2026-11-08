// KS_OPS_KB_v5 - feature-by-feature articles: partner portals, reports, admin, mobile apps and common questions.
import type { SeedArticle } from "./index.js";

const a = (slug: string, title: string, category: string, summary: string, body: string, plans: SeedArticle["plans"] = [], audience: SeedArticle["audience"] = "all_staff"): SeedArticle =>
  ({ slug, title, category, audience, plans, summary, body });

export const FEATURES_ADMIN: SeedArticle[] = [
  // ---- Partner portals ----
  a("lender-portal", "The lender portal", "Lenders",
    "Lenders keep their details and products up to date, and send you deals.", `
Invite a lender from **Lenders** > the lender > **Invite to portal**. They sign in with a texted code and can:
- update their company details and contacts,
- keep their products current and upload product sheets,
- send you files they couldn't place (see [Deals sent to you by lenders](kb:deals-sent-by-lenders)).

The portal shows your brokerage's name and logo.
`),
  a("referrer-portal", "The referrer portal", "Partners",
    "Referrers sign up, sign your agreement, add referrals and track them.", `
Share your referrer sign-up link. Referrers:
1. sign up and sign your referral agreement in the portal,
2. add referrals (name, phone, what they need),
3. follow each referral's progress and keep their payout details current.

Manage referrers and their referrals under **Marketing** > **Referrers**.
`, ["growth", "pro"]),
  a("broker-portal", "The broker portal", "Partners",
    "Partner brokers sign up, sign your agreement and upload client files.", `
Partner brokers sign up from your broker link, sign your broker agreement, agree the commission split, and upload client files. Each upload becomes an application marked as coming from that broker, so commission reports are right. See also [Import a partner broker's file](kb:broker-file-import).
`, ["growth", "pro"]),

  // ---- Reports ----
  a("ready-made-reports", "The ready-made reports", "Reports",
    "47 reports, from pipeline by stage to staff activity.", `
Open **Reports** for ready-made reports, including:
- pipeline by stage, funnel and drop-offs, visits to funded,
- lender scorecard, won vs lost, decline reasons,
- speed to lead, call outcomes, missed calls, staff activity,
- commission, broker payouts, revenue forecast,
- document turnaround, cohorts, renewals and consent health.

Filter any report by date, owner or source, and export to CSV.
`, ["growth", "pro"]),
  a("custom-reports", "Build a custom report", "Reports",
    "Choose the records, fields, filters and chart.", `
1. In **Reports**, choose **New report**.
2. Pick what to report on (deals, contacts, calls, tasks), the fields and filters.
3. Choose a table or chart and save. Add it to the dashboard if you like.
`, ["growth", "pro"]),
  a("team-goals", "Set and track team goals", "Reports",
    "Funded volume, applications or calls, by person or team.", `
In **Reports** > **Goals**, set a target (for example funded volume this quarter) for a person or the team. Progress shows on the dashboard.
`, ["growth", "pro"]),
  a("commission-tracking", "Commission tracking and broker payouts", "Reports",
    "What you're owed by month, and what you owe partner brokers.", `
Record the commission on each funded deal. **Revenue** shows commission receivable by month, and what's owed to partner brokers and referrers, so payouts match the deals.
`, ["growth", "pro"]),
  a("revenue-forecast", "Revenue forecast", "Reports",
    "Expected commission from open deals, weighted by stage.", `
**Revenue** > **Forecast** multiplies each open deal's expected commission by the odds for its stage. Admins set the odds per stage in pipeline settings.
`, ["growth", "pro"]),
  a("monday-summary-email", "The Monday summary email", "Reports",
    "A weekly summary of your business by email.", `
Every Monday morning (Mountain time), admins get a summary of last week: new leads, applications, funded deals, and anything stuck. Choose who receives it in **Settings** > **Company**.
`, [], "admins"),
  a("dashboard-cards", "Customise your dashboard", "Reports",
    "Move, resize, add and remove cards.", `
Drag cards to move them and pull the corner to resize. Choose **Add card** for more. Starter includes key numbers, pipeline, drop-offs, document issues and team; Growth and Pro add every card.
`),

  // ---- Admin and settings ----
  a("custom-roles", "Custom roles and permissions", "Users and teams",
    "Make your own roles when the built-in ones don't fit.", `
Admins open **Settings** > **Users** > **Roles**, choose **New role**, and tick what it can see and do (for example view all deals, export, change lender details). Assign it to people like any other role.
`, [], "admins"),
  a("deactivate-a-user", "Remove someone who left", "Users and teams",
    "Deactivate their access and hand their work to someone else.", `
1. **Settings** > **Users** > the person > **Deactivate**.
2. Choose who takes over their contacts, deals and tasks.

They are signed out everywhere straight away. Their history stays on the records. Deactivated users don't count as seats from your next bill.
`, [], "admins"),
  a("company-settings", "Company settings", "Getting started",
    "Your details, branding, email provider, connections and opt-ins.", `
**Settings** > **Company** holds your brokerage's details and address, branding, time zone, client languages, whether you use Microsoft 365 or Google, the fraud watchlist opt-in, and QuickBooks.
`, [], "admins"),
  a("my-profile", "Your profile", "Getting started",
    "Photo, signature, passkey, Microsoft or Google connection and call hours.", `
**Settings** > **Profile** is yours: photo, email signature, add a passkey, connect your Microsoft or Google account, call hours, ring-my-mobile and notification choices.
`),
  a("custom-tags", "Add your own tags", "CRM",
    "Admins add tags for the whole team.", `
In **Settings** > **Tags**, admins add tags (for example "Trucking" or "Spring promo"). Everyone can then apply them, filter by them and use them in automations. System tags are added automatically and can't be edited.
`, [], "admins"),
  a("plan-page", "The Plan page: usage, storage and upgrades", "Plans and billing",
    "See your plan, allowances, usage and storage; start a trial or upgrade.", `
**Settings** > **Plan** shows your plan, seats, this month's minutes, texts, assistant chats, signings and storage against your allowances. Start your free Pro trial or ask for an upgrade from here.
`, [], "admins"),
  a("export-everything", "Export all your data", "Security and privacy",
    "One zip of every record and file.", `
Admins choose **Settings** > **Data** > **Export everything**. You get an email with a download link when the zip is ready. It includes contacts, companies, deals, notes, tasks, messages and every file. It still works for 180 days after cancelling.
`, [], "admins"),
  a("audit-log", "The audit log", "Security and privacy",
    "Who did what and when: sign-ins, changes, exports and holds.", `
Admins open **Audit** to see sign-ins, code checks, user and role changes, pipeline moves, uploads, exports and legal holds, with who did it and when. Filter by person, action or date. Audit entries are kept for 7 years.
`, [], "admins"),
  a("sin-ssn-protection", "How SIN and SSN numbers are protected", "Security and privacy",
    "Encrypted separately, and deleted once everyone has signed.", `
Social insurance and social security numbers are encrypted separately from everything else, shown masked, and deleted once every signer has signed. Staff never need to copy them out of Keystone.
`),
  a("labs-beta-features", "Labs: try beta features", "Getting started",
    "Join or leave beta features and send feedback.", `
**Settings** > **Labs** lists beta features as they become available. Admins can switch one on for the brokerage, switch it off again, and send feedback. When nothing is in beta, the page says so.
`, [], "admins"),
  a("system-check", "The system check page", "Getting support",
    "See what's connected and working.", `
**Settings** > **System** shows each connection (phone, email, calendar, e-signing, storage) with a green tick or what's missing. Check it first when something isn't working, and include a screenshot when you contact support.
`, [], "admins"),
  a("pro-trial", "Try every Pro feature free for 14 days", "Plans and billing",
    "One in-app trial for Starter and Growth brokerages.", `
Admins choose **Start trial** on **Settings** > **Plan**. For 14 days you get every Pro feature, plus bonus minutes and texts. Nothing is charged; at the end you go back to your plan unless you choose to upgrade. Each brokerage gets one trial.
`, ["starter", "growth"], "admins"),
  a("usage-notices", "Usage notices", "Plans and billing",
    "Emails as you approach your monthly allowances.", `
Admins get an email when your brokerage reaches 80% and 100% of its monthly minutes, texts, assistant chats or storage. Nothing is cut off; usage over the allowance is billed at the published overage rates.
`, [], "admins"),

  // ---- Mobile apps ----
  a("ipad-staff-app", "The iPad staff app", "Mobile apps",
    "The full portal on iPad with calls, push alerts, Face ID and card scan.", `
The iPad app is the whole staff portal, plus calls, push notifications, Face ID lock, business-card scan, share-to-deal from other apps and document markup. Find your company by your work email or phone the first time you open it.
`, ["growth", "pro"]),
  a("staff-push-notifications", "Push notifications on iPhone, iPad and Watch", "Mobile apps",
    "Alerts for messages, missed calls, mentions and tasks.", `
Allow notifications when the app asks. Choose which topics you get in **Settings** > **Profile** > **Notifications**. Notifications show on your Apple Watch too when your iPhone is locked.
`),
  a("carplay", "Keystone in CarPlay", "Mobile apps",
    "Recent calls, favourites and voicemail on the car screen.", `
In CarPlay, the dialler shows recent calls, favourites and voicemail, and Siri reads incoming texts aloud. CarPlay availability depends on Apple's approval for the app.
`),

  // ---- Common questions ----
  a("faq-why-setup-takes-minutes", "Why does setting up my Keystone take a few minutes?", "Getting started",
    "Your brokerage gets its own private database, not a slice of a shared one.", `
Many CRMs keep every customer's records in one big shared database, separated by an account number. Keystone builds each brokerage its own database with its own login, its own keys and its own phone account, hosted in Canada. Creating those takes a few minutes instead of a few seconds. You can watch each step on your setup page; you get an email the moment you can sign in.
`, [], "public"),
  a("faq-texting-not-working-yet", "Why can't we send texts yet?", "Phone",
    "Carriers approve business texting separately; calls work in the meantime.", `
Phone carriers must approve every business that sends texts. Keystone submits your registration during setup; approval usually takes 2 to 5 business days. Calls, voicemail and sign-in codes work in the meantime. See [Business texting registration](kb:texting-registration).
`, [], "public"),
  a("faq-client-cant-sign-in", "A client says they can't sign in", "Client app and applications",
    "The usual causes and fixes.", `
Check these in order:
1. **Number**: is the mobile number on their contact the one they're typing? Fix it on the contact if not.
2. **Landline**: codes can't go to a landline.
3. **Too many tries**: after several attempts they must wait an hour.
4. **Stopped texts**: if they replied STOP, ask them to text START to your number.
5. **Wrong app**: make sure they're using your app or your client web address.
`),
  a("faq-email-not-sending", "Emails aren't sending from Keystone", "Email and calendar",
    "Usually a disconnected Microsoft or Google account.", `
1. Open **Settings** > **Profile** and check your Microsoft or Google connection. Reconnect if it says expired.
2. Check **Settings** > **System** for the company connection.
3. If your IT admin changed passwords or permissions, they may need to approve Keystone again.
`),
  a("faq-who-sees-what", "Who can see a deal or contact?", "Users and teams",
    "Roles, owners and team visibility decide it.", `
Admins see everything. Other people see what their role and team allow: everything, their team's records, or only their own. Set this in **Settings** > **Users**. See [Teams and record visibility](kb:teams-and-visibility).
`),
  a("faq-move-deal-back", "Move a deal back a stage", "Pipeline",
    "Drag it back; the client's portal updates.", `
Drag the card back on the pipeline board, or change the stage on the deal. The client portal shows the new stage, and the move is in the audit log. Automations triggered by entering a stage run again only if they are set to.
`),
  a("faq-delete-vs-hold", "Why can't I delete this record?", "Security and privacy",
    "Retention rules and legal holds protect some records.", `
Applications, documents, signed agreements, lender packages and the audit log are kept for 7 years after a file closes, and nothing under a legal hold can be deleted. You can still archive records so they don't clutter lists. See [Retention and legal holds](kb:retention-and-legal-holds).
`),
  a("faq-change-company-name", "Change your company name or logo", "Branding",
    "Update branding once; it changes everywhere.", `
Admins change the name, logo and colours in **Settings** > **Company** > **Branding**. The portal, client app, emails, texts and PDFs update straight away. Apps already published in the App Store or Google Play keep their store name until the next app update.
`, [], "admins"),
];
