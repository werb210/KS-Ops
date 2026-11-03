// KS_SHARED_HOSTING_v1 - ks-shared-web's entry point. App settings:
//   KS_CONTROL_DATABASE_URL              ks_control as ks_control_reader (SELECT on ks_tenants only)
//   KS_SITES_STORAGE_CONNECTION_STRING   the storage account with the `sites` container (or AZURE_STORAGE_CONNECTION_STRING)
//   PORT                                 set by App Service (default 8080)
import { createServer } from "node:http";
import pg from "pg";
import { cachedRegistry } from "./registry.js";
import { blobStore } from "./store.js";
import { createHandler } from "./server.js";

const controlUrl = String(process.env.KS_CONTROL_DATABASE_URL ?? "").trim();
const storage = String(process.env.KS_SITES_STORAGE_CONNECTION_STRING ?? process.env.AZURE_STORAGE_CONNECTION_STRING ?? "").trim();
if (!controlUrl || !storage) {
  console.error("[web-host] KS_CONTROL_DATABASE_URL and KS_SITES_STORAGE_CONNECTION_STRING must both be set");
  process.exit(1);
}

const local = /localhost|127\.0\.0\.1/.test(controlUrl) || /sslmode=disable/.test(controlUrl);
const pool = new pg.Pool({ connectionString: controlUrl, max: 3, idleTimeoutMillis: 30_000, ssl: local ? undefined : { rejectUnauthorized: false } });
pool.on("error", (err) => console.error("[web-host] idle database client error", err.message));

const handler = createHandler({ registry: cachedRegistry(pool), store: blobStore(storage) });
const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  void handler(req, res);
}).listen(port, () => console.log(`[web-host] listening on ${port}`));
