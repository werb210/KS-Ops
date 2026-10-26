// KS_OPS_AUTO_PROVISION_v1 - the KS-Ops provisioning workflow reports back here, and the website reads progress.
//
// Workflow (Authorization: Bearer <the run's one-off callback token>; the token expires with the run's workflow):
//   GET  /api/provisioning/callback/:runId/context    the licensee's non-secret details
//   POST /api/provisioning/callback/:runId/ops-key    a new ops key for KS-server (only while azure_resources runs)
//   POST /api/provisioning/callback/:runId/twilio-settings  the licensee's Twilio settings for its KS-server (only while
//                                                     twilio_settings runs; KS_OPS_TWILIO_AUTO_v1)
//   POST /api/provisioning/callback/:runId            { step, status: running|done|failed|log|setup_missing, message, output, missing }
// Website (public, CORS PUBLIC_SITE_URL):
//   GET  /api/public/provisioning/:token              setup progress for the thank-you page (token: statusToken.ts)
import { Router, type Request } from "express";
import { limiter } from "../lib/clientIp.js";
import type { Deps } from "../deps.js";
import { h, UUID_RE } from "../lib/http.js";
import { kick, machineDeps } from "../provisioning/index.js";
import { advanceRun, handleCallback, opsKeyForWorkflow, twilioSettingsForWorkflow, publicStatus, runForCallback, workflowContext, type MachineDeps } from "../provisioning/machine.js";
import { licenseeIdFromStatusToken } from "../provisioning/statusToken.js";
import { EncryptionNotConfigured } from "../licensees/repo.js";

const bearer = (req: Request) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  return m ? m[1].trim() : "";
};

export function provisioningCallbackRouter(deps: Deps, md: MachineDeps = machineDeps(deps)): Router {
  const router = Router();
  router.use(limiter(120, 60_000));

  const load = async (req: Request) => {
    const id = String(req.params.runId);
    return UUID_RE.test(id) ? runForCallback(md, id, bearer(req)) : null;
  };
  const denied = { error: "unauthorized" };

  router.get(
    "/:runId/context",
    h(async (req, res) => {
      const run = await load(req);
      if (!run) return res.status(401).json(denied);
      res.setHeader("Cache-Control", "no-store");
      return res.json(await workflowContext(md, run));
    }),
  );

  router.post(
    "/:runId/ops-key",
    h(async (req, res) => {
      const run = await load(req);
      if (!run) return res.status(401).json(denied);
      res.setHeader("Cache-Control", "no-store");
      try {
        const r = await opsKeyForWorkflow(md, run);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ ops_key: r.ops_key });
      } catch (err) {
        if (err instanceof EncryptionNotConfigured) return res.status(503).json({ error: "encryption_not_configured" });
        throw err;
      }
    }),
  );

  router.post(
    "/:runId/twilio-settings",
    h(async (req, res) => {
      const run = await load(req);
      if (!run) return res.status(401).json(denied);
      res.setHeader("Cache-Control", "no-store");
      const r = await twilioSettingsForWorkflow(md, run);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      return res.json({ settings: r.settings });
    }),
  );

  router.post(
    "/:runId",
    h(async (req, res) => {
      const run = await load(req);
      if (!run) return res.status(401).json(denied);
      const r = await handleCallback(md, run, req.body ?? {});
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      kick(() => advanceRun(md, run.id));
      return res.json({ ok: true });
    }),
  );

  return router;
}

export function publicProvisioningRouter(deps: Deps, md: MachineDeps = machineDeps(deps)): Router {
  const router = Router();
  router.get(
    "/provisioning/:token",
    limiter(120, 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const id = licenseeIdFromStatusToken(String(req.params.token));
      if (!id) return res.status(404).json({ state: "not_found" });
      const s = await publicStatus(md, id);
      if (s.state === "not_found") return res.status(404).json({ state: "not_found" });
      return res.json(s);
    }),
  );
  return router;
}
