// KS_SHARED_HOSTING_v1 - the shared web host (ks-shared-web). For each request it finds the brokerage and app by the
// Host header (ks_tenants.portal_hosts -> portal, client_hosts -> client) and streams the file from blob
// sites/<code>/<app>/<path>, falling back to index.html for SPA routes.
//   - hashed build assets (assets/index-3f9a1c2b.js) are cached for a year; index.html and everything else: no-cache
//   - content types by extension (and the build's staticwebapp.config.json mimeTypes)
//   - the build's staticwebapp.config.json headers (CSP and so on), as on Azure Static Web Apps
//   - an unknown host gets a plain 404 page; a closed brokerage a plain 410 page
//   - paths are decoded once and checked segment by segment: "..", ".", backslashes and NUL are refused, so a request
//     can never leave its own sites/<code>/<app>/ folder
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Registry, Site } from "./registry.js";
import type { SiteStore } from "./store.js";
import { EMPTY_CONFIG, headersFor, parseSwaConfig, type SwaConfig } from "./swaConfig.js";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

export const YEAR = "public, max-age=31536000, immutable";
export const NO_CACHE = "no-cache";

/** A content-hashed build file (Vite: name-<8+ chars of hash>.ext), safe to cache for a year. */
export function isHashedAsset(path: string): boolean {
  return /[.-][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|map|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico|wasm)$/i.test(path);
}

const extOf = (path: string) => {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot).toLowerCase() : "";
};

export type SafePath = { ok: true; rel: string } | { ok: false };

/** The request path as a path inside the site folder ("" for the root), or not ok when it tries to leave it. */
export function safePath(rawUrl: string | undefined): SafePath {
  const raw = String(rawUrl ?? "/").split("?")[0].split("#")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false };
  }
  if (/[\\\0]/.test(decoded) || !decoded.startsWith("/")) return { ok: false };
  const parts = decoded.split("/").slice(1);
  if (parts.some((p) => p === ".." || p === ".")) return { ok: false };
  // Empty segments ("//") are dropped; the result never starts with a slash.
  return { ok: true, rel: parts.filter((p, i) => p !== "" || i === parts.length - 1).join("/") };
}

export type HostDeps = {
  registry: Registry;
  store: SiteStore;
  now?: () => number;
  /** How long a site's staticwebapp.config.json is kept (default 60 s). */
  configTtlMs?: number;
};

function page(res: ServerResponse, status: number, title: string, text: string, head: boolean) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

export function createHandler(deps: HostDeps) {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.configTtlMs ?? 60_000;
  const configs = new Map<string, { at: number; cfg: SwaConfig }>();

  async function configFor(site: Site): Promise<SwaConfig> {
    const key = `${site.code}/${site.app}`;
    const hit = configs.get(key);
    if (hit && now() - hit.at < ttl) return hit.cfg;
    let cfg = EMPTY_CONFIG;
    try {
      cfg = parseSwaConfig(await deps.store.text(`${key}/staticwebapp.config.json`), key);
    } catch (err) {
      console.error("[web-host] staticwebapp.config.json not read", key, err instanceof Error ? err.message : String(err));
      if (hit) cfg = hit.cfg;
    }
    configs.set(key, { at: now(), cfg });
    return cfg;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const head = req.method === "HEAD";
    try {
      if (req.method !== "GET" && !head) {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method not allowed");
        return;
      }
      const url = String(req.url ?? "/");
      if (url === "/healthz" || url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(head ? undefined : JSON.stringify({ status: "ok" }));
        return;
      }

      const site = await deps.registry.lookup(String(req.headers.host ?? ""));
      if (!site) return page(res, 404, "Not found", "There is no Keystone site at this address.", head);
      if (site.status === "cancelled") return page(res, 410, "Closed", "This Keystone site has closed.", head);

      const p = safePath(url);
      if (!p.ok) return page(res, 400, "Bad request", "That address is not valid.", head);
      if (/(^|\/)staticwebapp\.config\.json$/i.test(p.rel)) return page(res, 404, "Not found", "There is no such page.", head);

      const cfg = await configFor(site);
      const base = `${site.code}/${site.app}/`;
      const wanted = p.rel === "" || p.rel.endsWith("/") ? `${p.rel}index.html` : p.rel;
      let servedPath = `/${wanted}`;
      let file = await deps.store.get(base + wanted, { head });
      if (!file) {
        // SPA routes: a path that is not a file (no extension) gets the app's index.html, unless the build excludes it.
        const routeLike = !extOf(wanted) || wanted.endsWith(".html");
        const excluded = cfg.fallbackExclude.some((re) => re.test(`/${p.rel}`));
        if (routeLike && !excluded) {
          servedPath = cfg.fallbackRewrite;
          file = await deps.store.get(base + cfg.fallbackRewrite.replace(/^\//, ""), { head });
        }
      }
      if (!file) return page(res, 404, "Not found", "There is no such page.", head);

      const ext = extOf(servedPath);
      const headers: Record<string, string | number> = {
        "Content-Type": cfg.mimeTypes[ext] ?? MIME[ext] ?? file.contentType ?? "application/octet-stream",
        "Cache-Control": isHashedAsset(servedPath) ? YEAR : NO_CACHE,
        "X-Content-Type-Options": "nosniff",
        ...headersFor(cfg, `/${p.rel}`),
      };
      if (file.etag) headers.ETag = file.etag;
      if (file.lastModified) headers["Last-Modified"] = file.lastModified.toUTCString();
      if (file.etag && req.headers["if-none-match"] === file.etag) {
        file.body?.destroy();
        res.writeHead(304, headers);
        res.end();
        return;
      }
      if (typeof file.contentLength === "number") headers["Content-Length"] = file.contentLength;
      res.writeHead(200, headers);
      if (head || !file.body) {
        file.body?.destroy();
        res.end();
        return;
      }
      await pipeline(file.body, res);
    } catch (err) {
      console.error("[web-host] request failed", req.headers.host, req.url, err instanceof Error ? err.message : String(err));
      if (!res.headersSent) page(res, 503, "Try again shortly", "This site could not be loaded just now.", head);
      else res.destroy();
    }
  };
}
