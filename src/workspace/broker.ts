// KS_OPS_WORKSPACE_APPS - the redirect broker: Keystone's ONE OAuth redirect address per provider.
//
// Why: Microsoft allows at most 256 redirect URIs on an app (wildcards are discouraged and not available for every
// account type), and each licensee server needs three (mail connect, admin consent, sign-in); Google only accepts
// redirect URIs on verified domains, which *.azurewebsites.net never is. Registering every licensee would also be a
// manual step per licensee. So both apps list only
//     https://<KS-Ops>/api/oauth/callback/microsoft      https://<KS-Ops>/api/oauth/callback/google
// and the licensee server sends a state of the form (KS-server src/licensee/oauthBroker.ts)
//     ks1.<licensee id>.<flow>.<expiry, unix seconds>.<inner state>.<HMAC-SHA256 with the licensee's ops key>
// Here: the licensee is looked up, the HMAC checked with its ops key (kept encrypted in KS-Ops), the expiry and the
// flow checked, and the browser is sent to that licensee's server address FROM KS-OPS'S OWN RECORDS (never an address
// in the state, so this is not an open redirect) at the fixed callback path for the flow, with every query parameter
// unchanged. The licensee server checks the same HMAC again, then its own cookie and single-use state, and redeems
// the code with this broker address as redirect_uri, as both providers require. KS-Ops never sees a token.
import { createHmac, timingSafeEqual } from "node:crypto";

export type BrokerProvider = "microsoft" | "google";

/** The flows each provider may forward, and where on the licensee's KS-server. */
export const FLOW_PATHS: Record<BrokerProvider, Record<string, string>> = {
  microsoft: {
    o365: "/api/o365-oauth/callback",
    consent: "/api/o365-oauth/admin-consent/callback",
    "sso-ms": "/api/auth/sso/microsoft/callback",
  },
  google: {
    google: "/api/google/oauth/callback",
    "sso-google": "/api/auth/sso/google/callback",
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedState = { licenseeId: string; flow: string; exp: number; inner: string; mac: string; body: string };

/** Splits a broker state; null when it is not one. Nothing is trusted yet. */
export function parseBrokerState(raw: unknown): ParsedState | null {
  if (typeof raw !== "string" || raw.length > 600 || !raw.startsWith("ks1.")) return null;
  const parts = raw.split(".");
  if (parts.length !== 6) return null;
  const [, licenseeId, flow, expRaw, inner, mac] = parts;
  if (!UUID.test(licenseeId) || !/^[a-z0-9-]{1,20}$/.test(flow) || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{16,200}$/.test(inner) || !mac) return null;
  return { licenseeId: licenseeId.toLowerCase(), flow, exp: Number(expRaw), inner, mac, body: parts.slice(0, 5).join(".") };
}

export function stateMac(key: string, body: string): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

export type BrokerRefusal = "bad_state" | "unknown_flow" | "expired" | "unknown_licensee" | "bad_signature" | "no_server";

/**
 * Where to send the browser, or why not. `licensee` is the record for parsed.licenseeId (server address and the
 * decrypted ops key), looked up by the caller.
 */
export function brokerTarget(
  provider: BrokerProvider,
  parsed: ParsedState | null,
  licensee: { server_url: string | null; ops_key: string | null } | null,
  query: Record<string, unknown>,
  now = Date.now(),
): { ok: true; url: string } | { ok: false; reason: BrokerRefusal } {
  if (!parsed) return { ok: false, reason: "bad_state" };
  const path = FLOW_PATHS[provider][parsed.flow];
  if (!path) return { ok: false, reason: "unknown_flow" };
  if (parsed.exp * 1000 < now) return { ok: false, reason: "expired" };
  if (!licensee || !licensee.ops_key) return { ok: false, reason: "unknown_licensee" };
  const want = Buffer.from(stateMac(licensee.ops_key, parsed.body), "utf8");
  const got = Buffer.from(parsed.mac, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  let base: URL;
  try {
    base = new URL(String(licensee.server_url ?? ""));
  } catch {
    return { ok: false, reason: "no_server" };
  }
  if (base.protocol !== "https:") return { ok: false, reason: "no_server" };
  const target = new URL(path, `https://${base.host}`);
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === "string" && k.length <= 64 && v.length <= 4000) target.searchParams.set(k, v);
  }
  return { ok: true, url: target.toString() };
}
