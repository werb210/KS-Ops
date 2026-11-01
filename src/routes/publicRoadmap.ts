// KS_OPS_ROADMAP_v1 - the website's public roadmap (KS-Website /roadmap).
//   GET  /api/public/roadmap                       { items: [{ id, title, summary, area, status, votes, shipped_at }] }
//   POST /api/public/roadmap/ideas                 { title, details?, name, email, brokerage?, consent: true,
//                                                    turnstile_token?, website_url } -> 201 { ok, message } | 400 | 429
//   POST /api/public/roadmap/items/:id/vote        { voter_id } -> { votes, voted: true }
//   POST /api/public/roadmap/items/:id/unvote      { voter_id } -> { votes, voted: false }
// Ideas are stored for Keystone staff to review on /ops/roadmap; nothing a broker sends is public until a person
// approves it, and even then only the item's title and summary are shown. Sales is emailed about each new idea.
import { Router } from "express";
import { salesEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { limiter } from "../lib/clientIp.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { clientIp, h, parseBody, UUID_RE } from "../lib/http.js";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile.js";
import { IDEA_CONSENT_TEXT, IDEA_THANKS, ideaSchema, listPublic, saltedHash, vote, votesFromIp, voteSchema } from "../roadmap/roadmap.js";

/** Most +1s one address may give in a day. */
export const VOTES_PER_IP_PER_DAY = 60;

export function publicRoadmapRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/",
    limiter(120, 60_000),
    h(async (_req, res) => {
      const items = await listPublic(deps.db);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ items });
    }),
  );

  router.post(
    "/ideas",
    limiter(6, 60 * 60_000),
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.website_url !== undefined && body.website_url !== null && String(body.website_url).trim() !== "") {
        console.warn(`[roadmap] honeypot filled from ${clientIp(req)}`);
        return res.status(400).json({ errors: { form: "We could not accept this idea. Please try again." } });
      }
      const parsed = parseBody(ideaSchema, body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      if (!/\p{L}/u.test(v.name)) return res.status(400).json({ errors: { name: "Enter your name" } });
      const ip = clientIp(req);
      if (turnstileEnabled() && !(await verifyTurnstile(v.turnstile_token, ip, deps.fetch))) {
        return res.status(400).json({ errors: { turnstile_token: "Please confirm you are not a robot and try again." } });
      }
      const now = deps.now();
      // The same person sending the same idea again within a day is thanked but not stored twice.
      const dup = await deps.db.query(
        "SELECT id FROM roadmap_ideas WHERE lower(email) = $1 AND lower(title) = lower($2) AND created_at > $3 LIMIT 1",
        [v.email, v.title, new Date(now.getTime() - 86_400_000)],
      );
      if (dup.rows.length) return res.status(201).json({ ok: true, message: IDEA_THANKS });
      await deps.db.query(
        `INSERT INTO roadmap_ideas (title, details, name, email, brokerage, consent_text, consent_at, ip_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`,
        [v.title, v.details || null, v.name, v.email, v.brokerage || null, IDEA_CONSENT_TEXT, now, ip ? saltedHash("ip", ip) : null],
      );
      await sendQuietly(
        deps.mailer,
        {
          to: [salesEmail()],
          subject: `Roadmap idea: ${v.title.slice(0, 80)}`,
          ...bodies([
            `${v.name}${v.brokerage ? ` from ${v.brokerage}` : ""} suggested a feature on the website. Review it on /ops/roadmap before it shows publicly.`,
            `Email: ${v.email}`,
            v.title,
            ...(v.details ? [v.details] : []),
          ]),
        },
        "roadmap idea notice",
      );
      return res.status(201).json({ ok: true, message: IDEA_THANKS });
    }),
  );

  const voteRoute = (on: boolean) =>
    h(async (req, res) => {
      const id = String(req.params.id ?? "");
      if (!UUID_RE.test(id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(voteSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const ip = clientIp(req);
      if (on && (await votesFromIp(deps.db, ip, new Date(deps.now().getTime() - 86_400_000))) >= VOTES_PER_IP_PER_DAY) {
        return res.status(429).json({ error: "too_many_votes", message: "That's a lot of votes from one place today. Try again tomorrow." });
      }
      const votes = await vote(deps.db, id, parsed.data.voter_id, ip, on);
      if (votes === null) return res.status(404).json({ error: "not_found", message: "That roadmap item isn't open for votes." });
      return res.json({ votes, voted: on });
    });
  router.post("/items/:id/vote", limiter(60, 60 * 60_000), voteRoute(true));
  router.post("/items/:id/unvote", limiter(60, 60 * 60_000), voteRoute(false));

  return router;
}
