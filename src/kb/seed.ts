// KS_OPS_KB_v1 - the starter library (src/kb/articles/*.ts) is loaded once per SEED_VERSION, on startup and by
// `npm run migrate`. Articles keep their seed_key, so a later version can add new ones; it never changes or brings back
// an article Keystone staff edited or deleted.
import type { Q } from "../db.js";
import { STARTER_ARTICLES, type SeedArticle } from "./articles/index.js";

export const SEED_VERSION = 3; // KS_OPS_KB_v2 - v2 refreshes untouched articles' text (Broker role, shared hosting); v3 sign-up team and licence agreement (KS_OPS_ONBOARDING_v1)

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
  // KS_OPS_KB_v2 - a new version also refreshes the text of starter articles nobody at Keystone has edited since they
  // were loaded (updated_by is still 'keystone'), so wording changes reach existing libraries. Edited ones are left alone.
  if (version >= 2) {
    let refreshed = 0;
    for (const a of articles) {
      const u = await db.query(
        `UPDATE kb_articles SET title = $2, summary = $3, body_md = $4, updated_at = now()
          WHERE slug = $1 AND seed_key IS NOT NULL AND updated_by = 'keystone'
            AND (title <> $2 OR summary <> $3 OR body_md <> $4) RETURNING id`,
        [a.slug, a.title, a.summary, a.body.trim()],
      );
      refreshed += u.rows.length;
    }
    if (refreshed) console.log(`[kb] starter library v${version}: ${refreshed} article(s) refreshed`);
  }
  await db.query("INSERT INTO kb_seed_runs (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
  if (added) console.log(`[kb] starter library v${version}: ${added} article(s) added`);
  return added;
}
