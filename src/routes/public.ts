// The public website (KS-Website): plans, company-code check, sign-up and sign-up status.
import { Router, type Request } from "express";
import { isProduction, salesEmail, signupTurnstileOptional } from "../config.js";
import type { Deps } from "../deps.js";
import { BillingNotConfigured } from "../billing/stripeClient.js";
import { createCheckout } from "../billing/billing.js";
import { matchesHash, newSecret } from "../lib/crypto.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { limiter } from "../lib/clientIp.js";
import { clientIp, h, parseBody, UUID_RE } from "../lib/http.js";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile.js";
import {
  audit, codeTaken, getLicensee, insertLicensee, isUniqueViolation, signupTokenColumns, type LicenseeRow,
} from "../licensees/repo.js";
import { CODE_MESSAGES, codeProblem, crossFieldErrors, normalizeCode, signupSchema } from "../licensees/validation.js";
import { PLAN_NAMES, publicPlans } from "../pricing.js";

const limited = (limit: number, windowMs: number) => limiter(limit, windowMs);

export const SIGNUP_NOT_CONFIGURED_MESSAGE =
  "Online sign-up is not available right now. Please contact us and we will set you up.";

/** Production sign-ups need the Turnstile check unless SIGNUP_TURNSTILE_OPTIONAL=true. */
export function signupConfigured(): boolean {
  return turnstileEnabled() || !isProduction() || signupTurnstileOptional();
}

export const NO_STRIPE_MESSAGE =
  "Thanks - we have your details. Online payment is not available right now, so our team will email you a secure payment link within one business day.";
export const CHECKOUT_FAILED_MESSAGE =
  "Thanks - we have your details, but the payment page could not be opened. Our team will email you a secure payment link within one business day.";

function salesSignupMail(l: LicenseeRow, note: string) {
  return {
    to: [salesEmail()],
    subject: `New Keystone sign-up: ${l.company_name}`,
    ...bodies([
      `${l.company_name} signed up on the website. ${note}`,
      [
        `Company: ${l.company_name} (${l.legal_name})`,
        `Company code: ${l.company_code}`,
        `Plan: ${PLAN_NAMES[l.plan]}, ${l.seats} seat(s), ${l.billing_interval} billing, ${l.support_level} support`,
        `Contact: ${l.contact_name}, ${l.contact_email}, ${l.contact_phone}`,
        `Address: ${l.mailing_address ?? ""}, ${l.province_state ?? ""}, ${l.country}`,
      ].join("\n"),
    ]),
  };
}

