// KS_ZOOM_MEETINGS_v1 - Zoom's callback for a broker's Zoom connection goes back to that brokerage's own server.
import { describe, expect, it } from "vitest";
import { brokerTarget, parseBrokerState, stateMac } from "../../src/workspace/broker.js";

const LICENSEE = "11111111-2222-3333-4444-555555555555";
const KEY = "ops-key";

function state(flow: string, exp = Math.floor(Date.now() / 1000) + 600) {
  const body = `ks1.${LICENSEE}.${flow}.${exp}.abcdefghijklmnopqrstuvwxyz012345`;
  return `${body}.${stateMac(KEY, body)}`;
}

describe("Zoom redirect broker", () => {
  it("forwards a Zoom callback to the brokerage's server with every parameter", () => {
    const t = brokerTarget("zoom", parseBrokerState(state("zoom")), { server_url: "https://acme-api.example.test", ops_key: KEY }, { code: "c1", state: "s" });
    expect(t.ok).toBe(true);
    if (t.ok) {
      const u = new URL(t.url);
      expect(u.host).toBe("acme-api.example.test");
      expect(u.pathname).toBe("/api/meeting-notes/zoom/callback");
      expect(u.searchParams.get("code")).toBe("c1");
    }
  });

  it("refuses a QuickBooks flow on the Zoom address", () => {
    const t = brokerTarget("zoom", parseBrokerState(state("qbo")), { server_url: "https://acme-api.example.test", ops_key: KEY }, {});
    expect(t).toEqual({ ok: false, reason: "unknown_flow" });
  });
});
