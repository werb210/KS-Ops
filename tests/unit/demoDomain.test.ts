// Demo links use Keystone's own demo address, never an Azure host name; the Azure name keeps working in the browser.
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PORTAL_DOMAIN, demoPortalOrigins, demoPortalUrl } from "../../src/demo/config.js";

const saved = process.env.KS_DEMO_PORTAL_URL;
afterEach(() => { if (saved === undefined) delete process.env.KS_DEMO_PORTAL_URL; else process.env.KS_DEMO_PORTAL_URL = saved; });

describe("the demo portal address", () => {
  it("links go to the demo domain when the setting lists only an Azure host", () => {
    process.env.KS_DEMO_PORTAL_URL = "https://thankful-wave-04964490f.2.azurestaticapps.net";
    expect(demoPortalUrl()).toBe(DEMO_PORTAL_DOMAIN);
    expect(demoPortalOrigins()).toEqual(["https://thankful-wave-04964490f.2.azurestaticapps.net", DEMO_PORTAL_DOMAIN]);
  });
  it("a Keystone address in the setting wins, wherever it is in the list", () => {
    process.env.KS_DEMO_PORTAL_URL = "https://thankful-wave-04964490f.2.azurestaticapps.net, https://try.keystonecrm.online/";
    expect(demoPortalUrl()).toBe("https://try.keystonecrm.online");
  });
  it("stays empty when the demo is not set up", () => {
    delete process.env.KS_DEMO_PORTAL_URL;
    expect(demoPortalUrl()).toBe("");
    expect(demoPortalOrigins()).toEqual([]);
  });
});
