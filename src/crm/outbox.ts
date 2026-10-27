// The CRM outbox: pushes to the Keystone CRM on BF-Server are stored first (crm_outbox) and sent by the worker, so
// they survive restarts and BF-Server outages.
//
// - Coalescing: one pending row per (source, external_id). A new push for the same record is merged into it (latest
//   contact/company values win, the furthest stage wins, events are combined, notes are joined), so only the latest
//   state is waiting. Merges are optimistic (the row's version), so two writers never lose each other's changes.
// - Sending: due rows are leased (next_attempt_at moved 2 minutes ahead) so two instances do not send the same row,
//   then posted. A row is marked sent only when nothing was merged into it while it was being sent; otherwise it stays
//   pending and goes again (the endpoint is idempotent).
// - Failures (including 404/503 while BF-Server does not have the endpoint yet) are retried after 1 min, 5 min,
//   30 min, 2 h, 12 h, then daily, for ever; every failure is logged. Nothing is dropped.
// - BF_CRM_KEY not set: enqueue does nothing and the worker sends nothing.
// - KS_OPS_v16_SUPPORT: rows with source "ks_support" are support ticket messages (src/crm/support.ts). They go to
//   /api/ks/support/ingest instead; 404/503 there means "not deployed yet": wait SUPPORT_NOT_AVAILABLE_MS, logged once.
//   A 400/422 (payload rejected) is logged with details and parked after SUPPORT_REJECTED_MAX_ATTEMPTS tries.
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { bfCrmConfigured, CRM_STAGES, pushToBfCrm, type CrmEvent, type CrmPayload, type CrmStage } from "../lib/bfCrm.js";
import {
  noteSupportAvailable, noteSupportNotAvailable, pushSupportToBf, SUPPORT_NOT_AVAILABLE_MS, SUPPORT_PARKED_AT,
  SUPPORT_REJECTED_MAX_ATTEMPTS, SUPPORT_SOURCE, type SupportIngestPayload,
} from "./support.js";

export const MAX_EVENTS = 50;
export const MAX_NOTE = 4000;
export const MAX_SUMMARY = 300;
export const LEASE_MS = 2 * 60_000;
const MAX_TRIES = 25;

const MINUTE = 60_000;
/** Wait after the 1st, 2nd, ... failure; daily after that. */
export const BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 12 * 60 * MINUTE];
export const DAY_MS = 24 * 60 * MINUTE;

export function backoffMs(failures: number): number {
  if (failures < 1) return 0;
  return BACKOFF_MS[failures - 1] ?? DAY_MS;
}

const AUTO_ORDER: CrmStage[] = ["lead", "demo_started", "demo_finished", "signed_up", "paying"];
/** Automatic stages only move forward; "lost" is never sent automatically and never wins a merge. */
export const stageRank = (s: CrmStage | undefined): number => (s ? AUTO_ORDER.indexOf(s) : -1);

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 3) + "..." : s);
const eventKey = (e: CrmEvent) => `${e.type}|${e.at}`;

/** Trims the payload to the endpoint's limits (note 4000, summary 300, 50 events, external_id 100). */
export function normalizePayload(p: CrmPayload): CrmPayload {
  const out: CrmPayload = { source: p.source, external_id: String(p.external_id).slice(0, 100) };
  if (p.stage && (CRM_STAGES as readonly string[]).includes(p.stage)) out.stage = p.stage;
  if (p.contact) out.contact = { ...p.contact };
  if (p.company) out.company = { ...p.company };
  if (p.note && p.note.trim()) out.note = clip(p.note.trim(), MAX_NOTE);
  if (p.events?.length) {
    const seen = new Set<string>();
    const events: CrmEvent[] = [];
    for (const e of p.events) {
      const ev = { type: e.type, at: e.at, summary: clip(String(e.summary ?? "").trim(), MAX_SUMMARY) };
      if (seen.has(eventKey(ev))) continue;
      seen.add(eventKey(ev));
      events.push(ev);
    }
    out.events = events.slice(-MAX_EVENTS);
  }
  // KS_OPS_KB_v1 - a sales follow-up task (title 200, notes 2000).
  if (p.task && p.task.title && p.task.due_at) {
    out.task = {
      title: clip(String(p.task.title).trim(), 200),
      due_at: p.task.due_at,
      ...(p.task.priority ? { priority: p.task.priority } : {}),
      ...(p.task.notes ? { notes: clip(String(p.task.notes).trim(), 2000) } : {}),
    };
  }
  return out;
}

/** Merges a newer push for the same record into the one still waiting. */
export function mergePayload(older: CrmPayload, newer: CrmPayload): CrmPayload {
  const merged: CrmPayload = { source: newer.source, external_id: newer.external_id };
  const stage = stageRank(newer.stage) >= stageRank(older.stage) ? newer.stage ?? older.stage : older.stage;
  if (stage) merged.stage = stage;
  if (older.contact || newer.contact) merged.contact = { ...(older.contact ?? {}), ...(newer.contact ?? {}) };
  if (older.company || newer.company) merged.company = { ...(older.company ?? {}), ...(newer.company ?? {}) };
  const notes = [older.note, newer.note].filter((n): n is string => Boolean(n && n.trim()));
  if (notes.length) merged.note = notes.length === 2 && notes[0] === notes[1] ? notes[0] : notes.join("\n\n");
  const events = [...(older.events ?? []), ...(newer.events ?? [])];
  if (events.length) merged.events = events;
  const task = newer.task ?? older.task; // KS_OPS_KB_v1 - the newest follow-up wins
  if (task) merged.task = task;
  return normalizePayload(merged);
}

