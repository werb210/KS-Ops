// KS_OPS_WORKSPACE_APPS - GET /api/oauth/callback/:provider (public): Microsoft and Google send every brokerage's
// browser here; it is forwarded to that brokerage's own KS-server. See src/workspace/broker.ts.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { h } from "../lib/http.js";
import { limiter } from "../lib/clientIp.js";
import { getLicensee, opsKeyOf } from "../licensees/repo.js";
import { brokerTarget, parseBrokerState, type BrokerProvider, type BrokerRefusal } from "../workspace/broker.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const REFUSAL_TEXT: Record<BrokerRefusal, string> = {
  bad_state: "This sign-in link is not complete or not valid.",
  unknown_flow: "This sign-in link is not valid.",
  expired: "This sign-in link has expired.",
  unknown_licensee: "This sign-in link is not valid for any Keystone company.",
  bad_signature: "This sign-in link is not valid.",
  no_server: "This company's Keystone system is not ready yet.",
};

/** A small readable page (dark text on white, well over 4.5:1). */
export function brokerPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f7f9;color:#14171c;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:3rem auto;padding:1.5rem;background:#fff;border:1px solid #cfd5dd;border-radius:10px}
h1{font-size:1.3rem;margin:0 0 .5rem}p{margin:.4rem 0;color:#2b313a}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p><p>Go back to Keystone and try again. If it keeps happening, contact Keystone support.</p></main></body></html>`;
}

export function oauthBrokerRouter(deps: Deps): Router {
  const router = Router();
  router.get(
    "/:provider",
    limiter(120, 60_000, { error: "rate_limited" }),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      // The query holds a one-time code: it must not leak to the next site in a Referer header.
      res.setHeader("Referrer-Policy", "no-referrer");
      const provider = String(req.params.provider);
      if (provider !== "microsoft" && provider !== "google") return res.status(404).type("html").send(brokerPage("Page not found", "There is nothing at this address."));
      const parsed = parseBrokerState(req.query.state);
      const l = parsed ? await getLicensee(deps.db, parsed.licenseeId) : null;
      const target = brokerTarget(
        provider as BrokerProvider,
        parsed,
        l ? { server_url: l.server_url, ops_key: opsKeyOf(l) } : null,
        req.query as Record<string, unknown>,
        deps.now().getTime(),
      );
      if (!target.ok) {
        console.warn(`[oauth-broker] ${provider} callback refused: ${target.reason}${parsed ? ` (licensee ${parsed.licenseeId}, flow ${parsed.flow})` : ""}`);
        return res.status(400).type("html").send(brokerPage("Sign-in could not continue", REFUSAL_TEXT[target.reason]));
      }
      return res.redirect(302, target.url);
    }),
  );
  return router;
}
