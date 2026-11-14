import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { originList } from "./config.js";
import { demoPortalOrigins } from "./demo/config.js";
import type { Deps } from "./deps.js";
import { requireStaff } from "./auth/staff.js";
import { BillingNotConfigured } from "./billing/stripeClient.js";
import { directoryRouter } from "./routes/directory.js";
import { staffDirectoryRouter } from "./routes/staffDirectory.js";
import { licenseeApiRouter } from "./routes/licenseeApi.js";
import { opsAuthRouter } from "./routes/opsAuth.js";
import { opsLicenseesRouter } from "./routes/opsLicensees.js";
import { opsSupportRouter } from "./routes/opsSupport.js";
import { publicRouter } from "./routes/public.js";
import { publicOnboardingRouter } from "./routes/publicOnboarding.js"; // KS_OPS_ONBOARDING_v1
import { opsOnboardingRouter } from "./routes/opsOnboarding.js";
import { stripeWebhookRouter } from "./routes/stripeWebhook.js";
import { demoOpsRouter, demoPublicRouter } from "./routes/demo.js";
import { opsQuickbooksRouter, qboCallbackRouter, qboPageRouter } from "./routes/opsQuickbooks.js";
import { opsTrialsRouter } from "./routes/opsTrials.js";
import { trialsPageRouter } from "./routes/opsTrialsPage.js";
import { presenterOpsRouter, presenterPublicRouter } from "./routes/presenter.js";
import { opsBetaRouter } from "./routes/opsBeta.js"; // KS_OPS_BETA_v1
import { betaPageRouter } from "./routes/opsBetaPage.js";
import { licenseeBetaRouter } from "./routes/licenseeBeta.js";
import { publicBetaRouter } from "./routes/publicBeta.js";
import { opsProvisioningRouter } from "./routes/opsProvisioning.js"; // KS_OPS_AUTO_PROVISION_v1
import { provisioningPageRouter } from "./routes/opsProvisioningPage.js";
import { provisioningCallbackRouter, publicProvisioningRouter } from "./routes/provisioningCallback.js";
import { textingOptInRouter } from "./routes/textingOptIn.js"; // KS_OPS_TWILIO_AUTO_v1
import { oauthBrokerRouter } from "./routes/oauthBroker.js"; // KS_OPS_WORKSPACE_APPS
import { metaWebhookRouter } from "./routes/metaWebhook.js"; // KS_META_LEAD_ADS_v1
import { opsKbRouter } from "./routes/opsKb.js"; // KS_OPS_KB_v1
import { kbPageRouter } from "./routes/opsKbPage.js";
import { publicAssistantRouter, publicKbRouter } from "./routes/publicKb.js";
import { licenseeKbRouter } from "./routes/licenseeKb.js";
import { publicRoadmapRouter } from "./routes/publicRoadmap.js"; // KS_OPS_ROADMAP_v1
import { opsRoadmapRouter } from "./routes/opsRoadmap.js";
import { roadmapPageRouter } from "./routes/opsRoadmapPage.js";
import { opsMarketingRouter } from "./routes/opsMarketing.js"; // KS_OPS_PROSPECT_MARKETING_v1
import { opsOutreachRouter } from "./routes/opsOutreach.js"; // KS_OPS_OUTREACH_v1
import { publicMarketingRouter } from "./routes/publicMarketing.js";
import { licenseePortingRouter } from "./routes/licenseePorting.js"; // KS_OPS_NUMBER_PORTING_v1
import { opsPortingRouter } from "./routes/opsPorting.js";
import { portingPageRouter } from "./routes/opsPortingPage.js";

/** KS_OPS_KEYSTONE_DOMAIN - Keystone's own website (keystonecrm.online) is always allowed on the website routes. */
export const KEYSTONE_SITE_ORIGINS = ["https://www.keystonecrm.online", "https://keystonecrm.online"];

/** CORS for a list of allowed origins read from env vars at request time (plus Keystone's site on PUBLIC_SITE_URL routes). */
function corsFor(...envNames: string[]) {
  return cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = envNames.flatMap((n) => originList(n));
      if (envNames.includes("PUBLIC_SITE_URL")) allowed.push(...KEYSTONE_SITE_ORIGINS);
      if (envNames.includes("KS_DEMO_PORTAL_URL")) allowed.push(...demoPortalOrigins()); // KS_DEMO_DOMAIN
      cb(null, allowed.includes(origin.replace(/\/+$/, "")));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });
}

