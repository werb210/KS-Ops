// KS_OPS_MKT_FLOW_v1 - the starting wording for the Keystone broker email flow. Staff can edit each template
// afterwards in Marketing > Templates. Signed by Todd; no price is mentioned.
import type { FlowKey } from "./flow.js";
import type { TemplateFields } from "./render.js";

const SITE = "https://www.keystonecrm.online";
const sig = "Todd";
// KS_OPS_FLOW_PDF_LINK_v1 - the approved one-page overview, linked from the second email and the "opened" email.
export const KS_ONE_PAGER_URL = `${SITE}/keystone-overview.pdf`;
const onePager = { link2_label: "Download the one-page Keystone overview (PDF)", link2_url: KS_ONE_PAGER_URL };
type T = { subject: string; fields: Partial<TemplateFields> };

export const KEYSTONE_BROKER_FLOW: { name: string; from_name: string; templates: Record<FlowKey, T> } = {
  name: "Keystone brokers - email flow",
  from_name: "Todd at Keystone",
  templates: {
    e1: { subject: "Software built by commercial brokers, for commercial brokers", fields: {
      preheader: "One system for your applications, pipeline, lenders, calls and documents.",
      body: "Hi {{first_name}},\n\nMost brokerages run on a CRM built for someone else, plus a phone system, an e-sign tool, a document portal and a spreadsheet of lenders.\n\nKeystone is one system that does all of it, built by working commercial finance brokers:\n\n- Client application and document upload under your own brand\n- Pipeline from first call to funded, with lender submissions built in\n- Calling, texting and email from the client's file",
      cta_label: "See Keystone in two minutes", cta_url: `${SITE}/features`, signature: sig } },
    n2: { subject: "One login instead of six", fields: {
      body: "Hi {{first_name}},\n\nKeystone replaces the CRM, dialler, document portal and lender tracker at {{company}} with one system made for commercial deals.",
      cta_label: "Take a look", cta_url: `${SITE}/why-keystone`, ...onePager, signature: sig } },
    n3: { subject: "Where do your deals stall?", fields: {
      body: "Hi {{first_name}},\n\nBrokers tell us the same three things slow a file down:\n\n- Chasing the client for documents\n- Re-keying the same application for each lender\n- Not knowing which deals need a call today\n\nKeystone was built to remove all three.",
      cta_label: "See how", cta_url: `${SITE}/features`, signature: sig } },
    n4: { subject: "Last note from me", fields: {
      body: "Hi {{first_name}},\n\nI will stop here. If {{company}} ever outgrows its current set-up, a demo is one click away.",
      cta_label: "Keystone overview", cta_url: SITE, signature: sig } },
    o1: { subject: "A deal in Keystone, start to finish", fields: {
      body: "Hi {{first_name}},\n\nHere is one file from start to finish:\n\n1. The client applies on your branded page and uploads documents from their phone.\n2. The file lands in your pipeline with a checklist of what is missing.\n3. You match it to lenders and send the package from the same screen.\n4. Calls, texts, emails and signatures are all logged on the file.\n5. When it funds, your commission and the referral source are tracked.",
      cta_label: "See the walkthrough", cta_url: `${SITE}/features`, ...onePager, signature: sig } },
    o2: { subject: "Try it with a live demo brokerage", fields: {
      body: "Hi {{first_name}},\n\nThe quickest way to judge Keystone is to click around in it. We have a demo brokerage loaded with sample deals, lenders and clients, and no set-up is needed.",
      cta_label: "Open the demo", cta_url: `${SITE}/try`, signature: sig } },
    c1: { subject: "Want a 20-minute walkthrough?", fields: {
      body: "Hi {{first_name}},\n\nThanks for taking a look at Keystone. I would be glad to show you how it would run {{company}}'s deals and answer questions about moving your data over.",
      cta_label: "Book a demo", cta_url: `${SITE}/try`,
      body2: "Or reply with a good number. Otherwise I will give you a call in the next day or two.", signature: sig } },
  },
};
