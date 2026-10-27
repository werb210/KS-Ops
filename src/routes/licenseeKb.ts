// KS_OPS_KB_v1 - the knowledge base for a licensee's portal, called by that licensee's KS-server with its ops key
// (X-KS-Ops-Key, checked against the licensee in the URL - the same check as support tickets). The server says who is
// reading (viewer_role: an Admin reads admin articles too; anyone else reads public and all-staff articles).
//   POST /api/licensees/:id/kb/search     { q?, category?, viewer_role }  -> { articles }   (each with on_your_plan)
//   POST /api/licensees/:id/kb/article    { slug, viewer_role }           -> { article } with body_html | 404
//   POST /api/licensees/:id/kb/categories { viewer_role }                 -> { categories }
//   POST /api/licensees/:id/kb/ask        { messages: [{ role, text }], viewer: { role, user_ref }, context? }
//        -> { answer, citations, related, offer_support, outcome }   ("Ask Maya", src/assistant/support.ts)
//        Limits (Keystone's cost, never the licensee's AI allowance): 30 questions an hour per person (user_ref, a hash
//        the server makes), KS_HELP_LICENSEE_DAILY_LIMIT (default 300) a day per licensee, and 60 a minute per licensee
//        in bursts; then 429 { error: "rate_limited", message }.
// Only the licensee named by the key is ever read; nothing about another licensee is used or returned.
import { Router } from "express";
import { z } from "zod";
import { env, opsPublicUrl } from "../config.js";
import type { Deps } from "../deps.js";
import { requireLicenseeKey } from "../auth/licenseeKey.js";
import { limiterBy } from "../lib/clientIp.js";
import { h, parseBody } from "../lib/http.js";
import { viewerFromRole } from "../kb/model.js";
import { categoriesFor, presentArticle, questionCount, readableArticle, searchArticles } from "../kb/repo.js";
import { answerSupport } from "../assistant/support.js";
import { turnsSchema } from "../assistant/turns.js";

export const HELP_PER_USER_HOUR = 30;
export const helpLicenseeDailyLimit = () => Math.max(1, Number(env("KS_HELP_LICENSEE_DAILY_LIMIT")) || 300);

const limited = {
  error: "rate_limited",
  message: "You've asked a lot of questions in a short time. Please wait a little, search the help articles, or contact support.",
};

const askSchema = z.object({
  messages: turnsSchema,
  viewer: z.object({ role: z.string().max(40).optional(), user_ref: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional() }).optional(),
  context: z.unknown().optional(),
});

export function licenseeKbRouter(deps: Deps): Router {
  const router = Router();
  const auth = requireLicenseeKey(deps.db);
  const burst = limiterBy(60, 60_000, (req) => `kb:${String(req.params.id ?? "")}`, limited);
  const base = (req: { protocol: string; get: (h: string) => string | undefined }) => opsPublicUrl(`${req.protocol}://${req.get("host") ?? ""}`);

  router.post(
    "/:id/kb/search",
    auth,
    h(async (req, res) => {
      const viewer = viewerFromRole(req.body?.viewer_role);
      const q = typeof req.body?.q === "string" ? req.body.q.slice(0, 300) : "";
      const category = typeof req.body?.category === "string" ? req.body.category.slice(0, 80) : "";
      const r = await searchArticles(deps.db, { viewer, q, category, limit: q ? 20 : 200, fetch: deps.fetch });
      return res.json({ articles: r.hits.map((a) => presentArticle(a, { plan: req.licensee!.plan })) });
    }),
  );

  router.post(
    "/:id/kb/article",
    auth,
    h(async (req, res) => {
      const slug = String(req.body?.slug ?? "").trim().toLowerCase();
      const a = /^[a-z0-9-]{1,120}$/.test(slug) ? await readableArticle(deps.db, viewerFromRole(req.body?.viewer_role), slug) : null;
      if (!a) return res.status(404).json({ error: "not_found" });
      return res.json({ article: presentArticle(a, { plan: req.licensee!.plan, withBody: true, imageBase: base(req) }) });
    }),
  );

  router.post(
    "/:id/kb/categories",
    auth,
    h(async (req, res) => res.json({ categories: await categoriesFor(deps.db, viewerFromRole(req.body?.viewer_role)) })),
  );

  router.post(
    "/:id/kb/ask",
    auth,
    burst,
    h(async (req, res) => {
      const parsed = parseBody(askSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_question", errors: parsed.errors });
      const l = req.licensee!;
      const askerRef = parsed.data.viewer?.user_ref ?? null;
      const now = deps.now();
      const [mine, theirs] = await Promise.all([
        askerRef
          ? questionCount(deps.db, { channel: "portal", licensee_id: l.id, asker_ref: askerRef, since: new Date(now.getTime() - 3_600_000) })
          : Promise.resolve(0),
        questionCount(deps.db, { channel: "portal", licensee_id: l.id, since: new Date(now.getTime() - 86_400_000) }),
      ]);
      if (mine >= HELP_PER_USER_HOUR || theirs >= helpLicenseeDailyLimit()) return res.status(429).json(limited);
      const reply = await answerSupport(deps, {
        licensee: l,
        viewer: viewerFromRole(parsed.data.viewer?.role) === "admin" ? "admin" : "staff",
        askerRef,
        turns: parsed.data.messages,
        context: parsed.data.context,
      });
      return res.json({
        answer: reply.answer,
        citations: reply.citations,
        related: reply.related,
        offer_support: reply.offer_support,
        outcome: reply.outcome,
      });
    }),
  );

  return router;
}
