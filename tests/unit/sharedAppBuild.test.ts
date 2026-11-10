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

  // The live service builds its machine deps without an env object: the switch must read the app settings then.
  it("reads the app settings when no env is passed", () => {
    const before = process.env.KS_SHARED_APP_BUILD;
    try {
      process.env.KS_SHARED_APP_BUILD = "true";
      expect(sharedAppBuild(undefined)).toBe(true);
      delete process.env.KS_SHARED_APP_BUILD;
      expect(sharedAppBuild(undefined)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.KS_SHARED_APP_BUILD;
      else process.env.KS_SHARED_APP_BUILD = before;
    }
  });
});
