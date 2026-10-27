import type { SeedArticle } from "./index.js";

export const PHONE: SeedArticle[] = [
  {
    slug: "get-phone-numbers",
    title: "Get your phone numbers",
    category: "Phone",
    audience: "admins",
    plans: [],
    summary: "Buy your business line, a toll-free line or direct lines in a few clicks.",
    body: `
Keystone sets up your phone account for you. Admins pick the numbers in **Settings** > **Phone lines**.

## Get a number
1. Open **Settings** > **Phone lines**.
2. Choose **Get a number**. Keystone suggests an area code from your main line, phone or address; you can change it.
3. Pick one of the numbers shown. It is bought and set up for calls and texts straight away.

## Which lines your plan includes
- **Business line**: every plan.
- **Toll-free line**: Growth and Pro.
- **Direct line for each person**: Pro. Calls to a direct number ring only that person, then their voicemail, and their outgoing calls show it.

## Change or release a number
- **Change number** buys a new one for the same person.
- **Release number** lets one go after a grace period. Choose **Keep** during the grace period to cancel. Admins are told either way.

> Calls and texts use your pooled minutes and texts. See [Allowances, usage and overage](kb:allowances-usage-and-overage).
`,
  },
  {
    slug: "texting-registration",
    title: "Business texting registration",
    category: "Phone",
    audience: "admins",
    plans: [],
    summary: "Why texts need carrier approval, and what Keystone does for you.",
    body: `
Canadian and US carriers only deliver business texts from registered senders. Keystone submits the registration for your brokerage when your phone account is opened, using the business details from your sign-up.

## What to expect
- Approval usually takes a few business days, sometimes longer for toll-free numbers.
- Calls work straight away. Texts may be blocked or delayed until approval.
- If the carrier needs more information, Keystone support contacts you.

## Clients' choices
- Clients choose whether they get application updates by text.
- Anyone who replies STOP is not texted again.
`,
  },
  {
    slug: "phone-menu",
    title: "Set up your phone menu",
    category: "Phone",
    audience: "admins",
    plans: [],
    summary: "What callers to your main number hear, your hours, and where each key goes.",
    body: `
Admins set up the phone menu in **Settings** > **Phone menu**. It is on every plan.

## Build the menu
1. **Greeting**: type what callers hear (read aloud), or upload a recording (MP3 or WAV, up to 5 MB).
2. **Options 1 to 9**: give each key a label and where it goes:
   - a **person**;
   - a **group** (ring everyone at once, or one at a time);
   - a **voicemail box**;
   - the **AI receptionist** (the caller says what they need and is routed);
   - the **meeting dial-in**.
3. Turn on **announce options** to read "For sales, press 1..." after the greeting.
4. **No answer**: choose where a call goes when nobody picks up (the person's own voicemail by default).
5. Save.

## Hours and holidays
Set your weekly hours and holidays in your brokerage's time zone. Outside them, callers hear the after-hours greeting and go to the after-hours choice (voicemail by default).

> Made a mess of it? **Reset** goes back to the default menu, built from your staff. Waiting in a hold queue is coming soon.
`,
  },
  {
    slug: "iphone-dialler",
    title: "The iPhone dialler",
    category: "Phone",
    audience: "all_staff",
    plans: [],
    summary: "Calls and texts from your business number, with the caller's file on screen.",
    body: `
The Keystone dialler uses the iPhone's own call screen, so calls feel like normal calls but come from your business number.

## Set it up
1. Install the Keystone dialler from the link Keystone sends you.
2. Sign in with your work email or mobile number. See [Sign in to the portal and the apps](kb:sign-in-to-keystone).
3. Allow notifications and the microphone.

## What it does
- Tabs for Calls, Contacts, SMS, Messages, Team chat and Calendar.
- The **caller card** shows the caller's name, file and stage during the call.
- In-call: mute, keypad, hold, transfer, add someone, speaker.
- **Call outcome**: one tap after the call to log how it went.
- **Voice notes**: dictate a note after a call and save it to the client's timeline.
- **Ring my mobile**: if the app doesn't answer, the call goes to your verified mobile; press 1 to accept.
- **Call hours**: outside your hours, callers hear an away message.
- Widgets, Control Center buttons and a Live Activity for the current call.

> The staff dialler is for iPhone. An Android staff app is coming soon.
`,
  },
  {
    slug: "apple-watch-and-ipad",
    title: "Apple Watch and iPad apps",
    category: "Phone",
    audience: "all_staff",
    plans: [],
    summary: "Take calls on your wrist, and run the full portal on iPad.",
    body: `
## Apple Watch (Growth and Pro)
The Watch app comes with the iPhone dialler. Dial, see favourites, calls due, recent calls and voicemail, send quick replies or dictate, and add complications to your watch face. It can take calls without the iPhone nearby.

## iPad (every plan)
The iPad app is the full staff portal, with calls, push notifications, Face ID, business-card scan, share-to-deal and document markup (annotate a document and save it back to the file).

1. Install the Keystone iPad app from the link Keystone sends you.
2. Sign in with your work email or mobile number.

> On Starter, the Watch app shows that it needs Growth or Pro. During a Pro trial it works.
`,
  },
  {
    slug: "recording-transcripts-voicemail",
    title: "Call recording, transcripts and voicemail",
    category: "Phone",
    audience: "all_staff",
    plans: [],
    summary: "What is recorded, who can play it back, and AI call notes.",
    body: `
- **Recording**: calls are recorded on every plan, and callers hear a notice first. **Playing recordings back** is on Growth and Pro.
- **Transcripts and AI notes** (Growth and Pro): after a call you get the transcript, a short summary, next steps and a follow-up task, saved to the deal.
- **Voicemail**: a voicemail box for each person and for the main line, played in the portal and the apps.
- **Voicemail transcription** (Growth and Pro): read voicemails as text.
- **Missed calls**: push alerts and a summary.

## Block a number
Admins can add unwanted callers to **Settings** > **Blocked numbers**.
`,
  },
];
