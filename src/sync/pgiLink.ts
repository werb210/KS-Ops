// PGI referrals: every licensee is a referral source of the insurance partner (Boreal Insurance, BI-Server), paid a
// referral fee of 20% of the partner's commission on each bound policy. On every plan.
//
// For a live licensee (trial, active, past_due) with a server address and an ops key, KS-Ops:
//   1. POST {BI_SERVER_URL}/api/v1/bi/ks/ops/licensees  (X-BI-Keystone-Key: BI_KEYSTONE_OPS_KEY)
//      { ks_licensee_id, company_code, company_name, legal_name, contact_*, country, server_url, issue_credentials: true }
//      -> { referral_source_id, credentials: { api_key, callback_secret } }   (new credentials each time; old ones revoked)
//   2. PUT {server_url}/api/pgi/link  (X-KS-Ops-Key)  { bi_server_url, referral_source_id, api_key, callback_secret }
// KS-Ops never stores the credentials: if step 2 fails, the next attempt issues fresh ones. A suspended or cancelled
// licensee is switched off at the partner (PATCH .../ops/licensees/:id { active: false }); reactivating links again.
// The worker (every 5 minutes) links anyone due, which is also the backfill for licensees that existed before this.
import type { Deps } from "../deps.js";
import { env } from "../config.js";
import { getLicensee, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";

export const PGI_RETRY_MINUTES = 15;
const LIVE = ["trial", "active", "past_due"];
const STOPPED = ["suspended", "cancelled"];

export type PgiLinkResult = { ok: true; action: "linked" | "disabled" } | { ok: false; error: string };

export function biConfig(e: NodeJS.ProcessEnv = process.env): { url: string; key: string } | null {
  const url = env("BI_SERVER_URL", e).replace(/\/+$/, "");
  const key = env("BI_KEYSTONE_OPS_KEY", e);
  return url && key ? { url, key } : null;
}

type L = LicenseeRow & { pgi_source_id?: string | null; pgi_link_status?: string; pgi_linked_server_url?: string | null };

async function fail(deps: Pick<Deps, "db" | "now">, id: string, error: string): Promise<PgiLinkResult> {
  const next = new Date(deps.now().getTime() + PGI_RETRY_MINUTES * 60_000);
  await deps.db.query(
    `UPDATE licensees SET pgi_link_status = CASE WHEN pgi_link_status = 'linked' THEN 'linked' ELSE 'error' END,
            pgi_link_error = $2, pgi_link_attempts = pgi_link_attempts + 1, pgi_link_next_at = $3, updated_at = now()
      WHERE id = $1`,
    [id, error.slice(0, 500), next],
  );
  return { ok: false, error };
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch (err) { return { parse_error: String(err).slice(0, 120) }; }
}

/** Creates or refreshes the licensee's referral source at the partner and pushes the credentials to its server. */
export async function linkPgi(deps: Pick<Deps, "db" | "fetch" | "now">, licenseeId: string): Promise<PgiLinkResult> {
  const l = (await getLicensee(deps.db, licenseeId)) as L | null;
  if (!l) return { ok: false, error: "licensee_not_found" };
  const bi = biConfig();
  if (!bi) return fail(deps, l.id, "bi_not_configured");

  if (STOPPED.includes(l.status)) {
    try {
      const res = await deps.fetch(`${bi.url}/api/v1/bi/ks/ops/licensees/${encodeURIComponent(l.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-BI-Keystone-Key": bi.key },
        body: JSON.stringify({ active: false }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok && res.status !== 404) return fail(deps, l.id, `partner status ${res.status}`);
    } catch (err) {
      return fail(deps, l.id, err instanceof Error ? err.message : String(err));
    }
    await deps.db.query(
      `UPDATE licensees SET pgi_link_status = 'disabled', pgi_link_error = NULL, pgi_link_attempts = 0, pgi_link_next_at = NULL,
              updated_at = now() WHERE id = $1`,
      [l.id],
    );
    return { ok: true, action: "disabled" };
  }

  if (!LIVE.includes(l.status)) return fail(deps, l.id, "licensee_not_live");
  if (!l.server_url) return fail(deps, l.id, "no_server_url");
  const opsKey = opsKeyOf(l);
  if (!opsKey) return fail(deps, l.id, "no_ops_key");

  let source: any;
  try {
    const res = await deps.fetch(`${bi.url}/api/v1/bi/ks/ops/licensees`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BI-Keystone-Key": bi.key },
      body: JSON.stringify({
        ks_licensee_id: l.id, company_code: l.company_code, company_name: l.company_name, legal_name: l.legal_name,
        contact_name: l.contact_name, contact_email: l.contact_email, contact_phone: l.contact_phone, country: l.country,
        server_url: l.server_url, issue_credentials: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    source = await readJson(res);
    if (!res.ok) return fail(deps, l.id, `partner status ${res.status}: ${String(source?.error ?? "").slice(0, 120)}`);
  } catch (err) {
    return fail(deps, l.id, err instanceof Error ? err.message : String(err));
  }
  const creds = source?.credentials;
  if (!source?.referral_source_id || !creds?.api_key || !creds?.callback_secret) return fail(deps, l.id, "partner_returned_no_credentials");

  try {
    const res = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/pgi/link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": opsKey, "X-KS-Ops-User": "ks-ops pgi-link" },
      body: JSON.stringify({ bi_server_url: bi.url, referral_source_id: source.referral_source_id, api_key: creds.api_key, callback_secret: creds.callback_secret }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch((e: unknown) => String(e));
      return fail(deps, l.id, `licensee server status ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
  } catch (err) {
    return fail(deps, l.id, err instanceof Error ? err.message : String(err));
  }
  await deps.db.query(
    `UPDATE licensees SET pgi_source_id = $2, pgi_link_status = 'linked', pgi_link_error = NULL, pgi_link_attempts = 0,
            pgi_link_next_at = NULL, pgi_linked_at = now(), pgi_linked_server_url = $3, updated_at = now()
      WHERE id = $1`,
    [l.id, String(source.referral_source_id), l.server_url],
  );
  return { ok: true, action: "linked" };
}

/**
 * The worker: link every live licensee not linked yet (or whose server moved), and switch off stopped ones. Also the
 * backfill for licensees created before PGI referrals existed.
 */
export async function syncPgiLinks(deps: Pick<Deps, "db" | "fetch" | "now">): Promise<{ tried: number; linked: number; disabled: number }> {
  if (!biConfig()) return { tried: 0, linked: 0, disabled: 0 };
  const r = await deps.db.query(
    `SELECT id FROM licensees
      WHERE server_url IS NOT NULL AND ops_key_encrypted IS NOT NULL
        AND ((status IN ('trial','active','past_due') AND (pgi_link_status <> 'linked' OR pgi_linked_server_url IS DISTINCT FROM server_url))
          OR (status IN ('suspended','cancelled') AND pgi_link_status = 'linked'))
        AND (pgi_link_next_at IS NULL OR pgi_link_next_at <= $1)
      ORDER BY pgi_link_next_at NULLS FIRST
      LIMIT 50`,
    [deps.now()],
  );
  let linked = 0;
  let disabled = 0;
  for (const row of r.rows) {
    const res = await linkPgi(deps, String(row.id));
    if (res.ok && res.action === "linked") linked += 1;
    else if (res.ok) disabled += 1;
    else console.warn(`[pgi-link] licensee ${row.id}: ${res.error}`);
  }
  return { tried: r.rows.length, linked, disabled };
}

/** Staff "link everyone again now": every live licensee is due on the next pass. */
export async function queuePgiBackfill(deps: Pick<Deps, "db">): Promise<number> {
  const r = await deps.db.query(
    `UPDATE licensees SET pgi_link_status = CASE WHEN pgi_link_status = 'linked' THEN 'pending' ELSE pgi_link_status END,
            pgi_link_next_at = NULL, updated_at = now()
      WHERE status IN ('trial','active','past_due') RETURNING id`,
  );
  return r.rowCount ?? r.rows.length;
}
