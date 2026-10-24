// GET /api/directory/:code - the company-code lookup the Keystone apps use to find a licensee's server.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { limiter } from "../lib/clientIp.js";
import { h } from "../lib/http.js";
import { CODE_RE, DIRECTORY_STATUSES, normalizeCode } from "../licensees/validation.js";

export function directoryRouter(deps: Deps): Router {
  const router = Router();
  router.use(limiter(30, 60_000, { error: "rate_limited", message: "Too many lookups. Please wait a minute and try again." }));
  router.get(
    "/:code",
    h(async (req, res) => {
      const code = normalizeCode(req.params.code);
      res.setHeader("Cache-Control", "no-store");
      if (!CODE_RE.test(code)) return res.status(404).json({ error: "unknown_company" });
      const r = await deps.db.query(
        `SELECT company_code, company_name, server_url, client_url, portal_url, logo_url, primary_color,
                accent_color, background_color, font_family
           FROM licensees WHERE company_code = $1 AND status = ANY($2::text[]) AND server_url IS NOT NULL`,
        [code, DIRECTORY_STATUSES],
      );
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: "unknown_company" });
      return res.json({
        company_code: row.company_code,
        company_name: row.company_name,
        server_url: row.server_url,
        client_url: row.client_url,
        portal_url: row.portal_url,
        logo_url: row.logo_url,
        primary_color: row.primary_color,
        accent_color: row.accent_color ?? null,
        background_color: row.background_color ?? null,
        font_family: row.font_family ?? null, // KS_OPS_v14_BRAND_FONT
      });
    }),
  );
  return router;
}
