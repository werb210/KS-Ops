// KS_OPS_BETA_v1 - the beta features programme. KS-Ops is the source of truth:
//   beta_features     the catalogue (key, name, description, status, plans that may join, open/closed, links)
//   beta_enrolments   which licensee is in which beta
//   beta_feedback     what licensees said about a beta
// A licensee's server is sent its own view of the catalogue (betaSnapshot) with the plan push, PUT /api/plan
// { beta_features: [...] } (see sync/planPush.ts). Servers that do not know the field ignore it.
//
// Whether a feature is on for a licensee:
//   private_beta  only when enrolled (staff enrol; the licensee only sees it once enrolled)
//   public_beta   only when enrolled; eligible licensee admins can join and leave themselves while it is open
//   ga            on for every licensee whose plan may use it (no enrolment needed, cannot be left)
//   retired       off for everyone and not shown
// A plan list limits who may join (and who gets a GA feature). An empty list = every plan.
import { z } from "zod";
import type { Q } from "../db.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { PLANS } from "../pricing.js";
import { pushPlanFor } from "../billing/adminTrialPlan.js";

export const BETA_STATUSES = ["private_beta", "public_beta", "ga", "retired"] as const;
export type BetaStatus = (typeof BETA_STATUSES)[number];
export const BETA_STATUS_NAMES: Record<BetaStatus, string> = {
  private_beta: "Private beta",
  public_beta: "Public beta",
  ga: "Generally available",
  retired: "Retired",
};

export const BETA_KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;

export type BetaFeatureRow = {
  key: string;
  name: string;
  description: string;
  status: BetaStatus;
  plans: string[];
  open: boolean;
  feedback_url: string | null;
  docs_url: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
  updated_by?: string | null;
};

/** What a licensee's server is told about one feature. */
export type BetaFlag = {
  key: string;
  name: string;
  description: string;
  status: BetaStatus;
  /** The feature is on for this licensee: isEnabled(key) is true on its server. */
  enabled: boolean;
  enrolled: boolean;
  /** Their admin may join it now (public beta, open, plan allowed, not yet in). */
  can_join: boolean;
  /** Their admin may leave it (in a beta; a GA feature cannot be left). */
  can_leave: boolean;
  feedback_url: string | null;
  docs_url: string | null;
};

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "Use a full https:// link.")
  .transform((v) => (v === "" ? null : v));

const plansField = z
  .array(z.enum(PLANS, { error: `Plans must be from: ${PLANS.join(", ")}.` }))
  .max(PLANS.length)
  .transform((v) => [...new Set(v)]);

export const betaCreateSchema = z.object({
  key: z
    .string({ error: (iss) => (iss.input === undefined ? "Enter a key." : undefined) })
    .trim()
    .toLowerCase()
    .regex(BETA_KEY_RE, "2 to 63 lowercase letters, numbers and underscores, starting with a letter."),
  name: z.string({ error: (iss) => (iss.input === undefined ? "Enter a name." : undefined) }).trim().min(1, "Enter a name.").max(120),
  description: z.string().trim().max(2000).default(""),
  status: z.enum(BETA_STATUSES).default("private_beta"),
  plans: plansField.default([]),
  open: z.boolean().default(true),
  feedback_url: httpsUrl.nullable().optional(),
  docs_url: httpsUrl.nullable().optional(),
});

export const betaUpdateSchema = betaCreateSchema.omit({ key: true }).partial().extend({
  // Defaults must not apply on a partial update.
  description: z.string().trim().max(2000).optional(),
  status: z.enum(BETA_STATUSES).optional(),
  plans: plansField.optional(),
  open: z.boolean().optional(),
});

export const betaFeedbackSchema = z.object({
  feature_key: z.string().trim().toLowerCase().regex(BETA_KEY_RE, "Unknown feature."),
  message: z.string({ error: (iss) => (iss.input === undefined ? "Write your feedback." : undefined) }).trim().min(1, "Write your feedback.").max(5000),
  rating: z.coerce.number().int().min(1).max(5).optional().nullable(),
  author_name: z.string().trim().max(200).optional().nullable(),
  author_email: z.string().trim().max(200).optional().nullable(),
});

export const betaEnrolmentRequestSchema = z.object({
  feature_key: z.string().trim().toLowerCase().regex(BETA_KEY_RE, "Unknown feature."),
  action: z.enum(["join", "leave"]),
  requested_by: z.string().trim().max(200).optional().nullable(),
});

