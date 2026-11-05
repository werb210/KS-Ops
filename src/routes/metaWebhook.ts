// KS_META_LEAD_ADS_v1 - GET/POST /api/webhooks/meta/leadgen: the one address Keystone's Meta app sends lead webhooks to.
// Raw body (the signature is over the exact bytes), so this is mounted before the JSON parser.
import express, { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Deps } from "../deps.js";
import { h } from "../lib/http.js";
import { relay, signatureValid } from "../meta/relay.js";

export function metaWebhookRouter(deps: Deps): Router {
  const router = Router();
  router.get("/leadgen", (req, res) => {
    const want = Buffer.from(String(process.env.META_WEBHOOK_VERIFY_TOKEN ?? ""));
    const got = Buffer.from(String(req.query["hub.verify_token"] ?? ""));
    if (req.query["hub.mode"] === "subscribe" && want.length > 0 && want.length === got.length && timingSafeEqual(want, got)) {
      return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    }
    return res.sendStatus(403);
  });
  router.post("/leadgen", express.raw({ type: "*/*", limit: "1mb" }), h(async (req, res) => {
    const secret = String(process.env.META_APP_SECRET ?? "");
    const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
    if (!signatureValid(raw, req.headers["x-hub-signature-256"], secret)) return res.sendStatus(401);
    let body: unknown;
    try { body = JSON.parse(raw!.toString("utf8")); } catch { return res.sendStatus(400); }
    const r = await relay(deps.db, body, secret);
    return res.sendStatus(r.failed ? 500 : 200);
  }));
  return router;
}
