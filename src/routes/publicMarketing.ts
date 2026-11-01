// KS_OPS_PROSPECT_MARKETING_v1 - the public side of Keystone marketing email.
//   GET  /api/public/marketing/unsubscribe?t=TOKEN   a page with one "Unsubscribe" button (link scanners that follow
//                                                    links do not unsubscribe anyone)
//   POST /api/public/marketing/unsubscribe?t=TOKEN   the button, and the mail apps' one-click unsubscribe
//                                                    (List-Unsubscribe-Post: List-Unsubscribe=One-Click, RFC 8058)
//   POST /api/public/marketing/sendgrid-events       SendGrid Event Webhook (signed, or ?token=), raw body
// The token is signed (render.ts), so nobody can unsubscribe someone else; it never expires, as CASL requires the
// unsubscribe to keep working for at least 60 days.
import express, { Router } from "express";
import type { Deps } from "../deps.js";
import { esc } from "../lib/email.js";
import { h } from "../lib/http.js";
import { limiter as makeLimiter } from "../lib/clientIp.js";
import { processSendgridEvents, suppressProspectEmail } from "../marketing/events.js";
import { KS_BRAND, readUnsubscribeToken } from "../marketing/render.js";
import { sender } from "../marketing/settings.js";
import { webhookAuthentic } from "../marketing/sendgrid.js";

function page(title: string, body: string, form?: { action: string }): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
    `<body style="margin:0;background:${KS_BRAND.background};font-family:Arial,Helvetica,sans-serif;color:${KS_BRAND.ink}">` +
    `<main style="max-width:520px;margin:48px auto;background:#ffffff;border-radius:12px;overflow:hidden">` +
    `<div style="background:${KS_BRAND.accent};padding:16px 24px;color:#ffffff;font-size:20px;font-weight:800">${esc(KS_BRAND.name)}</div>` +
    `<div style="padding:24px"><h1 style="font-size:22px;margin:0 0 12px">${esc(title)}</h1><p style="font-size:16px;line-height:1.5;margin:0 0 16px">${body}</p>` +
    (form
      ? `<form method="post" action="${esc(form.action)}"><button type="submit" style="background:${KS_BRAND.accent};color:#ffffff;border:0;border-radius:8px;padding:12px 22px;font-size:16px;font-weight:700;cursor:pointer">Unsubscribe</button></form>`
      : "") +
    `</div></main></body></html>`
  );
}

export function publicMarketingRouter(deps: Deps): Router {
  const r = Router();
  const limiter = makeLimiter(60, 60_000);

  r.get("/unsubscribe", limiter, (req, res) => {
    const email = readUnsubscribeToken(req.query.t);
    res.setHeader("Cache-Control", "no-store");
    if (!email) return res.status(400).type("html").send(page("This link is not valid", `Please use the unsubscribe link in the email, or write to ${esc(sender().reply_to)} and we will take you off the list.`));
    res.type("html").send(
      page("Unsubscribe from Keystone emails", `Stop sending Keystone marketing emails to <strong>${esc(email)}</strong>?`, {
        action: `?t=${encodeURIComponent(String(req.query.t))}`,
      }),
    );
  });

  r.post("/unsubscribe", limiter, express.urlencoded({ extended: false, limit: "8kb" }), h(async (req, res) => {
    const email = readUnsubscribeToken(req.query.t ?? req.body?.t);
    res.setHeader("Cache-Control", "no-store");
    if (!email) return res.status(400).type("html").send(page("This link is not valid", `Please write to ${esc(sender().reply_to)} and we will take you off the list.`));
    const oneClick = String(req.body?.["List-Unsubscribe"] ?? "") === "One-Click";
    await suppressProspectEmail(deps.db, email, "unsubscribed", oneClick ? "one-click unsubscribe (mail app)" : "unsubscribe link", deps.now());
    if (oneClick) return res.status(200).json({ ok: true });
    res.type("html").send(page("You are unsubscribed", `We will not send Keystone marketing emails to <strong>${esc(email)}</strong> again.`));
  }));

  r.post("/sendgrid-events", express.raw({ type: "*/*", limit: "5mb" }), h(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const ok = webhookAuthentic(raw, {
      signature: req.header("X-Twilio-Email-Event-Webhook-Signature") ?? undefined,
      timestamp: req.header("X-Twilio-Email-Event-Webhook-Timestamp") ?? undefined,
      token: typeof req.query.token === "string" ? req.query.token : undefined,
    });
    if (!ok) {
      console.warn("[marketing] SendGrid webhook refused: signature/token did not match (or KS_MARKETING_WEBHOOK_PUBLIC_KEY is not set)");
      return res.status(403).json({ error: "forbidden" });
    }
    let events: unknown = [];
    try {
      events = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
    const out = await processSendgridEvents(deps, events);
    res.json({ ok: true, ...out });
  }));

  return r;
}
