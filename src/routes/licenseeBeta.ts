// KS_OPS_BETA_v1 - calls from a licensee's KS-server (X-KS-Ops-Key) for the beta features programme.
//   GET  /api/licensees/:id/beta              { beta_features } - this licensee's view of the catalogue
//   POST /api/licensees/:id/beta/enrolment    { feature_key, action: join|leave, requested_by? }
//        join a public beta that is open and allowed on their plan: approved at once -> 200 { status: "joined" }
//        join anything else they can see but not join (a closed beta): recorded as a request for staff -> 202 { status: "requested" }
//        leave a beta they are in -> 200 { status: "left" }; a GA feature cannot be left -> 409
//        Every answer carries the new beta_features, so the server can store it at once without waiting for a push.
//   POST /api/licensees/:id/beta/feedback     { feature_key, message, rating?, author_name?, author_email? } -> 201
import { Router } from "express";
import type { Deps } from "../deps.js";
import { requireLicenseeKey } from "../auth/licenseeKey.js";
import { h, parseBody } from "../lib/http.js";
import { audit } from "../licensees/repo.js";
import {
  betaEnrolmentRequestSchema, betaFeedbackSchema, betaSnapshot, effectivePlan, enrol, enrolledKeys, getFeature, planAllowed,
  unenrol,
} from "../beta/catalogue.js";

export function licenseeBetaRouter(deps: Deps): Router {
  const router = Router();
  const auth = requireLicenseeKey(deps.db);

  router.get(
    "/:id/beta",
    auth,
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, beta_features: await betaSnapshot(deps.db, req.licensee!, deps.now()) });
    }),
  );

  router.post(
    "/:id/beta/enrolment",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(betaEnrolmentRequestSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      const { feature_key: key, action } = parsed.data;
      const l = req.licensee!;
      const by = `licensee:${l.company_code}${parsed.data.requested_by ? `:${parsed.data.requested_by}` : ""}`;
      const f = await getFeature(deps.db, key);
      const inIt = (await enrolledKeys(deps.db, l.id)).includes(key);
      const snapshot = async () => betaSnapshot(deps.db, l, deps.now());
      // Retired, or a private beta they are not in: the licensee cannot see it, so it does not exist for them.
      if (!f || f.status === "retired" || (f.status === "private_beta" && !inIt)) {
        return res.status(404).json({ error: "not_found", message: "That beta feature is not available." });
      }

      if (action === "leave") {
        if (f.status === "ga") return res.status(409).json({ error: "generally_available", message: "This feature is now part of the product and cannot be switched off.", beta_features: await snapshot() });
        const removed = await unenrol(deps.db, key, l.id);
        if (removed) await audit(deps.db, by, "beta.leave", l.id, { key });
        return res.json({ ok: true, status: "left", beta_features: await snapshot() });
      }

      if (inIt || f.status === "ga") return res.json({ ok: true, status: "joined", beta_features: await snapshot() });
      if (!planAllowed(f, effectivePlan(l, deps.now()))) {
        return res.status(403).json({ error: "plan_not_eligible", message: "This beta is not available on your plan.", beta_features: await snapshot() });
      }
      // A public beta that is open: approved at once.
      if (f.open) {
        await enrol(deps.db, key, l.id, "licensee", by);
        await audit(deps.db, by, "beta.join", l.id, { key, auto_approved: true });
        return res.json({ ok: true, status: "joined", beta_features: await snapshot() });
      }
      // A closed public beta: kept as a request for staff to decide.
      await deps.db.query(
        `INSERT INTO requests (licensee_id, kind, current_plan, requested_by, message, payload)
         VALUES ($1, 'other', $2, $3, $4, $5)`,
        [l.id, l.plan, parsed.data.requested_by ?? null, `Asked to join the beta "${f.name}" (${key}), which is closed to new members.`, JSON.stringify({ beta_feature: key, action })],
      );
      await audit(deps.db, by, "beta.join_requested", l.id, { key });
      return res.status(202).json({ ok: true, status: "requested", message: "This beta is full right now. We have your request and will be in touch.", beta_features: await snapshot() });
    }),
  );

  router.post(
    "/:id/beta/feedback",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(betaFeedbackSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_feedback", errors: parsed.errors });
      const v = parsed.data;
      const l = req.licensee!;
      const f = await getFeature(deps.db, v.feature_key);
      if (!f) return res.status(404).json({ error: "not_found", message: "That beta feature is not available." });
      const r = await deps.db.query(
        `INSERT INTO beta_feedback (feature_key, licensee_id, author_name, author_email, rating, message)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [f.key, l.id, v.author_name ?? null, v.author_email ?? null, v.rating ?? null, v.message],
      );
      return res.status(201).json({ ok: true, feedback_id: r.rows[0].id });
    }),
  );

  return router;
}
