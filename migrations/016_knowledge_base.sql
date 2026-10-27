-- KS_OPS_KB_v1 - the Keystone knowledge base: one library of help articles shared by every licensee, written by
-- Keystone staff on /ops/kb. Read by the website (public articles), the licensee portals (through their KS-server, with
-- the ops key) and the two Keystone Maya assistants (support in the portal, sales on the website).
--
-- audience: public    = the website too, and every licensee user
--           all_staff = every licensee user (Admin, Staff, Marketing, Ops), never the website
--           admins    = licensee Admins only
-- plans:    the plans the article applies to; empty = every plan.
-- search:   Postgres full-text (title A, category and summary B, body C). embedding: an OpenAI embedding of the same
--           text for semantic search (real[], compared in the app; no pgvector needed here). NULL until embedded.

CREATE TABLE IF NOT EXISTS kb_articles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 120),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  category        text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  summary         text NOT NULL DEFAULT '' CHECK (length(summary) <= 400),
  body_md         text NOT NULL DEFAULT '' CHECK (length(body_md) <= 100000),
  plans           text[] NOT NULL DEFAULT '{}',
  audience        text NOT NULL DEFAULT 'all_staff' CHECK (audience IN ('public', 'all_staff', 'admins')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  seed_key        text UNIQUE,
  embedding       real[],
  embedding_model text,
  embedded_at     timestamptz,
  created_by      text,
  updated_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  search          tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '') || ' ' || coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_md, '')), 'C')
  ) STORED
);

CREATE INDEX IF NOT EXISTS kb_articles_search_idx ON kb_articles USING gin (search);
CREATE INDEX IF NOT EXISTS kb_articles_status_audience_idx ON kb_articles (status, audience);
CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles (category);

-- Images used in article bodies (PNG or JPG, 2 MB at most), served from /api/public/kb/images/:id.
CREATE TABLE IF NOT EXISTS kb_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  data         bytea NOT NULL,
  filename     text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every question either assistant was asked (no answer text kept, only what is needed for the report and the limits).
-- channel: portal (licensee support assistant) or website (sales assistant). outcome: answered | no_answer |
-- escalated | refused (rate limited) | error. The "questions with no good answer" report reads no_answer and escalated.
CREATE TABLE IF NOT EXISTS kb_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL CHECK (channel IN ('portal', 'website')),
  licensee_id uuid REFERENCES licensees(id) ON DELETE SET NULL,
  asker_ref   text,
  question    text NOT NULL CHECK (length(question) <= 2000),
  outcome     text NOT NULL CHECK (outcome IN ('answered', 'no_answer', 'escalated', 'refused', 'error')),
  top_score   real,
  article_ids uuid[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_questions_created_idx ON kb_questions (created_at DESC);
CREATE INDEX IF NOT EXISTS kb_questions_licensee_idx ON kb_questions (licensee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kb_questions_asker_idx ON kb_questions (channel, asker_ref, created_at DESC);

-- Prospects the website assistant captured (name, email, brokerage, size, phone optional, consent). Pushed to the
-- Keystone CRM (BF-Server, KS silo) through crm_outbox like demo and beta sign-ups (source website_signup).
CREATE TABLE IF NOT EXISTS assistant_leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL,
  brokerage      text NOT NULL,
  team_size      text NOT NULL,
  phone          text,
  consent        boolean NOT NULL,
  consent_text   text NOT NULL,
  wants          text NOT NULL DEFAULT 'info' CHECK (wants IN ('info', 'live_demo', 'person')),
  message        text,
  transcript     jsonb NOT NULL DEFAULT '[]'::jsonb,
  handed_off_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_leads_email_idx ON assistant_leads (lower(email), created_at DESC);

-- The starter library is loaded once per seed version (src/kb/seed.ts); staff edits and deletions are never undone.
CREATE TABLE IF NOT EXISTS kb_seed_runs (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
