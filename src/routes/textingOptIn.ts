// KS_OPS_TWILIO_AUTO_v1 - GET /api/public/texting-opt-in/:code: a public page showing how a licensee's applicants opt in
// to texts (the optional, unticked "Text me updates" box in the client app, with its exact wording). Its address is
// given to Twilio and the carriers in toll-free verification and A2P 10DLC submissions as the proof of opt-in.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { esc } from "../lib/email.js";
import { h } from "../lib/http.js";
import { limiter } from "../lib/clientIp.js";
import { CODE_RE } from "../licensees/validation.js";
import { CONSENT_TEXT } from "../twilio/texting.js";

export function optInPage(l: { company_name: string; client_url: string | null; website: string | null }): string {
  const name = esc(l.company_name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}: how clients agree to texts</title>
<style>body{margin:0;background:#f6f7f9;color:#14171c;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.5rem 1rem 3rem}h1{font-size:1.4rem}section{background:#fff;border:1px solid #cfd5dd;border-radius:10px;padding:1rem 1.2rem;margin:1rem 0}
.box{display:flex;gap:.6rem;align-items:flex-start;border:1px solid #8a94a3;border-radius:8px;padding:.8rem;background:#fff}.check{width:1.2rem;height:1.2rem;border:2px solid #14171c;border-radius:3px;flex:none;margin-top:.2rem}
p.hint{color:#454d59}</style></head><body><main>
<h1>${name}: how clients agree to text messages</h1>
<p>${name} is a business-financing broker. It texts applicants about their own application only, and only after they agree.</p>
<section><h2 style="font-size:1.1rem">Where clients agree</h2>
<p>In ${name}'s client app${l.client_url ? ` (<a href="${esc(l.client_url)}">${esc(l.client_url)}</a>)` : ""}, when an applicant verifies their mobile number, and again under Settings, they see this optional box. It starts unticked, and applying does not need it:</p>
<div class="box"><span class="check" aria-hidden="true"></span><span>${esc(CONSENT_TEXT)}</span></div>
<p class="hint">Unticking it later (or replying STOP) stops the texts. Replying HELP gets contact details.</p></section>
<section><h2 style="font-size:1.1rem">What the texts are</h2>
<p>Status updates on the application, requests for documents, reminders to sign, and replies from the applicant's advisor. No marketing.</p></section>
${l.website ? `<p class="hint">${name}: <a href="${esc(l.website)}">${esc(l.website)}</a></p>` : ""}
</main></body></html>`;
}

export function textingOptInRouter(deps: Pick<Deps, "db">): Router {
  const router = Router();
  router.get(
    "/:code",
    limiter(60, 60_000),
    h(async (req, res) => {
      const code = String(req.params.code).toLowerCase();
      if (!CODE_RE.test(code)) return res.status(404).type("text").send("Not found");
      const r = await deps.db.query(
        "SELECT company_name, client_url, website FROM licensees WHERE company_code = $1 AND status IN ('provisioning','trial','active','past_due','suspended')",
        [code],
      );
      if (!r.rows[0]) return res.status(404).type("text").send("Not found");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.type("html").send(optInPage(r.rows[0]));
    }),
  );
  return router;
}
