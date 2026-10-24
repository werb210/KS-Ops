// What KS-Ops tells the Keystone CRM (BF-Server, KS silo), and when. Every function only queues (src/crm/outbox.ts)
// and never throws, so a CRM problem can never break a sign-up, a demo or a Stripe webhook.
//
// Demo sign-ups (source "demo_signup", external_id = demo_signups.id):
//   sign-up -> stage lead + event signup; first open -> demo_started + demo_opened; progress -> one demo_step event
//   per step reached (sent at most once a minute); finished -> demo_finished + demo_completed + a note of what they
//   did; idle/expired unfinished -> a note only.
// Licensees (source "website_signup" for website sign-ups, "licensee" for staff-created; external_id = licensees.id):
//   created -> stage signed_up + event signup; Stripe payment -> paying + event payment; status changes (suspended,
//   cancelled, past_due, ...) -> event status_change and the company status (cancelled never sets "lost").
// Beta programme sign-ups (KS_OPS_BETA_v1; source "website_signup", external_id = beta_signups.id): stage lead (none
//   when the email is already a licensee contact) + event signup + a note of their interests.
import type { Deps } from "../deps.js";
import { DEMO_STEPS } from "../demo/config.js";
import { digestEvents, type DemoEvent, type Digest } from "../demo/digest.js";
import { digestLines } from "../demo/emails.js";
import type { CrmPayload, CrmSource } from "../lib/bfCrm.js";
import { normalizeNaPhone } from "../lib/sms.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { PLAN_NAMES } from "../pricing.js";
import { enqueueCrm } from "./outbox.js";

type CrmDeps = Pick<Deps, "db" | "now">;

/** Demo progress pushes wait this long, so a demo is pushed at most once a minute. */
export const DEMO_PROGRESS_DELAY_MS = 60_000;

const iso = (d: Date | string | null | undefined, fallback: Date): string => new Date(d ?? fallback).toISOString();
const phoneOf = (raw: string | null | undefined): string | null => {
  const s = String(raw ?? "").trim();
  return s ? normalizeNaPhone(s) ?? s : null;
};

// ---- demo sign-ups ----

type DemoLike = { id: string; name: string; email: string; phone?: string | null; company: string; created_at?: Date | string };

function demoBase(s: DemoLike): CrmPayload {
  return {
    source: "demo_signup",
    external_id: s.id,
    contact: { name: s.name, email: s.email, phone: phoneOf(s.phone), title: null },
    company: { name: s.company },
  };
}

export async function crmDemoSignup(deps: CrmDeps, s: DemoLike): Promise<void> {
  await enqueueCrm(deps, {
    ...demoBase(s),
    stage: "lead",
    events: [{ type: "signup", at: iso(s.created_at, deps.now()), summary: "Asked for the self-serve Keystone demo on the website." }],
  });
}

export async function crmDemoOpened(deps: CrmDeps, s: DemoLike, openedAt: Date): Promise<void> {
  await enqueueCrm(deps, {
    ...demoBase(s),
    stage: "demo_started",
    events: [{ type: "demo_opened", at: openedAt.toISOString(), summary: "Opened the demo for the first time." }],
  });
}

/**
 * One demo_step event per step reached, timed at the first action on that step (so a resend is a duplicate the CRM
 * ignores). Held back a minute and coalesced, so a busy demo is pushed at most once a minute.
 */
export function demoStepEvents(events: DemoEvent[], digest: Digest = digestEvents(events)): CrmPayload["events"] {
  const firstAt = new Map<string, number>();
  for (const e of events) {
    if (!e.step) continue;
    const t = new Date(e.at).getTime();
    if (!firstAt.has(e.step) || t < firstAt.get(e.step)!) firstAt.set(e.step, t);
  }
  const out: NonNullable<CrmPayload["events"]> = [];
  DEMO_STEPS.forEach(([key, label], i) => {
    const t = firstAt.get(key);
    if (t === undefined) return;
    const done = digest.steps_completed.includes(key) ? " (completed)" : "";
    out.push({ type: "demo_step", at: new Date(t).toISOString(), summary: `Reached step ${i + 1} of ${DEMO_STEPS.length}: ${label}${done}.` });
  });
  return out;
}

export async function crmDemoProgress(deps: CrmDeps, s: DemoLike, events: DemoEvent[]): Promise<void> {
  const steps = demoStepEvents(events);
  if (!steps?.length) return;
  await enqueueCrm(deps, { ...demoBase(s), events: steps }, { delayMs: DEMO_PROGRESS_DELAY_MS });
}

export function demoFinishedNote(s: DemoLike, d: Digest): string {
  return [`${s.name} from ${s.company} finished the Keystone demo and was emailed the sample lender package.`, ...digestLines(d)].join("\n");
}

export async function crmDemoCompleted(deps: CrmDeps, s: DemoLike & { completed_at?: Date | string | null }, d: Digest | null): Promise<void> {
  await enqueueCrm(deps, {
    ...demoBase(s),
    stage: "demo_finished",
    events: [{ type: "demo_completed", at: iso(s.completed_at, deps.now()), summary: "Finished the demo (submitted the file to lenders)." }],
    ...(d ? { note: demoFinishedNote(s, d) } : {}),
  });
}

