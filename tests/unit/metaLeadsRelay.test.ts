// KS_META_LEAD_ADS_v1 - the Facebook lead webhook relay and the Facebook Login broker flow.
import { describe, expect, it, vi } from "vitest";
import { entriesByPage, registerPages, relay, sign, signatureValid } from "../../src/meta/relay.js";
import { FLOW_PATHS } from "../../src/workspace/broker.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const entry = (page: string, lead: string) => ({ id: page, time: 1, changes: [{ field: "leadgen", value: { leadgen_id: lead, page_id: page } }] });

function db(routes: Record<string, { licensee_id: string; company_code: string; server_url: string }>) {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM meta_page_routes")) {
        const ids = (params?.[0] as string[]) ?? [];
        return { rows: ids.filter((id) => routes[id]).map((id) => ({ page_id: id, ...routes[id] })) };
      }
      return { rows: [] };
    }),
  };
}

describe("relay", () => {
  it("sends each brokerage only its own entries, signed again", async () => {
    const d = db({
      "1000001": { licensee_id: A, company_code: "northwind", server_url: "https://northwind.api.example.ca" },
      "1000002": { licensee_id: B, company_code: "acme", server_url: "https://acme.api.example.ca" },
    });
    const f = vi.fn(async () => ({ ok: true, status: 200 }));
    const body = { object: "page", entry: [entry("1000001", "5001"), entry("1000002", "5002"), entry("1000009", "5009")] };
    const r = await relay(d as any, body, "secret", f as any);
    expect(r).toEqual({ delivered: 2, failed: 0, unknownPages: ["1000009"] });
    const calls = f.mock.calls as unknown as Array<[string, { headers: Record<string, string>; body: string }]>;
    const nw = calls.find(([u]) => u.startsWith("https://northwind"))!;
    expect(nw[0]).toBe("https://northwind.api.example.ca/api/webhooks/meta/leadgen");
    expect(JSON.parse(nw[1].body).entry.map((e: any) => e.id)).toEqual(["1000001"]);
    expect(nw[1].headers["X-Hub-Signature-256"]).toBe(sign(nw[1].body, "secret"));
    expect(nw[1].headers["X-KS-Tenant"]).toBe("northwind");
  });
  it("fails the delivery when a brokerage fails, so Meta retries", async () => {
    const d = db({ "1000001": { licensee_id: A, company_code: "northwind", server_url: "https://northwind.api.example.ca" } });
    const r = await relay(d as any, { object: "page", entry: [entry("1000001", "5001")] }, "s", (async () => ({ ok: false, status: 500 })) as any);
    expect(r.failed).toBe(1);
  });
  it("checks Meta's signature", () => {
    const raw = Buffer.from('{"object":"page"}');
    expect(signatureValid(raw, sign(raw, "s"), "s")).toBe(true);
    expect(signatureValid(raw, sign(raw, "x"), "s")).toBe(false);
  });
  it("groups entries by Page and registers Pages per brokerage", async () => {
    expect([...entriesByPage({ object: "page", entry: [entry("1000001", "1"), entry("1000001", "2"), { id: "bad" }] }).keys()]).toEqual(["1000001"]);
    const d = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await registerPages(d as any, A, ["1000001", "1000001", "nope"])).toBe(1);
  });
  it("forwards Facebook Login to the brokerage's callback", () => {
    expect(FLOW_PATHS.meta.meta).toBe("/api/integrations/meta/callback");
  });
});
