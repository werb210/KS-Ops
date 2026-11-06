// KS_OPS_ONBOARDING_v1 - staff view and edit of a licensee's sign-up team and licence agreement (mounted under /api/ops
// behind requireStaff; shown on /ops/provisioning):
//   GET /api/ops/licensees/:id/onboarding   the roster (owner first, with what provisioning did), whether it is locked,
//                                           and the agreement signature
//   PUT /api/ops/licensees/:id/team         { team: [...] } - same rules as the website; refused once the team is invited
import { Router } from "express";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, UUID_RE } from "../lib/http.js";
import { audit, getLicensee } from "../licensees/repo.js";
import { AGREEMENT_VERSION, signedAgreement } from "../onboarding/agreement.js";
import { getTeam, parseTeam, replaceTeam, teamLocked, teamOrOwner, teamView } from "../onboarding/team.js";
import { machineDeps } from "../provisioning/index.js";
import { nudgeRun, signatureView } from "./publicOnboarding.js";

export function opsOnboardingRouter(deps: Deps): Router {
  const router = Router();
  const store = () => machineDeps(deps).store;
  const licensee = async (id: string) => (UUID_RE.test(id) ? getLicensee(deps.db, id) : null);

  router.get(
    "/licensees/:id/onboarding",
    h(async (req, res) => {
      const l = await licensee(String(req.params.id));
      if (!l) return res.status(404).json({ error: "not_found" });
      const rows = await getTeam(deps.db, l.id);
      const a = await signedAgreement(deps.db, l.id);
      return res.json({
        seats: l.seats,
        locked: await teamLocked(store(), l.id),
        team: rows.length ? rows.map(teamView) : (await teamOrOwner(deps.db, l)).map(teamView),
        roster_saved: rows.length > 0,
        agreement: {
          current_version: AGREEMENT_VERSION,
          signed: signatureView(a),
          ip: a?.ip ?? null,
          sha256: a?.text_sha256 ?? null,
          emailed_at: a?.emailed_at ?? null,
          link_sent_at: l.agreement_link_sent_at ?? null,
          reminder_sent_at: l.agreement_reminder_sent_at ?? null,
        },
        onboarding_email_sent_at: l.onboarding_email_sent_at ?? null,
      });
    }),
  );

  router.put(
    "/licensees/:id/team",
    h(async (req, res) => {
      const l = await licensee(String(req.params.id));
      if (!l) return res.status(404).json({ error: "not_found" });
      if (await teamLocked(store(), l.id)) {
        return res.status(409).json({ error: "team_locked", message: "The team has been created on the brokerage's server. Change people from the brokerage's portal (Settings > Users)." });
      }
      const parsed = parseTeam(req.body?.team, l, l.seats);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors, message: Object.values(parsed.errors).join(" ") });
      await replaceTeam(deps.db, l.id, parsed.members);
      await audit(deps.db, actorOf(req), "licensee.team_updated", l.id, { people: parsed.members.length });
      await nudgeRun(store(), l.id, deps.now());
      return res.json({ ok: true, team: (await getTeam(deps.db, l.id)).map(teamView) });
    }),
  );

  return router;
}
