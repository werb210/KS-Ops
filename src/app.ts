import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { originList } from "./config.js";
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
import { stripeWebhookRouter } from "./routes/stripeWebhook.js";
import { demoOpsRouter, demoPublicRouter } from "./routes/demo.js";
import { opsQuickbooksRouter, qboCallbackRouter, qboPageRouter } from "./routes/opsQuickbooks.js";
import { opsTrialsRouter } from "./routes/opsTrials.js";
import { trialsPageRouter } from "./routes/opsTrialsPage.js";

/** CORS for a list of allowed origins read from env vars at request time. */
function corsFor(...envNames: string[]) {
  return cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, envNames.flatMap((n) => originList(n)).includes(origin.replace(/\/+$/, "")));
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

  // The demo server's completion carries the sample lender package (a small PDF, base64).
  app.use("/api/demo/sessions", express.json({ limit: "16mb" }));
  app.use(express.json({ limit: "1mb" }));

  // The self-serve demo: sign-up from the website, the magic link from the demo portal, progress from the demo server.
  app.use("/api/public/demo", corsFor("PUBLIC_SITE_URL", "KS_DEMO_PORTAL_URL"), demoPublicRouter(deps));
  app.use("/api/demo", demoOpsRouter(deps));
  app.use("/api/public", corsFor("PUBLIC_SITE_URL"), publicRouter(deps));
  app.use("/api/directory", cors({ origin: "*", methods: ["GET"] }), directoryRouter(deps));
  // KS_STAFF_DIRECTORY_v1 - the apps find a staff member's brokerage from their email or mobile number.
  app.use("/api/staff-directory", cors({ origin: "*", methods: ["POST"], allowedHeaders: ["Content-Type"] }), staffDirectoryRouter(deps));
  app.use("/api/licensees", licenseeApiRouter(deps));
  app.use("/api/ops", corsFor("OPS_ALLOWED_ORIGINS"));
  app.use("/api/ops/auth", opsAuthRouter(deps));
  // Intuit sends the browser back here without a staff token; the single-use OAuth state is the check.
  app.use("/api/ops/quickbooks/oauth/callback", qboCallbackRouter(deps));
  app.use("/api/ops", requireStaff, opsLicenseesRouter(deps), opsSupportRouter(deps), opsQuickbooksRouter(deps), opsTrialsRouter(deps));
  // The QuickBooks and free-trial ops pages (they hold no data; their calls need a staff token).
  app.use("/ops/quickbooks", qboPageRouter());
  app.use("/ops/trials", trialsPageRouter());

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
