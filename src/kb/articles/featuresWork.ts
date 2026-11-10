// KS_OPS_KB_v5 - feature-by-feature articles: CRM, communications, phone, calendar and AI.
import type { SeedArticle } from "./index.js";

const a = (slug: string, title: string, category: string, summary: string, body: string, plans: SeedArticle["plans"] = [], audience: SeedArticle["audience"] = "all_staff"): SeedArticle =>
  ({ slug, title, category, audience, plans, summary, body });

export const FEATURES_WORK: SeedArticle[] = [
  // ---- CRM ----
  a("people-on-a-company", "People on a company are linked for you", "CRM",
    "Owners, partners, guarantors and advisors from applications are added automatically.", `
When a client applies, every owner, guarantor and advisor they list becomes a contact linked to the company, with their role. Open the company to see everyone at once, and each person's own timeline.
`),
  a("csv-import-contacts", "Import contacts or companies from a spreadsheet", "Importing and exporting",
    "Upload a CSV, match the columns, and import.", `
1. In **CRM**, choose **Import**.
2. Upload a CSV file.
3. Match each column to a Keystone field (name, phone, email, company, tags).
4. Review and import.

For a full move from another CRM, use the import wizard. See [Import your data](kb:import-from-hubspot-salesforce-pipedrive).
`),
  a("ai-contact-summary", "AI summary of a contact or company", "CRM",
    "A short brief on a person or business, using their own website.", `
On a contact or company, choose **Summarize**. The assistant writes a short brief: what the business does, your history with them, open deals and recent conversations. It uses their website and your records only.
`),
  a("owners-lifecycle-lead-status", "Contact owner, lead status and lifecycle stage", "CRM",
    "Who owns each contact, and where they are in your process.", `
Every contact has:
- an **owner** (who looks after them),
- a **lead status** (new, attempting, connected, qualified, not a fit),
- a **lifecycle stage** (lead, applicant, client, past client).

Filter and report on any of them, and use them as triggers in automations.
`),
  a("business-card-scan", "Scan a business card", "CRM",
    "Point the iPhone or iPad camera at a card to create a contact.", `
In the iPhone dialler (every plan) or the iPad app (Growth and Pro), choose **Scan card**. Keystone reads the name, company, phone and email and creates the contact for you to check and save.
`),
  a("consent-records-casl", "Consent records (CASL)", "Security and privacy",
    "How and when each contact agreed to be contacted.", `
Each contact keeps a consent record: what they agreed to (texts, marketing email), how (app sign-up, web form, verbal) and when. Campaigns only go to contacts with the right consent, and STOP or unsubscribe replies update it automatically.
`),
  a("website-journey-and-replay", "Website journey and session replay on a contact", "CRM",
    "The pages a lead visited before applying, and a recording of the visit.", `
On Growth and Pro, a contact who came through your website or client app shows the pages they visited and in what order. With Microsoft Clarity connected, you can also watch a recording of the visit.
`, ["growth", "pro"]),
  a("ad-that-started-the-lead", "See which ad brought a contact in", "Marketing",
    "The ad, keyword and campaign behind each lead.", `
On Pro with Google Ads connected, each contact shows the campaign, ad and keyword that brought them in, and funded deals are reported back to Google Ads as conversions.
`, ["pro"]),

  // ---- Communications ----
  a("scheduled-send-email", "Schedule an email to send later", "Email and calendar",
    "Write now, send later.", `
When writing an email in the portal, open the arrow next to **Send** and choose **Schedule**. Pick the date and time. Scheduled emails can be changed or cancelled until they go. Needs Microsoft 365 connected.
`),
  a("email-signature", "Set your email signature", "Email and calendar",
    "Your signature is added to emails you send from Keystone.", `
1. Open **Settings** > **Profile**.
2. Write your signature (you can add a link to your booking page).
3. Save. It is added to every email you send from the portal and apps.
`),
  a("email-open-tracking", "Email open tracking and unopened alerts", "Email and calendar",
    "See when an email was opened; get a nudge if it wasn't.", `
Emails you send from Keystone show when they were opened. If an important email isn't opened within 24 business hours, you get a notification so you can follow up by phone or text.
`),
  a("text-to-many", "Send one text to several contacts", "Communications",
    "Each person gets their own copy; replies come back to you one by one.", `
1. In **CRM**, tick the contacts.
2. Choose **Text**.
3. Write the message (merge fields like first name work) and send.

Each contact gets their own text, and only contacts who agreed to texts are included. For marketing to a large list, use an SMS campaign instead. See [Email and text campaigns](kb:email-and-text-campaigns).
`),
  a("message-templates", "Message templates", "Communications",
    "Saved emails and texts with merge fields.", `
Admins create templates in **Settings** > **Templates**. Staff pick one when writing an email or text; merge fields such as first name and company fill in automatically.
`, ["growth", "pro"]),
  a("snippets", "Snippets: type a shortcut to insert a saved reply", "Communications",
    "Type #pnw to drop in your net-worth-form message.", `
Create snippets in **Settings** > **Snippets** with a short code, for example **#pnw**. When you type the code in a text, message or email, it expands to the full saved text.
`, ["growth", "pro"]),
  a("automation-from-a-sentence", "Build an automation from a sentence", "Marketing",
    "Describe the workflow in plain words and the assistant drafts it.", `
1. Open **Automations** and choose **New** > **Describe it**.
2. Write what you want, for example: "When a document is rejected, text the client and create a task for the owner due tomorrow."
3. Review the draft on the canvas, adjust any step, and switch it on.
`),
  a("text-then-email-follow-up", "Text-then-email follow-up", "Marketing",
    "No click or reply to a marketing text in 36 hours? An email follows.", `
Campaign texts can have an automatic follow-up: if the contact doesn't click or reply within 36 hours, a matching email goes out. Turn it on when you create the SMS campaign. Needs bulk email set up.
`),
  a("tracked-links", "Tracked links", "Marketing",
    "Short links in texts, with clicks recorded.", `
Links in texts are shortened automatically, and each click is recorded on the contact. Use clicks as a trigger in automations or a filter in segments.
`),
  a("notification-centre", "The notification centre and your notification settings", "Communications",
    "Mentions, messages, missed calls, unopened emails and tasks, and how to choose which you get.", `
The bell at the top of the portal lists your notifications. Choose which topics you get, and how (in the portal, push, email), in **Settings** > **Profile** > **Notifications**.
`),
  a("email-subscription-types", "Email subscription types", "Marketing",
    "Let contacts choose which kinds of email they get.", `
Create subscription types (for example "Newsletter" and "Rate updates") under **Marketing**. Each campaign uses one type; contacts can unsubscribe from one without losing the others.
`, [], "admins"),
  a("landing-pages", "Landing pages", "Marketing",
    "Build a simple page with a lead form, on your brand.", `
Under **Marketing** > **Landing pages**, build a page from blocks (headline, text, image, form), publish it, and share the link in ads or emails. Form submissions arrive in **Leads**.
`),
  a("facebook-instagram-lead-ads", "Facebook and Instagram lead ads", "Marketing",
    "Leads from Meta lead forms arrive in Keystone automatically.", `
Connect your Facebook page in **Settings** > **Connections**. Leads from your Facebook and Instagram lead forms then arrive in **Leads** within seconds, tagged with the form they came from.
`, [], "admins"),
  a("whatsapp-messages", "WhatsApp messages", "Communications",
    "Chat with clients on WhatsApp from the contact.", `
Once your WhatsApp Business number is connected (Keystone helps with this), WhatsApp conversations appear on the contact's timeline next to texts and emails, and you reply from the same place.
`),

  // ---- Phone ----
  a("caller-card", "The caller card during a call", "Phone",
    "Name, deal and stage on screen while you talk.", `
When a known contact calls, or you call them, the dialler and portal show their name, company, open deal and stage. Tap through to the deal without hanging up.
`),
  a("in-call-controls", "In-call controls: hold, transfer, add someone", "Phone",
    "Mute, keypad, hold, transfer, conference and speaker.", `
During a call in the dialler or portal softphone:
- **Mute** and **Speaker**
- **Keypad** for phone menus
- **Hold**
- **Transfer** to a teammate (announced or straight through)
- **Add** someone to make a conference call
`),
  a("call-outcomes", "Log a call outcome", "Phone",
    "One tap after each call: connected, voicemail, no answer, not interested.", `
When a call ends, pick how it went. The outcome is saved on the contact and feeds the **Call outcomes** report. Add a note or schedule a follow-up from the same screen.
`),
  a("ai-call-notes", "Call transcripts and AI notes", "Phone",
    "After a recorded call: transcript, summary, next steps and a follow-up task.", `
On Growth and Pro, recorded calls are transcribed. The assistant writes a short summary and next steps, saves them to the contact and deal, and suggests a follow-up task for you to confirm.
`, ["growth", "pro"]),
  a("voice-notes", "Dictate a voice note after a call", "Phone",
    "Use Siri or the Action button to add a note to the client's timeline.", `
After a call, choose **Voice note** in the dialler (or use the Action button or Siri) and speak. The note is transcribed and saved to the contact's timeline.
`),
  a("call-hours-and-away", "Set your call hours", "Phone",
    "Outside your hours, callers hear your away message.", `
In **Settings** > **Profile**, set the hours you take calls. Outside them, calls go to voicemail with your away message. The main line follows the company's hours.
`),
  a("ring-my-mobile", "Ring my mobile when the app doesn't answer", "Phone",
    "Calls fall back to your own mobile; press 1 to accept.", `
Turn on **Ring my mobile** in your profile. If the dialler doesn't answer (no data, phone off), the call rings your own mobile. Press 1 to accept, so the caller still sees your business number and the call is logged.
`),
  a("dialler-widgets-live-activity", "Dialler widgets, Control Center and Live Activity", "Phone",
    "Quick call, busy, voice note and next follow-up from the home and lock screens.", `
Add the Keystone widget to your iPhone home screen, and its buttons to Control Center: new call, quick call, set busy, voice note and next follow-up. During a call, the Live Activity shows it on the lock screen and Dynamic Island.
`),
  a("portal-softphone", "Make and take calls in the browser", "Phone",
    "The portal softphone, with available and busy status.", `
Use the phone icon in the portal to call from your computer or iPad with a headset. Set yourself **Available** or **Busy**; busy sends calls to voicemail. Needs your phone line set up.
`),
  a("dial-in-meeting-rooms", "Dial-in meeting rooms", "Phone",
    "Schedule a room with a 6-digit code; clients dial your main line to join.", `
1. In **Calendar**, choose **Meeting room** and pick a time.
2. Share the 6-digit code.
3. Guests call your main line, choose the meeting option, and enter the code.

Meetings are recorded, with a notice to everyone who joins.
`),
  a("missed-call-alerts", "Missed-call alerts", "Phone",
    "A push alert for each missed call, and a summary.", `
You get a push notification when you miss a call, with a one-tap call back. Missed calls also appear in the notification centre and the **Missed calls** report.
`),

  // ---- Calendar and tasks ----
  a("task-runner", "Work through tasks one by one with the task runner", "Calendar, tasks and booking",
    "Start N tasks and Keystone serves them one at a time.", `
1. Open **Tasks** and choose a queue.
2. Choose **Start** and how many tasks to work through.
3. Each task opens with the contact, deal and the right action (call, text, email). Complete it and the next one appears.

Admins set up shared queues with **Manage queues**.
`),
  a("todo-google-tasks-sync", "Tasks in Microsoft To Do or Google Tasks", "Calendar, tasks and booking",
    "Your Keystone tasks appear in To Do or Google Tasks, both ways.", `
Once your Microsoft or Google account is connected, your Keystone tasks show in Microsoft To Do or Google Tasks. Completing one in either place completes it in both.
`),
  a("microsoft-bookings-to-crm", "Microsoft Bookings into Keystone", "Calendar, tasks and booking",
    "Bookings become contacts and tasks automatically.", `
If you use Microsoft Bookings, each new booking creates (or updates) the contact in Keystone and a task for the person booked. Needs Microsoft 365 connected.
`),
  a("teams-meeting-notes", "Teams meeting notes on the contact", "Calendar, tasks and booking",
    "Recorded Teams meetings land on the timeline with a transcript and AI summary.", `
When a Teams meeting with a contact is recorded and transcribed, Keystone saves the transcript and a short AI summary to that contact's timeline. Needs Microsoft 365 connected and recording turned on in Teams.
`),

  // ---- AI ----
  a("assistant-for-website-visitors", "Your assistant on your website", "AI assistant",
    "Answers questions, estimates eligibility, captures the lead and books a callback.", `
On your website, the assistant can answer product questions, estimate what a visitor may qualify for, give a readiness score, list the documents they'll need, take their details and book a callback, or hand over to a person. Every conversation and lead lands in Keystone.
`),
  a("assistant-for-staff", "Ask the assistant to do things in the portal", "AI assistant",
    "Pipeline questions, drafts, summaries, daily briefing and more.", `
Open the assistant in the portal and ask, for example:
- "Which deals have been in Off to Lender for more than a week?"
- "Draft a follow-up email to Sam about his missing statements."
- "Summarise the banking on the Northwind deal."
- "What's on my plate today?"

It can draft texts and emails, but it only sends after you confirm.
`),
  a("train-your-assistant", "Teach your assistant about your products", "AI assistant",
    "Add text, web pages and files; lender products sync in by themselves.", `
Admins open **AI knowledge base** and add:
- text answers to common questions,
- web pages (it reads them),
- files such as product sheets.

Your lender products and collateral are added automatically. Changes take effect within a few minutes.
`, [], "admins"),
  a("assistant-tuning", "Adjust your assistant's tone", "AI assistant",
    "Set how formal it is and what it should always or never say.", `
In **AI knowledge base** > **Behaviour**, admins choose the tone, add rules (for example "never quote rates") and set when it should hand over to a person.
`, [], "admins"),
  a("live-chat-takeover", "Take over a live assistant chat", "AI assistant",
    "See conversations as they happen and step in.", `
**Live chat** lists conversations happening now on your website and client app. Open one to read along, and choose **Take over** to reply yourself. The visitor is told a person has joined.
`),
];
