// Calls to the shared demo server (KS-server with DEMO_MODE=true), with X-KS-Ops-Key = KS_DEMO_OPS_KEY.
//   POST   {KS_DEMO_SERVER_URL}/api/demo/ops/sessions        { ops_session_id, name, email, company, expires_at }
//   DELETE {KS_DEMO_SERVER_URL}/api/demo/ops/sessions/:id
import { demoOpsKey, demoServerUrl } from "./config.js";

export type DemoServerSession = { session_id: string; staff_token: string; client_code: string; client_url: string | null; expires_at: string };

export type OpenResult = { ok: true; session: DemoServerSession } | { ok: false; status: number | null; error: string };

export async function openServerSession(
  fetchImpl: typeof fetch,
  s: { id: string; name: string; email: string; company: string; expires_at: Date },
): Promise<OpenResult> {
  try {
    const r = await fetchImpl(`${demoServerUrl()}/api/demo/ops/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": demoOpsKey() },
      body: JSON.stringify({ ops_session_id: s.id, name: s.name, email: s.email, company: s.company, expires_at: new Date(s.expires_at).toISOString() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 410) return { ok: false, status: 410, error: "demo_session_ended" };
    if (!r.ok) return { ok: false, status: r.status, error: `status_${r.status}` };
    const body = (await r.json()) as DemoServerSession;
    if (!body?.staff_token || !body?.session_id) return { ok: false, status: r.status, error: "bad_reply" };
    return { ok: true, session: body };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function wipeServerSession(fetchImpl: typeof fetch, opsSessionId: string): Promise<boolean> {
  try {
    const r = await fetchImpl(`${demoServerUrl()}/api/demo/ops/sessions/${encodeURIComponent(opsSessionId)}`, {
      method: "DELETE",
      headers: { "X-KS-Ops-Key": demoOpsKey() },
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok || r.status === 404;
  } catch (err) {
    console.warn("[demo] wipe call failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}
