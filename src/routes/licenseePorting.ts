// KS_OPS_NUMBER_PORTING_v1 - "Keep your existing phone number", from a licensee's KS-server (X-KS-Ops-Key, like support
// tickets). The brokerage's admin works in the portal; KS-server adds who is asking and each person's temporary
// Keystone number and relays here. Bodies carry the account number and PIN: never logged, stored encrypted.
//   POST /api/licensees/:id/port-requests                   create (draft) -> 201 { request, loa }
//   POST /api/licensees/:id/port-requests/list              { requests } (account number masked, PIN only "on file")
//   POST /api/licensees/:id/port-requests/:rid/loa          the letter to sign { version, title, html, text, sha256, signed }
//   POST /api/licensees/:id/port-requests/:rid/sign         { signer_name, signer_title, agree, sha256, signer_email, ip, user_agent }
//   POST /api/licensees/:id/port-requests/:rid/forwarding   { phone_number, tested }
//   POST /api/licensees/:id/port-requests/:rid/cancel       before it goes to the carrier only
import { Router, type Response } from "express";
import type { Deps } from "../deps.js";
import { requireLicenseeKey } from "../auth/licenseeKey.js";
import { h, UUID_RE } from "../lib/http.js";
import { cancelFromLicensee, createFromLicensee, forwardingTested, getRequest, loaFor, signFromLicensee } from "../porting/service.js";
import { listForLicensee } from "../porting/repo.js";

type Out = { ok: true } | { ok: false; status: number; error: string; message: string; errors?: Record<string, string> };
const answer = (res: Response, r: Out & Record<string, unknown>, okStatus = 200) => {
  if (r.ok) return res.status(okStatus).json(r);
  const { status, ...body } = r;
  return res.status(status).json(body);
};

export function licenseePortingRouter(deps: Deps): Router {
  const router = Router();
  const auth = requireLicenseeKey(deps.db);
  const notFound = { error: "not_found", message: "We could not find that transfer request." };

  router.post("/:id/port-requests", auth, h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return answer(res, await createFromLicensee(deps, req.licensee!, req.body), 201);
  }));

  router.post("/:id/port-requests/list", auth, h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, requests: await listForLicensee(deps.db, req.licensee!.id, deps.now()) });
  }));

  router.post("/:id/port-requests/:rid/:action", auth, h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const rid = String(req.params.rid);
    const r = UUID_RE.test(rid) ? await getRequest(deps.db, rid, req.licensee!.id) : null;
    if (!r) return res.status(404).json(notFound);
    const b = req.body ?? {};
    switch (req.params.action) {
      case "loa": {
        const loa = await loaFor(deps, req.licensee!, r);
        return loa ? res.json({ ok: true, ...loa }) : res.status(503).json({ error: "not_configured", message: "Keystone cannot show the letter right now." });
      }
      case "sign": return answer(res, await signFromLicensee(deps, req.licensee!, r, b));
      case "forwarding": return answer(res, await forwardingTested(deps, r, b.phone_number, b.tested === true));
      case "cancel": return answer(res, await cancelFromLicensee(deps, req.licensee!, r, String(b.by ?? "").slice(0, 200)));
      default: return res.status(404).json({ error: "not_found" });
    }
  }));

  return router;
}
