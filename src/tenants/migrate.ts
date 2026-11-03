// KS_SHARED_HOSTING_v1 - applies migrations-control/*.sql to ks_control as ks_control_owner (a non-superuser), with the
// same runner as KS-Ops's own database. Nothing happens when KS_CONTROL_OWNER_DATABASE_URL is not set.
import pg from "pg";
import { controlMigrationsDir, runMigrations } from "../migrate.js";
import { controlOwnerUrl } from "./config.js";

export async function migrateControlDatabase(e: NodeJS.ProcessEnv = process.env, dir = controlMigrationsDir()): Promise<string[] | null> {
  const url = controlOwnerUrl(e);
  if (!url) return null;
  const local = /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 1, ssl: local ? undefined : { rejectUnauthorized: false } });
  pool.on("error", (err) => console.error("[control-migrations] idle client error", err.message));
  try {
    return await runMigrations(pool, dir);
  } finally {
    await pool.end();
  }
}
