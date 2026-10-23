// The self-serve sales demo.
// Public (the website's "Try it yourself" page and the demo portal; CORS: PUBLIC_SITE_URL + KS_DEMO_PORTAL_URL):
//   POST /api/public/demo/signup { name, email, company, phone?, website_url (honeypot, must be empty), turnstile_token? }
//        (phone: a Canadian/US mobile; the link is texted to it as well as emailed when Twilio is set up, see lib/sms.ts)
//        -> 201 { ok, message, open_url } (KS_OPS_v11_LIVE_DEMO: the website opens open_url straight away; the same link
//           is texted and emailed so they can come back) | 400 { errors } | 429 { error, message } | 503 { error, message }
//   POST /api/public/demo/open { demo_id, token }   (the magic link: {KS_DEMO_PORTAL_URL}/demo#d=<id>&t=<token>)
//        -> 200 { server_url, staff_token, client_url, expires_at, name, company } | 404 | 410 (expired) | 503
// From the demo server (X-KS-Ops-Key = KS_DEMO_OPS_KEY):
//   POST /api/demo/sessions/:id/events   { events: [{ type, step?, at, data? }] } -> 202
//   POST /api/demo/sessions/:id/complete { summary, package_pdf_base64, package_filename, lender_email? } -> 202 (emails go out)
//        lender_email (KS_OPS_v12): the real lender email for the sample file - { lender_name?, subject, html, text,
//        attachments: [{ filename, content_type, base64 }] }; the prospect gets exactly that, with a one-line demo banner.
//        Without it (an older demo server) the prospect gets the short note with package_pdf_base64 attached.
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { limiter } from "../lib/clientIp.js";
import { clientIp, h, parseBody, UUID_RE } from "../lib/http.js";
import { matchesHash, newSecret, safeEqual, sha256Hex } from "../lib/crypto.js";
import { sendQuietly } from "../lib/email.js";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile.js";
import {
  demoConfigured, demoMaxActive, demoOpsKey, demoPerEmail, demoPerIpDay, demoPortalUrl, demoServerUrl, demoSessionDays,
} from "../demo/config.js";
import { magicLinkMail, magicLinkSms, magicLinkUrl, type LenderEmail } from "../demo/emails.js";
import { normalizeNaPhone, prettyNaPhone, sendSms } from "../lib/sms.js";
import * as repo from "../demo/repo.js";
import { openServerSession } from "../demo/server.js";
import { sendCompletionMails } from "../demo/jobs.js";
import { digestEvents } from "../demo/digest.js";
import { crmDemoCompleted, crmDemoOpened, crmDemoProgress, crmDemoSignup } from "../crm/triggers.js";

export const DEMO_SENT_MESSAGE = "Check your email - we've sent you a private link to your demo.";
export const DEMO_RESENT_MESSAGE = "Welcome back - we've emailed you a fresh link to your demo.";
export const DEMO_NOT_CONFIGURED = { error: "demo_not_configured", message: "The demo is not available right now. Please contact us and we will show you around." };

const MAX_LINK_SENDS = 6;

const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : v), z.string().min(1, "Required").max(max, `At most ${max} characters`));

export const demoSignupSchema = z.object({
  name: text(120),
  email: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.string().max(200).email("Enter a valid email address")),
  company: text(160),
  phone: z.string().max(40).optional(),
  turnstile_token: z.string().max(4096).optional(),
  website_url: z.any().optional(),
});

const NAME_OK = /\p{L}/u;

/** Texts the link when a phone was given (and SMS is set up), and always emails it. Returns what to tell the person. */
async function deliverLink(deps: Deps, s: Parameters<typeof magicLinkMail>[0], url: string, phone: string | null, resent: boolean): Promise<string> {
  let texted = false;
  if (phone) {
    const r = await sendSms(deps.fetch, phone, magicLinkSms(s, url));
    texted = r.ok;
    if (!r.ok && r.error !== "sms_not_configured") console.warn(`[demo] link text failed: ${r.error}`);
  }
  await sendQuietly(deps.mailer, magicLinkMail(s, url, demoSessionDays()), resent ? "demo link (resent)" : "demo link");
  const where = phone ? prettyNaPhone(phone) : "";
  if (texted) {
    return resent
      ? `Welcome back - we've texted a fresh link to your demo to ${where} and emailed it too.`
      : `Your demo is ready - we've texted the link to ${where} and emailed it too.`;
  }
  if (phone) {
    return resent
      ? `Welcome back - we couldn't text ${where} just now, so we've emailed you a fresh link to your demo.`
      : `Your demo is ready - we couldn't text ${where} just now, so we've emailed you the link.`;
  }
  return resent ? DEMO_RESENT_MESSAGE : DEMO_SENT_MESSAGE;
}

