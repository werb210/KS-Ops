// KS_OPS_KB_v1 - the starter library (src/kb/articles/*.ts) is loaded once per SEED_VERSION, on startup and by
// `npm run migrate`. Articles keep their seed_key, so a later version can add new ones; it never changes or brings back
// an article Keystone staff edited or deleted.
import type { Q } from "../db.js";
import { STARTER_ARTICLES, type SeedArticle } from "./articles/index.js";

export const SEED_VERSION = 2; // KS_OPS_MAYA_TRAINING_v1: v2 adds the sales articles (src/kb/articles/whyKeystone.ts)

/**
 * Each seed version not yet run adds the articles that version introduced (an article's `since`, default 1). A copy
 * seeded at v1 therefore gets only the v2 articles, and an article staff deleted is never brought back.
 */
export async function seedKnowledgeBase(db: Q, articles: SeedArticle[] = STARTER_ARTICLES, version = SEED_VERSION): Promise<number> {
  let added = 0;
  for (let v = 1; v <= version; v++) {
    const done = await db.query("SELECT 1 FROM kb_seed_runs WHERE version = $1", [v]);
    if (done.rows.length) continue;
    for (const a of articles.filter((x) => (x.since ?? 1) === v)) {
      const r = await db.query(
        `INSERT INTO kb_articles (slug, title, category, summary, body_md, plans, audience, status, seed_key, created_by, updated_by, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', $8, 'keystone', 'keystone', now())
         ON CONFLICT DO NOTHING RETURNING id`,
        [a.slug, a.title, a.category, a.summary, a.body.trim(), a.plans ?? [], a.audience, `v${v}:${a.slug}`],
      );
      added += r.rows.length;
    }
    await db.query("INSERT INTO kb_seed_runs (version) VALUES ($1) ON CONFLICT DO NOTHING", [v]);
  }
  if (added) console.log(`[kb] starter library to v${version}: ${added} article(s) added`);
  return added;
}
