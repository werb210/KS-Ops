// KS_OPS_SOCIAL_SIGNUP_v1 - "Continue with Google / Microsoft / Apple" on the sign-up page: which buttons are offered,
// the signed state, reading who the person is, and the hand-over the form reads. No network: the token call is a fake.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appleClientSecret, authorizeUrl, exchangeCode, identityFromIdToken, newState, offeredProviders, prefillToken, readPrefill, readState, socialConfig } from "../../src/signup/social.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const BASE = { OPS_ENCRYPTION_KEY: "k".repeat(64), KS_OPS_PUBLIC_URL: "https://ops.example.test", PUBLIC_SITE_URL: "https://www.example.test" } as NodeJS.ProcessEnv;
const GOOGLE = { ...BASE, KS_GOOGLE_OAUTH_CLIENT_ID: "g-client", KS_GOOGLE_OAUTH_CLIENT_SECRET: "g-secret" };
const ALL = { ...GOOGLE, KS_M365_CLIENT_ID: "m-client", KS_M365_CLIENT_SECRET: "m-secret", KS_APPLE_SERVICES_ID: "com.example.signin", KS_APPLE_TEAM_ID: "TEAM123456", KS_APPLE_KEY_ID: "KEY1234567",
  KS_APPLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n") };
const NOW = Date.parse("2026-11-15T12:00:00Z");
const token = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("sign up with Google, Microsoft or Apple", () => {
  it("offers only the providers this server has keys for", () => {
    expect(offeredProviders(BASE)).toEqual([]);
    expect(offeredProviders(GOOGLE)).toEqual(["google"]);
    expect(offeredProviders(ALL)).toEqual(["google", "microsoft", "apple"]);
  });

  it("sends the person to the provider with Keystone's existing return address", () => {
    const cfg = socialConfig("google", ALL)!;
    const { state, nonce } = newState("google", ALL, NOW);
    const u = new URL(authorizeUrl(cfg, state, nonce));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("https://ops.example.test/api/oauth/callback/google");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    const apple = new URL(authorizeUrl(socialConfig("apple", ALL)!, state, nonce));
    expect(apple.searchParams.get("response_mode")).toBe("form_post");
  });

  it("accepts its own state once, for ten minutes, for that provider only", () => {
    const { state, nonce } = newState("microsoft", ALL, NOW);
    expect(readState(state, "microsoft", ALL, NOW + 60_000)).toEqual({ nonce });
    expect(readState(state, "google", ALL, NOW)).toBeNull();
    expect(readState(state, "microsoft", ALL, NOW + 11 * 60_000)).toBeNull();
    expect(readState(state.replace(/\.[^.]+$/, ".tampered"), "microsoft", ALL, NOW)).toBeNull();
    expect(readState(state, "microsoft", { ...ALL, OPS_ENCRYPTION_KEY: "other".repeat(13) }, NOW)).toBeNull();
  });

  it("reads the name and email, and refuses a token meant for someone else", () => {
    const cfg = socialConfig("google", ALL)!;
    const ok = { aud: "g-client", iss: "https://accounts.google.com", exp: NOW / 1000 + 600, nonce: "n1", email: "Pat@Example.test", name: "Pat Sample" };
    expect(identityFromIdToken(cfg, token(ok), "n1", undefined, NOW)).toEqual({ provider: "google", email: "pat@example.test", name: "Pat Sample" });
    expect(() => identityFromIdToken(cfg, token({ ...ok, aud: "someone-else" }), "n1", undefined, NOW)).toThrow("wrong_audience");
    expect(() => identityFromIdToken(cfg, token({ ...ok, iss: "https://evil.example" }), "n1", undefined, NOW)).toThrow("wrong_issuer");
    expect(() => identityFromIdToken(cfg, token(ok), "other", undefined, NOW)).toThrow("wrong_nonce");
    expect(() => identityFromIdToken(cfg, token({ ...ok, exp: NOW / 1000 - 5 }), "n1", undefined, NOW)).toThrow("expired");
  });

  it("Apple: the name arrives beside the code the first time", () => {
    const cfg = socialConfig("apple", ALL)!;
    const who = identityFromIdToken(cfg, token({ aud: "com.example.signin", iss: "https://appleid.apple.com", exp: NOW / 1000 + 600, nonce: "n1", email: "pat@example.test" }),
      "n1", JSON.stringify({ name: { firstName: "Pat", lastName: "Sample" } }), NOW);
    expect(who).toEqual({ provider: "apple", email: "pat@example.test", name: "Pat Sample" });
    expect(appleClientSecret(ALL, NOW).split(".")).toHaveLength(3);
  });

  it("exchanges the code with the provider and hands the form a signed, short-lived note of who it is", async () => {
    const cfg = socialConfig("microsoft", ALL)!;
    const calls: Array<{ url: string; body: string }> = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: String(init.body) }); return new Response(JSON.stringify({ id_token: "a.b.c" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await exchangeCode(cfg, "the-code", fake)).toBe("a.b.c");
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(calls[0]!.body).toContain("code=the-code");
    const refuse = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode(cfg, "bad", refuse)).rejects.toThrow("token_exchange_400_invalid_grant");

    const t = prefillToken({ provider: "microsoft", email: "pat@example.test", name: "Pat Sample" }, ALL, NOW);
    expect(readPrefill(t, ALL, NOW + 60_000)).toEqual({ provider: "microsoft", email: "pat@example.test", name: "Pat Sample" });
    expect(readPrefill(t, ALL, NOW + 2 * 60 * 60_000)).toBeNull();
    expect(readPrefill(`${prefillToken({ provider: "microsoft", email: "other@example.test", name: "X" }, ALL, NOW).split(".")[0]}.${t.split(".")[1]}`, ALL, NOW)).toBeNull();
  });
});
