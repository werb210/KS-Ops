// The Keystone CRM on BF-Server (KS silo): POST {BF_CRM_URL}/api/ks/crm/upsert with X-KS-Ops-Key. Configured by:
//   BF_CRM_URL   BF-Server's address (default https://server.boreal.financial)
//   BF_CRM_KEY   the same value as BF-Server's KS_OPS_CRM_KEY
// Without BF_CRM_KEY nothing is queued or sent (a warning is logged once at startup). Pushes go through the outbox
// (src/crm/outbox.ts) so they survive restarts and BF-Server outages; this client never throws.
import { env } from "../config.js";

export const DEFAULT_BF_CRM_URL = "https://server.boreal.financial";
export const CRM_TIMEOUT_MS = 15_000;

export const CRM_STAGES = ["lead", "demo_started", "demo_finished", "signed_up", "paying", "lost"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];
export type CrmSource = "demo_signup" | "website_signup" | "licensee";
export type CrmEventType = "demo_opened" | "demo_step" | "demo_completed" | "signup" | "payment" | "status_change";
export type CrmEvent = { type: CrmEventType; at: string; summary: string };

export type CrmPayload = {
  source: CrmSource;
  external_id: string;
  stage?: CrmStage;
  contact?: { name?: string | null; email?: string | null; phone?: string | null; title?: string | null };
  company?: {
    name?: string | null; website?: string | null; company_code?: string | null; plan?: string | null;
    seats?: number | null; status?: string | null;
    /** KS_OPS_v16_SUPPORT - the licensee's support level (email | priority | premium | dedicated). */
    support_level?: string | null;
  };
  note?: string;
  events?: CrmEvent[];
};

export function bfCrmUrl(e: NodeJS.ProcessEnv = process.env): string {
  return (env("BF_CRM_URL", e) || DEFAULT_BF_CRM_URL).replace(/\/+$/, "");
}

export function bfCrmKey(e: NodeJS.ProcessEnv = process.env): string {
  return env("BF_CRM_KEY", e);
}

export function bfCrmConfigured(e: NodeJS.ProcessEnv = process.env): boolean {
  return bfCrmKey(e) !== "";
}

export type CrmPushResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number | null; error: string; skipped?: boolean };

/** Sends one upsert. Never throws: a failure comes back as { ok: false, error }. */
export async function pushToBfCrm(
  fetchImpl: typeof fetch,
  payload: CrmPayload,
  opts: { timeoutMs?: number } = {},
): Promise<CrmPushResult> {
  if (!bfCrmConfigured()) return { ok: false, status: null, error: "bf_crm_not_configured", skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CRM_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${bfCrmUrl()}/api/ks/crm/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": bfCrmKey() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await r.json()) as Record<string, unknown>;
    } catch {
      /* body was not JSON */
    }
    if (r.ok) return { ok: true, status: r.status, body };
    const code = typeof body.error === "string" ? ` ${body.error}` : "";
    const detail = body.errors ? ` ${JSON.stringify(body.errors).slice(0, 300)}` : "";
    return { ok: false, status: r.status, error: `bf_crm_status_${r.status}${code}${detail}` };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, status: null, error: "bf_crm_timeout" };
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