export async function crmDemoUnfinished(deps: CrmDeps, s: DemoLike, d: Digest, reason: "idle" | "expired", idleHours: number): Promise<void> {
  const why = reason === "expired" ? "the demo has expired" : `no activity for ${idleHours} hours`;
  const reached = DEMO_STEPS.find(([k]) => k === d.last_step)?.[1] ?? "not started";
  await enqueueCrm(deps, {
    ...demoBase(s),
    note: [`${s.name} started the Keystone demo but did not finish it (${why}). They got as far as: ${reached}.`, ...digestLines(d)].join("\n"),
  });
}

// ---- licensees ----

export function licenseeSource(l: Pick<LicenseeRow, "source">): CrmSource {
  return l.source === "website" ? "website_signup" : "licensee";
}

type LicenseeLike = Pick<
  LicenseeRow,
  "id" | "source" | "company_name" | "company_code" | "website" | "plan" | "seats" | "status" | "contact_name" | "contact_email" | "contact_phone"
>;

function licenseeBase(l: LicenseeLike, status = l.status): CrmPayload {
  return {
    source: licenseeSource(l),
    external_id: l.id,
    contact: { name: l.contact_name, email: l.contact_email, phone: phoneOf(l.contact_phone), title: null },
    company: {
      name: l.company_name,
      website: l.website ?? null,
      company_code: l.company_code,
      plan: l.plan,
      seats: Number(l.seats),
      status,
    },
  };
}

export async function crmLicenseeCreated(deps: CrmDeps, l: LicenseeLike & { created_at?: Date | string }): Promise<void> {
  const how = l.source === "website" ? "Signed up on the Keystone website" : "Licensee created by Keystone staff";
  await enqueueCrm(deps, {
    ...licenseeBase(l),
    stage: "signed_up",
    events: [{ type: "signup", at: iso(l.created_at, deps.now()), summary: `${how}: ${PLAN_NAMES[l.plan] ?? l.plan} plan, ${l.seats} seat(s).` }],
  });
}

/** Stripe confirmed money in (checkout paid, or an invoice of its subscription paid). */
export async function crmLicenseePaid(deps: CrmDeps, l: LicenseeLike, status: string, at: Date, summary: string): Promise<void> {
  await enqueueCrm(deps, {
    ...licenseeBase(l, status),
    stage: "paying",
    events: [{ type: "payment", at: at.toISOString(), summary }],
  });
}

/** A status change (no stage change: staff decide whether a cancelled licensee is lost). */
export async function crmLicenseeStatus(deps: CrmDeps, l: LicenseeLike, from: string, to: string, at: Date, by: string): Promise<void> {
  if (from === to) return;
  await enqueueCrm(deps, {
    ...licenseeBase(l, to),
    events: [{ type: "status_change", at: at.toISOString(), summary: `Status changed from ${from} to ${to} (${by}).` }],
  });
}

/** Company details changed by staff (name, plan, seats, ...): refresh the company, no event. */
export async function crmLicenseeUpdated(deps: CrmDeps, l: LicenseeLike): Promise<void> {
  await enqueueCrm(deps, licenseeBase(l));
}

// ---- beta programme sign-ups (KS_OPS_BETA_v1) ----

type BetaSignupLike = {
  id: string; name: string; email: string; brokerage: string; interests: string[]; message?: string | null; created_at?: Date | string;
};

export function betaSignupNote(s: BetaSignupLike): string {
  return [
    `${s.name} from ${s.brokerage} joined the Keystone beta programme on the website.`,
    `Interests: ${s.interests.length ? s.interests.join(", ") : "none chosen"}.`,
    ...(s.message && s.message.trim() ? [`Their note: ${s.message.trim()}`] : []),
  ].join("\n");
}

/**
 * A website beta programme sign-up: a website lead (source "website_signup", external_id = beta_signups.id) with a
 * signup event and a note of their interests. When the email already belongs to a licensee's contact, no stage is
 * sent, so a paying customer is never moved back to "lead".
 */
export async function crmBetaSignup(deps: CrmDeps, s: BetaSignupLike): Promise<void> {
  let existing = false;
  try {
    const r = await deps.db.query("SELECT 1 FROM licensees WHERE lower(contact_email) = lower($1) LIMIT 1", [s.email]);
    existing = r.rows.length > 0;
  } catch (err) {
    console.warn(`[crm] beta sign-up licensee check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await enqueueCrm(deps, {
    source: "website_signup",
    external_id: s.id,
    ...(existing ? {} : { stage: "lead" as const }),
    contact: { name: s.name, email: s.email, phone: null, title: null },
    company: { name: s.brokerage },
    events: [{ type: "signup", at: iso(s.created_at, deps.now()), summary: "Joined the beta programme on the Keystone website." }],
    note: betaSignupNote(s),
  });
}
