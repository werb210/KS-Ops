import { describe, expect, it } from "vitest";
import { publicSiteUrl } from "../../src/config.js";

describe("the website address used in emails", () => {
  it("prefers Keystone's own address over an Azure host name", () => {
    expect(publicSiteUrl({ PUBLIC_SITE_URL: "https://nice-field-1.1.azurestaticapps.net, https://www.keystonecrm.online/" } as any)).toBe("https://www.keystonecrm.online");
  });
  it("keeps the first address otherwise", () => {
    expect(publicSiteUrl({ PUBLIC_SITE_URL: "https://www.a.example,https://b.example" } as any)).toBe("https://www.a.example");
    expect(publicSiteUrl({ PUBLIC_SITE_URL: "https://x.azurestaticapps.net" } as any)).toBe("https://x.azurestaticapps.net");
    expect(publicSiteUrl({} as any)).toBe("");
  });
});
