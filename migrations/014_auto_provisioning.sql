-- KS-Ops v15: automatic provisioning (KS_OPS_AUTO_PROVISION_v1). One run per licensee setup (or teardown), with each
-- step's status, attempts, error and output, and a log. Idempotent: safe to run again.

CREATE TABLE IF NOT EXISTS provisioning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  licensee_id uuid NOT NULL REFERENCES licensees(id) ON DELETE CASCADE,
  -- provision: set up a new copy. teardown: remove it, only once the retention rules allow.
  kind text NOT NULL CHECK (kind IN ('provision', 'teardown')),
  -- waiting_for_setup: credentials are not configured yet (see setup_missing); nothing has been changed.
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('waiting_for_setup', 'running', 'blocked', 'failed', 'done', 'cancelled')),
  -- checkout | admin_trial | staff | purge
  trigger text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  region text NOT NULL DEFAULT 'canadacentral',
  setup_missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The workflow run in KS-Ops GitHub Actions doing the Azure and GitHub steps: when it was started, for which steps,
  -- and the hash of the one-off token it reports back with.
  workflow_dispatched_at timestamptz,
  workflow_steps text[] NOT NULL DEFAULT '{}',
  callback_token_hash text,
  callback_expires_at timestamptz,
  next_attempt_at timestamptz,
  locked_until timestamptz,
  last_error text,
  failure_notified_at timestamptz,
  setup_notified_at timestamptz,
  created_by text NOT NULL DEFAULT 'ks-ops',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- At most one live run of each kind per licensee (dry runs never block a real one).
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_runs_one_live
  ON provisioning_runs (licensee_id, kind)
  WHERE status NOT IN ('done', 'cancelled') AND NOT dry_run;
CREATE INDEX IF NOT EXISTS provisioning_runs_due ON provisioning_runs (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  run_id uuid NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
  step text NOT NULL,
  position int NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'manual', 'blocked')),
  attempts int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  done_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step)
);

CREATE TABLE IF NOT EXISTS provisioning_logs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES provisioning_runs(id) ON DELETE CASCADE,
  step text,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provisioning_logs_run ON provisioning_logs (run_id, id);
