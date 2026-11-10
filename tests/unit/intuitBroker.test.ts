// KS_BROKERAGE_QBO - Intuit's callback for a brokerage's QuickBooks goes back to that brokerage's own server.
import { describe, expect, it } from "vitest";
import { brokerTarget, parseBrokerState, stateMac } from "../../src/workspace/broker.js";

const LICENSEE = "11111111-2222-3333-4444-555555555555";
const KEY = "ops-key";

function state(flow: string, exp = Math.floor(Date.now() / 1000) + 600) {
  const body = `ks1.${LICENSEE}.${flow}.${exp}.abcdefghijklmnopqrstuvwxyz012345`;
  return `${body}.${stateMac(KEY, body)}`;
}

describe("Intuit redirect broker", () => {
  it("forwards a QuickBooks callback to the brokerage's server with every parameter", () => {
    const t = brokerTarget("intuit", parseBrokerState(state("qbo")), { server_url: "https://acme-api.example.test", ops_key: KEY }, { code: "c1", state: "s", realmId: "9130" });
    expect(t.ok).toBe(true);
    if (t.ok) {
      const u = new URL(t.url);
      expect(u.host).toBe("acme-api.example.test");
      expect(u.pathname).toBe("/api/quickbooks/oauth/callback");
      expect(u.searchParams.get("realmId")).toBe("9130");
    }
  });

  it("refuses a Microsoft flow on the Intuit address", () => {
    const t = brokerTarget("intuit", parseBrokerState(state("o365")), { server_url: "https://acme-api.example.test", ops_key: KEY }, {});
    expect(t).toEqual({ ok: false, reason: "unknown_flow" });
  });
});
