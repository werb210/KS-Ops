import { describe, expect, it } from "vitest";
import { testBrokerageSkip } from "../../src/provisioning/executors.js";

// KS_OPS_TEST_BROKERAGE_v1
describe("test brokerages", () => {
  it("skip buying numbers, bundles and texting registration", () => {
    expect(testBrokerageSkip({ test_brokerage: true }, "phone numbers bought")).toMatchObject({ kind: "done", output: { skipped: "test_brokerage" } });
  });
  it("leave client brokerages alone", () => {
    expect(testBrokerageSkip({ test_brokerage: false }, "x")).toBeNull();
    expect(testBrokerageSkip({}, "x")).toBeNull();
  });
});
