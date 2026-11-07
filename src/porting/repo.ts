// KS_OPS_NUMBER_PORTING_v1 - transfer requests in the database. The account number and PIN go in encrypted
// (OPS_ENCRYPTION_KEY) and come out only through accountDetails(), for Keystone staff submitting to Twilio.
import type { Q } from "../db.js";
import { decryptSecret, encryptSecret, sha256Hex } from "../lib/crypto.js";
import { carrierLabel, maskTail, OPEN, STATUS_LABELS, statusMessage, type PortStatus, type RequestInput } from "./model.js";
import { latestLoa, loaExpired, type LoaRow } from "./loa.js";

export type PortRequestRow = {
  id: string;
  licensee_id: string;
  status: PortStatus;
  carrier: string;
  carrier_other: string | null;
  account_name: string;
  account_number_encrypted: string;
  account_last4: string;
  pin_encrypted: string | null;
  service_line1: string;
  service_line2: string | null;
  service_city: string;
  service_region: string;
  service_postal_code: string;
  service_country: "CA" | "US";
  submit_method: "staff" | "api";
  twilio_port_sid: string | null;
  twilio_reference: string | null;
  foc_date: string | Date | null;
  status_reason: string | null;
  requested_by_name: string | null;
  requested_by_email: string | null;
  requested_by_user_id: string | null;
  submitted_at: Date | null;
  submitted_by: string | null;
  carrier_approval_at: Date | null;
  scheduled_at: Date | null;
  completed_at: Date | null;
  rejected_at: Date | null;
  cancelled_at: Date | null;
  attach_error: string | null;
  created_at: Date;
  updated_at: Date;
};

export type PortNumberRow = {
  id: string;
  port_request_id: string;
  phone_number: string;
  number_type: string;
  server_user_id: string | null;
  assignee_name: string;
  temporary_number: string | null;
  forwarding_tested_at: Date | null;
  attached_at: Date | null;
  attach_status: string | null;
  attach_message: string | null;
  released_number: string | null;
};

export type BillRow = { id: string; port_request_id: string; filename: string; content_type: string; size_bytes: number; sha256: string; created_at: Date };

export async function getRequest(db: Q, id: string, licenseeId?: string): Promise<PortRequestRow | null> {
  const r = licenseeId
    ? await db.query("SELECT * FROM port_requests WHERE id = $1 AND licensee_id = $2", [id, licenseeId])
    : await db.query("SELECT * FROM port_requests WHERE id = $1", [id]);
  return (r.rows[0] as PortRequestRow) ?? null;
}

export async function requestNumbers(db: Q, ids: string[]): Promise<PortNumberRow[]> {
  if (!ids.length) return [];
  const r = await db.query("SELECT * FROM port_request_numbers WHERE port_request_id = ANY($1::uuid[]) ORDER BY created_at, phone_number", [ids]);
  return r.rows as PortNumberRow[];
}

export async function latestBill(db: Q, requestId: string): Promise<BillRow | null> {
  const r = await db.query(
    "SELECT id, port_request_id, filename, content_type, size_bytes, sha256, created_at FROM port_request_files WHERE port_request_id = $1 AND kind = 'bill' ORDER BY created_at DESC LIMIT 1",
    [requestId],
  );
  return (r.rows[0] as BillRow) ?? null;
}

export async function billData(db: Q, requestId: string): Promise<(BillRow & { data: Buffer }) | null> {
  const r = await db.query("SELECT * FROM port_request_files WHERE port_request_id = $1 AND kind = 'bill' ORDER BY created_at DESC LIMIT 1", [requestId]);
  return (r.rows[0] as BillRow & { data: Buffer }) ?? null;
}

/** Numbers already in an open request of this licensee (one transfer per number at a time). */
export async function numbersInOpenRequests(db: Q, licenseeId: string, phones: string[]): Promise<string[]> {
  if (!phones.length) return [];
  const r = await db.query(
    `SELECT DISTINCT n.phone_number FROM port_request_numbers n JOIN port_requests p ON p.id = n.port_request_id
      WHERE p.licensee_id = $1 AND p.status = ANY($2::text[]) AND n.phone_number = ANY($3::text[])`,
    [licenseeId, OPEN, phones],
  );
  return r.rows.map((x: any) => String(x.phone_number));
}

