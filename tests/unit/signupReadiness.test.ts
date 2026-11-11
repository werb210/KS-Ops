// KS_OPS_SIGNUP_READINESS_v1 - what is still missing before a brokerage can sign up, pay and get its emails unaided.
import { afterEach, describe, expect, it, vi } from "vitest";
import { signupSetupMissing } from "../../src/onboarding/readiness.js";
import { stripePriceSpecs } from "../../src/pricing.js";

const db = (keys: string[] | Error) => ({ query: vi.fn(async () => { if (keys instanceof Error) throw keys; return { rows: keys.map((key) => ({ key })) }; }) });
const EMAIL = ["MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_SEND_AS", "SENDGRID_API_KEY", "SENDGRID_FROM"];

afterEach(() => vi.unstubAllEnvs());

describe("sign-up readiness", () => {
  it("lists every missing setting in production, by name only", async () => {
    for (const k of EMAIL) vi.stubEnv(k, "");
    const keys = (await signupSetupMissing(db([]), { NODE_ENV: "production" } as NodeJS.ProcessEnv)).map((x) => x.key);
    expect(keys).toEqual(["TURNSTILE_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "email", "KS_SALES_EMAIL"]);
  });

  it("is empty once everything is set and every Stripe price exists", async () => {
    vi.stubEnv("SENDGRID_API_KEY", "x"); vi.stubEnv("SENDGRID_FROM", "hello@example.com");
    const all = stripePriceSpecs().map((p) => p.key);
    const e = { NODE_ENV: "production", TURNSTILE_SECRET: "t", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", KS_SALES_EMAIL: "s@example.com" } as NodeJS.ProcessEnv;
    expect(await signupSetupMissing(db(all), e)).toEqual([]);
  });

  it("counts missing Stripe prices, and says so when the table cannot be read", async () => {
    vi.stubEnv("SENDGRID_API_KEY", "x"); vi.stubEnv("SENDGRID_FROM", "hello@example.com");
    const e = { NODE_ENV: "development", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh", KS_SALES_EMAIL: "s@example.com" } as NodeJS.ProcessEnv;
    const some = stripePriceSpecs().map((p) => p.key).slice(1);
    const [item] = await signupSetupMissing(db(some), e);
    expect(item.key).toBe("stripe_prices");
    expect(item.label).toMatch(/^Stripe prices: 1 of \d+ missing/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await signupSetupMissing(db(new Error("no table")), e)).map((x) => x.key)).toEqual(["stripe_prices"]);
    expect(err).toHaveBeenCalled();
  });
});
