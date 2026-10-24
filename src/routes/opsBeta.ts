// KS_OPS_BETA_v1 - staff API for the beta features programme. Mounted under /api/ops behind requireStaff, so only
// Keystone operations admins can use it. The page at /ops/beta calls it.
//   GET    /api/ops/beta/features                          the catalogue with enrolment and feedback counts
//   POST   /api/ops/beta/features                          create { key, name, description?, status?, plans?, open?, feedback_url?, docs_url? }
//   GET    /api/ops/beta/features/:key                     one feature with who is in and the feedback received
//   PATCH  /api/ops/beta/features/:key                     edit any of the fields above except key (open/close = { open })
//   POST   /api/ops/beta/features/:key/enrolments          enrol { licensee_id }
//   DELETE /api/ops/beta/features/:key/enrolments/:licenseeId   remove
//   GET    /api/ops/beta/signups                           the website's beta programme sign-ups, newest first
// Every change is in the audit log. A catalogue change queues a push to every live licensee (sent within 5 minutes);
// an enrolment change pushes to that licensee at once.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { audit, getLicensee } from "../licensees/repo.js";
import { pushPlan } from "../sync/planPush.js";
import {
  BETA_KEY_RE, betaCreateSchema, betaUpdateSchema, enrol, getFeature, listFeatures, queueBetaPushForAll, unenrol,
  type BetaFeatureRow,
} from "../beta/catalogue.js";

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === "23505";

function featureView(f: BetaFeatureRow, counts?: { enrolled: number; feedback: number }) {
  return {
    key: f.key, name: f.name, description: f.description, status: f.status, plans: f.plans, open: f.open,
    feedback_url: f.feedback_url, docs_url: f.docs_url, created_at: f.created_at ?? null, updated_at: f.updated_at ?? null,
    updated_by: f.updated_by ?? null,
    ...(counts ? { enrolled_count: counts.enrolled, feedback_count: counts.feedback } : {}),
  };
}

const NOT_FOUND = { error: "not_found", message: "That beta feature does not exist." };

