// Keystone's own QuickBooks Online connection (ops admins only), the Intuit OAuth callback and a small ops page.
//
//   GET    /api/ops/quickbooks/status            configured?, connected?, company, settings, outbox counts
//   POST   /api/ops/quickbooks/connect           { authorize_url } - a single-use state, 10 minutes
//   GET    /api/ops/quickbooks/oauth/callback    Intuit sends the browser here (no staff token: the state is the check)
//   POST   /api/ops/quickbooks/disconnect        revokes the refresh token at Intuit and forgets the tokens
//   PATCH  /api/ops/quickbooks/settings          tax codes and accounts (QuickBooks ids)
//   GET    /api/ops/quickbooks/outbox            recent rows (?status=pending|failed|done|skipped)
//   POST   /api/ops/quickbooks/outbox/:id/retry  send a row again now
//   GET    /ops/quickbooks                       the ops page (asks for a staff or break-glass token)
import { Router, type Request } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { newSecret, sha256Hex, decryptSecret } from "../lib/crypto.js";
import { h, parseBody } from "../lib/http.js";
import { limiter } from "../lib/clientIp.js";
import { audit } from "../licensees/repo.js";
import { authorizeUrl, exchangeCode, getConnection, qboApi, revokeToken, saveConnection } from "../qbo/client.js";
import { qboConfig, qboEnvironment, qboMissing, qboRedirectUri } from "../qbo/config.js";
import { loadSettings, SETTING_KEYS } from "../qbo/posting.js";
import { QBO_PAGE_HTML } from "./opsQuickbooksPage.js";

const STATE_TTL_MS = 10 * 60_000;
const notConfigured = (missing: string[]) => ({
  error: "quickbooks_not_configured",
  message: `QuickBooks is not set up on this server. Missing: ${missing.join(", ")}.`,
  missing,
});

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

