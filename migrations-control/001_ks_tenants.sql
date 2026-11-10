-- KS_SHARED_HOSTING_v1 - the brokerage registry in the control database ks_control (not KS-Ops's own database).
-- KS-Ops applies the files in migrations-control/ to KS_CONTROL_OWNER_DATABASE_URL on startup (and `npm run migrate`),
-- as ks_control_owner, which is not a superuser. Idempotent: safe to run again. No extensions.
--
-- One row per brokerage on the shared server. KS-Ops writes it (ks_control_owner); the shared KS-server, KS-Agent and
-- web host read it (ks_control_reader, SELECT only). Host names are stored lowercase, with no port and no scheme.
-- database_url_enc and env_enc are AES-256-GCM, "v1:<iv b64>:<tag b64>:<ciphertext b64>", key SHA-256(KS_TENANT_KEY).

CREATE TABLE IF NOT EXISTS ks_tenants (
  code              text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  licensee_id       uuid,                      -- KS-Ops licensee id
  status            text NOT NULL DEFAULT 'provisioning', -- provisioning|trial|active|past_due|suspended|cancelled
  api_hosts         text[] NOT NULL DEFAULT '{}',  -- e.g. {northwind.api.<domain>}
  portal_hosts      text[] NOT NULL DEFAULT '{}',  -- e.g. {northwind.portal.<domain>}
  client_hosts      text[] NOT NULL DEFAULT '{}',  -- e.g. {northwind.app.<domain>, apply.northwindcapital.ca}
  database_name     text NOT NULL,             -- ks_<code with - replaced by _>
  database_url_enc  text NOT NULL,             -- encrypted connection string for role ks_<code>_app
  env_enc           text NOT NULL DEFAULT '',  -- encrypted JSON object of this brokerage's env values
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_tenants_api_hosts ON ks_tenants USING gin (api_hosts);
CREATE INDEX IF NOT EXISTS ks_tenants_portal_hosts ON ks_tenants USING gin (portal_hosts);
CREATE INDEX IF NOT EXISTS ks_tenants_client_hosts ON ks_tenants USING gin (client_hosts);

-- The readers get SELECT on this table only. The role is made once by scripts/provision-shared.sh; when it is not
-- there yet (a development database) the grant is skipped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ks_control_reader') THEN
    GRANT SELECT ON ks_tenants TO ks_control_reader;
  END IF;
END
$$;
