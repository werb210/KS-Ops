// KS_SHARED_HOSTING_v1 - the shared KS-server's two service routes, authorised by X-KS-Ops-Service-Key:
//   POST /api/ops/tenants/reload          clears its 60-second registry cache
//   POST /api/ops/tenants/:code/migrate   runs its migrations against that brokerage's database now
import { opsServiceKey, sharedServerUrl } from "./config.js";

export type ServerCall = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: string; message: string };

async function post(fetchImpl: typeof fetch, path: string, e: NodeJS.ProcessEnv, timeoutMs: number): Promise<ServerCall> {
  const base = sharedServerUrl(e);
  const key = opsServiceKey(e);
  if (!base || !key) return { ok: false, status: 0, error: "not_configured", message: "KS_SHARED_SERVER_URL (https) and KS_OPS_SERVICE_KEY must be set on KS-Ops." };
  let r: Response;
  try {
    r = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Service-Key": key, "X-KS-Ops-User": "ks-ops provisioning" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tenants] shared server call failed", { path, message });
    return { ok: false, status: 0, error: "unreachable", message: `the shared server did not answer (${message})` };
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.ok) return { ok: true, status: r.status, body };
  const error = String(body.error ?? `http_${r.status}`);
  console.error("[tenants] shared server refused", { path, status: r.status, error });
  return { ok: false, status: r.status, error, message: `the shared server answered ${r.status} ${error}${body.message ? `: ${String(body.message)}` : ""}` };
}

export function reloadTenants(fetchImpl: typeof fetch, e: NodeJS.ProcessEnv = process.env): Promise<ServerCall> {
  return post(fetchImpl, "/api/ops/tenants/reload", e, 15_000);
}

export function migrateTenant(fetchImpl: typeof fetch, code: string, e: NodeJS.ProcessEnv = process.env): Promise<ServerCall> {
  return post(fetchImpl, `/api/ops/tenants/${encodeURIComponent(code)}/migrate`, e, 10 * 60_000);
}
