// KS_OPS_ONBOARDING_v1 - the provisioning steps after the owner's sign-in email:
//   licence_agreement  waits until the owner has signed the Keystone Software Licence Agreement. Emails the link once if
//                      it was not sent after payment, and one reminder 24 hours later. Never fails by itself.
//   team_users         creates each person on the sign-up roster on the brokerage's server (POST /api/provision/users;
//                      the owner was already made by admin_user), then emails every one except the owner their invite
//                      with a quick guide. Safe to run again: people already created or invited are skipped.
//   onboarding_email   emails the owner once, from support, introducing their onboarding contact and how to book the
//                      Microsoft Teams setup session for their support level.
// Runs that started before these steps existed have no rows for them and finish as before.
import type { ExecCtx, Executor, StepOutcome } from "./executors.js";
import { audit, newSignupToken, opsKeyOf, signupTokenOf } from "../licensees/repo.js";
import { signedAgreement } from "../onboarding/agreement.js";
import { signupLink } from "../onboarding/config.js";
import { agreementLinkMail, brokerInviteMail, ownerOnboardingMail } from "../onboarding/emails.js";
import { getTeam, teamOrOwner, type TeamRow } from "../onboarding/team.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const AGREEMENT_REMINDER_AFTER_MS = 24 * HOUR;
const AGREEMENT_RECHECK_MS = HOUR;
const CALL_LIMIT_MS = 30 * MIN;

const trim = (u: string | null | undefined) => String(u ?? "").replace(/\/+$/, "");
const envOf = (ctx: ExecCtx) => ctx.deps.env ?? process.env;
const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

function waitOrFail(ctx: ExecCtx, retryMs: number, message: string): StepOutcome {
  const started = ms(ctx.step.started_at) || ctx.deps.now().getTime();
  if (ctx.deps.now().getTime() - started > CALL_LIMIT_MS) return { kind: "failed", error: `${message} (gave up after ${CALL_LIMIT_MS / MIN} minutes)` };
  return { kind: "wait", retryMs, message };
}

async function agreementLink(ctx: ExecCtx): Promise<string> {
  const l = ctx.licensee;
  let token = signupTokenOf(l);
  if (!token) {
    try {
      token = await newSignupToken(ctx.deps.db, l.id);
    } catch (err) {
      console.error("[provisioning] no signup token for the agreement link", { licensee: l.id, message: err instanceof Error ? err.message : String(err) });
      token = null;
    }
  }
  return signupLink("agreement", l.id, token, envOf(ctx));
}

export const licenceAgreement: Executor = async (ctx) => {
  const l = ctx.licensee;
  const signed = await signedAgreement(ctx.deps.db, l.id);
  if (signed) {
    return {
      kind: "done",
      output: { version: signed.version, signed_at: signed.signed_at, signer: signed.signer_name },
      message: `signed by ${signed.signer_name} (${signed.signer_title}), version ${signed.version}`,
    };
  }
  const now = ctx.deps.now();
  if (!l.agreement_link_sent_at) {
    const link = await agreementLink(ctx);
    const r = await ctx.deps.mailer(agreementLinkMail(l, link, false, envOf(ctx)));
    if (r.ok) {
      await ctx.deps.db.query("UPDATE licensees SET agreement_link_sent_at = $2, updated_at = now() WHERE id = $1 AND agreement_link_sent_at IS NULL", [l.id, now]);
      await ctx.log(`agreement link emailed to ${l.contact_email}`);
    } else {
      await ctx.log(`agreement link not emailed yet (${r.error ?? "unknown error"}); trying again`, "warn");
    }
  } else if (!l.agreement_reminder_sent_at && now.getTime() - ms(l.agreement_link_sent_at) >= AGREEMENT_REMINDER_AFTER_MS) {
    const link = await agreementLink(ctx);
    const r = await ctx.deps.mailer(agreementLinkMail(l, link, true, envOf(ctx)));
    if (r.ok) {
      await ctx.deps.db.query("UPDATE licensees SET agreement_reminder_sent_at = $2, updated_at = now() WHERE id = $1 AND agreement_reminder_sent_at IS NULL", [l.id, now]);
      await ctx.log(`agreement reminder emailed to ${l.contact_email}`);
    } else {
      await ctx.log(`agreement reminder not emailed yet (${r.error ?? "unknown error"}); trying again`, "warn");
    }
  }
  return {
    kind: "wait",
    retryMs: AGREEMENT_RECHECK_MS,
    message: `Waiting for ${l.contact_name} to sign the licence agreement. The team is invited once it is signed.`,
  };
};

type ServerResult = { email?: string; status?: string; user_id?: string; error?: string };

