// KS_OPS_NUMBER_PORTING_v1 - what happens to a transfer request: created from the brokerage's portal (through its
// KS-server), signed, submitted by Keystone staff, followed to completion. Every status change emails the brokerage's
// owner (and the admin who asked) in plain English from the support address; "approve the carrier's text" also texts
// the owner when Keystone's texting is set up. On completion the numbers are attached on the brokerage's server and
// texting is registered where the number needs it.
import type { Deps } from "../deps.js";
import { env, salesEmail, supportEmail } from "../config.js";
import { encryptionKey } from "../lib/crypto.js";
import { bodies, sendQuietly, type Mail } from "../lib/email.js";
import { normalizeNaPhone, sendSms } from "../lib/sms.js";
import { audit, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";
import { tenantHeader } from "../provisioning/executors.js";
import { isUsLocal, pushTexting, submitA2p, submitTollFree } from "../twilio/texting.js";
import { twilioOf, type TwilioDeps } from "../twilio/account.js";
import { latestLoa, loaExpired, recordLoaSignature, renderLoa, type LoaRow } from "./loa.js";
import {
  APPROVAL_MINUTES, carrierLabel, crossCheck, decodeBill, pretty, requestSchema, STATUS_LABELS, statusMessage, TRANSITIONS, type PortStatus,
} from "./model.js";
import {
  accountDetails, addEvent, createRequest, dateOnly, getRequest, latestBill, licenseeView, numbersInOpenRequests, requestNumbers,
  type PortNumberRow, type PortRequestRow,
} from "./repo.js";
import { parseBody } from "../lib/http.js";

export type PortDeps = Pick<Deps, "db" | "fetch" | "mailer" | "now"> & { env?: NodeJS.ProcessEnv } & Partial<TwilioDeps>;

export const KEY_MISSING = "OPS_ENCRYPTION_KEY is not set on KS-Ops, so account numbers cannot be stored safely.";

/** KS_PORT_RELEASE_GRACE_DAYS (default 7): how long the temporary Keystone number keeps working after a transfer. */
export function portGraceDays(e: NodeJS.ProcessEnv = process.env): number {
  const raw = env("KS_PORT_RELEASE_GRACE_DAYS", e);
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 1 ? Math.min(90, Math.floor(n)) : 7;
}

type Fail = { ok: false; status: number; error: string; message: string; errors?: Record<string, string> };
const fail = (status: number, error: string, message: string, errors?: Record<string, string>): Fail => ({ ok: false, status, error, message, ...(errors ? { errors } : {}) });

// ---- the brokerage's side ------------------------------------------------------------------------------------------

export async function createFromLicensee(deps: PortDeps, l: LicenseeRow, body: unknown) {
  const key = encryptionKey(String((deps.env ?? process.env).OPS_ENCRYPTION_KEY ?? "").trim());
  if (!key) return fail(503, "not_configured", KEY_MISSING);
  const parsed = parseBody(requestSchema, body);
  if (!parsed.ok) return fail(400, "invalid_request", "Check the highlighted details.", parsed.errors);
  const v = parsed.data;
  const errors = crossCheck(v);
  const bill = decodeBill(v.bill);
  if (!bill.ok) errors.bill = bill.error;
  const taken = await numbersInOpenRequests(deps.db, l.id, v.numbers.map((n) => n.phone_number));
  v.numbers.forEach((n, i) => { if (taken.includes(n.phone_number)) errors[`numbers.${i}.phone_number`] = `${pretty(n.phone_number)} is already being transferred.`; });
  if (Object.keys(errors).length || !bill.ok) return fail(400, "invalid_request", "Check the highlighted details.", errors);
  const row = await createRequest(deps.db, l.id, v, { bytes: bill.bytes, contentType: bill.contentType, filename: v.bill.filename }, key);
  await addEvent(deps.db, row.id, null, "draft", v.requested_by?.email || v.requested_by?.name || "brokerage admin");
  // Never the account number or PIN in the audit trail.
  await audit(deps.db, `ks-server:${l.company_code}`, "port_request.created", l.id, { request: row.id, numbers: v.numbers.map((n) => n.phone_number), carrier: v.carrier });
  await sendQuietly(deps.mailer, {
    to: [supportEmail(deps.env)],
    subject: `Number transfer requested: ${l.company_name} (${l.company_code})`,
    ...bodies([
      `${v.requested_by?.name ?? "An admin"} at ${l.company_name} asked to keep ${v.numbers.map((n) => pretty(n.phone_number)).join(", ")} (now with ${carrierLabel(v.carrier, v.carrier_other)}).`,
      "It is a draft until the letter of authorization is signed; then it shows as Ready on /ops/porting.",
    ]),
  }, "port request notice");
  return { ok: true as const, ...(await viewOf(deps, row)), loa: await loaFor(deps, l, row) };
}

async function viewOf(deps: PortDeps, r: PortRequestRow) {
  return { request: licenseeView(r, await requestNumbers(deps.db, [r.id]), await latestBill(deps.db, r.id), await latestLoa(deps.db, r.id), deps.now()) };
}

/** The letter to sign, rendered now from the request (account number shown to the brokerage that entered it). */
export async function loaFor(deps: PortDeps, l: LicenseeRow, r: PortRequestRow) {
  const key = encryptionKey(String((deps.env ?? process.env).OPS_ENCRYPTION_KEY ?? "").trim());
  if (!key) return null;
  const doc = renderLoa(l, r, await requestNumbers(deps.db, [r.id]), accountDetails(r, key).account_number, deps.env);
  const signed = await latestLoa(deps.db, r.id);
  return {
    version: doc.version, title: doc.title, html: doc.html, text: doc.text, sha256: doc.sha256,
    signed: signed ? { signer_name: signed.signer_name, signer_title: signed.signer_title, signed_at: signed.signed_at, expired: loaExpired(signed, deps.now()), current: signed.text_sha256 === doc.sha256 } : null,
  };
}

export type SignBody = { signer_name?: unknown; signer_title?: unknown; agree?: unknown; sha256?: unknown; signer_email?: unknown; signer_user_id?: unknown; ip?: unknown; user_agent?: unknown };

export async function signFromLicensee(deps: PortDeps, l: LicenseeRow, r: PortRequestRow, b: SignBody) {
  const key = encryptionKey(String((deps.env ?? process.env).OPS_ENCRYPTION_KEY ?? "").trim());
  if (!key) return fail(503, "not_configured", KEY_MISSING);
  if (r.status !== "draft" && r.status !== "ready_to_submit" && r.status !== "rejected") {
    return fail(409, "already_submitted", "This transfer has already gone to the carrier, so the letter cannot be changed.");
  }
  const errors: Record<string, string> = {};
  const name = String(b.signer_name ?? "").trim();
  const title = String(b.signer_title ?? "").trim();
  if (name.length < 2 || name.length > 120) errors.signer_name = "Type your full name.";
  if (title.length < 2 || title.length > 80) errors.signer_title = "Type your title, for example Owner or President.";
  if (b.agree !== true) errors.agree = "Tick the box to sign.";
  if (Object.keys(errors).length) return fail(400, "invalid_signature", "Check the highlighted details.", errors);
  const doc = renderLoa(l, r, await requestNumbers(deps.db, [r.id]), accountDetails(r, key).account_number, deps.env);
  if (typeof b.sha256 === "string" && b.sha256 && b.sha256 !== doc.sha256) {
    return fail(409, "loa_changed", "The letter was updated. Please read the new version and sign again.");
  }
  const row = await recordLoaSignature(deps.db, r.id, doc, {
    signer_name: name, signer_title: title, signer_email: typeof b.signer_email === "string" ? b.signer_email.slice(0, 254) : null,
    signer_user_id: typeof b.signer_user_id === "string" ? b.signer_user_id.slice(0, 100) : null,
    ip: String(b.ip ?? ""), user_agent: String(b.user_agent ?? ""),
  }, key, deps.now());
  await audit(deps.db, `ks-server:${l.company_code}`, "port_request.loa_signed", l.id, { request: r.id, signer_name: name, signer_title: title, ip: row.ip, sha256: row.text_sha256, version: row.version });
  let current = r;
  if (r.status === "draft") {
    current = (await moveStatus(deps, l, r, "ready_to_submit", name, {})).row;
  }
  return { ok: true as const, ...(await viewOf(deps, current)) };
}

export async function cancelFromLicensee(deps: PortDeps, l: LicenseeRow, r: PortRequestRow, by: string) {
  if (r.status !== "draft" && r.status !== "ready_to_submit") {
    return fail(409, "cannot_cancel", "This transfer is already with the carrier. Contact Keystone support to stop it.");
  }
  const moved = await moveStatus(deps, l, r, "cancelled", by || "brokerage admin", { reason: "Cancelled by the brokerage." });
  return { ok: true as const, ...(await viewOf(deps, moved.row)) };
}

export async function forwardingTested(deps: PortDeps, r: PortRequestRow, phone: unknown, tested: boolean) {
  const nums = await requestNumbers(deps.db, [r.id]);
  const target = nums.find((n) => n.phone_number === phone) ?? (nums.length === 1 ? nums[0] : null);
  if (!target) return fail(404, "not_found", "That number is not in this request.");
  await deps.db.query("UPDATE port_request_numbers SET forwarding_tested_at = $2 WHERE id = $1", [target.id, tested ? deps.now() : null]);
  return { ok: true as const, ...(await viewOf(deps, r)) };
}

// ---- status changes and the emails -----------------------------------------------------------------------------------

export type StatusPatch = { reason?: string | null; foc_date?: string | null; twilio_port_sid?: string | null; twilio_reference?: string | null };

const STAMP: Partial<Record<PortStatus, string>> = {
  submitted: "submitted_at", carrier_approval_pending: "carrier_approval_at", scheduled: "scheduled_at", completed: "completed_at",
  rejected: "rejected_at", cancelled: "cancelled_at",
};

/** Writes the move, records it and tells the owner. Callers check TRANSITIONS first. */
export async function moveStatus(deps: PortDeps, l: LicenseeRow, r: PortRequestRow, to: PortStatus, actor: string, patch: StatusPatch, extraParagraphs: string[] = [])
  : Promise<{ row: PortRequestRow; emailed: boolean; texted: boolean }> {
  const sets = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [r.id, to];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  const stamp = STAMP[to];
  if (stamp && to !== "scheduled") add(stamp, deps.now());
  if (to === "scheduled") add("scheduled_at", deps.now());
  if (to === "submitted") add("submitted_by", actor.slice(0, 200));
  if (patch.foc_date !== undefined) add("foc_date", patch.foc_date);
  if (patch.twilio_port_sid !== undefined) add("twilio_port_sid", patch.twilio_port_sid);
  if (patch.twilio_reference !== undefined) add("twilio_reference", patch.twilio_reference);
  if (to === "rejected" || to === "cancelled" || to === "draft") add("status_reason", patch.reason ?? null);
  else if (to === "ready_to_submit" || to === "submitted" || to === "completed") add("status_reason", null);
  const u = await deps.db.query(`UPDATE port_requests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
  const row = (u.rows[0] as PortRequestRow) ?? { ...r, status: to };
  const eventId = await addEvent(deps.db, r.id, r.status, to, actor, patch.reason ?? (patch.foc_date ? `FOC ${patch.foc_date}` : null));
  await audit(deps.db, actor, "port_request.status", l.id, { request: r.id, from: r.status, to, foc_date: patch.foc_date ?? null, reason: patch.reason ?? null });
  const numbers = await requestNumbers(deps.db, [r.id]);
  const mail = statusMail(l, row, numbers, to, extraParagraphs, deps.env);
  const emailed = mail ? await sendQuietly(deps.mailer, mail, "port request status email") : false;
  let texted = false;
  if (to === "carrier_approval_pending") {
    const owner = normalizeNaPhone(String(l.contact_phone ?? ""));
    if (owner) {
      const s = await sendSms(deps.fetch, owner, `${l.company_name}: your phone number transfer to Keystone is nearly done. Your current carrier may text ${numbers.map((n) => pretty(n.phone_number)).join(", ")} asking to approve it. Approve within ${APPROVAL_MINUTES} minutes or the transfer is rejected.`);
      texted = s.ok;
      if (!s.ok && s.error !== "sms_not_configured") console.error("[porting] approval text not sent", { request: r.id, error: s.error });
    }
  }
  if (eventId && (emailed || texted)) {
    try {
      await deps.db.query("UPDATE port_request_events SET emailed_at = $2, texted_at = $3 WHERE id = $1", [eventId, emailed ? deps.now() : null, texted ? deps.now() : null]);
    } catch (err) {
      console.error("[porting] event not updated", { request: r.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { row, emailed, texted };
}

/** The owner's email for a status change, in plain English (null for moves nobody needs to hear about). */
export function statusMail(l: LicenseeRow, r: PortRequestRow, numbers: PortNumberRow[], to: PortStatus, extra: string[] = [], e: NodeJS.ProcessEnv = process.env): Mail | null {
  const list = numbers.map((n) => pretty(n.phone_number)).join(", ") || "your number";
  const fwd = numbers.filter((n) => n.temporary_number).map((n) => `${pretty(n.phone_number)} -> ${pretty(n.temporary_number)}`).join("; ");
  const subjects: Record<PortStatus, string> = {
    draft: `Please sign again: transfer of ${list}`,
    ready_to_submit: `Got it: we will transfer ${list} to Keystone`,
    submitted: `Submitted: transfer of ${list} to Keystone`,
    carrier_approval_pending: `Action needed within ${APPROVAL_MINUTES} minutes: approve your carrier's text for ${list}`,
    scheduled: `Transfer date set for ${list}`,
    completed: `Done: ${list} now rings in Keystone`,
    rejected: `Your carrier rejected the transfer of ${list}`,
    cancelled: `Cancelled: transfer of ${list}`,
  };
  const lines: string[] = [`Hello ${l.contact_name || "there"},`];
  switch (to) {
    case "draft":
      lines.push(`Your carrier needs a letter of authorization signed within the last 30 days, and the one for ${list} is older than that. Open Settings > Phone lines in your portal (or Set-up > Your phone numbers) and sign it again. We will send the transfer as soon as it is signed.`);
      break;
    case "ready_to_submit":
      lines.push(`Thank you. We have everything we need to transfer ${list} from ${carrierLabel(r.carrier, r.carrier_other)} to Keystone, and Keystone support will send it to the carrier within one business day.`);
      if (fwd) lines.push(`Until the transfer is done, keep the call forwarding on (${fwd}) so no calls are missed. Texts cannot be forwarded: they keep going to the old phone until the transfer is done.`);
      break;
    case "submitted":
      lines.push(`We sent the transfer of ${list} to ${carrierLabel(r.carrier, r.carrier_other)}. Transfers usually take one to four weeks. We will email you at each step.`);
      lines.push(`Near the end your current carrier may text the number asking you to approve the transfer. You must approve it within ${APPROVAL_MINUTES} minutes or the transfer is rejected.`);
      break;
    case "carrier_approval_pending":
      lines.push(`Your current carrier is about to text ${list} asking you to approve the transfer to Keystone. Please reply to approve it within ${APPROVAL_MINUTES} minutes of receiving it. If it is not approved in time, the carrier rejects the transfer and we have to start again.`);
      lines.push("Make sure someone can see the texts on that phone today.");
      break;
    case "scheduled":
      lines.push(`The carrier confirmed the transfer of ${list} for ${dateOnly(r.foc_date) ?? "the date they gave us"}. On that day the number switches over to Keystone. Keep your call forwarding on until we tell you it is done.`);
      break;
    case "completed":
      lines.push(`${list} has been transferred and now rings in Keystone. Calls made from Keystone show it as your caller ID.`);
      lines.push("Please turn off the call forwarding you set up on your old phone: on most landlines dial *73; on most mobiles dial ##21#; or turn it off in your phone system's settings.");
      break;
    case "rejected":
      lines.push(`${carrierLabel(r.carrier, r.carrier_other)} did not accept the transfer of ${list}${r.status_reason ? `. The reason they gave: ${r.status_reason}` : ""}.`);
      lines.push("The most common reasons are an account number, PIN, name or service address that does not match the carrier's records exactly. Reply to this email and we will help you fix it and send it again. Your number keeps working with your current carrier meanwhile.");
      break;
    case "cancelled":
      lines.push(`The transfer of ${list} was cancelled${r.status_reason ? ` (${r.status_reason})` : ""}. The number stays with your current carrier. You can turn off any call forwarding you set up for it.`);
      break;
  }
  lines.push(...extra);
  lines.push(`Status: ${STATUS_LABELS[to]}. ${statusMessage(to, { foc_date: dateOnly(r.foc_date), reason: r.status_reason })}`);
  lines.push(`Questions? Reply to this email or write to ${supportEmail(e)}.`, "Keystone support");
  const to_ = [l.contact_email, r.requested_by_email ?? ""].filter((x) => x && x.includes("@"));
  return {
    to: [...new Set(to_.map((x) => x.toLowerCase()))],
    subject: `${l.company_name}: ${subjects[to]}`,
    from: { email: supportEmail(e), name: "Keystone support" },
    replyTo: supportEmail(e),
    ...bodies(lines),
  };
}

// ---- Keystone staff --------------------------------------------------------------------------------------------------

export type StaffMove = { status?: unknown; reason?: unknown; foc_date?: unknown; twilio_port_sid?: unknown; twilio_reference?: unknown };

export async function staffMove(deps: PortDeps, l: LicenseeRow, r: PortRequestRow, body: StaffMove, actor: string) {
  const to = String(body.status ?? "") as PortStatus;
  if (!(to in STATUS_LABELS)) return fail(400, "invalid_status", "Choose a status.");
  if (!TRANSITIONS[r.status].includes(to)) return fail(409, "invalid_move", `A request that is "${STATUS_LABELS[r.status]}" cannot move to "${STATUS_LABELS[to]}".`);
  const reason = String(body.reason ?? "").trim().slice(0, 1000);
  const foc = String(body.foc_date ?? "").trim();
  const ref = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : undefined);
  const patch: StatusPatch = { twilio_port_sid: ref(body.twilio_port_sid), twilio_reference: ref(body.twilio_reference) };
  if (to === "rejected") {
    if (!reason) return fail(400, "reason_required", "Type the carrier's reason for the rejection; it goes to the brokerage.");
    patch.reason = reason;
  }
  if (to === "cancelled") patch.reason = reason || "Cancelled by Keystone support.";
  if (to === "scheduled") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(foc) || Number.isNaN(Date.parse(`${foc}T00:00:00Z`))) return fail(400, "foc_required", "Enter the FOC (transfer) date the carrier confirmed, as YYYY-MM-DD.");
    patch.foc_date = foc;
  }
  if (to === "submitted") {
    // The carrier needs the letter dated within 30 days: an older one goes back to the brokerage to sign again.
    const loa = await latestLoa(deps.db, r.id);
    if (loaExpired(loa, deps.now())) {
      const back = await moveStatus(deps, l, r, "draft", actor, { reason: "The letter of authorization is more than 30 days old. Please sign it again." });
      return fail(409, "loa_expired", `The letter of authorization ${loa ? "is more than 30 days old" : "is not signed"}. The request went back to the brokerage to sign again${back.emailed ? " and they were emailed" : ""}.`);
    }
    if (!(await latestBill(deps.db, r.id))) return fail(409, "bill_missing", "There is no bill on this request.");
  }
  if (to === "completed") return completeRequest(deps, l, r, actor);
  const moved = await moveStatus(deps, l, r, to, actor, patch);
  return { ok: true as const, request: moved.row, emailed: moved.emailed, texted: moved.texted };
}

