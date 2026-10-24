// The QuickBooks outbox: Stripe webhooks queue what to post (qbo_outbox), the worker posts it.
//
// - Idempotent: one row per (kind, Stripe id) - invoice and payment and fee by the Stripe invoice id, refund by the
//   Stripe refund id. A repeated webhook only refreshes a row still pending. Each QuickBooks create also carries a
//   requestid made from the same key, and an invoice is looked up by its number first, so a retry after a crash does
//   not make a second document.
// - Order: invoices go before payments, fees and refunds; a payment whose invoice is not posted yet posts it first.
// - Failures are logged and retried after 1 min, 5 min, 30 min, 2 h, 12 h, then daily. Nothing is dropped.
// - QuickBooks not configured (env vars unset): nothing is queued. Configured but not connected: rows wait, untouched,
//   and go once someone connects.
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { backoffMs } from "../crm/outbox.js";
import { getLicensee, type LicenseeRow } from "../licensees/repo.js";
import { qboApi, QboNotConnected, getConnection } from "./client.js";
import { qboConfig, qboConfigured } from "./config.js";
import { loadSettings, postFee, postInvoice, postPayment, postRefund, type PostCtx, type PostResult } from "./posting.js";

type Obj = Record<string, any>;
export type QboKind = "invoice" | "payment" | "refund" | "fee";
export const LEASE_MS = 3 * 60_000;
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? ((v as Obj).id ?? null) : null);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Queues (or refreshes, while still pending) one thing to post. Errors are thrown, so the webhook answers 500 and
 *  Stripe sends it again. */
export async function enqueueQbo(
  db: Q,
  kind: QboKind,
  stripeId: string,
  payload: Obj,
  hints: { licensee_id?: unknown; customer?: unknown; subscription?: unknown } = {},
): Promise<void> {
  const lid = typeof hints.licensee_id === "string" && UUID.test(hints.licensee_id) ? hints.licensee_id : null;
  await db.query(
    `INSERT INTO qbo_outbox (kind, stripe_id, payload, licensee_id)
     VALUES ($1, $2, $3::jsonb, (SELECT id FROM licensees
                                  WHERE ($4::uuid IS NOT NULL AND id = $4::uuid)
                                     OR ($5::text IS NOT NULL AND stripe_customer_id = $5)
                                     OR ($6::text IS NOT NULL AND stripe_subscription_id = $6)
                                  ORDER BY (id = $4::uuid) DESC NULLS LAST LIMIT 1))
     ON CONFLICT (kind, stripe_id) DO UPDATE SET payload = EXCLUDED.payload,
       licensee_id = COALESCE(qbo_outbox.licensee_id, EXCLUDED.licensee_id), updated_at = now()
     WHERE qbo_outbox.status = 'pending'`,
    [kind, stripeId, JSON.stringify(payload), lid, idOf(hints.customer), idOf(hints.subscription)],
  );
}

function invoiceHints(inv: Obj) {
  return {
    licensee_id: inv.parent?.subscription_details?.metadata?.licensee_id ?? inv.metadata?.licensee_id,
    customer: inv.customer,
    subscription: idOf(inv.parent?.subscription_details?.subscription) ?? idOf(inv.subscription),
  };
}

/** Called from the Stripe webhook for every event; queues what QuickBooks needs. Does nothing when QuickBooks is off. */
export async function queueQboForStripeEvent(deps: Pick<Deps, "db"> & Partial<Pick<Deps, "stripe">>, event: Obj): Promise<number> {
  if (!qboConfigured()) return 0;
  const obj = event.data?.object ?? {};
  if (!obj.id) return 0;
  switch (event.type) {
    case "invoice.finalized":
      await enqueueQbo(deps.db, "invoice", obj.id, obj, invoiceHints(obj));
      return 1;
    case "invoice.paid":
      // The invoice too, in case invoice.finalized never arrived (a pending row just gets the newer copy).
      await enqueueQbo(deps.db, "invoice", obj.id, obj, invoiceHints(obj));
      await enqueueQbo(deps.db, "payment", obj.id, obj, invoiceHints(obj));
      await enqueueQbo(deps.db, "fee", obj.id, obj, invoiceHints(obj));
      return 3;
    case "charge.refunded": {
      let refunds: Obj[] = obj.refunds?.data ?? [];
      if (!refunds.length) {
        const stripe = deps.stripe?.() ?? null;
        if (!stripe?.refunds) throw new Error(`charge ${obj.id} was refunded but its refunds cannot be listed (Stripe not configured)`);
        refunds = (await stripe.refunds.list({ charge: obj.id, limit: 100 })).data ?? [];
      }
      const charge = { id: obj.id, customer: idOf(obj.customer), payment_intent: idOf(obj.payment_intent), metadata: obj.metadata ?? {} };
      for (const r of refunds) {
        await enqueueQbo(deps.db, "refund", r.id, { refund: r, charge }, { customer: obj.customer, licensee_id: obj.metadata?.licensee_id });
      }
      return refunds.length;
    }
    default:
      return 0;
  }
}

