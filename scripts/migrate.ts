// npm run migrate - applies migrations/*.sql to DATABASE_URL (the server also does this on startup).
import { closePool, getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { seedKnowledgeBase } from "../src/kb/seed.js";

const applied = await runMigrations(getPool());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
const seeded = await seedKnowledgeBase(getPool()); // KS_OPS_KB_v1
if (seeded) console.log(`help articles added: ${seeded}`);
await closePool();
