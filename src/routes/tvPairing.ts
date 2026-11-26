// KS_OPS_TV_PAIRING_v1 - see src/tv/pairing.ts.
//   POST /api/tv/pair/start                      (the TV)  -> { code, device_secret, expires_in }
//   POST /api/tv/pair/collect { code, device_secret }  (the TV, every few seconds) -> { state: waiting|expired|paired, ... }
//   POST /api/tv/pair/claim/bf { code, token }   (BF-Server, with the admin's BF sign-in) - Boreal Financial
//   POST /api/licensees/:id/tv/claim { code, token }  (a KS-server, X-KS-Ops-Key) - see licenseeTvRouter
import { Router } from "express";
import { env } from "../config.js";
import type { Deps } from "../deps.js";
import { requireLicenseeKey } from "../auth/licenseeKey.js";
import { bfIdentity, isAdminRole } from "../auth/staff.js";
import { limiter } from "../lib/clientIp.js";
import { h } from "../lib/http.js";
import { claimPairing, collectPairing, startPairing } from "../tv/pairing.js";

const LIMITED = { error: "rate_limited", message: "Too many tries. Please wait a few minutes and try again." };

export function tvPairingRouter(deps: Deps): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  router.post("/pair/start", limiter(20, 15 * 60_000, LIMITED), h(async (_req, res) => {
    res.status(201).json({ ok: true, ...(await startPairing(deps.db, deps.now())) });
  }));

  router.post("/pair/collect", limiter(400, 15 * 60_000, LIMITED), h(async (req, res) => {
    const b = req.body ?? {};
    res.json({ ok: true, ...(await collectPairing(deps.db, b.code, b.device_secret, deps.now())) });
  }));

  // Boreal Financial is not a licensee: BF-Server forwards the admin's own sign-in, which we check with BF-Server.
  router.post("/pair/claim/bf", limiter(30, 15 * 60_000, LIMITED), h(async (req, res) => {
    const base = env("BF_SERVER_URL").replace(/\/+$/, "");
    const auth = String(req.headers.authorization ?? "");
    if (!base) return res.status(503).json({ error: "not_configured", message: "Pairing is not set up on this server." });
    if (!/^Bearer\s+\S{10,}/i.test(auth)) return res.status(401).json({ error: "sign_in_required", message: "Sign in to the staff portal first." });
    let who: ReturnType<typeof bfIdentity> = null;
    try {
      const r = await deps.fetch(`${base}/api/auth/me`, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) who = bfIdentity(await r.json().catch(() => null));
    } catch (err) {
      console.warn("[tv] BF-Server check failed", err instanceof Error ? err.message : String(err));
      return res.status(502).json({ error: "bf_server_unreachable", message: "Could not check your sign-in. Please try again." });
    }
    if (!who) return res.status(401).json({ error: "invalid_sign_in", message: "Your staff portal sign-in has expired. Please sign in again." });
    if (!isAdminRole(who.role)) return res.status(403).json({ error: "admin_only", message: "Only Admin users can add a TV." });
    const out = await claimPairing(deps.db, req.body?.code, req.body?.token,
      { licensee_id: null, server_url: base, company_name: "Boreal Financial", logo_url: null, primary_color: null }, deps.now());
    if (!out.ok) { const { status, ...body } = out; return res.status(status).json(body); }
    return res.json({ ok: true });
  }));
  return router;
}

export function licenseeTvRouter(deps: Deps): Router {
  const router = Router();
  router.post("/:id/tv/claim", requireLicenseeKey(deps.db), h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const l = req.licensee!;
    const out = await claimPairing(deps.db, req.body?.code, req.body?.token,
      { licensee_id: l.id, server_url: String(l.server_url ?? ""), company_name: l.company_name, logo_url: l.logo_url, primary_color: l.primary_color }, deps.now());
    if (!out.ok) { const { status, ...body } = out; return res.status(status).json(body); }
    return res.json({ ok: true });
  }));
  return router;
}
