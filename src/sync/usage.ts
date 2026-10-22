// Usage reports: stored when a licensee's server sends one, or pulled from it (GET {server_url}/api/plan/usage-report).
// One row per licensee and month; a report replaces the stored one only when it was generated at the same time or later.
import { z } from "zod";
import type { Deps } from "../deps.js";
import type { Q } from "../db.js";
import { PERIOD_RE, periodEnd } from "../lib/http.js";
import { getLicensee, opsKeyOf } from "../licensees/repo.js";

const count = z.coerce.number().finite().min(0).transform((n) => Math.round(n));

export const usageReportSchema = z
  .object({
    licensee_id: z.string().optional(),
    period: z.string().regex(PERIOD_RE, "period must look like 2026-10"),
    generated_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "generated_at must be a date and time"),
    plan: z.string().optional(),
    effective_plan: z.string().optional(),
    trial: z.any().optional(),
    seats: count.default(0),
    minutes: count.default(0),
    texts: count.default(0),
    assistant_chats: count.default(0),
    storage_bytes: count.default(0),
    allowances: z.any().optional(),
    overage: z.object({ minutes: count.default(0), texts: count.default(0) }).partial().optional(),
    extra_storage_blocks: count.default(0),
  })
  .passthrough();
export type UsageReport = z.infer<typeof usageReportSchema>;

/** How far ahead of KS-Ops's clock a report's generated_at may be (clock drift). */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * A report dated in the future would win every "latest wins" comparison until that time and could pass as a
 * month's final report early, so generated_at more than 5 minutes ahead of now is refused.
 */
export function futureGeneratedAt(report: Pick<UsageReport, "generated_at">, now: Date): boolean {
  return new Date(report.generated_at).getTime() > now.getTime() + MAX_FUTURE_SKEW_MS;
}

/** A report is final when it was generated after its month ended. */
export function isFinal(period: string, generatedAt: Date | string): boolean {
  return new Date(generatedAt).getTime() >= periodEnd(period).getTime();
}

export type StoreResult = { stored: boolean; period: string };

export async function storeUsageReport(db: Q, licenseeId: string, report: UsageReport, source: "push" | "pull"): Promise<StoreResult> {
  const r = await db.query(
    `INSERT INTO usage_reports (licensee_id, period, generated_at, plan, effective_plan, seats, minutes, texts,
                                assistant_chats, storage_bytes, overage_minutes, overage_texts, extra_storage_blocks,
                                trial, report, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (licensee_id, period) DO UPDATE SET
       generated_at = EXCLUDED.generated_at, plan = EXCLUDED.plan, effective_plan = EXCLUDED.effective_plan,
       seats = EXCLUDED.seats, minutes = EXCLUDED.minutes, texts = EXCLUDED.texts,
       assistant_chats = EXCLUDED.assistant_chats, storage_bytes = EXCLUDED.storage_bytes,
       overage_minutes = EXCLUDED.overage_minutes, overage_texts = EXCLUDED.overage_texts,
       extra_storage_blocks = EXCLUDED.extra_storage_blocks, trial = EXCLUDED.trial, report = EXCLUDED.report,
       source = EXCLUDED.source, updated_at = now()
     WHERE usage_reports.generated_at <= EXCLUDED.generated_at
     RETURNING id`,
    [
      licenseeId,
      report.period,
      new Date(report.generated_at),
      report.plan ?? null,
      report.effective_plan ?? null,
      report.seats,
      report.minutes,
      report.texts,
      report.assistant_chats,
      report.storage_bytes,
      report.overage?.minutes ?? 0,
      report.overage?.texts ?? 0,
      report.extra_storage_blocks,
      report.trial === undefined ? null : JSON.stringify(report.trial),
      JSON.stringify({ ...report, licensee_id: licenseeId }),
      source,
    ],
  );
  return { stored: (r.rowCount ?? r.rows.length) > 0, period: report.period };
}

export type PullResult = { ok: true; stored: boolean; report: UsageReport } | { ok: false; error: string };

export async function pullUsageReport(
  deps: Pick<Deps, "db" | "fetch"> & Partial<Pick<Deps, "now">>,
  licenseeId: string,
  period: string,
): Promise<PullResult> {
  const l = await getLicensee(deps.db, licenseeId);
  if (!l) return { ok: false, error: "licensee_not_found" };
  if (!l.server_url) return { ok: false, error: "no_server_url" };
  const key = opsKeyOf(l);
  if (!key) return { ok: false, error: "no_ops_key" };
  let body: unknown;
  try {
    const res = await deps.fetch(
      `${l.server_url.replace(/\/+$/, "")}/api/plan/usage-report?period=${encodeURIComponent(period)}`,
      { headers: { "X-KS-Ops-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return { ok: false, error: `status ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = usageReportSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: "invalid_report" };
  if (parsed.data.period !== period) return { ok: false, error: "wrong_period" };
  if (futureGeneratedAt(parsed.data, deps.now?.() ?? new Date())) return { ok: false, error: "generated_at_in_future" };
  const stored = await storeUsageReport(deps.db, l.id, parsed.data, "pull");
  return { ok: true, stored: stored.stored, report: parsed.data };
}
