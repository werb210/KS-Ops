import { Router } from "express";
import type { Deps } from "../deps.js";
import { exchangeBfToken, requireStaff } from "../auth/staff.js";
import { limiter } from "../lib/clientIp.js";
import { h } from "../lib/http.js";

export function opsAuthRouter(deps: Deps): Router {
  const router = Router();
  router.post(
    "/exchange",
    limiter(20, 60_000, { error: "rate_limited" }),
    h(async (req, res) => {
      const r = await exchangeBfToken(req.body?.bfToken, deps.fetch);
      res.setHeader("Cache-Control", "no-store");
      if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
      return res.json({ token: r.token, expires_in: r.expires_in, user: r.user });
    }),
  );
  router.get("/me", requireStaff, (req, res) => res.json({ user: req.staff }));
  return router;
}
