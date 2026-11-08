import { describe, expect, it } from "vitest";
import { sharedAppBuild } from "../../src/provisioning/machine.js";

// KS_SHARED_APP_BUILD_v1
describe("shared app build switch", () => {
  it("is on only when asked for", () => {
    expect(sharedAppBuild({ KS_SHARED_APP_BUILD: "true" })).toBe(true);
    expect(sharedAppBuild({ KS_SHARED_APP_BUILD: "1" })).toBe(true);
    expect(sharedAppBuild({})).toBe(false);
    expect(sharedAppBuild({ KS_SHARED_APP_BUILD: "false" })).toBe(false);
  });
});
