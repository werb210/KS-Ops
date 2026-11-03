// npm run migrate - applies migrations/*.sql to DATABASE_URL (the server also does this on startup).
import { closePool, getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { seedKnowledgeBase } from "../src/kb/seed.js";
import { migrateControlDatabase } from "../src/tenants/migrate.js";

const applied = await runMigrations(getPool());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
const seeded = await seedKnowledgeBase(getPool()); // KS_OPS_KB_v1
if (seeded) console.log(`help articles added: ${seeded}`);
// KS_SHARED_HOSTING_v1 - the brokerage registry, when KS_CONTROL_OWNER_DATABASE_URL is set.
const control = await migrateControlDatabase();
if (control) console.log(control.length ? `control database applied: ${control.join(", ")}` : "control database: nothing to apply");
await closePool();
