// KS_OPS_SOCIAL_SIGNUP_v1 - "Continue with Google / Microsoft / Apple" on the sign-up page.
//
// The button only saves typing: after the person picks their account, the sign-up form opens with their name and email
// filled in. Nothing is granted by it - the brokerage is still created by the normal sign-up (and paid for) - so the
// state is a short-lived signed value rather than a session.
//
// Google and Microsoft use Keystone's existing apps (KS_GOOGLE_OAUTH_CLIENT_ID / KS_M365_CLIENT_ID) and the existing
// redirect address ({broker}/google and /microsoft), so no new redirect address has to be registered with either.
// Apple needs its own Services ID and key (KS_APPLE_SERVICES_ID, KS_APPLE_TEAM_ID, KS_APPLE_KEY_ID,
// KS_APPLE_PRIVATE_KEY) with {broker}/apple as its return address; until those are set the Apple button is not offered.
import { createHmac, createPrivateKey, randomBytes, sign as cryptoSign, timingSafeEqual } from "node:crypto";
import { env, publicSiteUrl } from "../config.js";
import { brokerBaseUrl } from "../workspace/apps.js";

export const SOCIAL_PROVIDERS = ["google", "microsoft", "apple"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
export const isSocialProvider = (v: unknown): v is SocialProvider => (SOCIAL_PROVIDERS as readonly string[]).includes(String(v));

export const STATE_PREFIX = "kssu1.";
export const STATE_TTL_MS = 10 * 60_000;
export const PREFILL_TTL_MS = 60 * 60_000;

type Cfg = { provider: SocialProvider; clientId: string; redirectUri: string; authorizeUrl: string; tokenUrl: string; secret: () => string };

function signingKey(e: NodeJS.ProcessEnv): string {
  return env("OPS_ENCRYPTION_KEY", e) || env("OPS_JWT_SECRET", e) || env("JWT_SECRET", e);
}
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const mac = (key: string, body: string) => createHmac("sha256", `social-signup:${key}`).update(body, "utf8").digest("base64url");
function same(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Apple's client secret is a short-lived token signed with the key from the Apple Developer account. */
export function appleClientSecret(e: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const header = b64(JSON.stringify({ alg: "ES256", kid: env("KS_APPLE_KEY_ID", e) }));
  const iat = Math.floor(now / 1000);
  const payload = b64(JSON.stringify({ iss: env("KS_APPLE_TEAM_ID", e), iat, exp: iat + 300, aud: "https://appleid.apple.com", sub: env("KS_APPLE_SERVICES_ID", e) }));
  const pem = env("KS_APPLE_PRIVATE_KEY", e).replace(/\\n/g, "\n");
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64(sig)}`;
}

/** A provider's settings, or null when it cannot be offered on this server. */
export function socialConfig(provider: SocialProvider, e: NodeJS.ProcessEnv = process.env): Cfg | null {
  const broker = brokerBaseUrl(e);
  if (!broker || !signingKey(e) || !publicSiteUrl(e)) return null;
  if (provider === "google") {
    const id = env("KS_GOOGLE_OAUTH_CLIENT_ID", e); const secret = env("KS_GOOGLE_OAUTH_CLIENT_SECRET", e);
    if (!id || !secret) return null;
    return { provider, clientId: id, redirectUri: `${broker}/google`, authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", secret: () => secret };
  }
  if (provider === "microsoft") {
    const id = env("KS_M365_CLIENT_ID", e); const secret = env("KS_M365_CLIENT_SECRET", e);
    if (!id || !secret) return null;
    return { provider, clientId: id, redirectUri: `${broker}/microsoft`, authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", secret: () => secret };
  }
  const id = env("KS_APPLE_SERVICES_ID", e);
  if (!id || !env("KS_APPLE_TEAM_ID", e) || !env("KS_APPLE_KEY_ID", e) || !env("KS_APPLE_PRIVATE_KEY", e)) return null;
  return { provider, clientId: id, redirectUri: `${broker}/apple`, authorizeUrl: "https://appleid.apple.com/auth/authorize", tokenUrl: "https://appleid.apple.com/auth/token", secret: () => appleClientSecret(e) };
}

export function offeredProviders(e: NodeJS.ProcessEnv = process.env): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((p) => socialConfig(p, e) !== null);
}

/** kssu1.<provider>.<expiry seconds>.<nonce>.<mac> */
export function newState(provider: SocialProvider, e: NodeJS.ProcessEnv = process.env, now = Date.now()): { state: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const body = `${STATE_PREFIX}${provider}.${Math.floor((now + STATE_TTL_MS) / 1000)}.${nonce}`;
  return { state: `${body}.${mac(signingKey(e), body)}`, nonce };
}

export function readState(raw: unknown, provider: SocialProvider, e: NodeJS.ProcessEnv = process.env, now = Date.now()): { nonce: string } | null {
  if (typeof raw !== "string" || raw.length > 300 || !raw.startsWith(STATE_PREFIX)) return null;
  const parts = raw.slice(STATE_PREFIX.length).split(".");
  if (parts.length !== 4) return null;
  const [p, exp, nonce, sig] = parts as [string, string, string, string];
  const key = signingKey(e);
  if (!key || p !== provider || !/^\d{1,12}$/.test(exp) || Number(exp) * 1000 < now) return null;
  if (!same(sig, mac(key, `${STATE_PREFIX}${p}.${exp}.${nonce}`))) return null;
  return { nonce };
}

export function authorizeUrl(cfg: Cfg, state: string, nonce: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", state, nonce });
  if (cfg.provider === "apple") { q.set("scope", "name email"); q.set("response_mode", "form_post"); }
  else { q.set("scope", "openid email profile"); q.set("prompt", "select_account"); }
  return `${cfg.authorizeUrl}?${q.toString()}`;
}

export type SocialIdentity = { provider: SocialProvider; email: string; name: string };

const ISSUER: Record<SocialProvider, (iss: string) => boolean> = {
  google: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
  microsoft: (iss) => /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(iss),
  apple: (iss) => iss === "https://appleid.apple.com",
};

/** Reads the ID token that came straight from the provider's token address over TLS (so its claims are checked, not
 *  its signature: OpenID Connect Core 3.1.3.7). Throws a short reason when anything does not fit. */
export function identityFromIdToken(cfg: Cfg, idToken: string, nonce: string, appleUser?: unknown, now = Date.now()): SocialIdentity {
  const part = String(idToken ?? "").split(".")[1];
  if (!part) throw new Error("no_id_token");
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw new Error("bad_id_token"); }
  const aud = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud ?? "")];
  if (!aud.includes(cfg.clientId)) throw new Error("wrong_audience");
  if (!ISSUER[cfg.provider](String(c.iss ?? ""))) throw new Error("wrong_issuer");
  if (!(Number(c.exp) * 1000 > now)) throw new Error("expired");
  if (String(c.nonce ?? "") !== nonce) throw new Error("wrong_nonce");
  const email = String(c.email ?? (cfg.provider === "microsoft" ? c.preferred_username ?? "" : "")).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("no_email");
  let name = String(c.name ?? "").trim() || [c.given_name, c.family_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  if (!name && cfg.provider === "apple" && appleUser) {
    // Apple sends the name once, beside the code, the first time the person signs in.
    try {
      const u = (typeof appleUser === "string" ? JSON.parse(appleUser) : appleUser) as { name?: { firstName?: string; lastName?: string } };
      name = [u?.name?.firstName, u?.name?.lastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
    } catch { /* the name is optional */ }
  }
  return { provider: cfg.provider, email, name: name.slice(0, 120) };
}

export async function exchangeCode(cfg: Cfg, code: string, doFetch: typeof fetch): Promise<string> {
  const r = await doFetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.secret(), redirect_uri: cfg.redirectUri }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!r.ok || !j.id_token) throw new Error(`token_exchange_${r.status}${j.error ? `_${j.error}` : ""}`);
  return j.id_token;
}

/** The signed hand-over the sign-up page reads: who the person is, for an hour. */
export function prefillToken(id: SocialIdentity, e: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const body = b64(JSON.stringify({ p: id.provider, e: id.email, n: id.name, x: Math.floor((now + PREFILL_TTL_MS) / 1000) }));
  return `${body}.${mac(signingKey(e), body)}`;
}

export function readPrefill(raw: unknown, e: NodeJS.ProcessEnv = process.env, now = Date.now()): SocialIdentity | null {
  if (typeof raw !== "string" || raw.length > 1200) return null;
  const [body, sig] = raw.split(".");
  const key = signingKey(e);
  if (!body || !sig || !key || !same(sig, mac(key, body))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: string; e?: string; n?: string; x?: number };
    if (!isSocialProvider(v.p) || !v.e || !(Number(v.x) * 1000 > now)) return null;
    return { provider: v.p, email: String(v.e), name: String(v.n ?? "") };
  } catch {
    return null;
  }
}

export const signupPage = (e: NodeJS.ProcessEnv = process.env) => `${publicSiteUrl(e).replace(/\/+$/, "")}/signup`;