export function rowToFeature(row: Record<string, any>): BetaFeatureRow {
  return {
    key: String(row.key),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    status: (BETA_STATUSES as readonly string[]).includes(row.status) ? row.status : "retired",
    plans: Array.isArray(row.plans) ? row.plans.map(String) : [],
    open: row.open !== false,
    feedback_url: row.feedback_url ?? null,
    docs_url: row.docs_url ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by ?? null,
  };
}

/** The plan a licensee's features are judged on: the plan its server runs (Pro during a staff free trial). */
export function effectivePlan(l: Pick<LicenseeRow, "plan"> & Partial<LicenseeRow>, now: Date = new Date()): string {
  return pushPlanFor(l, now);
}

export const planAllowed = (f: Pick<BetaFeatureRow, "plans">, plan: string): boolean => !f.plans.length || f.plans.includes(plan);

/** One feature as one licensee sees it, or null when it is not shown to them. */
export function flagFor(f: BetaFeatureRow, plan: string, enrolled: boolean): BetaFlag | null {
  const allowed = planAllowed(f, plan);
  const base = { key: f.key, name: f.name, description: f.description, status: f.status, feedback_url: f.feedback_url, docs_url: f.docs_url };
  switch (f.status) {
    case "retired":
      return null;
    case "ga":
      if (!allowed) return null;
      return { ...base, enabled: true, enrolled, can_join: false, can_leave: false };
    case "private_beta":
      if (!enrolled) return null;
      return { ...base, enabled: true, enrolled: true, can_join: false, can_leave: true };
    case "public_beta":
      if (enrolled) return { ...base, enabled: true, enrolled: true, can_join: false, can_leave: true };
      if (!allowed) return null;
      return { ...base, enabled: false, enrolled: false, can_join: f.open, can_leave: false };
  }
}

/** Every feature this licensee may see, in catalogue order. */
export function snapshotFrom(features: BetaFeatureRow[], plan: string, enrolledKeys: Iterable<string>): BetaFlag[] {
  const enrolled = new Set(enrolledKeys);
  return features.map((f) => flagFor(f, plan, enrolled.has(f.key))).filter((x): x is BetaFlag => x !== null);
}

export async function listFeatures(db: Q): Promise<BetaFeatureRow[]> {
  const r = await db.query("SELECT * FROM beta_features ORDER BY created_at, key");
  return r.rows.map(rowToFeature);
}

export async function getFeature(db: Q, key: string): Promise<BetaFeatureRow | null> {
  const r = await db.query("SELECT * FROM beta_features WHERE key = $1", [key]);
  return r.rows[0] ? rowToFeature(r.rows[0]) : null;
}

export async function enrolledKeys(db: Q, licenseeId: string): Promise<string[]> {
  const r = await db.query("SELECT feature_key FROM beta_enrolments WHERE licensee_id = $1", [licenseeId]);
  return r.rows.map((x) => String(x.feature_key));
}

/** The licensee's view of the catalogue, as pushed to its server. */
export async function betaSnapshot(db: Q, l: Pick<LicenseeRow, "id" | "plan"> & Partial<LicenseeRow>, now: Date = new Date()): Promise<BetaFlag[]> {
  const [features, keys] = await Promise.all([listFeatures(db), enrolledKeys(db, l.id)]);
  return snapshotFrom(features, effectivePlan(l, now), keys);
}

/** Adds a licensee to a feature (no-op when already in). True when a row was added. */
export async function enrol(db: Q, key: string, licenseeId: string, source: "ops" | "licensee", by: string): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO beta_enrolments (feature_key, licensee_id, source, enrolled_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (feature_key, licensee_id) DO NOTHING RETURNING feature_key`,
    [key, licenseeId, source, by.slice(0, 200)],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

export async function unenrol(db: Q, key: string, licenseeId: string): Promise<boolean> {
  const r = await db.query("DELETE FROM beta_enrolments WHERE feature_key = $1 AND licensee_id = $2 RETURNING feature_key", [key, licenseeId]);
  return (r.rowCount ?? r.rows.length) > 0;
}

/**
 * Marks every live licensee with a server for a plan push, so a catalogue change reaches them all within 5 minutes
 * (the plan-push retry worker sends them). Returns how many were queued.
 */
export async function queueBetaPushForAll(db: Q): Promise<number> {
  const r = await db.query(
    `UPDATE licensees SET plan_sync_status = 'pending_sync', plan_sync_next_at = NULL, updated_at = now()
      WHERE server_url IS NOT NULL AND status IN ('trial','active','past_due','suspended')
      RETURNING id`,
  );
  return r.rowCount ?? r.rows.length;
}
