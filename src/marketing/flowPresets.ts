// KS_OPS_MKT_FLOW_v1 - the starting wording for the Keystone broker email flows (US and Canada). Staff can edit each template
// afterwards in Marketing > Templates. Signed by Todd; no price is mentioned.
import type { FlowKey } from "./flow.js";
import type { TemplateFields } from "./render.js";

const SITE = "https://www.keystonecrm.online";
const sig = "Todd";
// KS_OPS_FLOW_PDF_LINK_v1 - the approved one-page overview, linked from the second email and the "opened" email.
export const KS_ONE_PAGER_URL = `${SITE}/keystone-overview.pdf`;
const onePager = { link2_label: "Download the one-page Keystone overview (PDF)", link2_url: KS_ONE_PAGER_URL };
type T = { subject: string; fields: Partial<TemplateFields> };

// KS_OPS_FLOW_US_CA_v1 (2026-11-24) - Todd: separate US and Canadian flows, more compelling, and every email points to
// the live demo (no sign-up, no call). Same seven emails in each market; only the wording about deals and lenders differs.
export type KsMarket = "CA" | "US";
type Flow = { name: string; from_name: string; market: KsMarket; templates: Record<FlowKey, T> };
const M = {
  CA: { who: "Canadian commercial finance brokers", deals: "equipment, working-capital and commercial real estate deals",
    lenders: "banks, credit unions, BDC and alternative lenders", country: "ca" },
  US: { who: "U.S. commercial loan brokers", deals: "SBA, equipment and working-capital deals",
    lenders: "SBA lenders, banks, equipment and alternative lenders", country: "us" },
} as const;

function keystoneFlow(market: KsMarket): Flow {
  const m = M[market];
  const demo = `${SITE}/try?country=${m.country}`;
  const noSignup = "No sign-up, no sales call: it opens straight into a working brokerage.";
  return {
    name: market === "US" ? "Keystone brokers - United States" : "Keystone brokers - Canada",
    from_name: "Todd at Keystone",
    market,
    templates: {
      e1: { subject: "What if your CRM was built by a commercial broker?", fields: {
        preheader: "Open a live demo brokerage and click through a real pipeline. No sign-up.",
        body: `Hi {{first_name}},\n\nMost ${m.who} run their business on a CRM made for real estate or sales teams, then bolt on a dialler, an e-sign tool, a document portal and a spreadsheet of lenders.\n\nKeystone is one system built around how commercial deals actually move, by people who broker them:\n\n- Clients apply and upload documents on your own branded page\n- Every file shows what is missing, which lenders fit and who needs a call today\n- Calls, texts, emails and signatures are logged on the file by themselves\n\nYou don't have to take my word for it. Our live demo brokerage is loaded with sample ${m.deals}, so you can click through a real pipeline in a couple of minutes.`,
        cta_label: "Open the live demo", cta_url: demo, body2: noSignup, signature: sig } },
      n2: { subject: "Six logins, or one?", fields: {
        preheader: "Follow one deal from application to funded in the demo.",
        body: "Hi {{first_name}},\n\nCount the tools {{company}} opens to move one deal: CRM, phone, email, e-sign, document portal, lender spreadsheet.\n\nKeystone puts all of it on one screen, built around the file instead of the contact. The quickest way to feel the difference is to open the demo and follow one deal from application to funded.",
        cta_label: "Follow a deal in the demo", cta_url: demo, ...onePager, signature: sig } },
      n3: { subject: "The three things that stall a file", fields: {
        preheader: "Each one is fixed in Keystone. See it in the demo.",
        body: "Hi {{first_name}},\n\nBrokers tell us the same three things slow a deal down:\n\n- Chasing the client for documents\n- Re-keying the same application for every lender\n- Losing track of which files need a call today\n\nIn the demo you can see how Keystone handles each one: the document checklist your client sees on their phone, the lender package built from one application, and the Today list that tells you who to call.",
        cta_label: "See all three in the demo", cta_url: demo, signature: sig } },
      n4: { subject: "Last note from me", fields: {
        preheader: "The demo stays open whenever you want it.",
        body: "Hi {{first_name}},\n\nI'll stop here. The demo brokerage stays open, so whenever {{company}} is ready to look, it is one click away.\n\nIf you would rather I walked you through it, just reply and I will set up a time.",
        cta_label: "Open the live demo", cta_url: demo, body2: noSignup, signature: sig } },
      o1: { subject: "A deal in Keystone, start to finish", fields: {
        preheader: "Every step below is live in the demo.",
        body: `Hi {{first_name}},\n\nHere is one file in Keystone from start to finish:\n\n1. The client applies on your branded page and uploads documents from their phone.\n2. The file lands in your pipeline with a checklist of what is still missing.\n3. You match it to ${m.lenders} and send the package from the same screen.\n4. Calls, texts, emails and signatures are all logged on the file.\n5. When it funds, your commission and the referral source are tracked.\n\nEvery step is live in the demo. Pick any sample deal and walk it through yourself.`,
        cta_label: "Walk a deal through the demo", cta_url: demo, ...onePager, signature: sig } },
      o2: { subject: "Five minutes in the demo", fields: {
        preheader: "A short tour of the parts brokers use most.",
        body: "Hi {{first_name}},\n\nIf you have five minutes, here is the tour I would give you:\n\n1. Open the pipeline and pick a deal in underwriting.\n2. Look at its document checklist, the same one the client sees.\n3. Check the lender matches and the package ready to send.\n4. Open Today to see the calls and follow-ups waiting.\n\nThat is most of a broker's day, on one screen.",
        cta_label: "Start the five-minute tour", cta_url: demo, body2: noSignup, signature: sig } },
      c1: { subject: "Want me to walk you through it?", fields: {
        preheader: "20 minutes, using {{company}}'s own deals and lenders.",
        body: "Hi {{first_name}},\n\nThanks for taking a look at Keystone. I would be glad to spend 20 minutes showing you how it would run {{company}}'s deals, using your own lender list, and to answer any questions about moving your data over.\n\nIn the meantime, the demo is still open if you want another look around.",
        cta_label: "Back to the live demo", cta_url: demo,
        body2: "Or reply with a good time and number. Otherwise I will give you a call in the next day or two.", signature: sig } },
    },
  };
}

export const KEYSTONE_BROKER_FLOWS: Record<KsMarket, Flow> = { CA: keystoneFlow("CA"), US: keystoneFlow("US") };
