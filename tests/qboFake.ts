// A fake Intuit: OAuth token, revoke and the QuickBooks API (query + create), in memory. No network.
import { vi } from "vitest";
import { INTUIT_REVOKE_URL, INTUIT_TOKEN_URL } from "../src/qbo/config.js";

type Obj = Record<string, any>;

export function fakeIntuit() {
  const store: Record<string, Obj[]> = {};
  const byRequestId = new Map<string, Obj>();
  const state = {
    refreshCount: 0,
    revoked: [] as string[],
    tokenRequests: [] as Array<Record<string, string>>,
    creates: [] as Array<{ entity: string; body: Obj; requestId: string | null }>,
    failNext: null as null | { entity: string; status: number; body: Obj },
    accessToken: "access-0",
    refreshToken: "refresh-0",
    unauthorizedOnce: false,
  };
  let nextId = 100;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const entityName: Record<string, string> = {
    customer: "Customer", item: "Item", vendor: "Vendor", invoice: "Invoice", payment: "Payment",
    refundreceipt: "RefundReceipt", creditmemo: "CreditMemo", purchase: "Purchase",
  };

  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === INTUIT_TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      state.tokenRequests.push(form);
      if (form.grant_type === "authorization_code") {
        if (form.code !== "good-code") return json({ error: "invalid_grant" }, 400);
      } else if (form.grant_type === "refresh_token") {
        if (form.refresh_token !== state.refreshToken) return json({ error: "invalid_grant" }, 400);
        state.refreshCount++;
      }
      state.accessToken = `access-${state.refreshCount}-${form.grant_type}`;
      state.refreshToken = `refresh-${state.refreshCount}-${form.grant_type}`;
      return json({ access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 3600, x_refresh_token_expires_in: 8_640_000 });
    }
    if (url === INTUIT_REVOKE_URL) {
      state.revoked.push(JSON.parse(String(init.body)).token);
      return new Response("", { status: 200 });
    }
    const m = /\/v3\/company\/(\d+)\/([^?]+)\?(.*)$/.exec(url);
    if (!m) return new Response("unexpected " + url, { status: 500 });
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? "");
    if (state.unauthorizedOnce) {
      state.unauthorizedOnce = false;
      return json({ fault: { error: [{ message: "AuthenticationFailed", code: "100" }] } }, 401);
    }
    if (auth !== `Bearer ${state.accessToken}`) return json({ fault: { error: [{ message: "AuthenticationFailed" }] } }, 401);
    const [, , path, qs] = m;
    const params = new URLSearchParams(qs);
    if (path === "query") {
      const q = params.get("query") ?? "";
      const qm = /FROM (\w+)(?: WHERE (\w+) = '((?:[^'\\]|\\.)*)')?/.exec(q);
      if (!qm) return json({ QueryResponse: {} });
      const [, entity, field, raw] = qm;
      const value = raw?.replace(/\\(.)/g, "$1");
      let rows = store[entity] ?? [];
      if (field === "AccountType") rows = [{ Id: "79", Name: "Services" }];
      else if (field) rows = rows.filter((r) => (field === "PrimaryEmailAddr" ? r.PrimaryEmailAddr?.Address : r[field]) === value);
      return json({ QueryResponse: rows.length ? { [entity]: rows.slice(0, 1) } : {} });
    }
    if (path.startsWith("companyinfo/")) return json({ CompanyInfo: { CompanyName: "Keystone Software Inc." } });
    const entity = entityName[path];
    if (!entity || init.method !== "POST") return new Response("unexpected " + path, { status: 500 });
    if (state.failNext && state.failNext.entity === entity) {
      const f = state.failNext;
      state.failNext = null;
      return json(f.body, f.status);
    }
    const requestId = params.get("requestid");
    if (requestId && byRequestId.has(requestId)) return json(byRequestId.get(requestId));
    const body = JSON.parse(String(init.body));
    state.creates.push({ entity, body, requestId });
    const lines: Obj[] = body.Line ?? [];
    const sales = lines.filter((l) => l.DetailType !== "DiscountLineDetail").reduce((a, l) => a + Number(l.Amount ?? 0), 0);
    const disc = lines.filter((l) => l.DetailType === "DiscountLineDetail").reduce((a, l) => a + Number(l.Amount ?? 0), 0);
    const tax = Number(body.TxnTaxDetail?.TotalTax ?? 0);
    const saved = { ...body, Id: String(nextId++), TotalAmt: body.TotalAmt ?? Math.round((sales - disc + tax) * 100) / 100 };
    (store[entity] ??= []).push(saved);
    const res = { [entity]: saved };
    if (requestId) byRequestId.set(requestId, res);
    return json(res);
  });
  return { fetch: fetchImpl, store, state };
}
