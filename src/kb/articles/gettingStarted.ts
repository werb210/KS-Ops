import type { SeedArticle } from "./index.js";

export const GETTING_STARTED: SeedArticle[] = [
  {
    slug: "welcome-to-keystone",
    title: "Welcome to Keystone: your first week",
    category: "Getting started",
    audience: "public",
    plans: [],
    summary: "What to set up first, in order, so your team and your clients can start using Keystone.",
    body: `
Keystone is your brokerage's own CRM and loan-origination system: a staff portal, a branded client app, a dialler and an AI assistant, all with your name on them.

## The first week, in order
1. **Brand it.** Add your logo, colours and font. See [Brand your portal and client app](kb:brand-your-portal).
2. **Add your team.** Each person signs in with a code sent to their mobile. See [Add users and choose their roles](kb:add-users-and-roles).
3. **Get your phone number.** Pick a local business number in a few clicks. See [Get your phone numbers](kb:get-phone-numbers).
4. **Connect email and calendar.** Each person connects Microsoft 365 or Google. See [Connect your email and calendar](kb:connect-email-and-calendar).
5. **Add your lenders.** Your own lenders and their products drive matching. See [Add lenders and their products](kb:add-lenders-and-products).
6. **Bring your data over.** Import from HubSpot, Salesforce, Pipedrive or a spreadsheet. See [Import your data](kb:import-from-hubspot-salesforce-pipedrive).
7. **Send your first application link.** See [Send a client the application link](kb:send-application-link).

> Stuck on any step? Open **Get help** in the sidebar, search the help articles or ask Maya. You can always contact Keystone support from there.
`,
  },
  {
    slug: "after-you-sign-up",
    title: "What happens after you sign up",
    category: "Getting started",
    audience: "public",
    plans: [],
    summary: "From payment to your first sign-in: how your own Keystone copy is set up.",
    body: `
When you sign up on the Keystone website, you choose a company code, a plan, the number of seats, a support level and how to pay (Canadian pre-authorized debit or card).

## What happens next
1. **You pay the first invoice** through a secure Stripe page. Growth and Pro include a one-time onboarding fee; Starter has none.
2. **Your copy is built.** Each brokerage gets its own server and database in Microsoft Azure, Canada Central. Your branding from sign-up is applied.
3. **You get a welcome email** with your portal address and how to sign in. Your first admin account is the contact you gave at sign-up.
4. **Your phone account is opened.** Keystone sets up your phone and texting account and starts the carrier registration for business texting. Texting can take a few business days to be approved.
5. **You sign in** with a code sent to your mobile and follow [Welcome to Keystone: your first week](kb:welcome-to-keystone).

> Your company code is how your staff and apps find your copy. It cannot be changed later, so pick something short, like your brokerage name.
`,
  },
  {
    slug: "sign-in-to-keystone",
    title: "Sign in to the portal and the apps",
    category: "Getting started",
    audience: "all_staff",
    plans: [],
    summary: "Text codes, passkeys, Face ID and finding your company in the apps.",
    body: `
Keystone has no passwords. You sign in with a code texted to your mobile, or with a passkey.

## Sign in to the staff portal
1. Open your portal address (it is in your welcome email).
2. Enter your mobile number and ask for a code.
3. Type the 6-digit code from the text.

## Sign in to the iPhone dialler or iPad app
1. Open the app and enter your **work email or mobile number**. The app finds your brokerage for you.
2. If it can't, tap **Enter company code instead** and type your brokerage's company code.
3. Enter the code we text you. After that, Face ID unlocks the app.

## Add a passkey (faster sign-in)
1. Open **Settings** > **My Profile**.
2. Under **Passkeys**, add a passkey for this device and follow your device's prompts.

> Not getting the code? Check the mobile number on your user with your admin, and make sure your phone can receive texts from short numbers. If your admin turned on single sign-on, use **Sign in with Microsoft** or **Sign in with Google** instead. See [Single sign-on](kb:single-sign-on).
`,
  },
  {
    slug: "find-your-way-around",
    title: "Find your way around the portal",
    category: "Getting started",
    audience: "all_staff",
    plans: [],
    summary: "What each part of the sidebar is for.",
    body: `
The sidebar on the left takes you everywhere. What you see depends on your role.

- **Dashboard**: your key numbers, the pipeline at a glance, drop-offs and document issues.
- **Pipeline**: every deal as a card, by stage. See [Pipeline stages](kb:pipeline-stages).
- **CRM**: contacts and companies with their full timeline.
- **Communications**: email, texts, client messages and team chat.
- **Calendar**: your calendar and tasks.
- **Marketing**: campaigns, sequences, referrers and analytics (Admins and the Marketing role).
- **Lenders**: your lenders and their products.
- **PGI referrals**: Personal Guarantee Insurance referrals.
- **Reports**: ready-made and custom reports (Growth and Pro).
- **Settings**: your profile and, for Admins, the company settings.
- **Get help**: the Help Center, Ask Maya and support requests.

> Press **?** anywhere in the portal to see the keyboard shortcuts.
`,
  },
  {
    slug: "add-users-and-roles",
    title: "Add users and choose their roles",
    category: "Users and teams",
    audience: "admins",
    plans: [],
    summary: "Add a staff member, pick Admin, Staff or Marketing, and remove someone who leaves.",
    body: `
Only Admins can add or change users.

## Add a user
1. Open **Settings** > **User Management**.
2. Choose **Add user**.
3. Enter their first and last name, work email and **mobile number** (they sign in with a code sent to it).
4. Pick a role: **Admin**, **Staff** or **Marketing**. See [Roles explained](kb:roles-explained).
5. Choose **Add user**. They can sign in straight away.

## Change or remove a user
1. Open **Settings** > **User Management** and choose **Edit** on the person.
2. Change their details or role and save, or remove them.

When someone leaves, remove them on their last day. Their records, calls and notes stay in Keystone.

> Each active user uses one seat. To add seats, ask your Keystone contact or send a support request from **Get help**. See [Seats, plans and changing plan](kb:seats-and-changing-plan).
`,
  },
  {
    slug: "roles-explained",
    title: "Roles explained: Admin, Staff, Marketing and Ops",
    category: "Users and teams",
    audience: "all_staff",
    plans: [],
    summary: "What each role can see and do.",
    body: `
Every user has one role. Your Admin sets it in **Settings** > **User Management**.

- **Admin**: everything, including company settings, users, billing, phone lines, the phone menu, imports, exports and security.
- **Staff**: the day-to-day work: pipeline, CRM, communications, calendar, lenders and reports. Staff can't change company settings.
- **Marketing**: marketing tools and reports. Up to three Marketing users can use the Marketing add-on's advanced tools.
- **Ops**: a back-office role with the pipeline, calendar and reports.

Lenders, referrers and partner brokers never get staff roles. They have their own sign-ins to their own portals.

> Need finer control than roles? On Growth and Pro, [teams and record visibility](kb:teams-and-visibility) decide who sees which records. Custom roles are coming soon.
`,
  },
  {
    slug: "teams-and-visibility",
    title: "Teams and record visibility",
    category: "Users and teams",
    audience: "admins",
    plans: ["growth", "pro"],
    summary: "Put people on teams and choose who sees all records, their team's or only their own.",
    body: `
On Growth and Pro, Admins can put people on teams and decide who sees which records.

## Set up teams
1. Open **Settings** > **Teams**.
2. Create a team and add its members. Each person has one **primary team**.
3. Under visibility, choose for each role what they see:
   - **All records** (the default, so nothing changes until you change it);
   - **Their team's records**;
   - **Only their own records**.
4. Override it for one person if you need to.

Admins always see everything. The rule applies everywhere: lists, search, records, exports, reports and the assistant's answers.
`,
  },
  {
    slug: "brand-your-portal",
    title: "Brand your portal and client app",
    category: "Branding",
    audience: "admins",
    plans: [],
    summary: "Your name, logo, colours, font and assistant name, used everywhere.",
    body: `
Your brand is used across the staff portal, the client app, emails, texts and PDFs.

## Change your branding
1. Open **Settings** > **Company**.
2. Update your company name, legal name, logo, **main colour**, accent colour, background colour and font.
3. Name your AI assistant (clients and staff see this name).
4. Add the support email and phone your clients should use.
5. Choose **Save**. The portal changes at once.

## Rules that keep it readable
- The main colour must be dark enough for white text on it. Keystone refuses a colour that can't be read (below 4.5 to 1 contrast).
- The background colour sits behind dark text in the client app.

> Branding you chose at sign-up is applied for you. Once you change a field here, your own value wins.
`,
  },
  {
    slug: "branded-app-in-the-stores",
    title: "Your branded client app in the App Store and Google Play",
    category: "Branding",
    audience: "admins",
    plans: [],
    summary: "How your own client app is published under your brokerage's name.",
    body: `
Your clients can use the client app in any browser straight away, and add it to their home screen. Your own app in the App Store and Google Play is published under **your** developer accounts, so it shows your name.

## What you need
1. An Apple Developer account and a Google Play developer account in your brokerage's name.
2. Your logo as a square app icon.
3. Keystone added as a developer on both accounts. Keystone then builds and submits the app with your name, icon, colours and wording.

Store review usually takes a few days. Ask for this from **Get help** > **Contact support**.

> Until your app is in the stores, send clients the web link. It does everything the app does.
`,
  },
];
