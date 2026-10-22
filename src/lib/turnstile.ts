// Cloudflare Turnstile check for the public sign-up form. Only used when TURNSTILE_SECRET is set.
import { env } from "../config.js";

export function turnstileEnabled(): boolean {
  return env("TURNSTILE_SECRET") !== "";
}

export async function verifyTurnstile(token: unknown, ip: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (typeof token !== "string" || !token.trim()) return false;
  try {
    const body = new URLSearchParams({ secret: env("TURNSTILE_SECRET"), response: token.trim() });
    if (ip) body.set("remoteip", ip);
    const r = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await r.json().catch(() => null)) as { success?: boolean } | null;
    return json?.success === true;
  } catch (err) {
    console.warn("[turnstile] check failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}