export const teamUsers: Executor = async (ctx) => {
  const l = ctx.licensee;
  const others = (await getTeam(ctx.deps.db, l.id)).filter((t) => !t.is_owner);
  if (!others.length) return { kind: "done", output: { created: 0, invited: 0 }, message: "no one else on the sign-up roster (the owner was made by admin_user)" };
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return { kind: "failed", error: "No server address or ops key on the licensee." };
  if (!l.portal_url) return { kind: "failed", error: "The licensee has no portal address." };

  const todo = others.filter((t) => !t.provisioned_at);
  let created = 0;
  let existing = 0;
  if (todo.length) {
    let r: Response;
    try {
      r = await ctx.deps.fetch(`${trim(l.server_url)}/api/provision/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops provisioning", "X-KS-Tenant": l.company_code },
        body: JSON.stringify({ users: todo.map((t) => ({ name: t.full_name, email: t.email, phone: t.phone_e164, role: t.role })) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[provisioning] team users request failed", { licensee: l.id, message });
      return waitOrFail(ctx, 5 * MIN, `team users: ${message}`);
    }
    const body = (await r.json().catch(() => ({}))) as { error?: string; results?: ServerResult[] };
    if (r.status === 404) return { kind: "failed", error: "The licensee's KS-server has no /api/provision/users (deploy a newer KS-server)." };
    if (r.status === 400) return { kind: "failed", error: `KS-server refused the team: ${String(body.error ?? r.status)}` };
    if (!r.ok) {
      console.error("[provisioning] team users refused", { licensee: l.id, status: r.status, error: body.error });
      return waitOrFail(ctx, 5 * MIN, `team users: KS-server answered ${r.status}`);
    }
    const results = Array.isArray(body.results) ? body.results : [];
    const refused: string[] = [];
    for (const t of todo) {
      const res = results.find((x) => String(x.email ?? "").toLowerCase() === t.email.toLowerCase());
      if (res && (res.status === "created" || res.status === "existing")) {
        if (res.status === "created") created += 1;
        else existing += 1;
        await ctx.deps.db.query(
          "UPDATE licensee_team SET server_user_id = $2, provisioned_at = $3, updated_at = now() WHERE id = $1",
          [t.id, res.user_id ? String(res.user_id) : null, ctx.deps.now()],
        );
        t.provisioned_at = ctx.deps.now();
      } else {
        refused.push(`${t.full_name} <${t.email}>: ${res?.error ?? "no answer for this person"}`);
      }
    }
    if (refused.length) {
      console.error("[provisioning] team members refused by KS-server", { licensee: l.id, refused });
      return { kind: "failed", error: `KS-server refused ${refused.length} team member(s): ${refused.join("; ")}. Fix them on /ops/provisioning (Team), then press Retry step.` };
    }
  }

  const invited: string[] = [];
  const failed: string[] = [];
  for (const t of others.filter((x: TeamRow) => x.provisioned_at && !x.invite_sent_at)) {
    const sent = await ctx.deps.mailer(brokerInviteMail(l, t, envOf(ctx)));
    if (sent.ok) {
      await ctx.deps.db.query("UPDATE licensee_team SET invite_sent_at = $2, updated_at = now() WHERE id = $1", [t.id, ctx.deps.now()]);
      invited.push(t.email);
    } else {
      failed.push(`${t.email} (${sent.error ?? "unknown error"})`);
    }
  }
  if (invited.length) await audit(ctx.deps.db, "ks-ops provisioning", "licensee.team_invited", l.id, { run_id: ctx.run.id, invited });
  if (failed.length) return waitOrFail(ctx, 5 * MIN, `invite email not sent to ${failed.join(", ")}`);
  return {
    kind: "done",
    output: { created, existing, invited: invited.length },
    message: `${created} created, ${existing} already there, ${invited.length} invite(s) emailed`,
  };
};

export const onboardingEmail: Executor = async (ctx) => {
  const l = ctx.licensee;
  if (l.onboarding_email_sent_at) return { kind: "done", output: { already_sent: true }, message: "the onboarding email was already sent" };
  if (!l.portal_url) return { kind: "failed", error: "The licensee has no portal address." };
  const team = await teamOrOwner(ctx.deps.db, l);
  const r = await ctx.deps.mailer(ownerOnboardingMail(l, team, envOf(ctx)));
  if (!r.ok) return waitOrFail(ctx, 5 * MIN, `onboarding email not sent: ${r.error ?? "unknown error"}`);
  await ctx.deps.db.query("UPDATE licensees SET onboarding_email_sent_at = $2, updated_at = now() WHERE id = $1 AND onboarding_email_sent_at IS NULL", [l.id, ctx.deps.now()]);
  return { kind: "done", output: { sent_to: l.contact_email, support_level: l.support_level }, message: `onboarding email sent to ${l.contact_email}` };
};

export const ONBOARDING_EXECUTORS: Record<string, Executor> = {
  licence_agreement: licenceAgreement,
  team_users: teamUsers,
  onboarding_email: onboardingEmail,
};
