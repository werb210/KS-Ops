// KS_OPS_NUMBER_PORTING_v1 - Keystone staff's view of number transfers (mounted under /api/ops behind requireStaff;
// shown on /ops/porting):
//   GET  /api/ops/porting?status=           every licensee's requests (newest first), account number masked
//   GET  /api/ops/porting/:id               one request with everything Twilio's form / Console asks for, including the
//                                           account number and PIN in clear (each view is audited)
//   GET  /api/ops/porting/:id/bill          the uploaded bill (download)
//   GET  /api/ops/porting/:id/loa           the signed letter of authorization (HTML download)
//   POST /api/ops/porting/:id/status        { status, foc_date?, reason?, twilio_port_sid?, twilio_reference? }
import { Router } from "express";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { encryptionKey } from "../lib/crypto.js";
import { h, UUID_RE } from "../lib/http.js";
import { audit, getLicensee } from "../licensees/repo.js";
import { latestLoa, loaExpired, signedLoaHtml } from "../porting/loa.js";
import { carrierLabel, NUMBER_TYPE_LABELS, STATUS_LABELS, STATUSES, TRANSITIONS, type NumberType, type PortStatus } from "../porting/model.js";
import { accountDetails, billData, dateOnly, getRequest, latestBill, licenseeView, requestNumbers, type PortRequestRow } from "../porting/repo.js";
import { KEY_MISSING, portGraceDays, staffMove } from "../porting/service.js";

