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
import { addTouch, recordClick } from "../outreach/store.js"; // KS_OPS_OUTREACH_v1
import { upsertProspect } from "../marketing/prospects.js";
import { isEmail } from "../marketing/consent.js";
import { UUID_RE } from "../lib/http.js";
import { publicSiteUrl } from "../config.js";

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

  // KS_OPS_OUTREACH_v1 - a tracked link (on a letter's QR code, an ad, a post, a video): count the click against its
  // channel and brokerage, then send the visitor on. An unknown code goes to the website, never to an error page.
  r.get("/l/:code", limiter, h(async (req, res) => {
    const code = String(req.params.code ?? "").toLowerCase();
    let target: string | null = null;
    if (/^[a-z0-9]{4,16}$/.test(code)) {
      try { target = await recordClick(deps.db, code, deps.now()); } catch (e) { console.error("[outreach] click not recorded", e instanceof Error ? e.message : String(e)); }
    }
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, target ?? publicSiteUrl());
  }));

  // KS_OPS_OUTREACH_v2 - a webinar's sign-up page. The webinar is a channel item (kind webinar) made in the staff
  // portal; whoever registers becomes a prospect with express consent (they ticked the box) and is credited to the
  // webinar on the channel scoreboard.
  const webinarOf = async (id: string) => UUID_RE.test(id)
    ? (await deps.db.query(`SELECT id, name, happens_on, notes, status FROM ks_mkt_channel_items WHERE id = $1 AND kind = 'webinar' AND status <> 'dropped'`, [id])).rows[0] ?? null
    : null;
  const field = (name: string, label: string, type = "text", required = true) =>
    `<label style="display:block;font-size:15px;font-weight:700;margin:0 0 12px">${label}<br><input name="${name}" type="${type}" ${required ? "required" : ""} maxlength="200" style="width:100%;box-sizing:border-box;margin-top:4px;padding:10px;font-size:16px;border:1px solid #9CA3AF;border-radius:8px"></label>`;
  r.get("/webinar/:id", limiter, h(async (req, res) => {
    const w = await webinarOf(String(req.params.id));
    res.setHeader("Cache-Control", "no-store");
    if (!w) return res.status(404).type("html").send(page("This webinar is not open", "The sign-up link may be out of date."));
    const when = w.happens_on ? new Date(w.happens_on).toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
    const body = `${when ? `<strong>${esc(when)}</strong><br>` : ""}${esc(w.notes ?? "")}</p>` +
      `<form method="post" action="/api/public/marketing/webinar/${esc(w.id)}">` + field("name", "Your name") + field("email", "Work email", "email") + field("company", "Brokerage") +
      `<input name="website_url" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">` +
      `<label style="display:block;font-size:14px;margin:0 0 16px"><input type="checkbox" name="consent" value="yes" required> Email me the joining details and occasional news about ${esc(KS_BRAND.name)}. I can unsubscribe at any time.</label>` +
      `<button type="submit" style="background:${KS_BRAND.accent};color:#ffffff;border:0;border-radius:8px;padding:12px 22px;font-size:16px;font-weight:700;cursor:pointer">Save my seat</button></form><p style="margin:0">`;
    return res.type("html").send(page(w.name, body));
  }));
  r.post("/webinar/:id", makeLimiter(10, 60 * 60_000), express.urlencoded({ extended: false, limit: "10kb" }), h(async (req, res) => {
    const w = await webinarOf(String(req.params.id));
    if (!w) return res.status(404).type("html").send(page("This webinar is not open", "The sign-up link may be out of date."));
    const b = req.body ?? {};
    const email = String(b.email ?? "").trim().toLowerCase();
    const name = String(b.name ?? "").trim().slice(0, 200);
    const company = String(b.company ?? "").trim().slice(0, 200);
    if (String(b.website_url ?? "").trim() !== "") return res.status(400).type("html").send(page("We could not save that", "Please go back and try again."));
    if (!isEmail(email) || !name || b.consent !== "yes") return res.status(400).type("html").send(page("One thing is missing", "Please go back, enter your name and work email, and tick the box."));
    const now = deps.now();
    await upsertProspect(deps.db, now, {
      email, name, company: company || null, source: "manual", status: "lead",
      consent: { consent_type: "express", consent_source: `Webinar sign-up: ${w.name}`, consent_text: `Email me the joining details and occasional news about ${KS_BRAND.name}. I can unsubscribe at any time.`, consent_at: now, consent_expires_at: null, consent_recorded_by: "webinar sign-up" },
      event: { type: "webinar_signup", summary: `Signed up for the webinar "${w.name}".`, at: now, dedupe_key: `webinar:${w.id}:${email}` },
    });
    const person = (await deps.db.query(`SELECT id, brokerage_id FROM ks_broker_people WHERE lower(email) = $1 LIMIT 1`, [email])).rows[0];
    const already = (await deps.db.query(`SELECT 1 FROM ks_mkt_touches WHERE item_id = $1 AND summary = $2 LIMIT 1`, [w.id, `Webinar sign-up: ${email}`])).rows.length > 0;
    if (!already) await addTouch(deps.db, { channel_key: "podcasts_webinars", item_id: w.id, brokerage_id: person?.brokerage_id ?? null, person_id: person?.id ?? null, direction: "in", outcome: "reply", summary: `Webinar sign-up: ${email}`, at: now, by: "webinar sign-up" });
    return res.type("html").send(page("You are in", `Thanks, ${esc(name.split(/\s+/)[0] ?? name)}. We will email the joining details for <strong>${esc(w.name)}</strong> to ${esc(email)}.`));
  }));

  return r;
}
