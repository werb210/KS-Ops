// KS_OPS_AUTO_PROVISION_v1 - staff API for automatic provisioning. Mounted under /api/ops behind requireStaff.
//   GET  /api/ops/provisioning                          runs, newest first, with their steps, and the setup checklist
//   GET  /api/ops/provisioning/runs/:id                 one run with its steps and log
//   POST /api/ops/provisioning { licensee_id, kind?, dry_run? }   start a run (provision by default)
//   POST /api/ops/provisioning/runs/:id/retry { step? } retry a step (default: the first unfinished one)
//   POST /api/ops/provisioning/runs/:id/steps/:step/done { note }  mark a step done manually
//   POST /api/ops/provisioning/runs/:id/cancel
//   GET  /api/ops/provisioning/plan/:code?kind=         the dry-run plan (what a run would do), changes nothing
//   GET  /api/ops/provisioning/twilio/:licenseeId       the licensee's Twilio sub-account and texting registration (KS_OPS_TWILIO_AUTO_v1)
//   POST /api/ops/provisioning/twilio/:licenseeId/texting/resubmit   submit texting registration again (after a fix)
import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { getLicensee } from "../licensees/repo.js";
import { CODE_RE } from "../licensees/validation.js";
import { kick, machineDeps } from "../provisioning/index.js";
import { advanceRun, cancelRun, markStepDone, retryStep, runView, startRun, type MachineDeps } from "../provisioning/machine.js";
import { serviceSetupMissing } from "../provisioning/config.js";
import { describePlan, type RunKind } from "../provisioning/steps.js";
import { statusTokenFor } from "../provisioning/statusToken.js";
import { publicSiteUrl } from "../config.js";
import { twilioSummary } from "../twilio/view.js";
import { linesFrom, pushTexting, submitTexting } from "../twilio/texting.js";
import { twilioOf } from "../twilio/account.js";
import { audit } from "../licensees/repo.js";

const startSchema = z.object({
  licensee_id: z.string().regex(UUID_RE, "Choose a licensee."),
  kind: z.enum(["provision", "teardown"]).default("provision"),
  dry_run: z.boolean().default(false),
});

export function opsProvisioningRouter(deps: Deps, md: MachineDeps = machineDeps(deps)): Router {
  const router = Router();

  router.get(
    "/provisioning",
    h(async (_req, res) => {
      const runs = await md.store.listRuns(200);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        setup_missing: { provision: serviceSetupMissing("provision"), teardown: serviceSetupMissing("teardown") },
        runs: await Promise.all(runs.map((r) => runView(md, r, 0))),
      });
    }),
  );

  router.get(
    "/provisioning/plan/:code",
    h(async (req, res) => {
      const code = String(req.params.code);
      if (!CODE_RE.test(code)) return res.status(400).json({ errors: { code: "3 to 32 lowercase letters, numbers and hyphens." } });
      const kind: RunKind = req.query.kind === "teardown" ? "teardown" : "provision";
      return res.json({ kind, code, plan: describePlan(kind, code) });
    }),
  );

  router.get(
    "/provisioning/runs/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? await md.store.getRun(id) : null;
      if (!run) return res.status(404).json({ error: "not_found" });
      const site = publicSiteUrl();
      const token = run.kind === "provision" ? statusTokenFor(run.licensee_id) : null;
      res.setHeader("Cache-Control", "no-store");
      return res.json({ run: await runView(md, run), status_page: token && site ? `${site}/signup/success?p=${token}` : null });
    }),
  );

  router.post(
    "/provisioning",
    h(async (req, res) => {
      const parsed = parseBody(startSchema, req.body ?? {});
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const l = await getLicensee(deps.db, parsed.data.licensee_id);
      if (!l) return res.status(404).json({ error: "not_found", message: "That licensee does not exist." });
      if (parsed.data.kind === "teardown" && l.status !== "cancelled" && !parsed.data.dry_run) {
        return res.status(409).json({ error: "not_cancelled", message: "Only a cancelled licensee can be torn down." });
      }
      const r = await startRun(md, l.id, parsed.data.kind, "staff", { dryRun: parsed.data.dry_run, by: actorOf(req) });
      kick(() => advanceRun(md, r.run.id));
      return res.status(r.created ? 201 : 200).json({
        created: r.created,
        run: await runView(md, r.run),
        message: r.created ? "Started." : "A run is already going for this licensee; showing it.",
      });
    }),
  );

  router.get(
    "/provisioning/twilio/:licenseeId",
    h(async (req, res) => {
      const id = String(req.params.licenseeId);
      if (!UUID_RE.test(id) || !(await getLicensee(deps.db, id))) return res.status(404).json({ error: "not_found" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(await twilioSummary(md, id));
    }),
  );

  router.post(
    "/provisioning/twilio/:licenseeId/texting/resubmit",
    h(async (req, res) => {
      const id = String(req.params.licenseeId);
      const l = UUID_RE.test(id) ? await getLicensee(deps.db, id) : null;
      if (!l) return res.status(404).json({ error: "not_found" });
      // The lines: from the last provisioning run's phone step, else the numbers already on the registrations.
      const run = await md.store.latestRun(l.id, "provision");
      const step = run ? (await md.store.steps(run.id)).find((s) => s.step === "phone_numbers") : null;
      let lines = linesFrom(step?.output?.results);
      if (!lines.local && !lines.tollFree) {
        const regs = await twilioOf(md).store.registrations(l.id);
        lines = { local: regs.find((r) => r.kind === "a2p_10dlc")?.phone_number ?? null, tollFree: regs.find((r) => r.kind === "toll_free")?.phone_number ?? null };
      }
      const rows = await submitTexting(md, l, lines);
      await audit(deps.db, actorOf(req), "licensee.texting_resubmitted", l.id, { results: rows.map((r) => ({ kind: r.kind, status: r.status })) });
      const pushed = await pushTexting(md, l);
      return res.json({ ...(await twilioSummary(md, l.id)), pushed: pushed.ok, message: "Texting registration submitted again." });
    }),
  );

  router.post(
    "/provisioning/runs/:id/retry",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json({ error: "not_found" });
      const step = typeof req.body?.step === "string" && req.body.step ? String(req.body.step) : null;
      const r = await retryStep(md, id, step, actorOf(req));
      if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
      kick(() => advanceRun(md, id));
      return res.json({ run: await runView(md, r.run), message: "Retrying." });
    }),
  );

  router.post(
    "/provisioning/runs/:id/steps/:step/done",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(z.object({ note: z.string().trim().min(3, "Say what you did by hand.").max(1000) }), req.body ?? {});
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const r = await markStepDone(md, id, String(req.params.step), actorOf(req), parsed.data.note);
      if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
      kick(() => advanceRun(md, id));
      return res.json({ run: await runView(md, r.run), message: "Marked done; the run carries on." });
    }),
  );

  router.post(
    "/provisioning/runs/:id/cancel",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json({ error: "not_found" });
      const r = await cancelRun(md, id, actorOf(req));
      if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
      return res.json({ run: await runView(md, r.run), message: "Cancelled. Anything already created is left as it is." });
    }),
  );

  return router;
}