export function demoPublicRouter(deps: Deps): Router {
  const router = Router();

  router.post(
    "/signup",
    limiter(5, 60 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!demoConfigured()) return res.status(503).json(DEMO_NOT_CONFIGURED);
      const body = req.body ?? {};
      if (body.website_url !== undefined && body.website_url !== null && String(body.website_url).trim() !== "") {
        console.warn(`[demo] honeypot filled from ${clientIp(req)}`);
        return res.status(400).json({ errors: { form: "We could not accept this request. Please try again." } });
      }
      const parsed = parseBody(demoSignupSchema, body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const input = parsed.data;
      if (!NAME_OK.test(input.name)) return res.status(400).json({ errors: { name: "Enter your name" } });
      const rawPhone = (input.phone ?? "").trim();
      const phone = rawPhone ? normalizeNaPhone(rawPhone) : null;
      if (rawPhone && !phone) return res.status(400).json({ errors: { phone: "Enter a Canadian or US mobile number, like (403) 555-0199" } });
      const now = deps.now();
      const ip = clientIp(req);

      // One live demo per email: asking again re-sends a fresh link to the same demo, with the name, company and phone
      // updated to what was just typed.
      const live = await repo.liveSignupForEmail(deps.db, input.email, now);
      if (live) {
        const resentToday = live.last_link_sent_at && now.getTime() - new Date(live.last_link_sent_at).getTime() < 86_400_000;
        if (live.link_sends >= MAX_LINK_SENDS && resentToday) {
          return res.status(429).json({ error: "too_many_links", message: "We've already sent your demo link several times today. Please check your inbox (and junk folder)." });
        }
        if (turnstileEnabled() && !(await verifyTurnstile(input.turnstile_token, ip, deps.fetch))) {
          return res.status(400).json({ errors: { turnstile_token: "Please confirm you are not a robot and try again." } });
        }
        const token = newSecret(24);
        // What they just typed wins: the demo they open greets the new name and shows the new brokerage (the demo
        // server is sent these again on open and refreshes its session).
        const updated = (await repo.replaceToken(deps.db, live.id, sha256Hex(token), now, phone, { name: input.name, company: input.company })) ?? live;
        const url = magicLinkUrl(demoPortalUrl(), live.id, token);
        const message = await deliverLink(deps, updated, url, phone ?? updated.phone ?? null, true);
        return res.status(200).json({ ok: true, resent: true, message, open_url: url });
      }
      if ((await repo.countRecentForEmail(deps.db, input.email, new Date(now.getTime() - 30 * 86_400_000))) >= demoPerEmail()) {
        return res.status(429).json({ error: "too_many_demos", message: "This email has had several demos recently. Contact us and we'll walk you through it live." });
      }
      if ((await repo.countRecentForIp(deps.db, ip, new Date(now.getTime() - 86_400_000))) >= demoPerIpDay()) {
        return res.status(429).json({ error: "too_many_demos", message: "Too many demos were started from this network today. Please try again tomorrow." });
      }
      if ((await repo.countActive(deps.db, now)) >= demoMaxActive()) {
        return res.status(503).json({ error: "demo_busy", message: "The demo is very busy right now. Please try again in a little while, or contact us for a live walkthrough." });
      }
      if (turnstileEnabled() && !(await verifyTurnstile(input.turnstile_token, ip, deps.fetch))) {
        return res.status(400).json({ errors: { turnstile_token: "Please confirm you are not a robot and try again." } });
      }
      const token = newSecret(24);
      const s = await repo.insertSignup(deps.db, {
        name: input.name, email: input.email, phone, company: input.company, ip,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300), tokenHash: sha256Hex(token),
        expiresAt: new Date(now.getTime() + demoSessionDays() * 86_400_000), now,
      });
      await crmDemoSignup(deps, s);
      const url = magicLinkUrl(demoPortalUrl(), s.id, token);
      const message = await deliverLink(deps, s, url, phone, false);
      return res.status(201).json({ ok: true, message, open_url: url });
    }),
  );

  router.post(
    "/open",
    limiter(30, 15 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (!demoConfigured()) return res.status(503).json(DEMO_NOT_CONFIGURED);
      const id = String(req.body?.demo_id ?? "");
      const s = UUID_RE.test(id) ? await repo.getSignup(deps.db, id) : null;
      // The same answer for an unknown demo and a wrong token.
      if (!s || !matchesHash(req.body?.token, s.token_hash)) {
        return res.status(404).json({ error: "demo_link_invalid", message: "This demo link is not valid. Ask for a new one on the website." });
      }
      if (s.status === "wiped" || new Date(s.expires_at).getTime() <= deps.now().getTime()) {
        return res.status(410).json({ error: "demo_expired", message: "This demo has ended and its data was wiped. You can start a new one on the website." });
      }
      const opened = await openServerSession(deps.fetch, s);
      if (!opened.ok) {
        if (opened.status === 410) return res.status(410).json({ error: "demo_expired", message: "This demo has ended. You can start a new one on the website." });
        console.error(`[demo] could not open session on the demo server: ${opened.error}`);
        return res.status(503).json({ error: "demo_server_unavailable", message: "The demo could not start just now. Please try the link again in a minute." });
      }
      await repo.markOpened(deps.db, s.id, opened.session.session_id);
      if (!s.opened_at) await crmDemoOpened(deps, s, deps.now());
      return res.json({
        server_url: demoServerUrl(),
        staff_token: opened.session.staff_token,
        client_url: opened.session.client_url,
        expires_at: opened.session.expires_at,
        name: s.name,
        company: s.company,
      });
    }),
  );

  return router;
}

