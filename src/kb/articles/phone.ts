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

## Keep a number you already have
You can transfer a number you use today instead. See [Keeping your existing phone number](kb:keep-your-existing-number).

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
    // KS_OPS_NUMBER_PORTING_v1
    slug: "keep-your-existing-number",
    title: "Keeping your existing phone number",
    category: "Phone",
    audience: "admins",
    plans: [],
    summary: "Transfer (port) a number you already use into Keystone, and forward it so no calls are missed while it moves.",
    body: `
Everyone on your team already has a new Keystone number. If you or a broker would rather keep a number you use today, Keystone can transfer it (this is called porting). Local business lines, mobile numbers and toll-free numbers can all be transferred.

## Before you start
Have your current carrier's latest bill in front of you. You need:
- **The account number** and, if your account has one, **the PIN or passcode**.
- **The name on the account** and **the service address** exactly as they appear on the bill. The carrier rejects the transfer if they do not match.
- **A copy of the bill** (PDF or a photo of the first page).

## Ask for the transfer
1. Open **Set-up** > **Your phone numbers**, or **Settings** > **Phone lines** > **Keep your existing number**. Only Admins can do this.
2. For each person, choose **Use the new Keystone number** (nothing more to do) or **Keep my existing number**.
3. For a number you keep, choose who it belongs to (a person, or the main line), the current carrier, the number type and enter the account details. Upload the bill.
4. Read and sign the **letter of authorization**. It lets Keystone's phone partner move the number for you. The carrier needs it signed within the last 30 days; if a transfer waits longer, you are asked to sign again.

Your account number and PIN are stored encrypted and only shown masked. Keystone support uses them only to submit the transfer.

## Forward your old number now
Transfers take up to four weeks. So that no calls are missed, forward the old number to your temporary Keystone number straight away:
- **Most landlines:** dial \`*72\` followed by the Keystone number. To stop, dial \`*73\`.
- **Bell, Rogers and Telus mobiles (and most others):** dial \`**21*\` then the Keystone number then \`#\`. To stop, dial \`##21#\`.
- **Office phone systems (VoIP or PBX):** set forwarding in your phone system's settings, or ask your provider.

Then call your old number from another phone to check it rings in Keystone, and tick **Test it** on the page.

> Texts cannot be forwarded. They keep going to the old phone until the transfer is done.

## What happens next
- Keystone support submits the transfer to the carrier, usually within one business day. You get an email at every step.
- **Approve the carrier's text.** Near the end your current carrier may text the number asking you to approve the transfer. Reply to approve it **within 90 minutes**, or the carrier rejects it and the transfer starts over.
- When the carrier sets the date, you are emailed it. On that day the number moves to Keystone.

## When it is done
- The number rings in Keystone and becomes that person's own line (or your main line), and calls from the dialler show it as the caller ID.
- **Turn off the forwarding** on the old phone (\`*73\` or \`##21#\`).
- The temporary Keystone number keeps working for 7 days, then it is given back.
- Canadian local and mobile numbers can text straight away. US numbers and toll-free numbers need carrier approval to text first; Keystone submits it for you. See [Business texting registration](kb:texting-registration).

## If the carrier rejects it
You get an email with the reason. The usual cause is an account number, PIN, name or address that does not match the bill exactly. Reply to the email and Keystone support helps you fix it and send it again; your number keeps working with your current carrier meanwhile.
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
