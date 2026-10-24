// KS_OPS_BETA_v1 - the website's beta programme sign-up (KS-Website /beta).
//   POST /api/public/beta-signup { name, email, brokerage, interests?: string[], message?, turnstile_token?, website_url }
//   201 { ok, message } | 400 { errors } | 429
// The sign-up is stored (beta_signups, shown on /ops/beta), Keystone sales is emailed and it is pushed to the Keystone
// CRM (see crm/triggers.ts crmBetaSignup). The same email signing up again within a day is accepted but not stored again.
import { Router } from "express";
import { z } from "zod";
import { salesEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { limiter } from "../lib/clientIp.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { clientIp, h, parseBody } from "../lib/http.js";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile.js";
import { crmBetaSignup } from "../crm/triggers.js";

/** The interests the website offers. Anything else is dropped. */
export const BETA_INTERESTS = ["ai_assistant", "lender_matching", "mobile_apps", "fraud_protection", "integrations", "reporting", "other"] as const;
export const BETA_INTEREST_NAMES: Record<(typeof BETA_INTERESTS)[number], string> = {
  ai_assistant: "AI assistant",
  lender_matching: "Lender matching",
  mobile_apps: "Mobile apps",
  fraud_protection: "Fraud protection",
  integrations: "Integrations",
  reporting: "Reporting",
  other: "Something else",
};

const text = (max: number, msg: string) => z.string({ required_error: msg }).trim().min(1, msg).max(max);

export const betaSignupSchema = z.object({
  name: text(120, "Enter your name"),
  email: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.string({ required_error: "Enter a valid email address" }).max(200).email("Enter a valid email address")),
  brokerage: text(160, "Enter your brokerage's name"),
  interests: z
    .array(z.string())
    .max(20)
    .optional()
    .transform((v) => [...new Set((v ?? []).filter((x): x is (typeof BETA_INTERESTS)[number] => (BETA_INTERESTS as readonly string[]).includes(x)))]),
  message: z.string().trim().max(2000).optional(),
  turnstile_token: z.string().max(4096).optional(),
  website_url: z.any().optional(),
});

export const BETA_SIGNUP_THANKS = "Thanks - you're on the list. We'll email you when a beta that matches your interests opens.";

export function publicBetaRouter(deps: Deps): Router {
  const router = Router();

  router.post(
    "/beta-signup",
    limiter(10, 60 * 60_000),
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.website_url !== undefined && body.website_url !== null && String(body.website_url).trim() !== "") {
        console.warn(`[beta-signup] honeypot filled from ${clientIp(req)}`);
        return res.status(400).json({ errors: { form: "We could not accept this sign-up. Please try again." } });
      }
      const parsed = parseBody(betaSignupSchema, body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      if (!/\p{L}/u.test(v.name)) return res.status(400).json({ errors: { name: "Enter your name" } });
      const ip = clientIp(req);
      if (turnstileEnabled() && !(await verifyTurnstile(v.turnstile_token, ip, deps.fetch))) {
        return res.status(400).json({ errors: { turnstile_token: "Please confirm you are not a robot and try again." } });
      }
      const now = deps.now();
      const recent = await deps.db.query(
        "SELECT id FROM beta_signups WHERE lower(email) = $1 AND created_at > $2 LIMIT 1",
        [v.email, new Date(now.getTime() - 86_400_000)],
      );
      if (recent.rows.length) return res.status(201).json({ ok: true, message: BETA_SIGNUP_THANKS });
      const r = await deps.db.query(
        `INSERT INTO beta_signups (name, email, brokerage, interests, message, ip, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, brokerage, interests, message, created_at`,
        [v.name, v.email, v.brokerage, v.interests, v.message || null, ip || null, now],
      );
      const s = r.rows[0];
      const interestNames = v.interests.map((k) => BETA_INTEREST_NAMES[k]);
      await crmBetaSignup(deps, { id: String(s.id), name: v.name, email: v.email, brokerage: v.brokerage, interests: interestNames, message: v.message ?? null, created_at: s.created_at ?? now });
      await sendQuietly(
        deps.mailer,
        {
          to: [salesEmail()],
          subject: `Beta programme sign-up: ${v.brokerage}`,
          ...bodies([
            `${v.name} from ${v.brokerage} joined the beta programme on the website.`,
            [`Email: ${v.email}`, `Interests: ${interestNames.join(", ") || "none chosen"}`].join("\n"),
            ...(v.message ? [v.message] : []),
          ]),
        },
        "beta sign-up notice",
      );
      return res.status(201).json({ ok: true, message: BETA_SIGNUP_THANKS });
    }),
  );

  return router;
}
