// KS_OPS_KB_v1 - knowledge base storage: articles (CRUD), images, search (Postgres full text plus OpenAI embeddings when
// they are available), the question log behind the "no good answer" report, and the embedding job.
import type { Q } from "../db.js";
import { aiConfigured, cosine, embed, embeddingModel } from "../assistant/openai.js";
import { audiencesFor, appliesToPlan, plansLabel, slugify, type Audience, type ArticleInput, type ArticlePatch, type Viewer } from "./model.js";
import { plainText, renderMarkdown } from "./markdown.js";

export type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  category: string;
  summary: string;
  body_md: string;
  plans: string[];
  audience: Audience;
  status: "draft" | "published";
  seed_key: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  embedded_at?: Date | string | null;
};

const COLS = `id, slug, title, category, summary, body_md, plans, audience, status, seed_key, created_by, updated_by,
  created_at, updated_at, published_at, embedded_at`;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** What readers get: never the seed key, the embedding or who edited it. */
export function presentArticle(
  a: ArticleRow,
  opts: { plan?: string | null; imageBase?: string; withBody?: boolean } = {},
): Record<string, unknown> {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    category: a.category,
    summary: a.summary || snippet(a.body_md, 180),
    plans: a.plans ?? [],
    plans_label: plansLabel(a.plans),
    audience: a.audience,
    updated_at: iso(a.updated_at),
    ...(opts.plan !== undefined ? { on_your_plan: appliesToPlan(a.plans, opts.plan) } : {}),
    ...(opts.withBody ? { body_md: a.body_md, body_html: renderMarkdown(a.body_md, { imageBase: opts.imageBase }) } : {}),
  };
}

/** Everything, for Keystone staff. */
export function presentForStaff(a: ArticleRow, imageBase?: string): Record<string, unknown> {
  return {
    ...presentArticle(a, { withBody: true, imageBase }),
    status: a.status,
    seeded: Boolean(a.seed_key),
    created_by: a.created_by,
    updated_by: a.updated_by,
    created_at: iso(a.created_at),
    published_at: iso(a.published_at),
    embedded: Boolean(a.embedded_at),
  };
}

export function snippet(md: string, max: number): string {
  const t = plainText(md).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
}

// ---- CRUD (Keystone staff) ----

export class SlugTaken extends Error {
  constructor() {
    super("slug_taken");
  }
}

