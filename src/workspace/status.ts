// KS_OPS_WORKSPACE_APPS - what /ops/provisioning shows about a licensee's Microsoft 365 and Google Workspace: asked of
// its own KS-server (GET /api/provision/connections, with the ops key). Never names, email addresses or tokens.
import type { Deps } from "../deps.js";
import { opsKeyOf, type LicenseeRow } from "../licensees/repo.js";

export type WorkspaceSummary =
  | {
      ok: true;
      microsoft: { state: string; connected: boolean; headline: string; domain: string | null; staff_connected: number; last_sync_at: string | null; missing_permissions: string[] };
      google: { state: string; connected: boolean; headline: string; domains: string[]; staff_connected: number; last_sync_at: string | null };
      broker: boolean;
    }
  | { ok: false; message: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function workspaceSummary(deps: Pick<Deps, "fetch">, l: Pick<LicenseeRow, "id" | "server_url" | "ops_key_encrypted">): Promise<WorkspaceSummary> {
  if (!l.server_url) return { ok: false, message: "The licensee's server is not set up yet." };
  const key = opsKeyOf(l);
  if (!key) return { ok: false, message: "No ops key for this licensee, so its server cannot be asked." };
  try {
    const r = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/provision/connections`, {
      headers: { "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops provisioning" },
      signal: AbortSignal.timeout(8_000),
    });
    if (r.status === 404) return { ok: false, message: "This licensee's server is on an older version that cannot report it yet." };
    if (!r.ok) return { ok: false, message: `The licensee's server answered ${r.status}.` };
    const j = (await r.json()) as Record<string, any>;
    const m = (j.microsoft ?? {}) as Record<string, unknown>;
    const g = (j.google ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      microsoft: {
        state: str(m.state) || "unknown",
        connected: m.state === "connected" || m.state === "partial",
        headline: str(m.headline),
        domain: str(m.domain) || null,
        staff_connected: num(m.staff_connected),
        last_sync_at: str(m.last_sync_at) || null,
        missing_permissions: Array.isArray(m.missing_permissions) ? (m.missing_permissions as unknown[]).map(String) : [],
      },
      google: {
        state: str(g.state) || "unknown",
        connected: g.state === "connected" || g.state === "needs_reconnect",
        headline: str(g.headline),
        domains: Array.isArray(g.domains) ? (g.domains as unknown[]).map(String) : [],
        staff_connected: num(g.staff_connected),
        last_sync_at: str(g.last_sync_at) || null,
      },
      broker: j.broker === true,
    };
  } catch (err) {
    return { ok: false, message: `Could not reach the licensee's server: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
}
