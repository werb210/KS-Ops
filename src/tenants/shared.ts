// KS_SHARED_HOSTING_v1 - the outside world of the shared layout, behind one small interface so tests replace it:
// the control database (ks_control as ks_control_owner), the admin connection to ks-shared-pg, and the `sites` blob
// container. Production connections are made lazily, on first use, from the environment.
import pg from "pg";
import { ContainerClient } from "@azure/storage-blob";
import type { Q } from "../db.js";
import { adminUrlFor, type AdminConn } from "./database.js";
import { controlOwnerUrl, SHARED, sharedPgAdminUrl, sitesConnectionString } from "./config.js";

export type SitesStore = {
  /** Deletes every blob under the prefix (e.g. "northwind/"); returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
};

export type SharedDeps = {
  control: () => Q;
  admin: () => Q;
  adminOn: (database: string) => Promise<AdminConn>;
  sites: () => SitesStore;
};

const local = (url: string) => /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url);
const sslFor = (url: string) => (local(url) ? undefined : { rejectUnauthorized: false });

function lazyPool(urlOf: () => string, what: string, max: number): () => Q {
  let pool: pg.Pool | null = null;
  let poolUrl = "";
  return () => {
    const url = urlOf();
    if (!url) throw new Error(`${what} is not set`);
    if (!pool || poolUrl !== url) {
      if (pool) pool.end().catch((err) => console.error(`[tenants] old ${what} pool did not close`, err instanceof Error ? err.message : String(err)));
      pool = new pg.Pool({ connectionString: url, max, ssl: sslFor(url), idleTimeoutMillis: 30_000 });
      pool.on("error", (err) => console.error(`[tenants] ${what} idle client error`, err.message));
      poolUrl = url;
    }
    return pool;
  };
}

export function sitesStoreFrom(connectionString: string): SitesStore {
  return {
    async deletePrefix(prefix: string) {
      if (!connectionString) throw new Error("KS_SITES_STORAGE_CONNECTION_STRING is not set");
      if (!/^[a-z0-9][a-z0-9-]*\/$/.test(prefix)) throw new Error(`refusing to delete an unexpected blob prefix: ${JSON.stringify(prefix)}`);
      const container = new ContainerClient(connectionString, SHARED.sitesContainer);
      let n = 0;
      for await (const blob of container.listBlobsFlat({ prefix })) {
        await container.deleteBlob(blob.name, { deleteSnapshots: "include" });
        n++;
      }
      return n;
    },
  };
}

/** Production: connections from KS_CONTROL_OWNER_DATABASE_URL, KS_SHARED_PG_ADMIN_URL, KS_SITES_STORAGE_CONNECTION_STRING. */
export function productionShared(e: NodeJS.ProcessEnv = process.env): SharedDeps {
  return {
    control: lazyPool(() => controlOwnerUrl(e), "KS_CONTROL_OWNER_DATABASE_URL", 3),
    admin: lazyPool(() => sharedPgAdminUrl(e), "KS_SHARED_PG_ADMIN_URL", 2),
    adminOn: async (database: string) => {
      const base = sharedPgAdminUrl(e);
      if (!base) throw new Error("KS_SHARED_PG_ADMIN_URL is not set");
      const url = adminUrlFor(base, database);
      const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
      await client.connect();
      return { query: (text: string, params?: unknown[]) => client.query(text, params), end: () => client.end() };
    },
    sites: () => sitesStoreFrom(sitesConnectionString(e)),
  };
}

let shared: SharedDeps | null = null;
/** One production instance per process (its pools are reused). */
export function defaultShared(): SharedDeps {
  if (!shared) shared = productionShared();
  return shared;
}
