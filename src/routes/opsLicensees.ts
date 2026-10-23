// Staff API: licensees, their ops key, usage, invoices and billing. Mounted under /api/ops behind requireStaff.
import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { createCheckout, invoicePreview, liveSubscriptionStatus, requireStripe, syncSubscription } from "../billing/billing.js";
import { h, parseBody, PERIOD_RE, periodOf, UUID_RE } from "../lib/http.js";
import {
  audit, codeTaken, EncryptionNotConfigured, getLicensee, insertLicensee, isUniqueViolation, markPurged, rotateOpsKey,
  staffView, type LicenseeRow,
} from "../licensees/repo.js";
import { crossFieldErrors, staffCreateSchema, staffPatchSchema, STATUSES } from "../licensees/validation.js";
import { MIN_SEATS, PLAN_NAMES, dollars, monthlyCharge, onboardingFeeCents } from "../pricing.js";
import { isServiceStatus, pushPlan, recordPlanChange } from "../sync/planPush.js";
import { isFinal, pullUsageReport } from "../sync/usage.js";
import { biConfig, linkPgi, queuePgiBackfill } from "../sync/pgiLink.js";

export const OPS_KEY_MESSAGE =
  "Copy this key now - it will not be shown again. Set it as KS_OPS_KEY in the licensee's server settings.";

const PATCH_COLUMNS = [
  "company_name", "legal_name", "company_code", "contact_name", "contact_email", "contact_phone", "country",
  "province_state", "mailing_address", "website", "status", "plan", "billing_interval", "support_level", "seats",
  "extra_storage_blocks", "server_url", "client_url", "portal_url", "logo_url", "primary_color", "assistant_name",
  "onboarding_fee_paid",
] as const;

function pricingView(l: LicenseeRow) {
  const c = monthlyCharge(l);
  return {
    billable_seats: c.billable_seats,
    seat_price: dollars(c.seat_price_cents),
    seats: dollars(c.seats_cents),
    support: dollars(c.support_cents),
    storage: dollars(c.storage_cents),
    mrr: dollars(c.recurring_cents),
    onboarding_fee: dollars(onboardingFeeCents(l.plan)),
  };
}