type OutboxRow = { id: string; kind: QboKind; stripe_id: string; licensee_id: string | null; payload: Obj; attempts: number };

async function licenseeFor(db: Q, row: OutboxRow): Promise<LicenseeRow | null> {
  if (row.licensee_id) {
    const l = await getLicensee(db, row.licensee_id);
    if (l) return l;
  }
  const p = row.kind === "refund" ? row.payload.charge ?? {} : row.payload;
  const hints = row.kind === "refund" ? { licensee_id: p.metadata?.licensee_id, customer: p.customer, subscription: null } : invoiceHints(p);
  const lid = typeof hints.licensee_id === "string" && UUID.test(hints.licensee_id) ? hints.licensee_id : null;
  const r = await db.query(
    `SELECT * FROM licensees
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2::text IS NOT NULL AND stripe_customer_id = $2)
         OR ($3::text IS NOT NULL AND stripe_subscription_id = $3)
      ORDER BY (id = $1::uuid) DESC NULLS LAST LIMIT 1`,
    [lid, idOf(hints.customer), idOf(hints.subscription)],
  );
  const l = (r.rows[0] as LicenseeRow) ?? null;
  if (l) await db.query("UPDATE qbo_outbox SET licensee_id = $2 WHERE id = $1 AND licensee_id IS NULL", [row.id, l.id]);
  return l;
}

async function finish(db: Q, row: { id: string }, res: PostResult, realm: string): Promise<void> {
  await db.query(
    `UPDATE qbo_outbox SET status = $2, qbo_id = $3, qbo_realm_id = $4, note = $5, last_error = NULL, done_at = now(),
            attempts = attempts + 1, updated_at = now() WHERE id = $1`,
    [row.id, res.status, res.qbo_id ?? null, realm, res.note ?? null],
  );
}

/** The QuickBooks invoice for a Stripe invoice: already posted, or posted now (and its own row marked done). */
async function ensureInvoice(ctx: PostCtx, inv: Obj, l: LicenseeRow, now: Date): Promise<string | null> {
  const r = await ctx.db.query("SELECT id, status, qbo_id, qbo_realm_id FROM qbo_outbox WHERE kind = 'invoice' AND stripe_id = $1", [inv.id]);
  const row = r.rows[0];
  if (row?.status === "done" && row.qbo_id && row.qbo_realm_id === ctx.api.realmId) return String(row.qbo_id);
  if (row?.status === "skipped") return null;
  const res = await postInvoice(ctx, inv, l, now);
  if (row) await finish(ctx.db, row, res, ctx.api.realmId);
  else {
    await ctx.db.query(
      `INSERT INTO qbo_outbox (kind, stripe_id, payload, licensee_id, status, qbo_id, qbo_realm_id, note, done_at, attempts)
       VALUES ('invoice', $1, $2::jsonb, $3, $4, $5, $6, $7, now(), 1)
       ON CONFLICT (kind, stripe_id) DO UPDATE SET status = EXCLUDED.status, qbo_id = EXCLUDED.qbo_id,
         qbo_realm_id = EXCLUDED.qbo_realm_id, note = EXCLUDED.note, done_at = now(), last_error = NULL, updated_at = now()`,
      [inv.id, JSON.stringify(inv), l.id, res.status, res.qbo_id ?? null, ctx.api.realmId, res.note ?? null],
    );
  }
  return res.status === "done" ? (res.qbo_id ?? null) : null;
}

