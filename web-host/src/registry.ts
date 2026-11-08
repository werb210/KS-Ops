// KS_SHARED_HOSTING_v1 - which brokerage and which app a host name belongs to, from ks_tenants in ks_control (read with
// ks_control_reader through KS_CONTROL_DATABASE_URL). The whole host list is read at once and kept for 60 seconds; when a
// refresh fails the last good list is kept (and the failure logged), so a database blip never takes the sites down.

export type App = "portal" | "client";
// KS_SHARED_APP_BUILD_v1 - urls: the brokerage's own addresses, for /ks-config.js (only when the registry row has them).
export type SiteUrls = { server_url: string; portal_url: string; client_url: string };
export type Site = { code: string; app: App; status: string; urls?: SiteUrls };
export type Query = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Host names as the registry stores them: lowercase, no port. */
export function normalHost(raw: string | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

const httpsOf = (hosts: string[] | null | undefined) => (hosts && hosts[0] ? `https://${normalHost(hosts[0])}` : "");

export function buildHostMap(rows: Array<{ code: string; status: string; portal_hosts: string[] | null; client_hosts: string[] | null; api_hosts?: string[] | null }>): Map<string, Site> {
  const map = new Map<string, Site>();
  for (const r of rows) {
    const urls = r.api_hosts && r.api_hosts.length ? { urls: { server_url: httpsOf(r.api_hosts), portal_url: httpsOf(r.portal_hosts), client_url: httpsOf(r.client_hosts) } } : {};
    for (const h of r.portal_hosts ?? []) map.set(normalHost(h), { code: r.code, app: "portal", status: r.status, ...urls });
    for (const h of r.client_hosts ?? []) if (!map.has(normalHost(h))) map.set(normalHost(h), { code: r.code, app: "client", status: r.status, ...urls });
  }
  return map;
}

export type Registry = { lookup(host: string): Promise<Site | null> };

export function cachedRegistry(q: Query, opts: { ttlMs?: number; now?: () => number } = {}): Registry & { clear(): void } {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  let map: Map<string, Site> | null = null;
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  const refresh = async () => {
    try {
      const r = await q.query("SELECT code, status, portal_hosts, client_hosts, api_hosts FROM ks_tenants", []);
      map = buildHostMap(r.rows);
      loadedAt = now();
    } catch (err) {
      console.error("[web-host] registry not read", err instanceof Error ? err.message : String(err));
      if (!map) throw err;
      loadedAt = now() - ttl + 5_000; // keep the last good list, try again in 5 seconds
    }
  };

  return {
    async lookup(host: string) {
      if (!map || now() - loadedAt >= ttl) {
        loading ??= refresh().finally(() => { loading = null; });
        await loading;
      }
      return map!.get(normalHost(host)) ?? null;
    },
    clear() {
      map = null;
      loadedAt = 0;
    },
  };
}
