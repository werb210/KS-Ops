// KS_OPS_KB_v1 - the public knowledge base and Keystone Maya for prospects (CORS: PUBLIC_SITE_URL, like /api/public).
//   GET  /api/public/kb/articles?q=&category=   published PUBLIC articles only (search: full text + semantic)
//   GET  /api/public/kb/articles/:slug          one published public article, with body_html (404 for anything else)
//   GET  /api/public/kb/categories
//   GET  /api/public/kb/images/:id              an article image (image only, never a page)
//   POST /api/public/assistant/chat { messages: [{ role, text }], page?: { path, title, text }, session? }
//        -> { answer, citations: [{ slug, title, url }], actions: [{ kind, label, href }] }
//        20 a 10 minutes per address, 40 a day per browser session, KS_SALES_ASSISTANT_DAILY_LIMIT (default 3,000) a day
//        in all; then 429 { error: "rate_limited", message }
//   POST /api/public/assistant/lead { name, email, brokerage, team_size, phone?, consent: true, wants, message?,
//        transcript?, website_url (honeypot) } -> 201 { ok, id, handed_off, message } | 400 { errors }
//        5 an hour per address. wants "live_demo" or "person" is a hand-off: email to sales + a CRM follow-up task.
import { Router } from "express";
import { env, opsPublicUrl } from "../config.js";
import type { Deps } from "../deps.js";
import { limiter } from "../lib/clientIp.js";
import { clientIp, h, parseBody, UUID_RE } from "../lib/http.js";
import { sha256Hex } from "../lib/crypto.js";
import { categoriesFor, imageById, presentArticle, questionCount, readableArticle, searchArticles } from "../kb/repo.js";
import { answerSales, cleanPage } from "../assistant/sales.js";
import { captureLead, leadSchema } from "../assistant/leads.js";
import { turnsSchema } from "../assistant/turns.js";

export const SALES_PER_SESSION_DAY = 40;
export const salesDailyLimit = () => Math.max(1, Number(env("KS_SALES_ASSISTANT_DAILY_LIMIT")) || 3000);

const busy = { error: "rate_limited", message: "I've had a lot of questions just now. Please try again in a few minutes, or use the contact form." };

export function publicKbRouter(deps: Deps): Router {
  const router = Router();
  const base = (req: { protocol: string; get: (h: string) => string | undefined }) => opsPublicUrl(`${req.protocol}://${req.get("host") ?? ""}`);

  router.get(
    "/articles",
    limiter(120, 60_000),
    h(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 300) : "";
      const category = typeof req.query.category === "string" ? req.query.category.slice(0, 80) : "";
      const r = await searchArticles(deps.db, { viewer: "public", q, category, limit: q ? 20 : 50, fetch: deps.fetch });
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json({ articles: r.hits.map((a) => presentArticle(a)) });
    }),
  );

  router.get(
    "/articles/:slug",
    limiter(240, 60_000),
    h(async (req, res) => {
      const a = await readableArticle(deps.db, "public", String(req.params.slug).toLowerCase());
      if (!a) return res.status(404).json({ error: "not_found" });
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json({ article: presentArticle(a, { withBody: true, imageBase: base(req) }) });
    }),
  );

  router.get(
    "/categories",
    h(async (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json({ categories: await categoriesFor(deps.db, "public") });
    }),
  );

  router.get(
    "/images/:id",
    limiter(600, 60_000),
    h(async (req, res) => {
      const id = String(req.params.id);
      const img = UUID_RE.test(id) ? await imageById(deps.db, id) : null;
      if (!img) return res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", img.content_type);
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      return res.send(Buffer.from(img.data));
    }),
  );

  return router;
}

export function publicAssistantRouter(deps: Deps): Router {
  const router = Router();

  router.post(
    "/chat",
    limiter(20, 10 * 60_000, busy),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const parsed = parseBody(turnsSchema, req.body?.messages);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_messages", errors: parsed.errors });
      const session = typeof req.body?.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(req.body.session) ? req.body.session : null;
      // Hashed: the log never keeps the browser's id or address.
      const askerRef = sha256Hex(`website:${session ?? clientIp(req)}`).slice(0, 32);
      const since = new Date(deps.now().getTime() - 86_400_000);
      const [mine, all] = await Promise.all([
        questionCount(deps.db, { channel: "website", asker_ref: askerRef, since }),
        questionCount(deps.db, { channel: "website", since }),
      ]);
      if (mine >= SALES_PER_SESSION_DAY || all >= salesDailyLimit()) return res.status(429).json(busy);
      const reply = await answerSales(deps, { askerRef, turns: parsed.data, page: cleanPage(req.body?.page) });
      return res.json({
        answer: reply.answer,
        citations: reply.citations.map((c) => ({ ...c, url: `/help/${c.slug}` })),
        actions: reply.actions,
        outcome: reply.outcome,
      });
    }),
  );

  router.post(
    "/lead",
    limiter(5, 60 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const body = req.body ?? {};
      if (body.website_url !== undefined && body.website_url !== null && String(body.website_url).trim() !== "") {
        console.warn(`[assistant] lead honeypot filled from ${clientIp(req)}`);
        return res.status(400).json({ errors: { form: "We could not accept this request. Please try again." } });
      }
      const parsed = parseBody(leadSchema, body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const r = await captureLead(deps, parsed.data);
      if (!r.ok) return res.status(400).json({ errors: r.errors });
      return res.status(201).json({ ok: true, ...r.result });
    }),
  );

  return router;
}