export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  // Azure App Service puts one proxy in front of the app; the rate limits need the client's address.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

  app.get("/api/health", async (_req, res) => {
    try {
      await deps.db.query("SELECT 1");
      res.json({ ok: true, service: "ks-ops" });
    } catch {
      res.status(503).json({ ok: false, service: "ks-ops", error: "database_unavailable" });
    }
  });

  // Raw body for the Stripe signature: before the JSON parser.
  app.use("/api/ops/stripe/webhook", stripeWebhookRouter(deps));
  // KS_OPS_PROSPECT_MARKETING_v1 - unsubscribe pages and the SendGrid Event Webhook (raw body): before the JSON parser.
  app.use("/api/public/marketing", publicMarketingRouter(deps));
  // KS_META_LEAD_ADS_v1 - Facebook lead webhooks (raw body for the signature), passed on to each brokerage.
  app.use("/api/webhooks/meta", metaWebhookRouter(deps));

  // The demo server's completion carries the sample lender package (a small PDF, base64).
  app.use("/api/demo/sessions", express.json({ limit: "16mb" }));
  // KS_OPS_KB_v1 - article images (PNG or JPG up to 2 MB, sent as base64).
  app.use("/api/ops/kb/images", express.json({ limit: "4mb" }));
  // KS_OPS_NUMBER_PORTING_v1 - a transfer request carries the recent bill (up to 7 MB, sent as base64).
  app.use("/api/licensees/:id/port-requests", express.json({ limit: "12mb" }));
  app.use(express.json({ limit: "1mb" }));

  // The self-serve demo: sign-up from the website, the magic link from the demo portal, progress from the demo server.
  // KS_OPS_v13_PRESENTER - the demo portal checks a staff presenter link before the presenter-mode demo starts.
  app.use("/api/public/demo/presenter", corsFor("KS_DEMO_PORTAL_URL"), presenterPublicRouter());
  app.use("/api/public/demo", corsFor("PUBLIC_SITE_URL", "KS_DEMO_PORTAL_URL"), demoPublicRouter(deps));
  app.use("/api/demo", demoOpsRouter(deps));
  app.use("/api/public/texting-opt-in", textingOptInRouter(deps));
  // KS_OPS_KB_v1 - public help articles and Keystone Maya for prospects (the website's assistant).
  app.use("/api/public/kb", corsFor("PUBLIC_SITE_URL"), publicKbRouter(deps));
  app.use("/api/public/assistant", corsFor("PUBLIC_SITE_URL"), publicAssistantRouter(deps));
  app.use("/api/public/roadmap", corsFor("PUBLIC_SITE_URL"), publicRoadmapRouter(deps)); // KS_OPS_ROADMAP_v1
  app.use("/api/public", corsFor("PUBLIC_SITE_URL"), publicRouter(deps), publicBetaRouter(deps), publicProvisioningRouter(deps), publicOnboardingRouter(deps));
  // KS_OPS_AUTO_PROVISION_v1 - the provisioning workflow in GitHub Actions reports back with its run's one-off token.
  app.use("/api/provisioning/callback", provisioningCallbackRouter(deps));
  app.use("/api/oauth/callback", oauthBrokerRouter(deps)); // KS_OPS_WORKSPACE_APPS - Keystone's one OAuth redirect address
  app.use("/api/directory", cors({ origin: "*", methods: ["GET"] }), directoryRouter(deps));
  // KS_STAFF_DIRECTORY_v1 - the apps find a staff member's brokerage from their email or mobile number.
  app.use("/api/staff-directory", cors({ origin: "*", methods: ["POST"], allowedHeaders: ["Content-Type"] }), staffDirectoryRouter(deps));
  app.use("/api/licensees", licenseeApiRouter(deps), licenseeBetaRouter(deps));
  app.use("/api/licensees", licenseeKbRouter(deps)); // KS_OPS_KB_v1 - the portal's Help Center and Ask Maya
  app.use("/api/licensees", licenseePortingRouter(deps)); // KS_OPS_NUMBER_PORTING_v1 - "Keep your existing phone number"
  app.use("/api/ops", corsFor("OPS_ALLOWED_ORIGINS"));
  app.use("/api/ops/auth", opsAuthRouter(deps));
  // KS_OPS_v13_PRESENTER - a signed link to the staff presenter-mode demo (the staff portal's "Start sales demo").
  app.use("/api/ops/demo", requireStaff, presenterOpsRouter());
  // Intuit sends the browser back here without a staff token; the single-use OAuth state is the check.
  app.use("/api/ops/quickbooks/oauth/callback", qboCallbackRouter(deps));
  app.use("/api/ops", requireStaff, opsLicenseesRouter(deps), opsSupportRouter(deps), opsQuickbooksRouter(deps), opsTrialsRouter(deps), opsBetaRouter(deps), opsProvisioningRouter(deps));
  app.use("/api/ops", requireStaff, opsKbRouter(deps)); // KS_OPS_KB_v1
  app.use("/api/ops", requireStaff, opsRoadmapRouter(deps)); // KS_OPS_ROADMAP_v1
  app.use("/api/ops", requireStaff, opsOnboardingRouter(deps)); // KS_OPS_ONBOARDING_v1 - sign-up team and licence agreement
  app.use("/api/ops", requireStaff, opsMarketingRouter(deps)); // KS_OPS_PROSPECT_MARKETING_v1
  app.use("/api/ops", requireStaff, opsOutreachRouter(deps)); // KS_OPS_OUTREACH_v1
  app.use("/api/ops", requireStaff, opsPortingRouter(deps)); // KS_OPS_NUMBER_PORTING_v1 - number transfers
  // The QuickBooks and free-trial ops pages (they hold no data; their calls need a staff token).
  app.use("/ops/quickbooks", qboPageRouter());
  app.use("/ops/trials", trialsPageRouter());
  app.use("/ops/beta", betaPageRouter()); // KS_OPS_BETA_v1
  app.use("/ops/provisioning", provisioningPageRouter()); // KS_OPS_AUTO_PROVISION_v1
  app.use("/ops/kb", kbPageRouter()); // KS_OPS_KB_v1
  app.use("/ops/roadmap", roadmapPageRouter()); // KS_OPS_ROADMAP_v1
  app.use("/ops/porting", portingPageRouter()); // KS_OPS_NUMBER_PORTING_v1

  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BillingNotConfigured) {
      return res.status(503).json({
        error: "billing_not_configured",
        reason: err.reason,
        message: "Billing is not set up on this server yet.",
      });
    }
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
    console.error("[error]", err instanceof Error ? err.stack ?? err.message : String(err));
    return res.status(500).json({ error: "server_error", message: "Something went wrong. Please try again." });
  });

  return app;
}
