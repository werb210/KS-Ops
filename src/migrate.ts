// Runs migrations/*.sql in name order, once each, on startup. Every migration is idempotent (IF NOT EXISTS), and each
// file runs in its own transaction; a failure rolls it back and stops startup. An advisory lock stops two instances
// migrating at the same time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const LOCK_KEY = "4719305512";

export function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/migrate.ts and dist/migrate.js both sit one level below the repo root.
  return path.resolve(here, "..", "migrations");
}

export async function runMigrations(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        await client.query("COMMIT");
        applied.push(file);
        console.log(`[migrations] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`[migrations] ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch((err) => {
      console.warn("[migrations] unlock failed", err instanceof Error ? err.message : String(err));
    });
    client.release();
  }
  return applied;
}
