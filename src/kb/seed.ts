// KS_OPS_KB_v1 - the starter library (src/kb/articles/*.ts) is loaded once per SEED_VERSION, on startup and by
// `npm run migrate`. Articles keep their seed_key, so a later version can add new ones; it never changes or brings back
// an article Keystone staff edited or deleted.
import type { Q } from "../db.js";
import { STARTER_ARTICLES, type SeedArticle } from "./articles/index.js";

export const SEED_VERSION = 1;

export async function seedKnowledgeBase(db: Q, articles: SeedArticle[] = STARTER_ARTICLES, version = SEED_VERSION): Promise<number> {
  const done = await db.query("SELECT 1 FROM kb_seed_runs WHERE version = $1", [version]);
  if (done.rows.length) return 0;
  let added = 0;
  for (const a of articles) {
    const r = await db.query(
      `INSERT INTO kb_articles (slug, title, category, summary, body_md, plans, audience, status, seed_key, created_by, updated_by, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', $8, 'keystone', 'keystone', now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [a.slug, a.title, a.category, a.summary, a.body.trim(), a.plans ?? [], a.audience, `v${version}:${a.slug}`],
    );
    added += r.rows.length;
  }
  await db.query("INSERT INTO kb_seed_runs (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
  if (added) console.log(`[kb] starter library v${version}: ${added} article(s) added`);
  return added;
}