export function opsBetaRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/beta/features",
    h(async (_req, res) => {
      const [features, counts] = await Promise.all([
        listFeatures(deps.db),
        deps.db.query(
          `SELECT f.key,
                  (SELECT count(*) FROM beta_enrolments e WHERE e.feature_key = f.key)::int AS enrolled,
                  (SELECT count(*) FROM beta_feedback b WHERE b.feature_key = f.key)::int AS feedback
             FROM beta_features f`,
        ),
      ]);
      const byKey = new Map(counts.rows.map((r) => [String(r.key), { enrolled: Number(r.enrolled) || 0, feedback: Number(r.feedback) || 0 }]));
      res.setHeader("Cache-Control", "no-store");
      res.json({ features: features.map((f) => featureView(f, byKey.get(f.key) ?? { enrolled: 0, feedback: 0 })) });
    }),
  );

  router.post(
    "/beta/features",
    h(async (req, res) => {
      const parsed = parseBody(betaCreateSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      const actor = actorOf(req);
      let row;
      try {
        row = await deps.db.query(
          `INSERT INTO beta_features (key, name, description, status, plans, open, feedback_url, docs_url, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [v.key, v.name, v.description, v.status, v.plans, v.open, v.feedback_url ?? null, v.docs_url ?? null, actor],
        );
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ errors: { key: "A feature with this key already exists." } });
        throw err;
      }
      await audit(deps.db, actor, "beta.create", null, { key: v.key, status: v.status, plans: v.plans, open: v.open });
      // Only a GA or public beta feature changes what licensees see before anyone is enrolled.
      const queued = v.status === "ga" || v.status === "public_beta" ? await queueBetaPushForAll(deps.db) : 0;
      return res.status(201).json({ feature: featureView(await getFeature(deps.db, v.key) ?? (row.rows[0] as BetaFeatureRow)), pushes_queued: queued });
    }),
  );

  router.get(
    "/beta/features/:key",
    h(async (req, res) => {
      const key = String(req.params.key).toLowerCase();
      const f = BETA_KEY_RE.test(key) ? await getFeature(deps.db, key) : null;
      if (!f) return res.status(404).json(NOT_FOUND);
      const [enrolments, feedback] = await Promise.all([
        deps.db.query(
          `SELECT e.licensee_id, e.source, e.enrolled_by, e.enrolled_at, l.company_name, l.company_code, l.plan, l.status
             FROM beta_enrolments e JOIN licensees l ON l.id = e.licensee_id
            WHERE e.feature_key = $1 ORDER BY e.enrolled_at DESC`,
          [key],
        ),
        deps.db.query(
          `SELECT b.id, b.licensee_id, b.author_name, b.author_email, b.rating, b.message, b.created_at,
                  l.company_name, l.company_code
             FROM beta_feedback b LEFT JOIN licensees l ON l.id = b.licensee_id
            WHERE b.feature_key = $1 ORDER BY b.created_at DESC LIMIT 500`,
          [key],
        ),
      ]);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ feature: featureView(f, { enrolled: enrolments.rows.length, feedback: feedback.rows.length }), enrolments: enrolments.rows, feedback: feedback.rows });
    }),
  );

  router.patch(
    "/beta/features/:key",
    h(async (req, res) => {
      const key = String(req.params.key).toLowerCase();
      const f = BETA_KEY_RE.test(key) ? await getFeature(deps.db, key) : null;
      if (!f) return res.status(404).json(NOT_FOUND);
      const parsed = parseBody(betaUpdateSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data as Partial<BetaFeatureRow>;
      const fields = (["name", "description", "status", "plans", "open", "feedback_url", "docs_url"] as const).filter(
        (k) => v[k] !== undefined && JSON.stringify(v[k]) !== JSON.stringify(f[k]),
      );
      if (!fields.length) return res.json({ feature: featureView(f), changed: [], pushes_queued: 0 });
      const actor = actorOf(req);
      const params: unknown[] = [key, actor];
      const sets = fields.map((k) => {
        params.push(v[k]);
        return `${k} = $${params.length}`;
      });
      await deps.db.query(`UPDATE beta_features SET ${sets.join(", ")}, updated_at = now(), updated_by = $2 WHERE key = $1`, params);
      await audit(deps.db, actor, "beta.update", null, { key, ...Object.fromEntries(fields.map((k) => [k, { from: f[k], to: v[k] }])) });
      const queued = await queueBetaPushForAll(deps.db);
      return res.json({ feature: featureView((await getFeature(deps.db, key))!), changed: fields, pushes_queued: queued });
    }),
  );

  router.post(
    "/beta/features/:key/enrolments",
    h(async (req, res) => {
      const key = String(req.params.key).toLowerCase();
      const f = BETA_KEY_RE.test(key) ? await getFeature(deps.db, key) : null;
      if (!f) return res.status(404).json(NOT_FOUND);
      const licenseeId = String(req.body?.licensee_id ?? "");
      const l = UUID_RE.test(licenseeId) ? await getLicensee(deps.db, licenseeId) : null;
      if (!l) return res.status(404).json({ error: "not_found", message: "That licensee does not exist." });
      if (f.status === "retired") return res.status(409).json({ error: "feature_retired", message: "This feature is retired. Change its status before enrolling anyone." });
      const actor = actorOf(req);
      const added = await enrol(deps.db, key, l.id, "ops", actor);
      if (added) await audit(deps.db, actor, "beta.enrol", l.id, { key });
      const push = l.server_url ? await pushPlan(deps, l.id, actor) : null;
      return res.status(added ? 201 : 200).json({ ok: true, added, plan_push: push });
    }),
  );

  router.delete(
    "/beta/features/:key/enrolments/:licenseeId",
    h(async (req, res) => {
      const key = String(req.params.key).toLowerCase();
      const licenseeId = String(req.params.licenseeId);
      if (!BETA_KEY_RE.test(key) || !UUID_RE.test(licenseeId)) return res.status(404).json(NOT_FOUND);
      const actor = actorOf(req);
      const removed = await unenrol(deps.db, key, licenseeId);
      if (removed) await audit(deps.db, actor, "beta.unenrol", licenseeId, { key });
      const l = await getLicensee(deps.db, licenseeId);
      const push = removed && l?.server_url ? await pushPlan(deps, licenseeId, actor) : null;
      return res.json({ ok: true, removed, plan_push: push });
    }),
  );

  router.get(
    "/beta/signups",
    h(async (_req, res) => {
      const r = await deps.db.query(
        "SELECT id, name, email, brokerage, interests, message, created_at FROM beta_signups ORDER BY created_at DESC LIMIT 500",
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ signups: r.rows });
    }),
  );

  return router;
}
