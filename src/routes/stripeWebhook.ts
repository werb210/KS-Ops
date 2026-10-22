// POST /api/ops/stripe/webhook - needs the raw body for the signature check, so it is mounted before express.json().
import express, { Router } from "express";
import type { Deps } from "../deps.js";
import { handleStripeEvent } from "../billing/webhook.js";
import { stripeWebhookSecret } from "../billing/billing.js";

export function stripeWebhookRouter(deps: Deps): Router {
  const router = Router();
  router.post("/", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const stripe = deps.stripe();
    const secret = stripeWebhookSecret();
    if (!stripe || !secret) return res.status(503).json({ error: "billing_not_configured" });
    let event: Record<string, any>;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), secret);
    } catch (err) {
      console.warn("[stripe] webhook signature rejected", err instanceof Error ? err.message : String(err));
      return res.status(400).json({ error: "invalid_signature" });
    }
    try {
      const r = await handleStripeEvent(deps, event);
      return res.json({ received: true, ...r });
    } catch (err) {
      console.error(`[stripe] handling ${event.type} ${event.id} failed`, err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: "webhook_failed" });
    }
  });
  return router;
}
