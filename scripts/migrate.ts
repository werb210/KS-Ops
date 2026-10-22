// npm run migrate - applies migrations/*.sql to DATABASE_URL (the server also does this on startup).
import { closePool, getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";

const applied = await runMigrations(getPool());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
await closePool();
