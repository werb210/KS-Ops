// KS_SHARED_HOSTING_v1 - the web builds in blob storage: container `sites`, files at <code>/<app>/<path>
// (KS-Portal and KS-Client upload dist/ there on every deploy). Read with KS_SITES_STORAGE_CONNECTION_STRING.
import type { Readable } from "node:stream";
import { ContainerClient } from "@azure/storage-blob";

export type SiteFile = {
  /** The body; null for a HEAD request. */
  body: Readable | null;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
};

export type SiteStore = {
  /** The file, or null when there is no such blob. */
  get(name: string, opts?: { head?: boolean }): Promise<SiteFile | null>;
  /** The whole file as text (small files such as staticwebapp.config.json), or null. */
  text(name: string): Promise<string | null>;
};

const isNotFound = (err: unknown) => (err as { statusCode?: number })?.statusCode === 404;

export function blobStore(connectionString: string, container = "sites"): SiteStore {
  const client = new ContainerClient(connectionString, container);
  return {
    async get(name, opts = {}) {
      const blob = client.getBlobClient(name);
      try {
        if (opts.head) {
          const p = await blob.getProperties();
          return { body: null, contentType: p.contentType, contentLength: p.contentLength, etag: p.etag, lastModified: p.lastModified };
        }
        const d = await blob.download();
        return { body: (d.readableStreamBody as Readable | undefined) ?? null, contentType: d.contentType, contentLength: d.contentLength, etag: d.etag, lastModified: d.lastModified };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async text(name) {
      try {
        const buf = await client.getBlobClient(name).downloadToBuffer();
        return buf.toString("utf8");
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}