type OutboxDeps = { db: Q; now: () => Date };

/**
 * Queues a push (merged into the record's pending one, if any). delayMs holds a new row back (used to send demo
 * progress at most once a minute). Never throws: a database problem is logged.
 */
export async function enqueueCrm(deps: OutboxDeps, payload: CrmPayload, opts: { delayMs?: number } = {}): Promise<boolean> {
  if (!bfCrmConfigured()) return false;
  const p = normalizePayload(payload);
  try {
    const due = new Date(deps.now().getTime() + Math.max(0, opts.delayMs ?? 0));
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      // Someone else changed the pending row between our read and write: wait a moment (a little random) and retry.
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2 + Math.random() * 10 * Math.min(attempt, 5)));
      const cur = await deps.db.query(
        `SELECT id, payload, version, attempts, next_attempt_at FROM crm_outbox
          WHERE source = $1 AND external_id = $2 AND sent_at IS NULL`,
        [p.source, p.external_id],
      );
      const row = cur.rows[0];
      if (!row) {
        const ins = await deps.db.query(
          `INSERT INTO crm_outbox (source, external_id, payload, next_attempt_at) VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (source, external_id) WHERE sent_at IS NULL DO NOTHING RETURNING id`,
          [p.source, p.external_id, JSON.stringify(p), due],
        );
        if (ins.rows.length) return true;
        continue; // someone else inserted it just now: merge into theirs
      }
      const merged = mergePayload(row.payload as CrmPayload, p);
      // A row that has not failed yet goes at the earlier of the two times; one in backoff keeps its wait.
      const current = new Date(row.next_attempt_at);
      const next = Number(row.attempts) > 0 || current.getTime() <= due.getTime() ? current : due;
      const upd = await deps.db.query(
        `UPDATE crm_outbox SET payload = $3::jsonb, version = version + 1, next_attempt_at = $4, updated_at = now()
          WHERE id = $1 AND version = $2 AND sent_at IS NULL RETURNING id`,
        [row.id, row.version, JSON.stringify(merged), next],
      );
      if (upd.rows.length) return true;
    }
    console.error(`[crm] could not queue ${p.source} ${p.external_id}: the pending push kept changing`);
    return false;
  } catch (err) {
    console.error(`[crm] could not queue ${p.source} ${p.external_id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Sends due pushes. Returns how many were tried, sent and failed. */
export async function flushCrmOutbox(
  deps: Pick<Deps, "db" | "fetch" | "now">,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<{ tried: number; sent: number; failed: number }> {
  const out = { tried: 0, sent: 0, failed: 0 };
  if (!bfCrmConfigured()) return out;
  const now = deps.now();
  const leased = await deps.db.query(
    `UPDATE crm_outbox SET next_attempt_at = $2, updated_at = now()
      WHERE id IN (SELECT id FROM crm_outbox WHERE sent_at IS NULL AND next_attempt_at <= $1
                    ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, source, external_id, payload, version, attempts`,
    [now, new Date(now.getTime() + LEASE_MS), opts.limit ?? 50],
  );
  for (const row of leased.rows) {
    out.tried++;
    const isSupport = row.source === SUPPORT_SOURCE;
    const r = isSupport
      ? await pushSupportToBf(deps.fetch, row.payload as SupportIngestPayload, { timeoutMs: opts.timeoutMs })
      : await pushToBfCrm(deps.fetch, row.payload as CrmPayload, { timeoutMs: opts.timeoutMs });
    if (r.ok) {
      if (isSupport) noteSupportAvailable();
      const done = await deps.db.query(
        `UPDATE crm_outbox SET sent_at = $3, attempts = attempts + 1, last_error = NULL, updated_at = now()
          WHERE id = $1 AND version = $2 RETURNING id`,
        [row.id, row.version, deps.now()],
      );
      if (!done.rows.length) {
        // Something was merged in while it was sending: send the newer state on the next run.
        await deps.db.query(`UPDATE crm_outbox SET next_attempt_at = $2, updated_at = now() WHERE id = $1 AND sent_at IS NULL`, [row.id, deps.now()]);
      }
      out.sent++;
      continue;
    }
    out.failed++;
    const failures = Number(row.attempts) + 1;
    // The support ingest not deployed yet (404/503): a long wait and a single log line, not one per row per try.
    const notAvailable = isSupport && "notAvailable" in r && r.notAvailable;
    const rejected = isSupport && "rejected" in r && Boolean(r.rejected);
    const giveUp = rejected && failures >= SUPPORT_REJECTED_MAX_ATTEMPTS;
    const next = giveUp
      ? SUPPORT_PARKED_AT
      : new Date(deps.now().getTime() + (notAvailable ? SUPPORT_NOT_AVAILABLE_MS : backoffMs(failures)));
    if (notAvailable) noteSupportNotAvailable(r.error);
    else if (giveUp) {
      console.error(
        `[support] BF-Server rejected ${row.external_id} ${failures} times; giving up (parked, not retried): ${r.error} ` +
          `payload keys: ${Object.keys((row.payload ?? {}) as object).join(",")}`,
      );
    } else {
      console.warn(
        `[crm] push ${row.source} ${row.external_id} failed (attempt ${failures}, next ${next.toISOString()}): ${r.error}`,
      );
    }
    await deps.db.query(
      `UPDATE crm_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1`,
      [row.id, (giveUp ? `gave_up: ${r.error}` : r.error).slice(0, 1000), next],
    );
  }
  return out;
}
