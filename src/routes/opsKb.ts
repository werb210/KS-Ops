// KS_OPS_KB_v1 - Keystone staff manage the knowledge base (behind requireStaff, like every /api/ops route):
//   GET    /api/ops/kb/articles?q=&status=&audience=&category=   every article, drafts too, newest change first
//   POST   /api/ops/kb/articles      { title, category, body_md, summary?, slug?, plans?, audience?, status? } -> 201
//   GET    /api/ops/kb/articles/:id
//   PATCH  /api/ops/kb/articles/:id  any of the fields above
//   DELETE /api/ops/kb/articles/:id
//   POST   /api/ops/kb/images        { content_type, data_base64, filename? } (PNG or JPG, 2 MB) -> 201 { id, url, markdown }
//   POST   /api/ops/kb/preview       { body_md } -> { html } (exactly what readers will see)
//   GET    /api/ops/kb/categories    the categories in use
//   GET    /api/ops/kb/report?days=30   questions the assistants had no good answer for, most asked first
// Every change is audited (staff_audit). The page is /ops/kb (opsKbPage.ts).
import { Router } from "express";
import { opsPublicUrl } from "../config.js";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { sniffLogo } from "../lib/logo.js";
import { audit } from "../licensees/repo.js";
import { renderMarkdown } from "../kb/markdown.js";
import { articleCreateSchema, articlePatchSchema, publishProblem } from "../kb/model.js";
import {
  createArticle, deleteArticle, embedPending, getArticle, imagePath, listForStaff, MAX_IMAGE_BYTES, presentForStaff, saveImage,
  SlugTaken, unansweredReport, updateArticle,
} from "../kb/repo.js";

const slugTaken = { error: "invalid_article", errors: { slug: "Another article already uses this address. Choose another." } };

export function opsKbRouter(deps: Deps): Router {
  const router = Router();
  const base = (req: { protocol: string; get: (h: string) => string | undefined }) => opsPublicUrl(`${req.protocol}://${req.get("host") ?? ""}`);
  // A fresh article is embedded straight away (best effort; the worker catches anything missed).
  const embedSoon = () => {
    void embedPending(deps, 5).catch((err) => console.warn(`[kb] embedding after save failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  router.get(
    "/kb/articles",
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const s = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).trim() : "");
      const rows = await listForStaff(deps.db, { q: s("q"), status: s("status"), audience: s("audience"), category: s("category") });
      return res.json({ articles: rows.map((a) => presentForStaff(a, base(req))) });
    }),
  );

  router.post(
    "/kb/articles",
    h(async (req, res) => {
      const parsed = parseBody(articleCreateSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_article", errors: parsed.errors });
      const problem = publishProblem(parsed.data);
      if (problem) return res.status(400).json({ error: "invalid_article", errors: { body_md: problem } });
      try {
        const a = await createArticle(deps.db, parsed.data, actorOf(req));
        await audit(deps.db, actorOf(req), "kb.article_created", null, { id: a.id, slug: a.slug, status: a.status, audience: a.audience });
        embedSoon();
        return res.status(201).json({ article: presentForStaff(a, base(req)) });
      } catch (err) {
        if (err instanceof SlugTaken) return res.status(409).json(slugTaken);
        throw err;
      }
    }),
  );

  router.get(
    "/kb/articles/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      const a = UUID_RE.test(id) ? await getArticle(deps.db, id) : null;
      if (!a) return res.status(404).json({ error: "not_found" });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ article: presentForStaff(a, base(req)) });
    }),
  );

  router.patch(
    "/kb/articles/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(articlePatchSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_article", errors: parsed.errors });
      const cur = await getArticle(deps.db, id);
      if (!cur) return res.status(404).json({ error: "not_found" });
      const problem = publishProblem({ status: parsed.data.status ?? cur.status, body_md: parsed.data.body_md ?? cur.body_md });
      if (problem) return res.status(400).json({ error: "invalid_article", errors: { body_md: problem } });
      try {
        const a = await updateArticle(deps.db, id, parsed.data, actorOf(req));
        if (!a) return res.status(404).json({ error: "not_found" });
        await audit(deps.db, actorOf(req), "kb.article_updated", null, { id, slug: a.slug, fields: Object.keys(parsed.data) });
        embedSoon();
        return res.json({ article: presentForStaff(a, base(req)) });
      } catch (err) {
        if (err instanceof SlugTaken) return res.status(409).json(slugTaken);
        throw err;
      }
    }),
  );

  router.delete(
    "/kb/articles/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      const a = UUID_RE.test(id) ? await getArticle(deps.db, id) : null;
      if (!a || !(await deleteArticle(deps.db, id))) return res.status(404).json({ error: "not_found" });
      await audit(deps.db, actorOf(req), "kb.article_deleted", null, { id, slug: a.slug, title: a.title });
      return res.json({ ok: true });
    }),
  );

  router.post(
    "/kb/images",
    h(async (req, res) => {
      const b64 = String(req.body?.data_base64 ?? "").replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
      if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return res.status(400).json({ error: "invalid_image", message: "The image could not be read. Use a PNG or JPG." });
      const data = Buffer.from(b64, "base64");
      if (!data.length) return res.status(400).json({ error: "invalid_image", message: "The image is empty." });
      if (data.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: "invalid_image", message: "The image is too large. Use one under 2 MB." });
      const type = sniffLogo(data);
      if (type !== "image/png" && type !== "image/jpeg") return res.status(400).json({ error: "invalid_image", message: "Use a PNG or JPG image." });
      const filename = req.body?.filename ? String(req.body.filename).replace(/[^A-Za-z0-9._ ()-]/g, "_").slice(0, 150) : null;
      const id = await saveImage(deps.db, { contentType: type, data, filename }, actorOf(req));
      await audit(deps.db, actorOf(req), "kb.image_uploaded", null, { id, filename, bytes: data.length });
      const alt = (filename ?? "Screenshot").replace(/\.[a-z]+$/i, "").replace(/[\[\]()]/g, "");
      return res.status(201).json({ id, url: `${base(req)}${imagePath(id)}`, path: imagePath(id), markdown: `![${alt}](${imagePath(id)})` });
    }),
  );

  router.post(
    "/kb/preview",
    h(async (req, res) => {
      const md = typeof req.body?.body_md === "string" ? req.body.body_md.slice(0, 100_000) : "";
      return res.json({ html: renderMarkdown(md, { imageBase: base(req) }) });
    }),
  );

  router.get(
    "/kb/categories",
    h(async (_req, res) => {
      const r = await deps.db.query("SELECT category, count(*)::int AS count FROM kb_articles GROUP BY category ORDER BY category");
      return res.json({ categories: r.rows.map((x) => ({ category: String(x.category), count: Number(x.count) })) });
    }),
  );

  router.get(
    "/kb/report",
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      return res.json(await unansweredReport(deps.db, days, deps.now()));
    }),
  );

  return router;
}