/**
 * The transfer finished: the numbers are attached on the brokerage's server (into the person's line or the main line,
 * the temporary number released after the grace period), texting is registered where it is needed, then the owner is
 * told and asked to turn off forwarding. Nothing moves to completed until the server has attached every number.
 */
export async function completeRequest(deps: PortDeps, l: LicenseeRow, r: PortRequestRow, actor: string) {
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return fail(409, "no_server", "The licensee has no server address or ops key, so the numbers cannot be attached.");
  const numbers = await requestNumbers(deps.db, [r.id]);
  const grace = portGraceDays(deps.env);
  let res: Response;
  try {
    res = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/provision/ported-numbers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops porting", ...tenantHeader(l) },
      body: JSON.stringify({
        port_request_id: r.id, grace_days: grace,
        numbers: numbers.map((n) => ({ phone_number: n.phone_number, number_type: n.number_type, user_id: n.server_user_id, temporary_number: n.temporary_number })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[porting] attach request failed", { request: r.id, message });
    await deps.db.query("UPDATE port_requests SET attach_error = $2, updated_at = now() WHERE id = $1", [r.id, message.slice(0, 500)]);
    return fail(502, "server_unreachable", `The brokerage's server could not be reached: ${message}. Try again.`);
  }
  const json = (await res.json().catch(() => ({}))) as { results?: Array<Record<string, any>>; error?: string; message?: string };
  if (res.status === 404) return fail(502, "server_too_old", "The brokerage's KS-server has no /api/provision/ported-numbers yet (deploy a newer KS-server).");
  if (!res.ok) {
    const message = `KS-server answered ${res.status} ${json.error ?? ""} ${json.message ?? ""}`.trim();
    await deps.db.query("UPDATE port_requests SET attach_error = $2, updated_at = now() WHERE id = $1", [r.id, message.slice(0, 500)]);
    return fail(502, "attach_failed", message);
  }
  const results = Array.isArray(json.results) ? json.results : [];
  for (const n of numbers) {
    const x = results.find((y) => y.phone_number === n.phone_number);
    const okAttach = x && (x.status === "attached" || x.status === "already_attached");
    await deps.db.query(
      "UPDATE port_request_numbers SET attach_status = $2, attach_message = $3, attached_at = CASE WHEN $4 THEN COALESCE(attached_at, $5) ELSE attached_at END, released_number = COALESCE($6, released_number) WHERE id = $1",
      [n.id, x?.status ?? "failed", x?.message ?? null, Boolean(okAttach), deps.now(), x?.released ?? null],
    );
  }
  const failed = numbers.filter((n) => {
    const x = results.find((y) => y.phone_number === n.phone_number);
    return !x || (x.status !== "attached" && x.status !== "already_attached");
  });
  if (failed.length) {
    const why = failed.map((n) => `${pretty(n.phone_number)}: ${results.find((y) => y.phone_number === n.phone_number)?.message ?? "no answer"}`).join("; ");
    await deps.db.query("UPDATE port_requests SET attach_error = $2, updated_at = now() WHERE id = $1", [r.id, why.slice(0, 1000)]);
    return fail(409, "not_attached", `Not attached yet, so the request stays "${STATUS_LABELS[r.status]}": ${why}`);
  }
  await deps.db.query("UPDATE port_requests SET attach_error = NULL WHERE id = $1", [r.id]);
  const texting = await registerTexting(deps, l, numbers);
  const released = results.filter((x) => x.released).map((x) => `${pretty(String(x.released))} (released after ${grace} days${x.release_after ? `, on ${String(x.release_after).slice(0, 10)}` : ""})`);
  const extra = [
    ...(released.length ? [`Your temporary Keystone number${released.length > 1 ? "s" : ""} ${released.join(", ")} will be given back after the grace period, so turn the forwarding off before then.`] : []),
    ...texting,
  ];
  const moved = await moveStatus(deps, l, r, "completed", actor, {}, extra);
  return { ok: true as const, request: moved.row, emailed: moved.emailed, results, texting };
}

/**
 * Texting for the transferred numbers, reusing src/twilio/texting.ts: Canadian local and mobile numbers text Canadian
 * mobiles straight away; a toll-free main line gets toll-free verification; a US local main line goes through the A2P
 * 10DLC flow. Anything that needs a person is emailed to sales. Returns sentences for the owner's email.
 */
export async function registerTexting(deps: PortDeps, l: LicenseeRow, numbers: PortNumberRow[]): Promise<string[]> {
  const out: string[] = [];
  const twDeps = { ...deps, env: deps.env } as TwilioDeps;
  const staff: string[] = [];
  let pushed = false;
  for (const n of numbers) {
    const p = pretty(n.phone_number);
    try {
      if (n.number_type === "toll_free") {
        if (n.server_user_id) { staff.push(`${p} is a toll-free number given to ${n.assignee_name}: submit its toll-free verification by hand.`); out.push(`Texts from ${p} need carrier approval first; Keystone support is arranging it.`); continue; }
        const reg = await submitTollFree(twDeps, l, n.phone_number);
        pushed = true;
        out.push(reg.status === "approved" ? `${p} can text straight away.` : `Texting from ${p} needs toll-free verification by the carriers (usually 3-10 business days). We have submitted it; until then texts to US mobiles wait.`);
      } else if (isUsLocal(n.phone_number)) {
        const current = await twilioOf(twDeps).store.registration(l.id, "a2p_10dlc");
        if (!n.server_user_id && !current?.campaign_sid) {
          await submitA2p(twDeps, l, n.phone_number);
          pushed = true;
        } else {
          staff.push(`${p} (${n.assignee_name}) is a US number: add it to the brokerage's A2P 10DLC messaging service in Twilio.`);
        }
        out.push(`Texting US mobiles from ${p} needs US carrier registration (A2P 10DLC), which Keystone is arranging; calls work now.`);
      } else {
        out.push(`${p} can text Canadian mobiles straight away.`);
      }
    } catch (err) {
      console.error("[porting] texting registration failed", { licensee: l.id, number: n.phone_number, message: err instanceof Error ? err.message : String(err) });
      staff.push(`Texting registration for ${p} failed: ${err instanceof Error ? err.message : String(err)}`);
      out.push(`Texts from ${p} need carrier approval first; Keystone support is arranging it.`);
    }
  }
  if (pushed) {
    const r = await pushTexting(twDeps, l).catch((err: unknown) => {
      console.error("[porting] texting status not pushed", { licensee: l.id, message: err instanceof Error ? err.message : String(err) });
      return { ok: false };
    });
    if (!r.ok) staff.push("The texting status was not pushed to the brokerage's server yet; the texting worker tries again.");
  }
  if (staff.length) {
    await sendQuietly(deps.mailer, { to: [salesEmail(deps.env)], subject: `Texting for transferred numbers: ${l.company_name} (${l.company_code})`, ...bodies(staff) }, "port texting notice");
  }
  return out;
}

export { getRequest };