export function opsQuickbooksRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/quickbooks/status",
    h(async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const missing = qboMissing();
      const c = await getConnection(deps.db);
      const counts = await deps.db.query(
        `SELECT status, (last_error IS NOT NULL) AS failing, count(*)::int AS n FROM qbo_outbox GROUP BY 1, 2`,
      );
      const outbox = { pending: 0, failing: 0, done: 0, skipped: 0 };
      for (const r of counts.rows) {
        if (r.status === "pending") {
          outbox.pending += r.n;
          if (r.failing) outbox.failing += r.n;
        } else if (r.status === "done") outbox.done += r.n;
        else if (r.status === "skipped") outbox.skipped += r.n;
      }
      res.json({
        configured: missing.length === 0,
        missing,
        environment: qboEnvironment(),
        redirect_uri: qboRedirectUri(requestOrigin(_req)),
        connected: Boolean(c),
        connection: c
          ? {
              realm_id: c.realm_id,
              environment: c.environment,
              company_name: c.company_name,
              connected_by: c.connected_by,
              connected_at: c.connected_at,
              refreshed_at: c.refreshed_at,
              access_expires_at: c.access_expires_at,
              refresh_expires_at: c.refresh_expires_at,
              environment_matches: c.environment === qboEnvironment(),
            }
          : null,
        settings: await loadSettings(deps.db),
        outbox,
      });
    }),
  );

  router.post(
    "/quickbooks/connect",
    limiter(20, 60 * 60_000, { error: "rate_limited" }),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const cfg = qboConfig();
      if (!cfg) return res.status(503).json(notConfigured(qboMissing()));
      const state = newSecret(32);
      const redirectUri = qboRedirectUri(requestOrigin(req));
      await deps.db.query("DELETE FROM qbo_oauth_states WHERE expires_at < now() - interval '1 day'");
      await deps.db.query(
        "INSERT INTO qbo_oauth_states (state_hash, created_by, redirect_uri, expires_at) VALUES ($1, $2, $3, $4)",
        [sha256Hex(state), actorOf(req), redirectUri, new Date(deps.now().getTime() + STATE_TTL_MS)],
      );
      await audit(deps.db, actorOf(req), "quickbooks.connect_started", null, { environment: cfg.environment });
      return res.json({ authorize_url: authorizeUrl(cfg, state, redirectUri), redirect_uri: redirectUri, expires_in: STATE_TTL_MS / 1000 });
    }),
  );

  router.post(
    "/quickbooks/disconnect",
    h(async (req, res) => {
      const cfg = qboConfig();
      const c = await getConnection(deps.db);
      if (!c) return res.json({ disconnected: false, revoked: false, message: "QuickBooks was not connected." });
      let revoked = false;
      if (cfg) {
        try {
          revoked = await revokeToken(deps, cfg, decryptSecret(c.refresh_token_encrypted, cfg.key));
        } catch (err) {
          console.error(`[qbo] could not read the stored refresh token to revoke it: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        console.error("[qbo] disconnecting without KS_QBO_* settings: the token cannot be revoked at Intuit, only forgotten");
      }
      await deps.db.query("DELETE FROM qbo_connection WHERE id = 1");
      await audit(deps.db, actorOf(req), "quickbooks.disconnected", null, { realm_id: c.realm_id, revoked });
      return res.json({
        disconnected: true,
        revoked,
        ...(revoked ? {} : { message: "Disconnected here, but Intuit did not confirm the revoke. Remove the app in QuickBooks too." }),
      });
    }),
  );

  const idSchema = z.preprocess(
    (v) => (v === "" ? null : v),
    z.union([z.null(), z.string().trim().regex(/^[0-9A-Za-z_-]{1,40}$/, "Use the QuickBooks id (letters and numbers).")]),
  );
  const settingsSchema = z
    .object(Object.fromEntries(SETTING_KEYS.map((k) => [k, idSchema])) as Record<(typeof SETTING_KEYS)[number], typeof idSchema>)
    .partial()
    .strict();

  router.patch(
    "/quickbooks/settings",
    h(async (req, res) => {
      const parsed = parseBody(settingsSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data as Record<string, string | null | undefined>;
      const keys = SETTING_KEYS.filter((k) => v[k] !== undefined);
      await deps.db.query("INSERT INTO qbo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
      if (keys.length) {
        await deps.db.query(
          `UPDATE qbo_settings SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_by = $${keys.length + 1}, updated_at = now() WHERE id = 1`,
          [...keys.map((k) => v[k] ?? null), actorOf(req)],
        );
        await audit(deps.db, actorOf(req), "quickbooks.settings", null, Object.fromEntries(keys.map((k) => [k, v[k] ?? null])));
      }
      return res.json({ settings: await loadSettings(deps.db) });
    }),
  );

  router.get(
    "/quickbooks/outbox",
    h(async (req, res) => {
      const s = String(req.query.status ?? "");
      const where =
        s === "failed" ? "status = 'pending' AND last_error IS NOT NULL"
          : ["pending", "done", "skipped"].includes(s) ? `status = '${s}'` : "TRUE";
      const r = await deps.db.query(
        `SELECT o.id, o.kind, o.stripe_id, o.status, o.attempts, o.next_attempt_at, o.last_error, o.qbo_id, o.note,
                o.done_at, o.created_at, l.company_name
           FROM qbo_outbox o LEFT JOIN licensees l ON l.id = o.licensee_id
          WHERE ${where} ORDER BY o.created_at DESC LIMIT 100`,
      );
      res.json({ items: r.rows });
    }),
  );

  router.post(
    "/quickbooks/outbox/:id/retry",
    h(async (req, res) => {
      if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: "not_found" });
      const r = await deps.db.query(
        `UPDATE qbo_outbox SET status = 'pending', next_attempt_at = now(), updated_at = now()
          WHERE id = $1 AND status <> 'done' RETURNING id`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "not_found", message: "No such row, or it is already posted." });
      await audit(deps.db, actorOf(req), "quickbooks.retry", null, { outbox_id: req.params.id });
      return res.json({ queued: true });
    }),
  );

  return router;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function resultPage(title: string, message: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f6f7f9;color:#14171c;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:3rem auto;padding:1.5rem;background:#fff;border:1px solid #d5d9e0;border-radius:10px}
h1{font-size:1.35rem;margin:0 0 .75rem;color:${ok ? "#0f5132" : "#842029"}}a{color:#0b4f8a}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/ops/quickbooks">Back to QuickBooks in Keystone operations</a></p></main></body></html>`;
}

/** GET /api/ops/quickbooks/oauth/callback - mounted before the staff check: Intuit's redirect has no staff token. */
export function qboCallbackRouter(deps: Deps): Router {
  const router = Router();
  router.get(
    "/",
    limiter(30, 15 * 60_000, { error: "rate_limited" }),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.type("html");
      const cfg = qboConfig();
      if (!cfg) return res.status(503).send(resultPage("QuickBooks is not set up", "This server has no QuickBooks app settings.", false));
      const state = typeof req.query.state === "string" ? req.query.state : "";
      // Single use: the state is marked used before anything else happens.
      const claimed = state
        ? await deps.db.query(
            `UPDATE qbo_oauth_states SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now()
             RETURNING created_by, redirect_uri`,
            [sha256Hex(state)],
          )
        : { rows: [] as any[] };
      const st = claimed.rows[0];
      if (!st) {
        console.warn("[qbo] OAuth callback with an unknown, used or expired state");
        return res.status(400).send(resultPage("This link has expired", "Start the QuickBooks connection again from Keystone operations.", false));
      }
      if (typeof req.query.error === "string") {
        console.warn(`[qbo] Intuit returned ${req.query.error} to the OAuth callback`);
        return res.status(400).send(resultPage("QuickBooks was not connected", `Intuit answered: ${req.query.error}.`, false));
      }
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const realmId = typeof req.query.realmId === "string" ? req.query.realmId : "";
      if (!code || !/^\d{1,30}$/.test(realmId)) {
        return res.status(400).send(resultPage("QuickBooks was not connected", "Intuit did not send a code and company id.", false));
      }
      try {
        const tokens = await exchangeCode(deps, cfg, code, String(st.redirect_uri));
        await saveConnection(deps, cfg, realmId, tokens, String(st.created_by ?? "unknown"));
      } catch (err) {
        console.error(`[qbo] OAuth code exchange failed: ${err instanceof Error ? err.message : String(err)}`);
        return res.status(502).send(resultPage("QuickBooks was not connected", "Intuit did not accept the connection. Please try again.", false));
      }
      let company = "";
      try {
        const api = await qboApi(deps, cfg);
        const info = await api.get(`companyinfo/${encodeURIComponent(realmId)}`);
        company = String(info?.CompanyInfo?.CompanyName ?? "");
        if (company) await deps.db.query("UPDATE qbo_connection SET company_name = $1 WHERE id = 1", [company]);
      } catch (err) {
        console.warn(`[qbo] connected, but reading the company name failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await audit(deps.db, String(st.created_by ?? "unknown"), "quickbooks.connected", null, { realm_id: realmId, environment: cfg.environment });
      return res.send(
        resultPage("QuickBooks is connected", `Keystone will post Stripe invoices, payments and refunds to ${company || `company ${realmId}`} (${cfg.environment}).`, true),
      );
    }),
  );
  return router;
}

/** GET /ops/quickbooks - the page itself holds no data; every call needs a token. */
export function qboPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(QBO_PAGE_HTML);
  });
  return router;
}
