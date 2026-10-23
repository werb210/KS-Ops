// Text messages through Twilio's REST API (no SDK). Configured by:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN  the account (or a sub-account) that owns the sending number
//   KS_SMS_FROM                            the sending number in E.164 (+1...), or
//   TWILIO_MESSAGING_SERVICE_SID           a messaging service (used instead of KS_SMS_FROM when set)
// When it is not configured, nothing is sent and callers fall back to email.
import { env } from "../config.js";

export function smsConfigured(): boolean {
  return env("TWILIO_ACCOUNT_SID") !== "" && env("TWILIO_AUTH_TOKEN") !== "" && (env("KS_SMS_FROM") !== "" || env("TWILIO_MESSAGING_SERVICE_SID") !== "");
}

/**
 * A North American phone number in E.164 (+1XXXXXXXXXX), or null. Accepts the usual ways people type it:
 * "(403) 555-0199", "403.555.0199", "1 403 555 0199", "+1 403 555 0199".
 */
export function normalizeNaPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[^\d\s()+.\-]/.test(raw.trim())) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  // NANP: area code and exchange cannot start with 0 or 1.
  if (/^[01]/.test(d) || /^[01]/.test(d.slice(3))) return null;
  return `+1${d}`;
}

/** "(403) 555-0199" for showing a number back to the person who typed it. */
export function prettyNaPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export async function sendSms(fetchImpl: typeof fetch, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!smsConfigured()) return { ok: false, error: "sms_not_configured" };
  const sid = env("TWILIO_ACCOUNT_SID");
  const form = new URLSearchParams({ To: to, Body: body });
  if (env("TWILIO_MESSAGING_SERVICE_SID")) form.set("MessagingServiceSid", env("TWILIO_MESSAGING_SERVICE_SID"));
  else form.set("From", env("KS_SMS_FROM"));
  try {
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 201 || r.status === 200) return { ok: true };
    let code = "";
    try {
      code = String(((await r.json()) as { code?: unknown }).code ?? "");
    } catch {
      /* body was not JSON */
    }
    return { ok: false, error: `twilio_send_failed status=${r.status}${code ? ` code=${code}` : ""}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
