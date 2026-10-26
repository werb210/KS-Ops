// KS_OPS_TWILIO_AUTO_v1 - where each licensee's Twilio sub-account and texting registrations are kept (migration 015).
// The services only talk to this interface, so unit tests use an in-memory copy (tests/unit/twilioFake.ts).
import type { Q } from "../db.js";

export type AccountStatus = "active" | "suspended" | "closed";

export type TwilioRow = {
  licensee_id: string;
  subaccount_sid: string;
  auth_token_encrypted: string;
  friendly_name: string;
  api_key_sid: string | null;
  api_key_secret_encrypted: string | null;
  twiml_app_sid: string | null;
  twiml_app_voice_url: string | null;
  verify_service_sid: string | null;
  address_sid: string | null;
  bundle_required: boolean | null;
  bundle_sid: string | null;
  bundle_status: string | null;
  bundle_end_user_sid: string | null;
  bundle_document_sid: string | null;
  bundle_failure: string | null;
  account_status: AccountStatus;
  status_changed_at: Date | null;
  close_notice_sent_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type RegKind = "toll_free" | "a2p_10dlc";
export type RegStatus = "needs_info" | "submitted" | "pending" | "approved" | "rejected" | "not_needed";

export type RegistrationRow = {
  licensee_id: string;
  kind: RegKind;
  status: RegStatus;
  phone_number: string | null;
  phone_number_sid: string | null;
  verification_sid: string | null;
  customer_profile_sid: string | null;
  trust_product_sid: string | null;
  brand_sid: string | null;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  twilio_status: string | null;
  reason: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  last_checked_at: Date | null;
  next_check_at: Date | null;
  pushed_status: string | null;
  pushed_at: Date | null;
  push_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type Patch<T> = Partial<Omit<T, "licensee_id" | "created_at" | "updated_at">>;

export interface TwilioStore {
  get(licenseeId: string): Promise<TwilioRow | null>;
  /** Inserts the row unless one exists; returns the stored row either way (the first one wins). */
  insert(row: Pick<TwilioRow, "licensee_id" | "subaccount_sid" | "auth_token_encrypted" | "friendly_name">): Promise<TwilioRow>;
  update(licenseeId: string, patch: Patch<TwilioRow>): Promise<void>;
  /** Every sub-account that is not closed (the lifecycle worker). */
  listOpen(): Promise<TwilioRow[]>;
  registration(licenseeId: string, kind: RegKind): Promise<RegistrationRow | null>;
  registrations(licenseeId: string): Promise<RegistrationRow[]>;
  upsertRegistration(licenseeId: string, kind: RegKind, patch: Patch<RegistrationRow>): Promise<RegistrationRow>;
  /** Registrations waiting on Twilio or the carriers whose next check is due. */
  dueRegistrations(now: Date, limit: number): Promise<RegistrationRow[]>;
  /** Registrations whose status has not reached the licensee's server yet. */
  unpushedRegistrations(limit: number): Promise<RegistrationRow[]>;
}

const TWILIO_COLS = [
  "subaccount_sid", "auth_token_encrypted", "friendly_name", "api_key_sid", "api_key_secret_encrypted", "twiml_app_sid",
  "twiml_app_voice_url", "verify_service_sid", "address_sid", "bundle_required", "bundle_sid", "bundle_status",
  "bundle_end_user_sid", "bundle_document_sid", "bundle_failure", "account_status", "status_changed_at",
  "close_notice_sent_at", "closed_at",
] as const;

const REG_COLS = [
  "status", "phone_number", "phone_number_sid", "verification_sid", "customer_profile_sid", "trust_product_sid", "brand_sid",
  "messaging_service_sid", "campaign_sid", "twilio_status", "reason", "submitted_at", "approved_at", "last_checked_at",
  "next_check_at", "pushed_status", "pushed_at", "push_error",
] as const;

function setClause(patch: Record<string, unknown>, allowed: readonly string[], offset: number) {
  const cols = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  return { cols, sql: cols.map((c, i) => `${c} = $${i + offset}`).join(", "), values: cols.map((c) => patch[c]) };
}

export function pgTwilioStore(db: Q): TwilioStore {
  const store: TwilioStore = {
    async get(id) {
      const r = await db.query("SELECT * FROM licensee_twilio WHERE licensee_id = $1", [id]);
      return (r.rows[0] as TwilioRow) ?? null;
    },
    async insert(row) {
      await db.query(
        `INSERT INTO licensee_twilio (licensee_id, subaccount_sid, auth_token_encrypted, friendly_name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (licensee_id) DO NOTHING`,
        [row.licensee_id, row.subaccount_sid, row.auth_token_encrypted, row.friendly_name],
      );
      return (await store.get(row.licensee_id))!;
    },
    async update(id, patch) {
      const s = setClause(patch as Record<string, unknown>, TWILIO_COLS, 2);
      if (!s.cols.length) return;
      await db.query(`UPDATE licensee_twilio SET ${s.sql}, updated_at = now() WHERE licensee_id = $1`, [id, ...s.values]);
    },
    async listOpen() {
      const r = await db.query("SELECT * FROM licensee_twilio WHERE account_status <> 'closed' ORDER BY created_at");
      return r.rows as TwilioRow[];
    },
    async registration(id, kind) {
      const r = await db.query("SELECT * FROM texting_registrations WHERE licensee_id = $1 AND kind = $2", [id, kind]);
      return (r.rows[0] as RegistrationRow) ?? null;
    },
    async registrations(id) {
      const r = await db.query("SELECT * FROM texting_registrations WHERE licensee_id = $1 ORDER BY kind", [id]);
      return r.rows as RegistrationRow[];
    },
    async upsertRegistration(id, kind, patch) {
      await db.query(
        "INSERT INTO texting_registrations (licensee_id, kind) VALUES ($1, $2) ON CONFLICT (licensee_id, kind) DO NOTHING",
        [id, kind],
      );
      const s = setClause(patch as Record<string, unknown>, REG_COLS, 3);
      if (s.cols.length) {
        await db.query(`UPDATE texting_registrations SET ${s.sql}, updated_at = now() WHERE licensee_id = $1 AND kind = $2`, [id, kind, ...s.values]);
      }
      return (await store.registration(id, kind))!;
    },
    async dueRegistrations(now, limit) {
      const r = await db.query(
        `SELECT * FROM texting_registrations
          WHERE status IN ('submitted', 'pending') AND (next_check_at IS NULL OR next_check_at <= $1)
          ORDER BY next_check_at NULLS FIRST LIMIT $2`,
        [now, limit],
      );
      return r.rows as RegistrationRow[];
    },
    async unpushedRegistrations(limit) {
      const r = await db.query(
        `SELECT * FROM texting_registrations WHERE pushed_status IS DISTINCT FROM status ORDER BY updated_at LIMIT $1`,
        [limit],
      );
      return r.rows as RegistrationRow[];
    },
  };
  return store;
}