export function opsLicenseesRouter(deps: Deps): Router {
  const router = Router();

  const load = async (id: string) => (UUID_RE.test(id) ? getLicensee(deps.db, id) : null);
  const notFound = { error: "not_found", message: "That licensee does not exist." };

  router.get(
    "/licensees",
    h(async (req, res) => {
      const status = String(req.query.status ?? "");
      const q = String(req.query.q ?? "").trim();
      const r = await deps.db.query(
        `SELECT l.*, ur.period AS last_report_period, ur.generated_at AS last_report_generated_at,
                ur.received_at AS last_report_received_at, ur.minutes AS last_report_minutes,
                ur.texts AS last_report_texts, ur.seats AS last_report_seats, ur.trial AS last_report_trial
           FROM licensees l
           LEFT JOIN LATERAL (
             SELECT period, generated_at, received_at, minutes, texts, seats, trial
               FROM usage_reports WHERE licensee_id = l.id ORDER BY period DESC LIMIT 1
           ) ur ON true
          WHERE ($1 = '' OR l.status = $1)
            AND ($2 = '' OR l.company_name ILIKE '%' || $2 || '%' OR l.company_code ILIKE '%' || $2 || '%'
                 OR l.contact_email ILIKE '%' || $2 || '%')
          ORDER BY lower(l.company_name)`,
        [(STATUSES as readonly string[]).includes(status) ? status : "", q],
      );
      res.json({
        licensees: r.rows.map((row) => {
          const v = staffView(row as LicenseeRow);
          return {
            id: v.id,
            company_name: v.company_name,
            company_code: v.company_code,
            plan: v.plan,
            billing_interval: v.billing_interval,
            support_level: v.support_level,
            seats: v.seats,
            extra_storage_blocks: v.extra_storage_blocks,
            status: v.status,
            mrr: v.mrr,
            trial: row.last_report_trial ?? null,
            plan_sync_status: v.plan_sync_status,
            server_url: v.server_url,
            cancelled_at: v.cancelled_at ?? null,
            data_purge_on: v.data_purge_on,
            purged_at: v.purged_at ?? null,
            created_at: v.created_at,
            last_report: row.last_report_period
              ? {
                  period: row.last_report_period,
                  generated_at: row.last_report_generated_at,
                  received_at: row.last_report_received_at,
                  seats: row.last_report_seats,
                  minutes: row.last_report_minutes,
                  texts: row.last_report_texts,
                }
              : null,
          };
        }),
      });
    }),
  );

  router.post(
    "/licensees",
    h(async (req, res) => {
      const parsed = parseBody(staffCreateSchema, req.body, crossFieldErrors);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      if (await codeTaken(deps.db, v.company_code)) return res.status(409).json({ errors: { company_code: "taken" } });
      let l: LicenseeRow;
      try {
        l = await insertLicensee(deps.db, { ...v, status: v.status ?? "pending_payment", source: "staff" });
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ errors: { company_code: "taken" } });
        throw err;
      }
      // The plan is pushed once the licensee's server is known and reachable (the retry worker keeps trying).
      await deps.db.query("UPDATE licensees SET plan_sync_status = 'pending_sync' WHERE id = $1", [l.id]);
      let opsKey: string | null = null;
      try {
        opsKey = await rotateOpsKey(deps.db, l.id);
      } catch (err) {
        if (!(err instanceof EncryptionNotConfigured)) throw err;
      }
      await audit(deps.db, actorOf(req), "licensee.create", l.id, { company_code: l.company_code, plan: l.plan, seats: l.seats });
      const fresh = (await getLicensee(deps.db, l.id))!;
      // The body carries the ops key: never cached by a browser or proxy.
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({
        licensee: staffView(fresh),
        ops_key: opsKey,
        message: opsKey ? OPS_KEY_MESSAGE : "No ops key was made because OPS_ENCRYPTION_KEY is not set.",
      });
    }),
  );

  router.get(
    "/licensees/:id",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const [usage, invoices, tickets, notes, changes, requests, auditRows] = await Promise.all([
        deps.db.query(
          `SELECT period, generated_at, received_at, source, plan, effective_plan, seats, minutes, texts, assistant_chats,
                  storage_bytes, overage_minutes, overage_texts, extra_storage_blocks, trial, overage_billed_at,
                  overage_invoice_id
             FROM usage_reports WHERE licensee_id = $1 ORDER BY period DESC LIMIT 24`,
          [l.id],
        ),
        deps.db.query("SELECT * FROM invoices WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 50", [l.id]),
        deps.db.query(
          `SELECT t.*, (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
             FROM tickets t WHERE t.licensee_id = $1 ORDER BY t.updated_at DESC LIMIT 50`,
          [l.id],
        ),
        deps.db.query("SELECT * FROM notes WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 100", [l.id]),
        deps.db.query("SELECT * FROM plan_changes WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 50", [l.id]),
        deps.db.query("SELECT * FROM requests WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 50", [l.id]),
        deps.db.query("SELECT * FROM staff_audit WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 50", [l.id]),
      ]);
      res.json({
        licensee: staffView(l),
        pricing: pricingView(l),
        usage: usage.rows.map((u) => ({ ...u, final: isFinal(u.period, u.generated_at) })),
        invoices: invoices.rows,
        tickets: tickets.rows,
        notes: notes.rows,
        plan_changes: changes.rows,
        requests: requests.rows,
        audit: auditRows.rows,
      });
    }),
  );

  router.patch(
    "/licensees/:id",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const parsed = parseBody(staffPatchSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data as Record<string, unknown>;
      const changed = PATCH_COLUMNS.filter((c) => v[c] !== undefined && v[c] !== (l as Record<string, unknown>)[c]);
      if (!changed.length) return res.json({ licensee: staffView(l), plan_push: null, billing_sync: null });
      const next = { ...l, ...Object.fromEntries(changed.map((c) => [c, v[c]])) } as LicenseeRow;
      if (next.seats < MIN_SEATS[next.plan]) {
        return res.status(400).json({ errors: { seats: `The ${PLAN_NAMES[next.plan]} plan needs at least ${MIN_SEATS[next.plan]} seats.` } });
      }
      if (changed.includes("status") && l.purged_at) {
        return res.status(409).json({ errors: { status: "This licensee's data has been purged; it cannot be reopened." } });
      }
      if (changed.includes("company_code") && (await codeTaken(deps.db, next.company_code, l.id))) {
        return res.status(409).json({ errors: { company_code: "taken" } });
      }
      try {
        await deps.db.query(
          `UPDATE licensees SET ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`,
          [l.id, ...changed.map((c) => v[c])],
        );
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ errors: { company_code: "taken" } });
        throw err;
      }
      const actor = actorOf(req);
      await audit(deps.db, actor, "licensee.update", l.id, Object.fromEntries(changed.map((c) => [c, { from: (l as any)[c], to: v[c] }])));

      let planPush: { ok: boolean; error?: string } | null = null;
      // Live status changes (suspended, cancelled, or back to trial/active/past_due) go to the licensee's server with
      // the plan, recorded and retried the same way.
      const statusPush = changed.includes("status") && isServiceStatus(next.status);
      if (changed.includes("plan") || changed.includes("extra_storage_blocks") || statusPush) {
        await recordPlanChange(
          deps,
          l,
          { plan: next.plan, extra_storage_blocks: next.extra_storage_blocks, ...(statusPush ? { status: next.status } : {}) },
          actor,
        );
        planPush = await pushPlan(deps, l.id, actor);
      }
      let billingSync: string | null = null;
      if (["plan", "billing_interval", "seats", "support_level", "extra_storage_blocks"].some((c) => changed.includes(c as any))) {
        try {
          billingSync = await syncSubscription(deps, next);
        } catch (err) {
          billingSync = "failed";
          console.error(`[billing] subscription update for ${l.company_code} failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      const fresh = (await getLicensee(deps.db, l.id))!;
      return res.json({ licensee: staffView(fresh), plan_push: planPush, billing_sync: billingSync });
    }),
  );

  // Staff confirm a cancelled licensee's data was purged (on or after its purge date). Status stays cancelled.
  router.post(
    "/licensees/:id/purged",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const r = await markPurged(deps.db, l.id, deps.now(), actorOf(req));
      if (r === "not_cancelled") return res.status(409).json({ error: r, message: "Only a cancelled licensee can be marked purged." });
      if (r === "not_due") {
        return res.status(409).json({ error: r, message: `The data is held until ${staffView(l).data_purge_on}; it cannot be marked purged before then.` });
      }
      const fresh = (await getLicensee(deps.db, l.id))!;
      return res.json({ result: r, licensee: staffView(fresh) });
    }),
  );

  router.post(
    "/licensees/:id/notes",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const parsed = parseBody(z.object({ body: z.string().trim().min(1, "Write a note first.").max(10_000) }), req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const r = await deps.db.query("INSERT INTO notes (licensee_id, author, body) VALUES ($1, $2, $3) RETURNING *", [
        l.id,
        actorOf(req),
        parsed.data.body,
      ]);
      return res.status(201).json({ note: r.rows[0] });
    }),
  );

  router.post(
    "/licensees/:id/ops-key",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      try {
        const opsKey = await rotateOpsKey(deps.db, l.id);
        await audit(deps.db, actorOf(req), "licensee.ops_key_rotated", l.id, null);
        res.setHeader("Cache-Control", "no-store");
        return res.json({ licensee_id: l.id, ops_key: opsKey, message: OPS_KEY_MESSAGE });
      } catch (err) {
        if (err instanceof EncryptionNotConfigured) {
          return res.status(503).json({ error: "encryption_not_configured", message: "Set OPS_ENCRYPTION_KEY on KS-Ops first." });
        }
        throw err;
      }
    }),
  );

  // PGI referrals: create / refresh the licensee's referral source at the insurance partner and push the credentials
  // to its server now (the worker does this every 5 minutes anyway).
  router.post(
    "/licensees/:id/pgi-link",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      if (!biConfig()) return res.status(503).json({ error: "bi_not_configured", message: "Set BI_SERVER_URL and BI_KEYSTONE_OPS_KEY on KS-Ops first." });
      const r = await linkPgi(deps, l.id);
      await audit(deps.db, actorOf(req), "licensee.pgi_link", l.id, r.ok ? { action: r.action } : { error: r.error });
      if (!r.ok) return res.status(502).json({ error: "pgi_link_failed", reason: r.error, message: "The licensee could not be linked to the insurance partner yet; it will be retried." });
      const fresh = (await getLicensee(deps.db, l.id))!;
      return res.json({ ok: true, action: r.action, licensee: staffView(fresh) });
    }),
  );

  // Backfill: every live licensee is linked again on the worker's next pass (fresh credentials).
  router.post(
    "/pgi/backfill",
    h(async (req, res) => {
      if (!biConfig()) return res.status(503).json({ error: "bi_not_configured", message: "Set BI_SERVER_URL and BI_KEYSTONE_OPS_KEY on KS-Ops first." });
      const queued = await queuePgiBackfill(deps);
      await audit(deps.db, actorOf(req), "pgi.backfill", null, { queued });
      return res.json({ ok: true, queued });
    }),
  );

  router.post(
    "/licensees/:id/sync-usage",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const period = String(req.query.period ?? req.body?.period ?? periodOf(deps.now()));
      if (!PERIOD_RE.test(period)) return res.status(400).json({ errors: { period: "Use a month like 2026-10." } });
      const r = await pullUsageReport(deps, l.id, period);
      if (!r.ok) {
        return res.status(502).json({ error: "usage_pull_failed", reason: r.error, message: "The licensee's server did not return a usage report." });
      }
      await audit(deps.db, actorOf(req), "licensee.sync_usage", l.id, { period });
      return res.json({ ok: true, stored: r.stored, report: r.report });
    }),
  );

  router.get(
    "/licensees/:id/invoices",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const r = await deps.db.query("SELECT * FROM invoices WHERE licensee_id = $1 ORDER BY created_at DESC", [l.id]);
      return res.json({ invoices: r.rows });
    }),
  );

  router.post(
    "/licensees/:id/invoices/preview",
    h(async (req, res) => {
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      const period = String(req.query.period ?? periodOf(deps.now()));
      if (!PERIOD_RE.test(period)) return res.status(400).json({ errors: { period: "Use a month like 2026-10." } });
      return res.json(await invoicePreview(deps.db, l, period));
    }),
  );

  router.post(
    "/licensees/:id/billing/checkout",
    h(async (req, res) => {
      const stripe = requireStripe(deps);
      const l = await load(req.params.id);
      if (!l) return res.status(404).json(notFound);
      if (l.stripe_subscription_id) {
        // A second Checkout would start a second subscription: only allowed once the old one has ended.
        const live = await liveSubscriptionStatus(stripe, l.stripe_subscription_id);
        if (live) {
          return res.status(409).json({
            error: "subscription_exists",
            subscription_id: l.stripe_subscription_id,
            subscription_status: live,
            message: `This licensee already has a Stripe subscription (${live}). Change the plan or seats here instead, or cancel that subscription in Stripe first.`,
          });
        }
      }
      const session = await createCheckout(deps, l);
      await audit(deps.db, actorOf(req), "licensee.billing_checkout", l.id, { session_id: session.id });
      return res.json({ url: session.url, session_id: session.id });
    }),
  );

  return router;
}