export async function addEvent(db: Q, requestId: string, from: PortStatus | null, to: PortStatus, actor: string, note: string | null = null): Promise<string | null> {
  try {
    const r = await db.query(
      "INSERT INTO port_request_events (port_request_id, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [requestId, from, to, actor.slice(0, 200), note ? note.slice(0, 1000) : null],
    );
    return r.rows[0]?.id != null ? String(r.rows[0].id) : null;
  } catch (err) {
    console.error("[porting] event not recorded", { request: requestId, to, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Saves a new request (draft), its numbers and the bill. */
export async function createRequest(db: Q, licenseeId: string, v: RequestInput, bill: { bytes: Buffer; contentType: string; filename: string }, key: Buffer): Promise<PortRequestRow> {
  const acct = v.account_number.replace(/\s+/g, " ").trim();
  const pin = String(v.pin ?? "").trim();
  const a = v.service_address;
  const r = await db.query(
    `INSERT INTO port_requests (licensee_id, carrier, carrier_other, account_name, account_number_encrypted, account_last4, pin_encrypted,
                                service_line1, service_line2, service_city, service_region, service_postal_code, service_country,
                                requested_by_name, requested_by_email, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [licenseeId, v.carrier, v.carrier === "other" ? String(v.carrier_other ?? "").trim() : null, v.account_name, encryptSecret(acct, key),
      acct.replace(/[^A-Za-z0-9]/g, "").slice(-4), pin ? encryptSecret(pin, key) : null,
      a.line1, a.line2 || null, a.city, a.region, a.postal_code, a.country,
      v.requested_by?.name ?? null, v.requested_by?.email ?? null, v.requested_by?.id ?? null],
  );
  const row = r.rows[0] as PortRequestRow;
  for (const n of v.numbers) {
    await db.query(
      `INSERT INTO port_request_numbers (port_request_id, phone_number, number_type, server_user_id, assignee_name, temporary_number, forwarding_tested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, n.phone_number, n.number_type, n.user_id || null, n.assignee_name || (n.user_id ? "Team member" : "Main line"), n.temporary_number || null, v.forwarding_tested ? new Date() : null],
    );
  }
  await db.query(
    "INSERT INTO port_request_files (port_request_id, kind, filename, content_type, size_bytes, sha256, data) VALUES ($1, 'bill', $2, $3, $4, $5, $6)",
    [row.id, bill.filename.replace(/[^\w .()-]/g, "_").slice(0, 120) || "bill", bill.contentType, bill.bytes.length, sha256Hex(bill.bytes.toString("binary")), bill.bytes],
  );
  return row;
}

/** The account number and PIN in clear, for staff only (callers audit it). */
export function accountDetails(r: Pick<PortRequestRow, "account_number_encrypted" | "pin_encrypted">, key: Buffer): { account_number: string; pin: string | null } {
  return { account_number: decryptSecret(r.account_number_encrypted, key), pin: r.pin_encrypted ? decryptSecret(r.pin_encrypted, key) : null };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const dateOnly = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
};

/** What the brokerage sees: never the account number or PIN, only that they are on file. */
export function licenseeView(r: PortRequestRow, numbers: PortNumberRow[], bill: BillRow | null, loa: LoaRow | null, now: Date) {
  return {
    id: r.id,
    status: r.status,
    status_label: STATUS_LABELS[r.status],
    status_message: statusMessage(r.status, { foc_date: dateOnly(r.foc_date), reason: r.status_reason }),
    carrier: r.carrier,
    carrier_label: carrierLabel(r.carrier, r.carrier_other),
    account_name: r.account_name,
    account_number_masked: maskTail(r.account_last4),
    pin_on_file: Boolean(r.pin_encrypted),
    service_address: { line1: r.service_line1, line2: r.service_line2, city: r.service_city, region: r.service_region, postal_code: r.service_postal_code, country: r.service_country },
    numbers: numbers.filter((n) => n.port_request_id === r.id).map((n) => ({
      phone_number: n.phone_number, number_type: n.number_type, user_id: n.server_user_id, assignee_name: n.assignee_name,
      temporary_number: n.temporary_number, forwarding_tested_at: iso(n.forwarding_tested_at), attached_at: iso(n.attached_at),
    })),
    bill: bill ? { filename: bill.filename, size_bytes: bill.size_bytes, uploaded_at: iso(bill.created_at) } : null,
    loa: loa ? { signer_name: loa.signer_name, signer_title: loa.signer_title, signed_at: iso(loa.signed_at), version: loa.version, expired: loaExpired(loa, now) } : null,
    needs_signature: (r.status === "draft" || r.status === "ready_to_submit") && loaExpired(loa, now),
    can_cancel: r.status === "draft" || r.status === "ready_to_submit",
    foc_date: dateOnly(r.foc_date),
    status_reason: r.status_reason,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    completed_at: iso(r.completed_at),
  };
}

export async function listForLicensee(db: Q, licenseeId: string, now: Date) {
  const rows = (await db.query("SELECT * FROM port_requests WHERE licensee_id = $1 ORDER BY created_at DESC LIMIT 100", [licenseeId])).rows as PortRequestRow[];
  const numbers = await requestNumbers(db, rows.map((r) => r.id));
  const out = [];
  for (const r of rows) out.push(licenseeView(r, numbers, await latestBill(db, r.id), await latestLoa(db, r.id), now));
  return out;
}