async function runRow(ctx: PostCtx, row: OutboxRow, now: Date): Promise<PostResult> {
  const l = await licenseeFor(ctx.db, row);
  if (!l) throw new Error("no Keystone licensee matches this Stripe customer yet");
  switch (row.kind) {
    case "invoice":
      return postInvoice(ctx, row.payload, l, now);
    case "payment": {
      const qboInvoice = await ensureInvoice(ctx, row.payload, l, now);
      if (!qboInvoice) return { status: "skipped", note: "its invoice was not posted (nothing charged)" };
      return postPayment(ctx, row.payload, l, qboInvoice, now);
    }
    case "fee":
      return postFee(ctx, row.payload, now);
    case "refund":
      return postRefund(ctx, row.payload.refund ?? {}, row.payload.charge ?? {}, l, now);
  }
}

export type FlushResult = { tried: number; done: number; skipped: number; failed: number; waiting: boolean };

/** Posts due rows. Returns counts; waiting is true when QuickBooks is configured but not connected. */
export async function flushQboOutbox(deps: Pick<Deps, "db" | "fetch" | "now" | "stripe">, opts: { limit?: number } = {}): Promise<FlushResult> {
  const out: FlushResult = { tried: 0, done: 0, skipped: 0, failed: 0, waiting: false };
  const cfg = qboConfig();
  if (!cfg) return out;
  const conn = await getConnection(deps.db);
  if (!conn) {
    out.waiting = true;
    return out;
  }
  const now = deps.now();
  const leased = await deps.db.query(
    `UPDATE qbo_outbox SET next_attempt_at = $2, updated_at = now()
      WHERE id IN (SELECT id FROM qbo_outbox WHERE status = 'pending' AND next_attempt_at <= $1
                    ORDER BY CASE kind WHEN 'invoice' THEN 0 WHEN 'payment' THEN 1 WHEN 'fee' THEN 2 ELSE 3 END,
                             next_attempt_at, id
                    LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, stripe_id, licensee_id, payload, attempts`,
    [now, new Date(now.getTime() + LEASE_MS), opts.limit ?? 25],
  );
  if (!leased.rows.length) return out;
  const rows = (leased.rows as OutboxRow[]).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  let ctx: PostCtx;
  try {
    ctx = { db: deps.db, api: await qboApi(deps, cfg), settings: await loadSettings(deps.db), stripe: deps.stripe() };
  } catch (err) {
    console.error(`[qbo] cannot reach QuickBooks: ${errText(err)}`);
    await deps.db.query("UPDATE qbo_outbox SET next_attempt_at = $2, last_error = $3, updated_at = now() WHERE id = ANY($1::bigint[])", [
      rows.map((r) => r.id), new Date(deps.now().getTime() + 5 * 60_000), errText(err).slice(0, 1000),
    ]);
    out.waiting = err instanceof QboNotConnected;
    return out;
  }
  for (const row of rows) {
    out.tried++;
    try {
      const res = await runRow(ctx, row, deps.now());
      await finish(deps.db, row, res, ctx.api.realmId);
      if (res.status === "done") out.done++;
      else {
        out.skipped++;
        console.log(`[qbo] ${row.kind} ${row.stripe_id} skipped: ${res.note ?? ""}`);
      }
    } catch (err) {
      out.failed++;
      const failures = Number(row.attempts) + 1;
      const next = new Date(deps.now().getTime() + backoffMs(failures));
      console.error(`[qbo] posting ${row.kind} ${row.stripe_id} failed (attempt ${failures}, next ${next.toISOString()}): ${errText(err)}`);
      await deps.db.query(
        "UPDATE qbo_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1",
        [row.id, errText(err).slice(0, 1000), next],
      );
      if (err instanceof QboNotConnected) {
        out.waiting = true;
        break;
      }
    }
  }
  return out;
}

const ORDER: Record<QboKind, number> = { invoice: 0, payment: 1, fee: 2, refund: 3 };
