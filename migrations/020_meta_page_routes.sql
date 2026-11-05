-- KS_META_LEAD_ADS_v1: which brokerage each Facebook Page belongs to. Meta sends every lead webhook for Keystone's app
-- to KS-Ops; KS-Ops passes each lead to the brokerage that connected the Page.
CREATE TABLE IF NOT EXISTS meta_page_routes (
  page_id      text PRIMARY KEY,
  licensee_id  uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meta_page_routes_licensee ON meta_page_routes (licensee_id);
