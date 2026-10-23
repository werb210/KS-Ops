-- KS-Ops v8: the outbox for pushes to the Keystone CRM on BF-Server (POST /api/ks/crm/upsert). One pending row per
-- (source, external_id): a new push for the same record is merged into it, so only the latest state is waiting. Rows
-- are kept once sent (sent_at) for the record. Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS crm_outbox (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  external_id text NOT NULL,
  payload jsonb NOT NULL,
  -- Bumped on every merge: the sender only marks a row sent when nothing was merged in while it was sending.
  version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_outbox_pending_uidx ON crm_outbox (source, external_id) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_outbox_due_idx ON crm_outbox (next_attempt_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_outbox_sent_idx ON crm_outbox (sent_at) WHERE sent_at IS NOT NULL;
