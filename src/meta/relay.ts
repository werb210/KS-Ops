// KS_META_LEAD_ADS_v1 - the relay for Facebook lead webhooks.
// Meta sends every webhook for Keystone's app to ONE address (this one). Each brokerage's KS-server registers the
// Facebook Pages it connected (POST /api/licensees/:id/meta-pages). For each delivery, KS-Ops checks Meta's signature,
// splits the entries by Page, and posts each brokerage only its own entries, signed again with the app secret (the
// brokerage checks that signature exactly as it would a direct delivery). KS-Ops never sees a Page token or a lead's
// answers: only lead ids.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Q } from "../db.js";

export type RelayTarget = { licenseeId: string; companyCode: string; serverUrl: string };

export function sign(raw: string | Buffer, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

export function signatureValid(raw: Buffer | undefined, header: unknown, secret: string): boolean {
  if (!raw || !secret || typeof header !== "string") return false;
  const want = Buffer.from(sign(raw, secret));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const PAGE_RE = /^\d{5,25}$/;

/** Saves the Pages a brokerage connected. A Page moves to the brokerage that connected it last. */
export async function registerPages(db: Q, licenseeId: string, pageIds: unknown): Promise<number> {
  const ids = [...new Set((Array.isArray(pageIds) ? pageIds : []).map(String).filter((p) => PAGE_RE.test(p)))].slice(0, 200);
  for (const id of ids) {
    await db.query(
      `INSERT INTO meta_page_routes (page_id, licensee_id, updated_at) VALUES ($1, $2::uuid, now())
       ON CONFLICT (page_id) DO UPDATE SET licensee_id = EXCLUDED.licensee_id, updated_at = now()`,
      [id, licenseeId],
    );
  }
  return ids.length;
}

/** The body's entries grouped by Page id (only Page objects). */
export function entriesByPage(body: any): Map<string, any[]> {
  const out = new Map<string, any[]>();
  if (body?.object !== "page" || !Array.isArray(body.entry)) return out;
  for (const e of body.entry) {
    const id = String(e?.id ?? "");
    if (!PAGE_RE.test(id)) continue;
    out.set(id, [...(out.get(id) ?? []), e]);
  }
  return out;
}

export async function targetsFor(db: Q, pageIds: string[]): Promise<Map<string, RelayTarget>> {
  if (!pageIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT r.page_id, l.id::text AS licensee_id, l.company_code, l.server_url
       FROM meta_page_routes r JOIN licensees l ON l.id = r.licensee_id
      WHERE r.page_id = ANY($1::text[]) AND l.status NOT IN ('cancelled')`,
    [pageIds],
  );
  return new Map(rows.map((r: any) => [String(r.page_id), { licenseeId: r.licensee_id, companyCode: r.company_code, serverUrl: r.server_url }]));
}

export type RelayFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export type RelayResult = { delivered: number; failed: number; unknownPages: string[] };

/**
 * Splits one delivery and passes it on. A brokerage that fails makes the whole delivery fail (500), so Meta sends it
 * again; brokerages that already handled a lead skip it on the retry (they remember lead ids).
 */
export async function relay(db: Q, body: any, secret: string, f: RelayFetch = globalThis.fetch as unknown as RelayFetch): Promise<RelayResult> {
  const byPage = entriesByPage(body);
  const targets = await targetsFor(db, [...byPage.keys()]);
  const byLicensee = new Map<string, { t: RelayTarget; entries: any[] }>();
  const unknownPages: string[] = [];
  for (const [page, entries] of byPage) {
    const t = targets.get(page);
    if (!t) { unknownPages.push(page); continue; }
    const g = byLicensee.get(t.licenseeId) ?? { t, entries: [] };
    g.entries.push(...entries);
    byLicensee.set(t.licenseeId, g);
  }
  let delivered = 0, failed = 0;
  for (const { t, entries } of byLicensee.values()) {
    let base: URL;
    try { base = new URL(t.serverUrl); } catch { failed += 1; continue; }
    if (base.protocol !== "https:") { failed += 1; continue; }
    const raw = JSON.stringify({ object: "page", entry: entries });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await f(new URL("/api/webhooks/meta/leadgen", `https://${base.host}`).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(raw, secret), "X-KS-Tenant": t.companyCode },
        body: raw, signal: ctrl.signal,
      });
      if (r.ok) delivered += 1; else { failed += 1; console.warn(`[meta-relay] ${t.companyCode} answered ${r.status}`); }
    } catch (err) {
      failed += 1;
      console.warn(`[meta-relay] ${t.companyCode} unreachable: ${(err as Error)?.message ?? err}`);
    } finally { clearTimeout(timer); }
  }
  if (unknownPages.length) console.warn(`[meta-relay] leads for Pages no brokerage connected: ${unknownPages.join(", ")}`);
  return { delivered, failed, unknownPages };
}
