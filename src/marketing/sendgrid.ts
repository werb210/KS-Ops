// KS_OPS_PROSPECT_MARKETING_v1 - SendGrid for marketing: one personalised email per call (open and click tracking on,
// SendGrid's own unsubscribe footer off - ours is in the email), and the Event Webhook check.
//
// Every marketing email carries custom_args { ks_mkt: "1", ks_mkt_send_id }, which come back on every event. Events
// without them belong to someone else (BF-Server shares the SendGrid account) and are ignored here; BF-Server's own
// webhook skips events that carry ks_mkt_send_id (BF-Server block v865 KS_MARKETING).
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { env } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import type { Rendered } from "./render.js";
import { sender, sendgridKey } from "./settings.js";

export type SendResult = { ok: true; message_id: string | null } | { ok: false; error: string; permanent: boolean };

export async function sendMarketingEmail(
  fetchImpl: typeof fetch,
  to: { email: string; name?: string | null },
  email: Rendered,
  customArgs: Record<string, string>,
): Promise<SendResult> {
  const key = sendgridKey();
  const s = sender();
  if (!key || !s.from) return { ok: false, error: "sendgrid_not_configured", permanent: false };
  try {
    const r = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: to.email, ...(to.name ? { name: String(to.name).slice(0, 100) } : {}) }],
            custom_args: { ks_mkt: "1", ...customArgs },
          },
        ],
        from: { email: s.from, name: s.from_name },
        reply_to: { email: s.reply_to },
        subject: email.subject,
        content: [
          { type: "text/plain", value: email.text },
          { type: "text/html", value: email.html },
        ],
        headers: email.headers,
        categories: ["keystone-marketing"],
        tracking_settings: {
          click_tracking: { enable: true, enable_text: false },
          open_tracking: { enable: true },
          subscription_tracking: { enable: false },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 202 || r.ok) return { ok: true, message_id: r.headers.get("x-message-id") };
    let detail = "";
    try {
      const body = (await r.json()) as { errors?: Array<{ message?: string }> };
      detail = body.errors?.map((e) => e.message).filter(Boolean).join("; ") ?? "";
    } catch {
      /* not JSON */
    }
    // 400/403/413: this email will never be accepted as it is; 401/429/5xx: try again later.
    const permanent = r.status === 400 || r.status === 403 || r.status === 413;
    return { ok: false, error: `sendgrid_status_${r.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, permanent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), permanent: false };
  }
}

/**
 * The Event Webhook is genuine when either its ECDSA signature checks out against KS_MARKETING_WEBHOOK_PUBLIC_KEY
 * (SendGrid "Signed Event Webhook", the key shown there, base64) or the URL's ?token= matches
 * KS_MARKETING_WEBHOOK_TOKEN. Neither configured: refused.
 */
export function webhookAuthentic(raw: Buffer, headers: { signature?: string; timestamp?: string; token?: string }): boolean {
  const key = env("KS_MARKETING_WEBHOOK_PUBLIC_KEY");
  if (key && headers.signature && headers.timestamp) {
    try {
      const pub = createPublicKey({ key: Buffer.from(key.replace(/-----[^-]+-----|\s+/g, ""), "base64"), format: "der", type: "spki" });
      if (cryptoVerify("sha256", Buffer.concat([Buffer.from(headers.timestamp, "utf8"), raw]), pub, Buffer.from(headers.signature, "base64"))) {
        return true;
      }
    } catch (err) {
      console.warn(`[marketing] webhook signature check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const token = env("KS_MARKETING_WEBHOOK_TOKEN");
  if (token.length >= 24 && headers.token && safeEqual(headers.token, token)) return true;
  return false;
}
