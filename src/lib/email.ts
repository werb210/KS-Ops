// Email through Microsoft Graph when configured, else SendGrid, else the message is logged (KS-server's approach).
import { env } from "../config.js";

export type Mail = { to: string[]; subject: string; text: string; html?: string };
export type Mailer = (mail: Mail) => Promise<{ ok: boolean; error?: string }>;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Paragraphs of plain text as both HTML and text bodies. */
export function bodies(paragraphs: string[]): { html: string; text: string } {
  return {
    html:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0B1F3A">' +
      paragraphs.map((p) => "<p>" + esc(p).replace(/\n/g, "<br/>") + "</p>").join("") +
      "</div>",
    text: paragraphs.join("\n\n"),
  };
}

export function graphConfigured(): boolean {
  return ["MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_SEND_AS"].every((k) => env(k) !== "");
}

export function sendgridConfigured(): boolean {
  return env("SENDGRID_API_KEY") !== "" && env("SENDGRID_FROM") !== "";
}

let graphToken: { token: string; expiresAt: number } | null = null;

async function graphAccessToken(fetchImpl: typeof fetch): Promise<string> {
  if (graphToken && graphToken.expiresAt > Date.now() + 60_000) return graphToken.token;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(env("MS_GRAPH_TENANT_ID"))}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env("MS_GRAPH_CLIENT_ID"),
    client_secret: env("MS_GRAPH_CLIENT_SECRET"),
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`graph_token_failed status=${r.status}`);
  const json = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("graph_token_empty");
  graphToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return graphToken.token;
}

export function createMailer(fetchImpl: typeof fetch = fetch): Mailer {
  return async (mail) => {
    const to = [...new Set(mail.to.map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))];
    if (!to.length) return { ok: false, error: "no_recipients" };
    const html = mail.html ?? bodies([mail.text]).html;
    try {
      if (graphConfigured()) {
        const token = await graphAccessToken(fetchImpl);
        const r = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env("MS_GRAPH_SEND_AS"))}/sendMail`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: mail.subject,
              body: { contentType: "HTML", content: html },
              toRecipients: to.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return r.status === 202 ? { ok: true } : { ok: false, error: `graph_send_failed status=${r.status}` };
      }
      if (sendgridConfigured()) {
        const r = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${env("SENDGRID_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: to.map((email) => ({ email })) }],
            from: { email: env("SENDGRID_FROM"), name: env("SENDGRID_FROM_NAME") || "Keystone" },
            subject: mail.subject,
            content: [
              { type: "text/plain", value: mail.text },
              { type: "text/html", value: html },
            ],
            tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        return r.status === 202 ? { ok: true } : { ok: false, error: `sendgrid_send_failed status=${r.status}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    console.log(`[email] not configured; would send to ${to.join(", ")}: ${mail.subject}`);
    return { ok: false, error: "email_not_configured" };
  };
}

/** Sends and logs a failure; never throws. For notices that must not break the request that triggered them. */
export async function sendQuietly(mailer: Mailer, mail: Mail, what: string): Promise<boolean> {
  try {
    const r = await mailer(mail);
    if (!r.ok && r.error !== "email_not_configured") console.warn(`[email] ${what} failed: ${r.error}`);
    return r.ok;
  } catch (err) {
    console.warn(`[email] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