function requireDemoKey(req: Request, res: Response, next: NextFunction) {
  const key = demoOpsKey();
  if (!key || !safeEqual(req.headers["x-ks-ops-key"], key)) return res.status(401).json({ error: "invalid_ops_key" });
  return next();
}

// KS_OPS_v12 - the real lender email the demo server rendered for the sample file.
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const lenderEmailSchema = z.object({
  lender_name: z.string().max(200).optional(),
  subject: z.string().min(1).max(300),
  html: z.string().min(1).max(200_000),
  text: z.string().min(1).max(100_000),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(200),
    content_type: z.enum(["application/zip", "application/pdf"]),
    base64: z.string().min(1),
  })).min(1).max(5),
});

/** The lender email, checked and size-capped; "invalid" when it is there but unusable. */
export function parseLenderEmail(raw: unknown): LenderEmail | "invalid" {
  const p = lenderEmailSchema.safeParse(raw);
  if (!p.success) return "invalid";
  let total = 0;
  const attachments: LenderEmail["attachments"] = [];
  for (const a of p.data.attachments) {
    const bytes = Buffer.from(a.base64, "base64");
    total += bytes.length;
    if (!bytes.length || total > MAX_PACKAGE_BYTES) return "invalid";
    const magic = a.content_type === "application/zip" ? "PK\x03\x04" : "%PDF-";
    if (bytes.subarray(0, magic.length).toString("latin1") !== magic) return "invalid";
    attachments.push({ filename: a.filename.replace(/[^A-Za-z0-9._ ()-]/g, "_").slice(0, 150), contentType: a.content_type, base64: bytes.toString("base64") });
  }
  return { lenderName: p.data.lender_name ?? null, subject: p.data.subject.replace(/[\r\n]+/g, " ").trim(), html: p.data.html, text: p.data.text, attachments };
}

const eventSchema = z.object({
  type: z.string().regex(/^[a-z_]{1,40}$/),
  step: z.string().max(40).nullish(),
  at: z.string().datetime({ offset: true }),
  data: z.record(z.unknown()).optional(),
});

export function demoOpsRouter(deps: Deps): Router {
  const router = Router();
  router.use(requireDemoKey);

  const signupFor = async (req: Request) => {
    const id = String(req.params.id ?? "");
    return UUID_RE.test(id) ? repo.getSignup(deps.db, id) : null;
  };

  router.post(
    "/sessions/:id/events",
    h(async (req, res) => {
      const s = await signupFor(req);
      if (!s) return res.status(404).json({ error: "not_found" });
      const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : null;
      if (!list) return res.status(400).json({ error: "events_required" });
      const events = [];
      for (const raw of list) {
        const p = eventSchema.safeParse(raw);
        if (!p.success) continue; // one odd event does not lose the batch
        const data = p.data.data ?? {};
        if (JSON.stringify(data).length > 4000) continue;
        events.push({ type: p.data.type, step: p.data.step ?? null, data, at: new Date(p.data.at) });
      }
      const stored = await repo.addEvents(deps.db, s.id, events);
      // Keystone CRM: the steps reached (held back a minute and coalesced), and "finished" once they submit.
      if (stored && events.some((e) => e.step)) await crmDemoProgress(deps, s, await repo.eventsFor(deps.db, s.id));
      if (!s.completed_at && events.some((e) => e.type === "submitted")) {
        const fresh = await repo.getSignup(deps.db, s.id);
        if (fresh?.completed_at) await crmDemoCompleted(deps, fresh, null);
      }
      return res.status(202).json({ ok: true, stored });
    }),
  );

  router.post(
    "/sessions/:id/complete",
    h(async (req, res) => {
      const s = await signupFor(req);
      if (!s) return res.status(404).json({ error: "not_found" });
      const b64 = String(req.body?.package_pdf_base64 ?? "");
      const pdf = b64 ? Buffer.from(b64, "base64") : null;
      const pdfOk = !!pdf && pdf.length <= 12 * 1024 * 1024 && pdf.subarray(0, 5).toString("latin1") === "%PDF-";
      const mail = req.body?.lender_email === undefined ? null : parseLenderEmail(req.body.lender_email);
      if (mail === "invalid" || (!pdfOk && !mail)) return res.status(400).json({ error: "package_required" });
      const filename = String(req.body?.package_filename ?? "Lender-Submission-Package-SAMPLE.pdf").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
      await repo.storePackage(deps.db, s.id, pdfOk ? pdf : null, filename, mail);
      // Emails go out now; anything that fails is retried by the demo job.
      await sendCompletionMails(deps, s.id);
      const fresh = (await repo.getSignup(deps.db, s.id)) ?? s;
      await crmDemoCompleted(deps, fresh, digestEvents(await repo.eventsFor(deps.db, s.id)));
      return res.status(202).json({ ok: true });
    }),
  );

  return router;
}
