// KS_OPS_ONBOARDING_v1 - the brokerage's team roster, entered by the owner at sign-up: each person's full name, email,
// mobile and role (Broker, Marketing or Admin). The owner is always the first row and an Admin; rows never exceed the
// seats bought (the owner takes one). Stored in licensee_team; editable from the owner's emailed link and by Keystone
// staff until provisioning creates the people on the brokerage's server (step team_users), then locked.
import type { Q } from "../db.js";
import type { LicenseeRow } from "../licensees/repo.js";
import type { ProvisioningStore } from "../provisioning/store.js";

export const TEAM_ROLES = ["Broker", "Marketing", "Admin"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export type TeamMember = { full_name: string; email: string; phone_e164: string; role: TeamRole; is_owner: boolean };
export type TeamRow = TeamMember & {
  id: string;
  position: number;
  server_user_id: string | null;
  provisioned_at: Date | null;
  invite_sent_at: Date | null;
};

export const MOBILE_MESSAGE = "Enter a Canadian or US mobile number with its area code, for example (403) 555-0123.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A Canadian or US mobile number as E.164 (+1XXXXXXXXXX), or null. Ten digits are the number; eleven digits starting
 * with 1 are the country code plus the number (North American area codes never start with 0 or 1, so a leading 1 can
 * only be the country code). The area code and exchange must start with 2-9.
 */
export function normalizeNanpMobile(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || !/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

export function normalizeRole(raw: unknown): TeamRole | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "staff") return "Broker"; // KS-server's name for the Broker role
  return TEAM_ROLES.find((r) => r.toLowerCase() === v) ?? null;
}

export type OwnerContact = Pick<LicenseeRow, "contact_name" | "contact_email" | "contact_phone">;

export type TeamParse = { ok: true; members: TeamMember[] } | { ok: false; errors: Record<string, string> };

/**
 * Checks a roster from the website or staff. The owner row is always built from the licensee's contact details (row 0,
 * Admin); a submitted row with the owner's email is taken as the owner's and skipped. Errors are keyed
 * "team.<row>.<field>" with the row numbered as the person sees it (the owner is row 1), plus "team" for the list.
 */
export function parseTeam(raw: unknown, owner: OwnerContact, seats: number): TeamParse {
  const errors: Record<string, string> = {};
  const ownerEmail = String(owner.contact_email ?? "").trim().toLowerCase();
  const ownerPhone = normalizeNanpMobile(owner.contact_phone);
  if (!ownerPhone) errors["contact_phone"] = MOBILE_MESSAGE;
  const members: TeamMember[] = [
    { full_name: String(owner.contact_name ?? "").trim(), email: ownerEmail, phone_e164: ownerPhone ?? "", role: "Admin", is_owner: true },
  ];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) return { ok: false, errors: { team: "The team must be a list of people." } };
  const list = (Array.isArray(raw) ? raw : []) as unknown[];
  if (list.length > 1001) return { ok: false, errors: { team: "That is too many people." } };
  let row = 1;
  for (const item of list) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const email = String(r.email ?? "").trim().toLowerCase();
    if (row === 1 && email === ownerEmail) continue; // the owner's own row, as the website shows it
    row += 1;
    const key = (f: string) => `team.${row}.${f}`;
    const name = String(r.full_name ?? r.name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2) errors[key("full_name")] = "Enter the person's full name.";
    else if (name.length > 120) errors[key("full_name")] = "Names must be 120 characters or fewer.";
    if (!EMAIL_RE.test(email) || email.length > 200) errors[key("email")] = "Enter a valid email address.";
    const phone = normalizeNanpMobile(r.phone ?? r.phone_e164);
    if (!phone) errors[key("phone")] = MOBILE_MESSAGE;
    const role = normalizeRole(r.role);
    if (!role) errors[key("role")] = "Choose Broker, Marketing or Admin.";
    members.push({ full_name: name, email, phone_e164: phone ?? "", role: role ?? "Broker", is_owner: false });
  }
  if (members.length > seats) {
    errors.team = `You bought ${seats} ${seats === 1 ? "seat" : "seats"}, so you can add up to ${seats} ${seats === 1 ? "person" : "people"} including yourself. Add seats or remove someone.`;
  }
  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  members.forEach((m, i) => {
    const n = i + 1;
    if (m.email && seenEmail.has(m.email) && !errors[`team.${n}.email`]) errors[`team.${n}.email`] = `Row ${seenEmail.get(m.email)} already uses this email.`;
    if (m.phone_e164 && seenPhone.has(m.phone_e164) && !errors[`team.${n}.phone`]) errors[`team.${n}.phone`] = `Row ${seenPhone.get(m.phone_e164)} already uses this mobile number.`;
    if (m.email && !seenEmail.has(m.email)) seenEmail.set(m.email, n);
    if (m.phone_e164 && !seenPhone.has(m.phone_e164)) seenPhone.set(m.phone_e164, n);
  });
  if (Object.keys(errors).length) {
    if (!errors.team) errors.team = "Check the highlighted people in your team.";
    return { ok: false, errors };
  }
  return { ok: true, members };
}

