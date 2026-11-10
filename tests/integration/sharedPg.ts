// KS_SHARED_HOSTING_v1 - the shared Postgres layout on the test server, made the way scripts/provision-shared.sh makes
// it on ks-shared-pg: an admin role that is NOT a superuser (CREATEDB, CREATEROLE, like Azure's admin), a control
// database made by that admin, an owner role with CREATE on its public schema, a reader role, and CONNECT revoked from
// PUBLIC. The superuser (DATABASE_URL) is only used to reset the roles between runs.
import pg from "pg";
import { DATABASE_URL } from "./db.js";

export const ADMIN_ROLE = "ks_it_admin";
export const CONTROL_DB = "ks_control_it";
export const OWNER_ROLE = "ks_control_owner";
export const READER_ROLE = "ks_control_reader";
const PW = "it-password";

const withDb = (base: string, user: string, db: string) => {
  const u = new URL(base);
  u.username = user;
  u.password = PW;
  u.pathname = `/${db}`;
  return u.toString();
};

export const adminUrl = () => withDb(DATABASE_URL, ADMIN_ROLE, "postgres");
export const controlOwnerUrl = () => withDb(DATABASE_URL, OWNER_ROLE, CONTROL_DB);
export const controlReaderUrl = () => withDb(DATABASE_URL, READER_ROLE, CONTROL_DB);
export const urlAs = (user: string, password: string, db: string) => {
  const u = new URL(DATABASE_URL);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
};

async function q(url: string, sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

/** Drops what an earlier run left (brokerage databases and roles under the given codes) and makes the layout again. */
export async function resetSharedLayout(codes: string[]): Promise<void> {
  const suUrl = new URL(DATABASE_URL);
  suUrl.pathname = "/postgres";
  const s = suUrl.toString();
  for (const code of codes) {
    const db = `ks_${code.replace(/-/g, "_")}`;
    await q(s, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await q(s, `DROP ROLE IF EXISTS "${db}_app"`);
  }
  await q(s, `DROP DATABASE IF EXISTS "${CONTROL_DB}" WITH (FORCE)`);
  for (const r of [OWNER_ROLE, READER_ROLE, "ks_it_intruder", ADMIN_ROLE]) await q(s, `DROP ROLE IF EXISTS "${r}"`);
  await q(s, `CREATE ROLE "${ADMIN_ROLE}" WITH LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD '${PW}'`);
  // From here on everything is done as the non-superuser admin, like on Azure.
  const a = adminUrl();
  await q(a, `CREATE ROLE "${OWNER_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${PW}'`);
  await q(a, `CREATE ROLE "${READER_ROLE}" WITH LOGIN NOSUPERUSER PASSWORD '${PW}'`);
  await q(a, `CREATE ROLE "ks_it_intruder" WITH LOGIN NOSUPERUSER PASSWORD '${PW}'`);
  await q(a, `CREATE DATABASE "${CONTROL_DB}"`);
  await q(a, `REVOKE ALL ON DATABASE "${CONTROL_DB}" FROM PUBLIC`);
  await q(a, `GRANT CONNECT, TEMPORARY ON DATABASE "${CONTROL_DB}" TO "${OWNER_ROLE}"`);
  await q(a, `GRANT CONNECT ON DATABASE "${CONTROL_DB}" TO "${READER_ROLE}"`);
  await q(withDb(DATABASE_URL, ADMIN_ROLE, CONTROL_DB), `GRANT USAGE, CREATE ON SCHEMA public TO "${OWNER_ROLE}"`);
}

export { q as queryOnce };
