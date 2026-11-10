// KS_OPS_ONBOARDING_v1 - the website's licence agreement and team pages, for one sign-up (?token= is its signup token):
//   GET  /api/public/signup/:id/agreement   the agreement rendered for this licensee, and the signature if signed
//   POST /api/public/signup/:id/agreement   { signer_name, signer_title, agree: true, sha256? } - click to sign
//   GET  /api/public/signup/:id/team        the roster (owner first), the seats and whether it can still be changed
//   PUT  /api/public/signup/:id/team        { team: [{ full_name, email, phone, role }] } - until the team is invited
import { Router, type Request } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { matchesHash } from "../lib/crypto.js";
import { sendQuietly } from "../lib/email.js";
import { limiter } from "../lib/clientIp.js";
import { clientIp, h, parseBody, UUID_RE } from "../lib/http.js";
import { audit, getLicensee, type LicenseeRow } from "../licensees/repo.js";
import { recordSignature, renderAgreement, signedAgreement, signedCopyMail, type AgreementRow } from "../onboarding/agreement.js";
import { getTeam, parseTeam, replaceTeam, teamLocked, teamOrOwner, teamView } from "../onboarding/team.js";
import { machineDeps } from "../provisioning/index.js";
import type { ProvisioningStore } from "../provisioning/store.js";

const notFound = { error: "not_found", message: "We could not find that sign-up." };

export const signSchema = z.object({
  signer_name: z.string({ error: "Type your full name." }).trim().min(2, "Type your full name.").max(120, "Names must be 120 characters or fewer."),
  signer_title: z.string({ error: "Type your title." }).trim().min(2, "Type your title, for example Owner or President.").max(80, "Titles must be 80 characters or fewer."),
  agree: z.literal(true, { error: "Tick the box to agree." }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export function signatureView(a: AgreementRow | null) {
  return a ? { version: a.version, signer_name: a.signer_name, signer_title: a.signer_title, signed_at: a.signed_at } : null;
}

/** Wakes the licensee's live provisioning run so a signature or roster change is picked up straight away. */
export async function nudgeRun(store: ProvisioningStore, licenseeId: string, now: Date): Promise<void> {
  try {
    const run = await store.liveRun(licenseeId, "provision");
    if (run) await store.updateRun(run.id, { next_attempt_at: now });
  } catch (err) {
    console.error("[onboarding] could not nudge the provisioning run", { licensee: licenseeId, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Saves a signature and emails the signed copy (owner and sales) once. Shared by the website and tests. */
export async function signAgreement(deps: Pick<Deps, "db" | "mailer" | "now">, l: LicenseeRow, input: { signer_name: string; signer_title: string; ip: string; user_agent: string }, actor: string) {
  const { row, created } = await recordSignature(deps.db, l, input);
  if (created) {
    await audit(deps.db, actor, "licensee.agreement_signed", l.id, { version: row.version, signer_name: row.signer_name, signer_title: row.signer_title, ip: row.ip, sha256: row.text_sha256 });
    if (await sendQuietly(deps.mailer, signedCopyMail(l, row), "signed agreement copy")) {
      await deps.db.query("UPDATE licence_agreements SET emailed_at = now() WHERE id = $1", [row.id]);
    }
  }
  return { row, created };
}

export function publicOnboardingRouter(deps: Deps): Router {
  const router = Router();
  const store = () => machineDeps(deps).store;

  const signupFor = async (req: Request): Promise<LicenseeRow | null> => {
    const id = String(req.params.id);
    const l = UUID_RE.test(id) ? await getLicensee(deps.db, id) : null;
    return l && l.status !== "cancelled" && matchesHash(req.query.token, l.signup_token_hash) ? l : null;
  };

  router.get(
    "/signup/:id/agreement",
    limiter(120, 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const l = await signupFor(req);
      if (!l) return res.status(404).json(notFound);
      const doc = renderAgreement(l);
      const signed = await signedAgreement(deps.db, l.id);
      return res.json({
        company_name: l.company_name,
        legal_name: l.legal_name,
        contact_name: l.contact_name,
        contact_title: l.contact_title ?? "",
        version: doc.version,
        title: doc.title,
        html: doc.html,
        text: doc.text,
        sha256: doc.sha256,
        signed: signatureView(signed),
      });
    }),
  );

  router.post(
    "/signup/:id/agreement",
    limiter(20, 15 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const l = await signupFor(req);
      if (!l) return res.status(404).json(notFound);
      const parsed = parseBody(signSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const doc = renderAgreement(l);
      // The person signs the text they were shown: if the order changed since, they see the new text first.
      if (parsed.data.sha256 && parsed.data.sha256 !== doc.sha256) {
        const already = await signedAgreement(deps.db, l.id);
        if (!already || already.version !== doc.version) {
          return res.status(409).json({ error: "agreement_changed", message: "The agreement was updated. Please read the new version and sign again." });
        }
      }
      const { row, created } = await signAgreement(
        deps,
        l,
        { signer_name: parsed.data.signer_name, signer_title: parsed.data.signer_title, ip: clientIp(req), user_agent: String(req.get("user-agent") ?? "") },
        "website",
      );
      await nudgeRun(store(), l.id, deps.now());
      return res.status(created ? 201 : 200).json({ ok: true, signed: signatureView(row) });
    }),
  );

  router.get(
    "/signup/:id/team",
    limiter(120, 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const l = await signupFor(req);
      if (!l) return res.status(404).json(notFound);
      const rows = await getTeam(deps.db, l.id);
      const team = rows.length ? rows.map(teamView) : (await teamOrOwner(deps.db, l)).map(teamView);
      return res.json({ company_name: l.company_name, seats: l.seats, locked: await teamLocked(store(), l.id), team });
    }),
  );

  router.put(
    "/signup/:id/team",
    limiter(30, 15 * 60_000),
    h(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const l = await signupFor(req);
      if (!l) return res.status(404).json(notFound);
      if (await teamLocked(store(), l.id)) {
        return res.status(409).json({ error: "team_locked", message: "Your team has already been invited. Add or change people from Settings > Users in your portal." });
      }
      const parsed = parseTeam(req.body?.team, l, l.seats);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      await replaceTeam(deps.db, l.id, parsed.members);
      await audit(deps.db, "website", "licensee.team_updated", l.id, { people: parsed.members.length, ip: clientIp(req) });
      await nudgeRun(store(), l.id, deps.now());
      return res.json({ ok: true, seats: l.seats, locked: false, team: (await getTeam(deps.db, l.id)).map(teamView) });
    }),
  );

  return router;
}
