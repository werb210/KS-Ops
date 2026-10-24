// KS_OPS_v13_PRESENTER - the staff "presenter mode" sales demo. The demo portal's /demo/present page runs the live
// demo with no tour, for a salesperson to drive. It is staff-only: the page opens only with a presenter token that
// KS-Ops signs for a signed-in Keystone operations user, and it checks that token here before it starts.
//
//   POST /api/ops/demo/presenter-link   (staff token, see auth/staff.ts)
//        -> 200 { url, token, expires_at }   url = {KS_DEMO_PORTAL_URL}/demo/present#p=<token>
//        -> 503 { error: "demo_not_configured" } when KS_DEMO_PORTAL_URL is not set
//   POST /api/public/demo/presenter/verify { token }   (CORS: KS_DEMO_PORTAL_URL)
//        -> 200 { ok: true, presenter: { name }, expires_at } | 401 { error: "presenter_link_invalid" }
//
// The token carries no prospect data and is useless anywhere else: its own type, issuer and audience, signed with
// OPS_JWT_SECRET, valid for PRESENTER_TTL_SECONDS. The staff allowlist (OPS_ADMIN_EMAILS) is checked again on verify,
// so removing someone ends their presenter links too.
import { Router } from "express";
import jwt from "jsonwebtoken";
import { allowlistProblem, jwtSecret, type StaffUser } from "../auth/staff.js";
import { demoPortalUrl } from "../demo/config.js";
import { limiter } from "../lib/clientIp.js";
import { h } from "../lib/http.js";

const TOKEN_TYPE = "ks-demo-presenter";
const AUDIENCE = "ks-demo-portal";
/** Long enough for a working day of meetings; a new link is one click in the staff portal. */
export const PRESENTER_TTL_SECONDS = 12 * 60 * 60;

export type PresenterClaims = { id: string; email: string | null; name: string | null; expiresAt: string };

export function signPresenterToken(staff: Pick<StaffUser, "id" | "email" | "name">, ttl = PRESENTER_TTL_SECONDS): string {
  const secret = jwtSecret();
  if (!secret) throw new Error("OPS_JWT_SECRET is not set (needs 32 or more characters)");
  return jwt.sign({ typ: TOKEN_TYPE, email: staff.email, name: staff.name }, secret, {
    algorithm: "HS256",
    subject: staff.id,
    audience: AUDIENCE,
    issuer: "ks-ops",
    expiresIn: ttl,
  });
}

export function verifyPresenterToken(token: unknown): PresenterClaims | null {
  const secret = jwtSecret();
  if (!secret || typeof token !== "string" || token.length < 20 || token.length > 4096) return null;
  try {
    const p = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "ks-ops", audience: AUDIENCE }) as jwt.JwtPayload;
    if (p.typ !== TOKEN_TYPE || !p.sub || typeof p.exp !== "number") return null;
    // Break-glass presenters have no email; everyone else must still be on the allowlist.
    if (p.sub !== "break-glass" && allowlistProblem(p.email ?? null)) return null;
    return { id: p.sub, email: p.email ?? null, name: p.name ?? null, expiresAt: new Date(p.exp * 1000).toISOString() };
  } catch {
    return null;
  }
}

/** Mounted under /api/ops/demo, behind requireStaff. */
export function presenterOpsRouter(): Router {
  const router = Router();
  router.post(
    "/presenter-link",
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const portal = demoPortalUrl();
      if (!portal) return res.status(503).json({ error: "demo_not_configured", message: "The demo portal address (KS_DEMO_PORTAL_URL) is not set." });
      const staff = req.staff!;
      const token = signPresenterToken(staff);
      const expiresAt = new Date(Date.now() + PRESENTER_TTL_SECONDS * 1000).toISOString();
      return res.json({ url: `${portal}/demo/present#p=${encodeURIComponent(token)}`, token, expires_at: expiresAt });
    }),
  );
  return router;
}

/** Mounted under /api/public/demo/presenter (CORS for the demo portal). */
export function presenterPublicRouter(): Router {
  const router = Router();
  router.post(
    "/verify",
    limiter(60, 15 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const claims = verifyPresenterToken(req.body?.token);
      if (!claims) {
        return res.status(401).json({ error: "presenter_link_invalid", message: "This presenter link is not valid or has expired. Open a new one from the staff portal." });
      }
      return res.json({ ok: true, presenter: { name: claims.name }, expires_at: claims.expiresAt });
    }),
  );
  return router;
}
