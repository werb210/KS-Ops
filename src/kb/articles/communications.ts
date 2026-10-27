import type { SeedArticle } from "./index.js";

export const COMMUNICATIONS: SeedArticle[] = [
  {
    slug: "connect-email-and-calendar",
    title: "Connect your email and calendar",
    category: "Email and calendar",
    audience: "all_staff",
    plans: [],
    summary: "Connect Microsoft 365 or Google so mail and meetings land on the right contact.",
    body: `
Keystone works with **Microsoft 365** and **Google Workspace**. Your Admin chooses which one (or both) your brokerage uses, then each person connects their own account.

## Connect your account
1. Open **Settings** > **My Profile**.
2. Choose **Connect** for Microsoft 365 or Google and sign in with your work account.
3. Approve the permissions Keystone asks for (mail, calendar and tasks).
4. You're back in the portal, connected.

## What you get
- **Microsoft 365**: your Outlook inbox in the portal (read, reply, forward), shared mailboxes, sending, calendar with Teams links, To Do, and OneDrive client folders. Every email is logged on the right contact.
- **Google**: sending from Gmail, Google Calendar with Meet links, Google Tasks and Drive folders. Reading a Gmail inbox inside Keystone is coming soon.

## Disconnect
In **Settings** > **My Profile**, choose **Disconnect**. Keystone stops using your account at once.

> A simpler one-click connection for the whole brokerage is being rolled out. If connecting doesn't work, your Microsoft or Google admin may need to approve Keystone first: send a support request from **Get help** and we'll help.
`,
  },
  {
    slug: "email-inbox-and-tracking",
    title: "Your inbox, shared mailboxes and email tracking",
    category: "Email and calendar",
    audience: "all_staff",
    plans: [],
    summary: "Read and send email in the portal, see opens and schedule sends.",
    body: `
Once Microsoft 365 is connected, open **Communications** to use email in the portal.

- **Shared mailboxes**: shared Microsoft 365 mailboxes (such as info@) next to your own, or all in one view.
- **Open tracking**: see when an email was opened, and get an alert if it isn't opened within 24 business hours.
- **Scheduled send**: write now, send later (Microsoft 365).
- **Signature**: set yours in **Settings** > **My Profile**. Shared mailboxes can have their own.
- **Attachments**: attachments in staff inboxes are saved to the matching contact.

## Keep some mail out of Keystone
Admins can add email addresses or whole domains to **Settings** > **Never log**. Mail with them never reaches a timeline.
`,
  },
  {
    slug: "calendar-and-tasks",
    title: "Calendar, tasks and task queues",
    category: "Email and calendar",
    audience: "all_staff",
    plans: [],
    summary: "Two-way calendar, tasks with reminders, and working through a queue.",
    body: `
## Calendar
With Microsoft 365 or Google connected, **Calendar** is two-way: create, edit and cancel events, add Teams or Meet links, find a time, and see teammates' calendars.

## Tasks
- Tasks have due dates, priorities and reminders. Select several to act on them in bulk.
- Tasks sync with Microsoft To Do or Google Tasks: finish one there and it's finished here.

## Task queues
Shared queues hold tasks for the team. Use **start tasks** to work through a queue one by one without going back to the list.
`,
  },
  {
    slug: "texting-and-client-messages",
    title: "Texting and client messages",
    category: "Communications",
    audience: "all_staff",
    plans: [],
    summary: "Text from your business number and chat with clients in their portal.",
    body: `
## Texting
- Send texts and picture messages from your business number. They are saved on the contact with their delivery status.
- Pick several contacts to send each the same text separately.
- Your plan includes texts per seat, pooled across the team. See [Allowances, usage and overage](kb:allowances-usage-and-overage).

## Client messages
Chat with clients inside their client portal, with read receipts. You can send one message to many clients.

## Templates and snippets (Growth and Pro)
- Save email and text templates with merge fields such as first name.
- Type a snippet shortcut such as **#pnw** to drop a saved reply into a text, message or email.

> Texting needs your business number and carrier approval first. See [Business texting registration](kb:texting-registration).
`,
  },
  {
    slug: "team-chat",
    title: "Team chat and notifications",
    category: "Communications",
    audience: "all_staff",
    plans: [],
    summary: "Channels, direct messages, threads and the notification centre.",
    body: `
Team chat is in **Communications** and in the iPhone dialler.

- Channels, group chats and direct messages, with threads, @mentions, emoji and link previews.
- Search, saved messages and **remind me**.
- Set your status so the team knows if you're busy.
- **Read this** posts ask people to confirm they read them, with read receipts.

The **notification centre** collects mentions, messages, missed calls, unopened emails and tasks in one place.
`,
  },
  {
    slug: "booking-pages",
    title: "Booking pages",
    category: "Email and calendar",
    audience: "admins",
    plans: [],
    summary: "Let clients book a call with one person or with the next free person on the team.",
    body: `
Each staff member has their own public booking page, and your team can share one round-robin page.

## Set up booking
1. Open **Settings** > **Booking pages**.
2. Turn the **team page** on or off. It books the next available person in turn.
3. Add **meeting types** (for example a 30-minute phone call or a video call).
4. Set **booking hours**, reminders and the confirmation note clients get.

## Share the links
- Everyone sees their own link and the team link in **Settings** > **My Profile**.
- Put the link in your email signature or on your website.
- Clients can also book from inside the client app.

> Bookings go into each person's calendar, so they need Microsoft 365 or Google connected. See [Connect your email and calendar](kb:connect-email-and-calendar).
`,
  },
];
