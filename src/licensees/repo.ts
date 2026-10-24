// Licensee rows: reads, writes, the ops key and how a licensee is shown to staff.
import type { Q } from "../db.js";
import { decryptSecret, encryptSecret, encryptionKey, newSecret, sha256Hex } from "../lib/crypto.js";
import { monthlyCharge, type BillingInterval, type Plan, type SupportLevel } from "../pricing.js";

export type LicenseeRow = {
  id: string;
  company_name: string;
  legal_name: string;
  company_code: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  country: string;
  province_state: string | null;
  mailing_address: string | null;
  website: string | null;
  status: string;
  plan: Plan;
  billing_interval: BillingInterval;
  support_level: SupportLevel;
  seats: number;
  extra_storage_blocks: number;
  /** How the licensee pays: "acss_debit" (Canadian pre-authorized debit, the default) or "card". */
  payment_method?: string | null;
  /** KS_OPS_BANK_CONNECT_ADDON - add-ons switched on by Keystone staff (not plan features). Missing = none. */
  addons?: Record<string, boolean> | null;
  server_url: string | null;
  client_url: string | null;
  portal_url: string | null;
  logo_url: string | null;
  primary_color: string | null;
  assistant_name: string | null;
  ops_key_hash: string | null;
  /** v3 shared fraud watchlist (opt-in from the licensee's portal). */
  watchlist_opt_in?: boolean;
  watchlist_opt_in_at?: Date | string | null;
  ops_key_encrypted: string | null;
  ops_key_rotated_at: Date | null;
  signup_token_hash: string | null;
  /** The signup token, encrypted with OPS_ENCRYPTION_KEY, so emails can link back to the sign-up. */
  signup_token_encrypted?: string | null;
  /** The company code a cancelled, never-paid sign-up gave up (its company_code was replaced). */
  released_company_code?: string | null;
  /** When the licensee became cancelled (set by a database trigger); its data is purged DATA_RETENTION_DAYS later. */
  cancelled_at?: Date | null;
  /** When the licensee's server reported (or staff marked) the data purge done. */
  purged_at?: Date | null;
  source: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
  onboarding_fee_paid: boolean;
  plan_sync_status: string;
  plan_sync_error: string | null;
  plan_sync_attempts: number;
  plan_sync_next_at: Date | null;
  plan_synced_at: Date | null;
  past_due_since: Date | null;
  past_due_reminder_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function getLicensee(db: Q, id: string): Promise<LicenseeRow | null> {
  const r = await db.query("SELECT * FROM licensees WHERE id = $1", [id]);
  return (r.rows[0] as LicenseeRow) ?? null;
}

export async function codeTaken(db: Q, code: string, exceptId?: string): Promise<boolean> {
  const r = await db.query(
    "SELECT 1 FROM licensees WHERE company_code = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1",
    [code, exceptId ?? null],
  );
  return r.rows.length > 0;
}

/** MRR in dollars: recurring charges (seats, support, storage) per month. Annual billing uses the annual rate. */
export function mrrOf(l: Pick<LicenseeRow, "plan" | "billing_interval" | "seats" | "support_level" | "extra_storage_blocks">): number {
  return monthlyCharge(l).recurring_cents / 100;
}

/** A cancelled licensee can download its data for this long; then KS-server deletes and purges it. */
export const DATA_RETENTION_DAYS = 180;

/** The day a cancelled licensee's data is purged (cancelled_at + 180 days), as YYYY-MM-DD; null when not cancelled. */
export function dataPurgeOn(l: Pick<LicenseeRow, "status" | "cancelled_at">): string | null {
  if (l.status !== "cancelled" || !l.cancelled_at) return null;
  return new Date(new Date(l.cancelled_at).getTime() + DATA_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export type PurgeResult = "purged" | "already_purged" | "not_cancelled" | "not_due";

/**
 * Marks a cancelled licensee's data as purged (its status stays cancelled). Only on or after the purge date; the
 * licensee's server reports it, or staff mark it by hand.
 */
export async function markPurged(db: Q, id: string, now: Date, by: string): Promise<PurgeResult> {
  const l = await getLicensee(db, id);
  if (!l || l.status !== "cancelled") return "not_cancelled";
  if (l.purged_at) return "already_purged";
  const on = dataPurgeOn(l);
  if (!on || now.toISOString().slice(0, 10) < on) return "not_due";
  const r = await db.query(
    "UPDATE licensees SET purged_at = $2, updated_at = now() WHERE id = $1 AND status = 'cancelled' AND purged_at IS NULL RETURNING id",
    [id, now],
  );
  if (!(r.rowCount ?? r.rows.length)) return "already_purged";
  await audit(db, by, "licensee.data_purged", id, { data_purge_on: on });
  return "purged";
}

/** The licensee as staff see it: no hashes or encrypted secrets. */
export function staffView(l: LicenseeRow) {
  const { ops_key_hash, ops_key_encrypted, signup_token_hash, signup_token_encrypted, ...rest } = l;
  return { ...rest, has_ops_key: Boolean(ops_key_hash && ops_key_encrypted), mrr: mrrOf(l), data_purge_on: dataPurgeOn(l) };
}

export const INSERTABLE = [
  "company_name", "legal_name", "company_code", "contact_name", "contact_email", "contact_phone", "country",
  "province_state", "mailing_address", "website", "status", "plan", "billing_interval", "support_level", "seats",
  "extra_storage_blocks", "server_url", "client_url", "portal_url", "logo_url", "primary_color", "assistant_name",
  "signup_token_hash", "signup_token_encrypted", "source", "accepted_terms_at", "accepted_privacy_at", "payment_method",
] as const;

export async function insertLicensee(db: Q, fields: Partial<Record<(typeof INSERTABLE)[number], unknown>>): Promise<LicenseeRow> {
  const cols = INSERTABLE.filter((c) => fields[c] !== undefined);
  const r = await db.query(
    `INSERT INTO licensees (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    cols.map((c) => fields[c]),
  );
  return r.rows[0] as LicenseeRow;
}

export class EncryptionNotConfigured extends Error {
  constructor() {
    super("encryption_not_configured");
  }
}

/** Makes a new ops key, stores its hash and encrypted copy, and returns the plain key (shown once). */
export async function rotateOpsKey(db: Q, id: string): Promise<string> {
  const key = encryptionKey();
  if (!key) throw new EncryptionNotConfigured();
  const opsKey = "ksops_" + newSecret(32);
  await db.query(
    `UPDATE licensees SET ops_key_hash = $2, ops_key_encrypted = $3, ops_key_rotated_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, sha256Hex(opsKey), encryptSecret(opsKey, key)],
  );
  return opsKey;
}

/** The plain ops key, for calls to the licensee's server. Null when none is stored or it cannot be decrypted. */
export function opsKeyOf(l: Pick<LicenseeRow, "ops_key_encrypted" | "id">): string | null {
  if (!l.ops_key_encrypted) return null;
  const key = encryptionKey();
  if (!key) return null;
  try {
    return decryptSecret(l.ops_key_encrypted, key);
  } catch (err) {
    console.error(`[ops-key] cannot decrypt the ops key for licensee ${l.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** A new signup token: stored as a hash, the plain value goes in the success/cancel links and status checks. */
export async function newSignupToken(db: Q, id: string): Promise<string> {
  const token = newSecret(24);
  const c = signupTokenColumns(token);
  await db.query(
    "UPDATE licensees SET signup_token_hash = $2, signup_token_encrypted = $3, updated_at = now() WHERE id = $1",
    [id, c.signup_token_hash, c.signup_token_encrypted],
  );
  return token;
}

/** Columns for a signup token: always its hash, and an encrypted copy when OPS_ENCRYPTION_KEY is set. */
export function signupTokenColumns(token: string): { signup_token_hash: string; signup_token_encrypted: string | null } {
  const key = encryptionKey();
  return { signup_token_hash: sha256Hex(token), signup_token_encrypted: key ? encryptSecret(token, key) : null };
}

/** The plain signup token when an encrypted copy is stored; null otherwise. */
export function signupTokenOf(l: Pick<LicenseeRow, "id" | "signup_token_encrypted">): string | null {
  if (!l.signup_token_encrypted) return null;
  const key = encryptionKey();
  if (!key) return null;
  try {
    return decryptSecret(l.signup_token_encrypted, key);
  } catch (err) {
    console.error(`[signup] cannot decrypt the signup token for licensee ${l.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function audit(db: Q, actor: string, action: string, licenseeId: string | null, details: unknown): Promise<void> {
  try {
    await db.query("INSERT INTO staff_audit (actor, action, licensee_id, details) VALUES ($1, $2, $3, $4)", [
      actor,
      action,
      licenseeId,
      details === undefined ? null : JSON.stringify(details),
    ]);
  } catch (err) {
    console.error(`[audit] could not record ${action}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "23505";