export function opsPortingRouter(deps: Deps): Router {
  const router = Router();
  const find = async (id: string) => (UUID_RE.test(id) ? getRequest(deps.db, id) : null);

  router.get("/porting", h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const status = String(req.query.status ?? "");
    const filter = (STATUSES as readonly string[]).includes(status) ? status : null;
    const r = await deps.db.query(
      `SELECT p.*, l.company_name, l.company_code FROM port_requests p JOIN licensees l ON l.id = p.licensee_id
        WHERE ($1::text IS NULL OR p.status = $1) ORDER BY
          CASE p.status WHEN 'ready_to_submit' THEN 0 WHEN 'carrier_approval_pending' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'submitted' THEN 3 WHEN 'draft' THEN 4 ELSE 5 END,
          p.updated_at DESC LIMIT 200`,
      [filter],
    );
    const rows = r.rows as Array<PortRequestRow & { company_name: string; company_code: string }>;
    const numbers = await requestNumbers(deps.db, rows.map((x) => x.id));
    const out = [];
    for (const x of rows) {
      const loa = await latestLoa(deps.db, x.id);
      out.push({ ...licenseeView(x, numbers, await latestBill(deps.db, x.id), loa, deps.now()), company_name: x.company_name, company_code: x.company_code, licensee_id: x.licensee_id, twilio_port_sid: x.twilio_port_sid, twilio_reference: x.twilio_reference, attach_error: x.attach_error, next: TRANSITIONS[x.status] });
    }
    return res.json({ ok: true, statuses: STATUSES.map((s) => ({ status: s, label: STATUS_LABELS[s] })), requests: out, grace_days: portGraceDays() });
  }));

  router.get("/porting/:id", h(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const r = await find(String(req.params.id));
    if (!r) return res.status(404).json({ error: "not_found" });
    const key = encryptionKey();
    if (!key) return res.status(503).json({ error: "not_configured", message: KEY_MISSING });
    const l = await getLicensee(deps.db, r.licensee_id);
    const numbers = await requestNumbers(deps.db, [r.id]);
    const loa = await latestLoa(deps.db, r.id);
    const bill = await latestBill(deps.db, r.id);
    const acct = accountDetails(r, key);
    await audit(deps.db, actorOf(req), "port_request.details_viewed", r.licensee_id, { request: r.id });
    const events = (await deps.db.query("SELECT from_status, to_status, actor, note, emailed_at, texted_at, created_at FROM port_request_events WHERE port_request_id = $1 ORDER BY id", [r.id])).rows;
    const tollFree = numbers.some((n) => n.number_type === "toll_free");
    return res.json({
      ok: true,
      request: { ...licenseeView(r, numbers, bill, loa, deps.now()), licensee_id: r.licensee_id, twilio_port_sid: r.twilio_port_sid, twilio_reference: r.twilio_reference, attach_error: r.attach_error, next: TRANSITIONS[r.status] },
      licensee: l ? { company_name: l.company_name, legal_name: l.legal_name, company_code: l.company_code, contact_name: l.contact_name, contact_email: l.contact_email } : null,
      events,
      // Everything to paste into Twilio, in the order its form asks.
      checklist: {
        where: tollFree
          ? "Toll-free: Twilio Console > Phone Numbers > Port & Host > Port in, signed in to the licensee's own sub-account."
          : "Local and mobile: Twilio's porting request form (international port-in), for the licensee's own sub-account.",
        fields: [
          ["Numbers", numbers.map((n) => n.phone_number).join(", ")],
          ["Number type", [...new Set(numbers.map((n) => NUMBER_TYPE_LABELS[n.number_type as NumberType] ?? n.number_type))].join(", ")],
          ["Current carrier", carrierLabel(r.carrier, r.carrier_other)],
          ["Business name", l?.legal_name ?? ""],
          ["Name on the account", r.account_name],
          ["Account number", acct.account_number],
          ["Account PIN", acct.pin ?? "(none)"],
          ["Service address line 1", r.service_line1],
          ["Service address line 2", r.service_line2 ?? ""],
          ["City", r.service_city],
          ["Province / state", r.service_region],
          ["Postal / ZIP code", r.service_postal_code],
          ["Country", r.service_country],
          ["Authorized signer", loa ? `${loa.signer_name}, ${loa.signer_title}` : "(not signed)"],
          ["Signer email", loa?.signer_email ?? l?.contact_email ?? ""],
          ["LOA signed on", loa ? dateOnly(loa.signed_at) ?? "" : ""],
          ["Notification email", l?.contact_email ?? ""],
        ],
        loa_ok: Boolean(loa) && !loaExpired(loa, deps.now()),
        bill: bill ? { filename: bill.filename, size_bytes: bill.size_bytes } : null,
        notes: [
          "Port into the licensee's own Twilio sub-account, so the number lands where its server can attach it.",
          "Attach the signed letter of authorization and the bill (download them below).",
          "Twilio's reference (PX... or the ticket number) goes in the box below when you mark it submitted.",
          "When the carrier says it will text the number for approval, mark \"Approve the carrier's text\": the owner is emailed (and texted when Keystone texting is set up) to approve within 90 minutes.",
        ],
      },
    });
  }));

  router.get("/porting/:id/bill", h(async (req, res) => {
    const r = await find(String(req.params.id));
    const f = r ? await billData(deps.db, r.id) : null;
    if (!r || !f) return res.status(404).json({ error: "not_found" });
    await audit(deps.db, actorOf(req), "port_request.bill_downloaded", r.licensee_id, { request: r.id });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", f.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${f.filename.replace(/[^\w .()-]/g, "_")}"`);
    return res.send(Buffer.from(f.data));
  }));

  router.get("/porting/:id/loa", h(async (req, res) => {
    const r = await find(String(req.params.id));
    const loa = r ? await latestLoa(deps.db, r.id) : null;
    if (!r || !loa) return res.status(404).json({ error: "not_found", message: "The letter of authorization is not signed yet." });
    const key = encryptionKey();
    if (!key) return res.status(503).json({ error: "not_configured", message: KEY_MISSING });
    const l = await getLicensee(deps.db, r.licensee_id);
    await audit(deps.db, actorOf(req), "port_request.loa_downloaded", r.licensee_id, { request: r.id });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="letter-of-authorization-${(l?.company_code ?? "brokerage").replace(/[^\w-]/g, "")}-${dateOnly(loa.signed_at)}.html"`);
    return res.send(signedLoaHtml(loa, l?.company_name ?? "", key));
  }));

  router.post("/porting/:id/status", h(async (req, res) => {
    const r = await find(String(req.params.id));
    if (!r) return res.status(404).json({ error: "not_found" });
    const l = await getLicensee(deps.db, r.licensee_id);
    if (!l) return res.status(404).json({ error: "not_found" });
    const out = await staffMove(deps, l, r, req.body ?? {}, actorOf(req));
    if (!out.ok) {
      const { status, ...body } = out;
      return res.status(status).json(body);
    }
    return res.json({ ...out, status_label: STATUS_LABELS[(out.request as PortRequestRow).status as PortStatus] });
  }));

  return router;
}