export function publicRouter(deps: Deps): Router {
  const router = Router();

  router.get("/plans", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(publicPlans());
  });

  router.get(
    "/company-code-available",
    limited(60, 60_000),
    h(async (req, res) => {
      const code = normalizeCode(req.query.code);
      const problem = codeProblem(code);
      if (problem) return res.json({ available: false, reason: problem, message: CODE_MESSAGES[problem] });
      if (await codeTaken(deps.db, code)) return res.json({ available: false, reason: "taken", message: CODE_MESSAGES.taken });
      return res.json({ available: true });
    }),
  );

  router.post(
    "/signup",
    limited(10, 60 * 60_000),
    h(async (req, res) => {
      if (!signupConfigured()) {
        console.error("[signup] TURNSTILE_SECRET is not set in production; sign-ups are refused (set SIGNUP_TURNSTILE_OPTIONAL=true to allow)");
        return res.status(503).json({ error: "signup_not_configured", message: SIGNUP_NOT_CONFIGURED_MESSAGE });
      }
      const body = req.body ?? {};
      // Honeypot: a hidden field people never fill in.
      if (body.website_url !== undefined && body.website_url !== null && String(body.website_url).trim() !== "") {
        console.warn(`[signup] honeypot filled from ${clientIp(req)}`);
        return res.status(400).json({ errors: { form: "We could not accept this sign-up. Please try again." } });
      }
      const parsed = parseBody(signupSchema, body, crossFieldErrors);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const input = parsed.data;
      if (await codeTaken(deps.db, input.company_code)) {
        return res.status(409).json({ errors: { company_code: "taken" } });
      }
      // Checked last, so a form error or a taken code does not use up the person's one-time token.
      if (turnstileEnabled() && !(await verifyTurnstile(input.turnstile_token, clientIp(req), deps.fetch))) {
        return res.status(400).json({ errors: { turnstile_token: "Please confirm you are not a robot and try again." } });
      }
      const token = newSecret(24);
      const now = deps.now();
      let l: LicenseeRow;
      try {
        l = await insertLicensee(deps.db, {
          company_name: input.company_name,
          legal_name: input.legal_name,
          company_code: input.company_code,
          contact_name: input.contact_name,
          contact_email: input.contact_email,
          contact_phone: input.contact_phone,
          country: input.country,
          province_state: input.province_state,
          mailing_address: input.mailing_address,
          website: input.website,
          status: "pending_payment",
          plan: input.plan,
          billing_interval: input.billing_interval,
          support_level: input.support_level,
          seats: input.seats,
          primary_color: input.primary_color,
          logo_url: input.logo_url,
          assistant_name: input.assistant_name,
          ...signupTokenColumns(token),
          source: "website",
          accepted_terms_at: now,
          accepted_privacy_at: now,
        });
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ errors: { company_code: "taken" } });
        throw err;
      }
      await audit(deps.db, "website", "signup", l.id, { plan: l.plan, seats: l.seats, ip: clientIp(req) });

      let checkoutUrl: string | null = null;
      let message: string | undefined;
      if (deps.stripe()) {
        try {
          checkoutUrl = (await createCheckout(deps, l, token)).url;
        } catch (err) {
          if (!(err instanceof BillingNotConfigured)) {
            console.error("[signup] checkout failed", err instanceof Error ? err.message : String(err));
          }
          message = CHECKOUT_FAILED_MESSAGE;
        }
      } else {
        message = NO_STRIPE_MESSAGE;
      }
      if (!checkoutUrl) {
        await sendQuietly(deps.mailer, salesSignupMail(l, "Online payment was not available: please send them a payment link."), "sales signup notice");
      }
      return res.status(201).json({ licensee_id: l.id, signup_token: token, checkout_url: checkoutUrl, ...(message ? { message } : {}) });
    }),
  );

  /** The sign-up named by :id, when ?token= is its signup token; otherwise null. */
  const signupFor = async (req: Request): Promise<LicenseeRow | null> => {
    const id = String(req.params.id);
    const l = UUID_RE.test(id) ? await getLicensee(deps.db, id) : null;
    return l && matchesHash(req.query.token, l.signup_token_hash) ? l : null;
  };
  const signupNotFound = { error: "not_found", message: "We could not find that sign-up." };

  router.get(
    "/signup/:id/status",
    limited(120, 60_000),
    h(async (req, res) => {
      const l = await signupFor(req);
      if (!l) return res.status(404).json(signupNotFound);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ status: l.status, company_name: l.company_name });
    }),
  );

  // A new Stripe Checkout link for a sign-up that has not paid yet (the website's "Resume payment").
  router.post(
    "/signup/:id/checkout",
    limited(10, 15 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const l = await signupFor(req);
      if (!l) return res.status(404).json(signupNotFound);
      if (l.status !== "pending_payment") {
        return res.status(409).json({
          error: "not_pending_payment",
          status: l.status,
          message: "This sign-up does not need a payment right now.",
        });
      }
      if (!deps.stripe()) {
        return res.status(503).json({ error: "billing_not_configured", checkout_url: null, message: NO_STRIPE_MESSAGE });
      }
      let checkoutUrl: string;
      try {
        // The token the person already holds stays valid, so their success and cancel pages keep working.
        checkoutUrl = (await createCheckout(deps, l, String(req.query.token))).url;
      } catch (err) {
        if (err instanceof BillingNotConfigured) {
          return res.status(503).json({ error: "billing_not_configured", checkout_url: null, message: NO_STRIPE_MESSAGE });
        }
        console.error("[signup] resume checkout failed", err instanceof Error ? err.message : String(err));
        return res.status(502).json({ error: "checkout_failed", checkout_url: null, message: CHECKOUT_FAILED_MESSAGE });
      }
      await audit(deps.db, "website", "signup.checkout_resumed", l.id, { ip: clientIp(req) });
      return res.json({ checkout_url: checkoutUrl });
    }),
  );

  return router;
}
