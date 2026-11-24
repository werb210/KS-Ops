// KS_OPS_FLOW_PDF_LINK_v1 - the one-page overview link under the button in the Keystone flow emails.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderEmail } from "../../src/marketing/render.js";
import { KEYSTONE_BROKER_FLOWS, KS_ONE_PAGER_URL } from "../../src/marketing/flowPresets.js";

const r = { email: "pat@example.com", name: "Pat Lee", company: "Lee Capital" };

describe("Keystone flow one-pager link", () => {
  it("is on the second email and the opened email only", () => {
    const withLink = Object.entries(KEYSTONE_BROKER_FLOWS.CA.templates).filter(([, t]) => t.fields.link2_url).map(([k]) => k);
    expect(withLink.sort()).toEqual(["n2", "o1"]);
    expect(KS_ONE_PAGER_URL).toBe("https://www.keystonecrm.online/keystone-overview.pdf");
  });

  it("renders as a link in HTML and in the text version", () => {
    const t = KEYSTONE_BROKER_FLOWS.CA.templates.o1;
    const out = renderEmail(t.subject, t.fields, r);
    expect(out.html).toContain(`href="${KS_ONE_PAGER_URL}"`);
    expect(out.html).toContain("Download the one-page Keystone overview (PDF)");
    expect(out.text).toContain(`Download the one-page Keystone overview (PDF): ${KS_ONE_PAGER_URL}`);
  });

  it("adds nothing when the template has no link", () => {
    const t = KEYSTONE_BROKER_FLOWS.CA.templates.e1;
    const out = renderEmail(t.subject, t.fields, r);
    expect(out.html).not.toContain("keystone-overview.pdf");
  });

  it("migration only fills an empty link and never names Boreal", () => {
    const sql = readFileSync("migrations/028_flow_one_pager.sql", "utf8");
    expect(sql).toContain("COALESCE(fields->>'link2_url', '') = ''");
    expect(sql.toLowerCase()).not.toContain("boreal");
  });

  // KS_OPS_FLOW_US_CA_v1
  it("has a Canadian and a US flow, and every email in both points to the live demo for that country", () => {
    for (const [mk, flow] of Object.entries(KEYSTONE_BROKER_FLOWS)) {
      expect(flow.market).toBe(mk);
      for (const t of Object.values(flow.templates)) {
        expect(t.fields.cta_url).toBe(`https://www.keystonecrm.online/try?country=${mk.toLowerCase()}`);
        expect(`${t.subject} ${t.fields.body}`).not.toMatch(/\$|price|boreal/i);
      }
    }
    expect(KEYSTONE_BROKER_FLOWS.US.templates.e1.fields.body).toContain("SBA");
    expect(KEYSTONE_BROKER_FLOWS.CA.templates.e1.fields.body).not.toContain("SBA");
    expect(KEYSTONE_BROKER_FLOWS.CA.name).not.toBe(KEYSTONE_BROKER_FLOWS.US.name);
  });
});