export async function getTeam(db: Q, licenseeId: string): Promise<TeamRow[]> {
  const r = await db.query("SELECT * FROM licensee_team WHERE licensee_id = $1 ORDER BY position", [licenseeId]);
  return r.rows as TeamRow[];
}

/**
 * Replaces the whole roster in one statement (so a failure leaves the old one in place). A person kept on the list
 * (same email) keeps what provisioning recorded for them, so a fix after a failed step never invites anyone twice.
 */
export async function replaceTeam(db: Q, licenseeId: string, members: TeamMember[]): Promise<void> {
  const rows = members.map((m, i) => ({ position: i, full_name: m.full_name, email: m.email, phone_e164: m.phone_e164, role: m.role, is_owner: m.is_owner }));
  await db.query(
    `WITH gone AS (
       DELETE FROM licensee_team WHERE licensee_id = $1
       RETURNING lower(email) AS email, server_user_id, provisioned_at, invite_sent_at
     )
     INSERT INTO licensee_team (licensee_id, position, full_name, email, phone_e164, role, is_owner, server_user_id, provisioned_at, invite_sent_at)
     SELECT $1, x.position, x.full_name, x.email, x.phone_e164, x.role, x.is_owner, g.server_user_id, g.provisioned_at, g.invite_sent_at
       FROM jsonb_to_recordset($2::jsonb) AS x(position int, full_name text, email text, phone_e164 text, role text, is_owner boolean)
       LEFT JOIN gone g ON g.email = lower(x.email)`,
    [licenseeId, JSON.stringify(rows)],
  );
}

/** The roster to show: the stored one, or (before anything was stored) the owner alone from the contact details. */
export async function teamOrOwner(db: Q, l: LicenseeRow): Promise<TeamMember[]> {
  const rows = await getTeam(db, l.id);
  if (rows.length) return rows.map(({ full_name, email, phone_e164, role, is_owner }) => ({ full_name, email, phone_e164, role, is_owner }));
  return [{ full_name: l.contact_name, email: l.contact_email.toLowerCase(), phone_e164: normalizeNanpMobile(l.contact_phone) ?? l.contact_phone, role: "Admin", is_owner: true }];
}

/**
 * Locked once provisioning has started creating the team (the team_users step is running, waiting, done or marked done)
 * or a provisioning run finished without one (licensees set up before rosters existed). Editable before payment, while
 * setup runs, and after the team step failed (so staff can fix a row and press Retry step).
 */
export async function teamLocked(store: Pick<ProvisioningStore, "latestRun" | "steps">, licenseeId: string): Promise<boolean> {
  const run = await store.latestRun(licenseeId, "provision");
  if (!run) return false;
  const steps = await store.steps(run.id);
  const team = steps.find((s) => s.step === "team_users");
  if (!team) return run.status === "done";
  return team.status !== "pending" && team.status !== "failed";
}

/** What the website and staff see of one person. */
export function teamView(m: TeamMember | TeamRow) {
  const row = m as Partial<TeamRow>;
  return {
    full_name: m.full_name,
    email: m.email,
    phone: m.phone_e164,
    role: m.role,
    is_owner: m.is_owner,
    ...(row.provisioned_at !== undefined ? { provisioned_at: row.provisioned_at, invite_sent_at: row.invite_sent_at ?? null } : {}),
  };
}
