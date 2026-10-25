// KS_OPS_v13_ADMIN_TRIAL - staff API for the free trial (see billing/adminTrial.ts). Mounted under /api/ops behind
// requireStaff, so only Keystone operations admins can use it.
//   GET  /api/ops/trials                        every licensee given a staff trial, newest first
//   POST /api/ops/trials { licensee_id, plan?, billing_interval? }   start one for an existing licensee (prospect
//                                               sign-up or licensee); billed from day 15 on its own plan and interval
//                                               unless plan / billing_interval are sent (KS_OPS_v14_TRIAL_RULES)
//   POST /api/ops/trials { licensee: {...} }    create the licensee (same fields as POST /api/ops/licensees; plan and
//                                               billing_interval default to Starter, monthly) and start one
// 201 { licensee, trial: { started_at, billing_starts_at, pro_until, started_by }, subscription_id }
// 404 not_found | 409 trial_already_used | licensee_cancelled | subscription_exists | company code taken
// 503 billing_not_configured (Stripe is needed: days 15-28 are billed)
import { Router } from "express";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { requireStripe } from "../billing/billing.js";
import { BillingNotConfigured } from "../billing/stripeClient.js";
import { startAdminTrial, trialDay } from "../billing/adminTrial.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { audit, codeTaken, insertLicensee, isUniqueViolation, staffView, type LicenseeRow } from "../licensees/repo.js";
import { crossFieldErrors, staffCreateSchema } from "../licensees/validation.js";
import { crmLicenseeCreated } from "../crm/triggers.js";
import { startProvisioningQuietly } from "../provisioning/machine.js"; // KS_OPS_AUTO_PROVISION_v1
import { machineDeps } from "../provisioning/index.js";
import { PLAN_NAMES } from "../pricing.js";

function trialView(l: LicenseeRow) {
  return {
    started_at: l.admin_trial_started_at ?? null,
    started_by: l.admin_trial_started_by ?? null,
    billing_starts_at: l.admin_trial_billing_starts_at ?? null,
    pro_until: l.admin_trial_pro_until ?? null,
    ended_at: l.admin_trial_ended_at ?? null,
    end_reason: l.admin_trial_end_reason ?? null,
  };
}

export function opsTrialsRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/trials",
    h(async (_req, res) => {
      const r = await deps.db.query(
        `SELECT * FROM licensees WHERE admin_trial_started_at IS NOT NULL ORDER BY admin_trial_started_at DESC LIMIT 200`,
      );
      res.json({
        trials: r.rows.map((row) => {
          const l = row as LicenseeRow;
          return {
            licensee_id: l.id,
            company_name: l.company_name,
            company_code: l.company_code,
            contact_name: l.contact_name,
            contact_email: l.contact_email,
            status: l.status,
            plan: l.plan,
            billing_interval: l.billing_interval,
            seats: l.seats,
            ...trialView(l),
          };
        }),
      });
    }),
  );

  router.post(
    "/trials",
    h(async (req, res) => {
      const actor = actorOf(req);
      // Stripe is checked first, so nothing is created when billing is not set up.
      requireStripe(deps);
      let licenseeId = String(req.body?.licensee_id ?? "");
      let created = false;
      if (!licenseeId) {
        const raw = req.body?.licensee;
        if (!raw || typeof raw !== "object") {
          return res.status(400).json({ errors: { licensee_id: "Choose a licensee, or fill in the new prospect's details." } });
        }
        // KS_OPS_v14_TRIAL_RULES - the plan and interval the prospect chose (default Starter, monthly).
        const body = { ...raw, plan: raw.plan || "starter", billing_interval: raw.billing_interval || "monthly" };
        const parsed = parseBody(staffCreateSchema, body, crossFieldErrors);
        if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
        const v = parsed.data;
        if (await codeTaken(deps.db, v.company_code)) return res.status(409).json({ errors: { company_code: "taken" } });
        let l: LicenseeRow;
        try {
          l = await insertLicensee(deps.db, { ...v, status: "provisioning", source: "staff" });
        } catch (err) {
          if (isUniqueViolation(err)) return res.status(409).json({ errors: { company_code: "taken" } });
          throw err;
        }
        await audit(deps.db, actor, "licensee.create", l.id, { company_code: l.company_code, plan: l.plan, seats: l.seats, for: "free_trial" });
        await crmLicenseeCreated(deps, l);
        licenseeId = l.id;
        created = true;
      } else if (!UUID_RE.test(licenseeId)) {
        return res.status(404).json({ error: "not_found", message: "That licensee does not exist." });
      }
      let r;
      try {
        r = await startAdminTrial(deps, licenseeId, actor, created ? {} : { plan: req.body?.plan, billing_interval: req.body?.billing_interval });
      } catch (err) {
        const why = err instanceof BillingNotConfigured ? err.reason : err instanceof Error ? err.message : String(err);
        console.error(`[admin-trial] could not start for ${licenseeId}: ${why}`);
        await audit(deps.db, actor, "licensee.admin_trial_failed", licenseeId, { error: why.slice(0, 300) });
        return res.status(err instanceof BillingNotConfigured ? 503 : 502).json({
          error: err instanceof BillingNotConfigured ? "billing_not_configured" : "trial_failed",
          licensee_id: licenseeId,
          licensee_created: created,
          message: `${created ? "The licensee was created, but the" : "The"} trial did not start: Stripe could not set up the subscription (${why}). Try again.`,
        });
      }
      if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message, licensee_id: licenseeId, licensee_created: created });
      // KS_OPS_AUTO_PROVISION_v1 - no copy yet: set one up automatically (no payment needed for a staff trial).
      const provisioning = r.licensee.status === "provisioning" && !r.licensee.server_url
        ? await startProvisioningQuietly(machineDeps(deps), r.licensee, "admin_trial", actor)
        : null;
      return res.status(201).json({
        provisioning_run_id: provisioning?.id ?? null,
        licensee: staffView(r.licensee),
        licensee_created: created,
        trial: trialView(r.licensee),
        subscription_id: r.subscription_id,
        message:
          `Free trial started. ${r.licensee.contact_email} was emailed the dates: free until ${trialDay(new Date(r.dates.billing_starts_at.getTime() - 86_400_000))}, ` +
          `billed for ${PLAN_NAMES[r.licensee.plan]} (${r.licensee.billing_interval}) from ${trialDay(r.dates.billing_starts_at)}, ` +
          `${PLAN_NAMES[r.licensee.plan]} features from ${trialDay(r.dates.pro_until)}.`,
      });
    }),
  );

  return router;
}
