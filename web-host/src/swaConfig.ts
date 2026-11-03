// KS_SHARED_HOSTING_v1 - the parts of a build's staticwebapp.config.json the shared web host honours, so the portal and
// client keep the headers they had on Azure Static Web Apps (Content-Security-Policy and so on):
//   globalHeaders        on every response
//   routes[].headers     on responses whose path matches routes[].route (SWA wildcards: "/assets/*", "*.{png,svg}")
//   mimeTypes            extra content types by extension
//   navigationFallback   rewrite (default /index.html) and exclude patterns for SPA routes
// Anything else in the file is ignored. A file that cannot be read as JSON is ignored too (and logged).

export type SwaConfig = {
  globalHeaders: Record<string, string>;
  routes: Array<{ match: RegExp; headers: Record<string, string> }>;
  mimeTypes: Record<string, string>;
  fallbackRewrite: string;
  fallbackExclude: RegExp[];
};

export const EMPTY_CONFIG: SwaConfig = { globalHeaders: {}, routes: [], mimeTypes: {}, fallbackRewrite: "/index.html", fallbackExclude: [] };

/** An SWA route pattern as a regular expression over the request path. */
export function routePattern(pattern: string): RegExp {
  const p = String(pattern).trim();
  const anchored = p.startsWith("/");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") out += ".*";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end < 0) { out += "\\{"; continue; }
      out += "(?:" + p.slice(i + 1, end).split(",").map((x) => x.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`, "i");
}

const headerName = /^[A-Za-z0-9-]{1,100}$/;
function cleanHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (headerName.test(k) && typeof v === "string" && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

export function parseSwaConfig(text: string | null, where = ""): SwaConfig {
  if (!text) return EMPTY_CONFIG;
  let j: any;
  try {
    j = JSON.parse(text);
  } catch (err) {
    console.error("[web-host] staticwebapp.config.json is not JSON; ignored", where, err instanceof Error ? err.message : String(err));
    return EMPTY_CONFIG;
  }
  const routes = Array.isArray(j?.routes)
    ? j.routes.filter((r: any) => typeof r?.route === "string" && r.headers).map((r: any) => ({ match: routePattern(r.route), headers: cleanHeaders(r.headers) }))
    : [];
  const mimeTypes: Record<string, string> = {};
  for (const [ext, type] of Object.entries((j?.mimeTypes ?? {}) as Record<string, unknown>)) {
    if (typeof type === "string" && /^\.?[a-z0-9]+$/i.test(ext)) mimeTypes[(ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()] = type;
  }
  const nf = j?.navigationFallback ?? {};
  const rewrite = typeof nf.rewrite === "string" && /^\/[^?#]*$/.test(nf.rewrite) ? nf.rewrite : "/index.html";
  const exclude = Array.isArray(nf.exclude) ? nf.exclude.filter((x: unknown) => typeof x === "string").map(routePattern) : [];
  return { globalHeaders: cleanHeaders(j?.globalHeaders), routes, mimeTypes, fallbackRewrite: rewrite, fallbackExclude: exclude };
}

/** The headers this config adds for a path: global ones, then each matching route's (later ones win). */
export function headersFor(cfg: SwaConfig, path: string): Record<string, string> {
  const out: Record<string, string> = { ...cfg.globalHeaders };
  for (const r of cfg.routes) if (r.match.test(path)) Object.assign(out, r.headers);
  return out;
}
