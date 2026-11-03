// KS_SHARED_HOSTING_v1 - one brokerage's database and login role on ks-shared-pg, made through the admin connection
// (KS_SHARED_PG_ADMIN_URL). DDL cannot take bind parameters, so every name is checked against a strict pattern AND
// quoted (quoteIdent), and the password is quoted as a literal (quoteLiteral). Lookups use bind parameters.
//
// The database is owned by the admin role; the brokerage's role ks_<code>_app gets CONNECT and TEMPORARY on its own
// database only (CONNECT is revoked from PUBLIC), and USAGE + CREATE on its public schema, so the shared KS-server's
// migrations run as that non-superuser role. The only extension ever made is `vector`.
import type { Q } from "../db.js";

const NAME_RE = /^ks_[a-z0-9_]{1,60}$/;

/** A Postgres identifier, double-quoted. Throws on anything outside the ks_ naming rule. */
export function quoteIdent(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`refusing an unexpected database name: ${JSON.stringify(name)}`);
  return `"${name.replace(/"/g, '""')}"`;
}

/** A Postgres string literal (standard_conforming_strings, the default since 9.1). Refuses NUL and backslashes. */
export function quoteLiteral(value: string): string {
  if (/[\0\\]/.test(value)) throw new Error("refusing a literal with a NUL or backslash");
  return `'${value.replace(/'/g, "''")}'`;
}

/** The connection string for the brokerage's role, on the same host, port and TLS settings as the admin URL. */
export function brokerageDatabaseUrl(adminUrl: string, database: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  const out = new URL(`${u.protocol}//${u.host}`);
  out.username = role;
  out.password = password;
  out.pathname = `/${database}`;
  const ssl = u.searchParams.get("sslmode") || (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? "" : "require");
  if (ssl) out.searchParams.set("sslmode", ssl);
  return out.toString();
}

/** The admin URL pointed at another database on the same server. */
export function adminUrlFor(adminUrl: string, database: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

export type AdminConn = Q & { end?: () => Promise<void> };

export type EnsureResult = { role_created: boolean; database_created: boolean; vector: "ok" | "not_available" };

/**
 * Makes (or keeps) the role and database. Safe to run again: an existing role gets the password given (so it always
 * matches the registry), an existing database is kept, and the grants are applied again.
 *   admin   connected to the server's maintenance database (postgres)
 *   onDb    opens an admin connection to the brokerage's database (for the schema grant and `vector`)
 */
export async function ensureBrokerageDatabase(
  admin: Q,
  onDb: (database: string) => Promise<AdminConn>,
  names: { database: string; role: string },
  password: string,
  log: (m: string, level?: "info" | "warn") => Promise<void> | void = () => {},
): Promise<EnsureResult> {
  const db = quoteIdent(names.database);
  const role = quoteIdent(names.role);
  const pw = quoteLiteral(password);

  const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [names.role])).rows.length > 0;
  if (roleExists) {
    await admin.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pw}`);
  } else {
    await admin.query(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${pw}`);
    await log(`role ${names.role} created`);
  }

  const dbExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [names.database])).rows.length > 0;
  if (!dbExists) {
    await admin.query(`CREATE DATABASE ${db}`);
    await log(`database ${names.database} created`);
  }
  // Only this brokerage's role may connect to this database.
  await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`);

  const conn = await onDb(names.database);
  let vector: EnsureResult["vector"] = "ok";
  try {
    await conn.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await conn.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
    try {
      await conn.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch (err) {
      // Not fatal: the server works without it unless a migration needs it. Logged, never hidden.
      vector = "not_available";
      const message = err instanceof Error ? err.message : String(err);
      console.error("[tenants] CREATE EXTENSION vector failed", { database: names.database, message });
      await log(`the vector extension could not be made in ${names.database} (${message}); allow it on ks-shared-pg (azure.extensions = VECTOR) and retry`, "warn");
    }
  } finally {
    await conn.end?.().catch((err) => console.error("[tenants] admin connection did not close", err instanceof Error ? err.message : String(err)));
  }
  return { role_created: !roleExists, database_created: !dbExists, vector };
}

/** Drops the database (closing its connections) and then the role. Missing ones are fine. */
export async function dropBrokerageDatabase(admin: Q, names: { database: string; role: string }): Promise<{ database_dropped: boolean; role_dropped: boolean }> {
  const db = quoteIdent(names.database);
  const role = quoteIdent(names.role);
  const hadDb = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [names.database])).rows.length > 0;
  if (hadDb) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  const hadRole = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [names.role])).rows.length > 0;
  if (hadRole) await admin.query(`DROP ROLE IF EXISTS ${role}`);
  return { database_dropped: hadDb, role_dropped: hadRole };
}