async function uniqueSlug(db: Q, wanted: string, exceptId?: string): Promise<string> {
  const base = wanted || "article";
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const r = await db.query("SELECT id FROM kb_articles WHERE slug = $1", [slug]);
    if (!r.rows.length || r.rows[0].id === exceptId) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createArticle(db: Q, input: ArticleInput, by: string, opts: { seedKey?: string } = {}): Promise<ArticleRow> {
  let slug: string;
  if (input.slug) {
    const taken = await db.query("SELECT 1 FROM kb_articles WHERE slug = $1", [input.slug]);
    if (taken.rows.length) throw new SlugTaken();
    slug = input.slug;
  } else slug = await uniqueSlug(db, slugify(input.title));
  const r = await db.query(
    `INSERT INTO kb_articles (slug, title, category, summary, body_md, plans, audience, status, seed_key, created_by, updated_by,
                              published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, CASE WHEN $8 = 'published' THEN now() END)
     RETURNING ${COLS}`,
    [slug, input.title, input.category, input.summary ?? "", input.body_md ?? "", input.plans ?? [], input.audience, input.status, opts.seedKey ?? null, by],
  );
  return r.rows[0];
}

export async function getArticle(db: Q, id: string): Promise<ArticleRow | null> {
  const r = await db.query(`SELECT ${COLS} FROM kb_articles WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getArticleBySlug(db: Q, slug: string): Promise<ArticleRow | null> {
  const r = await db.query(`SELECT ${COLS} FROM kb_articles WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

export async function updateArticle(db: Q, id: string, patch: ArticlePatch, by: string): Promise<ArticleRow | null> {
  const cur = await getArticle(db, id);
  if (!cur) return null;
  if (patch.slug && patch.slug !== cur.slug) {
    const taken = await db.query("SELECT 1 FROM kb_articles WHERE slug = $1 AND id <> $2", [patch.slug, id]);
    if (taken.rows.length) throw new SlugTaken();
  }
  const next = { ...cur, ...patch };
  const r = await db.query(
    `UPDATE kb_articles SET slug = $2, title = $3, category = $4, summary = $5, body_md = $6, plans = $7, audience = $8,
            status = $9, updated_by = $10, updated_at = now(),
            published_at = CASE WHEN $9 = 'published' AND published_at IS NULL THEN now() ELSE published_at END
      WHERE id = $1 RETURNING ${COLS}`,
    [id, next.slug, next.title, next.category, next.summary ?? "", next.body_md ?? "", next.plans ?? [], next.audience, next.status, by],
  );
  return r.rows[0] ?? null;
}

export async function deleteArticle(db: Q, id: string): Promise<boolean> {
  const r = await db.query("DELETE FROM kb_articles WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** Staff list: drafts too, newest change first. */
export async function listForStaff(
  db: Q,
  f: { q?: string; status?: string; audience?: string; category?: string } = {},
): Promise<ArticleRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.audience) {
    params.push(f.audience);
    where.push(`audience = $${params.length}`);
  }
  if (f.category) {
    params.push(f.category);
    where.push(`category = $${params.length}`);
  }
  if (f.q && f.q.trim()) {
    params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(title ILIKE $${params.length} OR slug ILIKE $${params.length} OR category ILIKE $${params.length})`);
  }
  const r = await db.query(
    `SELECT ${COLS} FROM kb_articles ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 500`,
    params,
  );
  return r.rows;
}

/** Categories with how many published articles each viewer may read. */
export async function categoriesFor(db: Q, viewer: Viewer): Promise<Array<{ category: string; count: number }>> {
  const r = await db.query(
    `SELECT category, count(*)::int AS count FROM kb_articles WHERE status = 'published' AND audience = ANY($1)
      GROUP BY category ORDER BY category`,
    [audiencesFor(viewer)],
  );
  return r.rows.map((x) => ({ category: String(x.category), count: Number(x.count) }));
}

/** One published article a viewer may read, or null (drafts and other audiences look the same as missing). */
export async function readableArticle(db: Q, viewer: Viewer, slug: string): Promise<ArticleRow | null> {
  const r = await db.query(
    `SELECT ${COLS} FROM kb_articles WHERE slug = $1 AND status = 'published' AND audience = ANY($2)`,
    [slug, audiencesFor(viewer)],
  );
  return r.rows[0] ?? null;
}

// ---- search ----

export type SearchHit = ArticleRow & { score: number; fts_rank: number; similarity: number };
export type SearchResult = { hits: SearchHit[]; semantic: boolean; best_rank: number; best_similarity: number };

/** "how do I add a user?" -> "add | user" (any word may match; to_tsquery drops the stop words). */
export function orQuery(q: string): string {
  const words = String(q ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .match(/[a-z0-9]{2,}/g);
  return [...new Set(words ?? [])].slice(0, 24).join(" | ");
}

export const RRF_K = 60;
/** A similarity at or above this counts as a real match when there is no full-text match. */
export const MIN_SIMILARITY = 0.35;

/**
 * Published articles a viewer may read that match q, best first. Full-text ranks every article that shares a word with
 * the question; when OpenAI is set up and articles are embedded, the question is embedded too and the two rankings are
 * fused (reciprocal rank). Without q: the viewer's articles by category and title.
 */
export async function searchArticles(
  db: Q,
  opts: { viewer: Viewer; q?: string; category?: string; limit?: number; fetch?: typeof fetch },
): Promise<SearchResult> {
  const audiences = audiencesFor(opts.viewer);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const q = String(opts.q ?? "").trim().slice(0, 500);
  const cat = String(opts.category ?? "").trim();
  if (!q) {
    const r = await db.query(
      `SELECT ${COLS} FROM kb_articles WHERE status = 'published' AND audience = ANY($1) ${cat ? "AND category = $2" : ""}
        ORDER BY category, title LIMIT 500`,
      cat ? [audiences, cat] : [audiences],
    );
    return { hits: r.rows.map((a) => ({ ...a, score: 0, fts_rank: 0, similarity: 0 })), semantic: false, best_rank: 0, best_similarity: 0 };
  }

  const tsq = orQuery(q);
  const ftsRows: Array<ArticleRow & { rank: number }> = tsq
    ? (
        await db.query(
          `SELECT ${COLS}, ts_rank_cd(search, to_tsquery('english', $1), 32) AS rank
             FROM kb_articles
            WHERE status = 'published' AND audience = ANY($2) AND search @@ to_tsquery('english', $1)
              ${cat ? "AND category = $3" : ""}
            ORDER BY rank DESC, title LIMIT 25`,
          cat ? [tsq, audiences, cat] : [tsq, audiences],
        )
      ).rows
    : [];

  let semRows: Array<{ id: string; similarity: number }> = [];
  let semantic = false;
  if (opts.fetch && aiConfigured()) {
    try {
      const withVec = await db.query(
        `SELECT id, embedding FROM kb_articles
          WHERE status = 'published' AND audience = ANY($1) AND embedding IS NOT NULL AND embedding_model = $2
            ${cat ? "AND category = $3" : ""}`,
        cat ? [audiences, embeddingModel(), cat] : [audiences, embeddingModel()],
      );
      if (withVec.rows.length) {
        const [qv] = await embed(opts.fetch, [q]);
        semRows = withVec.rows
          .map((r) => ({ id: String(r.id), similarity: cosine(qv, (r.embedding as number[]).map(Number)) }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 25);
        semantic = true;
      }
    } catch (err) {
      console.warn(`[kb] semantic search unavailable, full text only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const byId = new Map<string, SearchHit>();
  ftsRows.forEach((a, i) => {
    byId.set(a.id, { ...a, score: 1 / (RRF_K + i + 1), fts_rank: Number(a.rank), similarity: 0 });
  });
  const missing = semRows.filter((s) => s.similarity >= MIN_SIMILARITY * 0.8 && !byId.has(s.id)).map((s) => s.id);
  const extra = new Map<string, ArticleRow>();
  if (missing.length) {
    const r = await db.query(`SELECT ${COLS} FROM kb_articles WHERE id = ANY($1)`, [missing]);
    for (const a of r.rows) extra.set(a.id, a);
  }
  semRows.forEach((s, i) => {
    if (s.similarity < MIN_SIMILARITY * 0.8) return; // unrelated: adds nothing to the ranking
    const hit = byId.get(s.id);
    if (hit) {
      hit.score += 1 / (RRF_K + i + 1);
      hit.similarity = s.similarity;
    } else if (extra.has(s.id)) {
      byId.set(s.id, { ...extra.get(s.id)!, score: 1 / (RRF_K + i + 1), fts_rank: 0, similarity: s.similarity });
    }
  });
  const hits = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return {
    hits,
    semantic,
    best_rank: ftsRows.length ? Number(ftsRows[0].rank) : 0,
    best_similarity: semRows.length ? semRows[0].similarity : 0,
  };
}

/** Whether a search found something worth answering from. */
export function hasGoodMatch(r: SearchResult): boolean {
  if (!r.hits.length) return false;
  if (r.semantic) return r.best_similarity >= MIN_SIMILARITY || r.best_rank >= 0.1;
  return r.best_rank > 0;
}

// ---- embeddings ----

export function embeddingText(a: Pick<ArticleRow, "title" | "category" | "summary" | "body_md">): string {
  return `${a.title}\n${a.category}\n${a.summary}\n\n${plainText(a.body_md)}`;
}

/** Embeds articles that have none, or whose text changed since (at most `max` a run). Never throws. */
export async function embedPending(deps: { db: Q; fetch: typeof fetch }, max = 20): Promise<{ embedded: number; failed: number }> {
  if (!aiConfigured()) return { embedded: 0, failed: 0 };
  let rows: ArticleRow[] = [];
  try {
    const r = await deps.db.query(
      `SELECT ${COLS} FROM kb_articles
        WHERE embedding IS NULL OR embedded_at < updated_at OR embedding_model IS DISTINCT FROM $1
        ORDER BY updated_at DESC LIMIT $2`,
      [embeddingModel(), max],
    );
    rows = r.rows;
  } catch (err) {
    console.error(`[kb] could not read articles to embed: ${err instanceof Error ? err.message : String(err)}`);
    return { embedded: 0, failed: 0 };
  }
  if (!rows.length) return { embedded: 0, failed: 0 };
  try {
    const vectors = await embed(deps.fetch, rows.map(embeddingText));
    for (let i = 0; i < rows.length; i++) {
      await deps.db.query(
        "UPDATE kb_articles SET embedding = $2, embedding_model = $3, embedded_at = now() WHERE id = $1",
        [rows[i].id, vectors[i], embeddingModel()],
      );
    }
    return { embedded: rows.length, failed: 0 };
  } catch (err) {
    console.warn(`[kb] embedding failed for ${rows.length} article(s): ${err instanceof Error ? err.message : String(err)}`);
    return { embedded: 0, failed: rows.length };
  }
}

// ---- images ----

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export async function saveImage(db: Q, img: { contentType: string; data: Buffer; filename: string | null }, by: string): Promise<string> {
  const r = await db.query(
    "INSERT INTO kb_images (content_type, data, filename, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    [img.contentType, img.data, img.filename, by],
  );
  return String(r.rows[0].id);
}

export async function imageById(db: Q, id: string): Promise<{ content_type: string; data: Buffer } | null> {
  const r = await db.query("SELECT content_type, data FROM kb_images WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

export const imagePath = (id: string) => `/api/public/kb/images/${id}`;

// ---- the question log and the "no good answer" report ----

export type QuestionLog = {
  channel: "portal" | "website";
  licensee_id: string | null;
  asker_ref: string | null;
  question: string;
  outcome: "answered" | "no_answer" | "escalated" | "error";
  top_score?: number | null;
  article_ids?: string[];
};

/** Logged for the report and the rate limits. Never throws. */
export async function logQuestion(db: Q, q: QuestionLog): Promise<void> {
  try {
    await db.query(
      `INSERT INTO kb_questions (channel, licensee_id, asker_ref, question, outcome, top_score, article_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [q.channel, q.licensee_id, q.asker_ref, q.question.slice(0, 2000), q.outcome, q.top_score ?? null, q.article_ids ?? []],
    );
  } catch (err) {
    console.error(`[kb] could not log a question: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Questions asked since `since` (all outcomes except "error"), for the rate limits. */
export async function questionCount(db: Q, f: { channel: "portal" | "website"; licensee_id?: string; asker_ref?: string; since: Date }): Promise<number> {
  const params: unknown[] = [f.channel, f.since];
  let extra = "";
  if (f.licensee_id) {
    params.push(f.licensee_id);
    extra += ` AND licensee_id = $${params.length}`;
  }
  if (f.asker_ref) {
    params.push(f.asker_ref);
    extra += ` AND asker_ref = $${params.length}`;
  }
  const r = await db.query(
    `SELECT count(*)::int AS n FROM kb_questions WHERE channel = $1 AND created_at >= $2 AND outcome <> 'error'${extra}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** "Questions with no good answer": grouped by the question's wording (lower case, spaces collapsed), most asked first. */
export async function unansweredReport(db: Q, days: number, now: Date): Promise<Record<string, unknown>> {
  const since = new Date(now.getTime() - Math.max(1, Math.min(days, 365)) * 86_400_000);
  const totals = await db.query(
    `SELECT outcome, count(*)::int AS n FROM kb_questions WHERE created_at >= $1 GROUP BY outcome`,
    [since],
  );
  const rows = await db.query(
    `SELECT lower(regexp_replace(trim(question), '\\s+', ' ', 'g')) AS question_key,
            min(question) AS question, count(*)::int AS times, max(created_at) AS last_asked,
            count(DISTINCT licensee_id)::int AS licensees,
            sum(CASE WHEN channel = 'website' THEN 1 ELSE 0 END)::int AS from_website,
            sum(CASE WHEN outcome = 'escalated' THEN 1 ELSE 0 END)::int AS escalated
       FROM kb_questions
      WHERE created_at >= $1 AND outcome IN ('no_answer', 'escalated')
      GROUP BY question_key
      ORDER BY times DESC, last_asked DESC
      LIMIT 200`,
    [since],
  );
  const t: Record<string, number> = {};
  for (const r of totals.rows) t[String(r.outcome)] = Number(r.n);
  return {
    since: since.toISOString(),
    totals: { answered: t.answered ?? 0, no_answer: t.no_answer ?? 0, escalated: t.escalated ?? 0, error: t.error ?? 0 },
    questions: rows.rows.map((r) => ({
      question: String(r.question),
      times: Number(r.times),
      last_asked: iso(r.last_asked),
      licensees: Number(r.licensees),
      from_website: Number(r.from_website),
      escalated: Number(r.escalated),
    })),
  };
}
