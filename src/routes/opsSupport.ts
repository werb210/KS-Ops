// Staff API: support tickets, upgrade/storage requests and the dashboard totals.
import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { audit } from "../licensees/repo.js";
import { dataPurgeOn, mrrOf, type LicenseeRow } from "../licensees/repo.js";

const TICKET_STATUSES = ["open", "waiting", "resolved", "closed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const newTicketSchema = z.object({
  licensee_id: z.string().regex(UUID_RE, "Choose a licensee.").nullable().optional(),
  subject: z.string({ required_error: "Subject is required." }).trim().min(1, "Subject is required.").max(200),
  body: z.string({ required_error: "Write the ticket first." }).trim().min(1, "Write the ticket first.").max(20_000),
  priority: z.enum(PRIORITIES).default("normal"),
  requester_name: z.string().trim().max(200).optional(),
  requester_email: z.string().trim().email("Enter a valid email address.").optional(),
});

const ticketPatchSchema = z
  .object({
    status: z.enum(TICKET_STATUSES, { errorMap: () => ({ message: "Status must be open, waiting, resolved or closed." }) }),
    priority: z.enum(PRIORITIES, { errorMap: () => ({ message: "Priority must be low, normal, high or urgent." }) }),
    assigned_to: z.string().trim().max(200).nullable(),
    subject: z.string().trim().min(1).max(200),
  })
  .partial()
  .strict();

const messageSchema = z.object({
  body: z.string({ required_error: "Write a reply first." }).trim().min(1, "Write a reply first.").max(20_000),
  internal: z.boolean().default(false),
  status: z.enum(TICKET_STATUSES).optional(),
});

export function opsSupportRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/tickets",
    h(async (req, res) => {
      const status = String(req.query.status ?? "");
      const licenseeId = String(req.query.licensee_id ?? "");
      const r = await deps.db.query(
        `SELECT t.*, l.company_name, l.company_code,
                (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
                (SELECT max(created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
           FROM tickets t LEFT JOIN licensees l ON l.id = t.licensee_id
          WHERE ($1 = '' OR t.status = $1) AND ($2 = '' OR t.licensee_id::text = $2)
          ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, t.updated_at DESC
          LIMIT 500`,
        [(TICKET_STATUSES as readonly string[]).includes(status) ? status : "", UUID_RE.test(licenseeId) ? licenseeId : ""],
      );
      res.json({ tickets: r.rows });
    }),
  );

  router.get(
    "/tickets/:id",
    h(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const t = await deps.db.query(
        "SELECT t.*, l.company_name, l.company_code FROM tickets t LEFT JOIN licensees l ON l.id = t.licensee_id WHERE t.id = $1",
        [req.params.id],
      );
      if (!t.rows[0]) return res.status(404).json({ error: "not_found" });
      const m = await deps.db.query("SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at", [req.params.id]);
      return res.json({ ticket: t.rows[0], messages: m.rows });
    }),
  );

  router.post(
    "/tickets",
    h(async (req, res) => {
      const parsed = parseBody(newTicketSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      if (v.licensee_id) {
        const l = await deps.db.query("SELECT 1 FROM licensees WHERE id = $1", [v.licensee_id]);
        if (!l.rows.length) return res.status(400).json({ errors: { licensee_id: "That licensee does not exist." } });
      }
      const t = await deps.db.query(
        `INSERT INTO tickets (licensee_id, subject, priority, source, requester_name, requester_email)
         VALUES ($1, $2, $3, 'staff', $4, $5) RETURNING *`,
        [v.licensee_id ?? null, v.subject, v.priority, v.requester_name ?? null, v.requester_email ?? null],
      );
      const ticket = t.rows[0];
      await deps.db.query(
        `INSERT INTO ticket_messages (ticket_id, author_type, author_name, author_email, body, internal)
         VALUES ($1, 'staff', $2, $3, $4, true)`,
        [ticket.id, req.staff?.name ?? null, req.staff?.email ?? null, v.body],
      );
      await audit(deps.db, actorOf(req), "ticket.create", v.licensee_id ?? null, { ticket_id: ticket.id });
      return res.status(201).json({ ticket });
    }),
  );

  router.patch(
    "/tickets/:id",
    h(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(ticketPatchSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const fields = Object.entries(parsed.data).filter(([, val]) => val !== undefined);
      if (!fields.length) return res.status(400).json({ errors: { form: "Nothing to change." } });
      const r = await deps.db.query(
        `UPDATE tickets SET ${fields.map(([k], i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [req.params.id, ...fields.map(([, val]) => val)],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
      await audit(deps.db, actorOf(req), "ticket.update", r.rows[0].licensee_id, { ticket_id: req.params.id, ...parsed.data });
      return res.json({ ticket: r.rows[0] });
    }),
  );

  router.post(
    "/tickets/:id/messages",
    h(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(messageSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const v = parsed.data;
      const t = await deps.db.query("SELECT * FROM tickets WHERE id = $1", [req.params.id]);
      const ticket = t.rows[0];
      if (!ticket) return res.status(404).json({ error: "not_found" });
      const m = await deps.db.query(
        `INSERT INTO ticket_messages (ticket_id, author_type, author_name, author_email, body, internal)
         VALUES ($1, 'staff', $2, $3, $4, $5) RETURNING *`,
        [ticket.id, req.staff?.name ?? null, req.staff?.email ?? null, v.body, v.internal],
      );
      await deps.db.query("UPDATE tickets SET status = COALESCE($2, status), updated_at = now() WHERE id = $1", [
        ticket.id,
        v.status ?? null,
      ]);
      let emailed = false;
      if (!v.internal && ticket.requester_email) {
        emailed = await sendQuietly(
          deps.mailer,
          {
            to: [ticket.requester_email],
            subject: `Re: ${ticket.subject}`,
            ...bodies([`Hi${ticket.requester_name ? ` ${ticket.requester_name}` : ""},`, v.body, "- Keystone support"]),
          },
          "ticket reply",
        );
      }
      return res.status(201).json({ message: m.rows[0], emailed });
    }),
  );

  router.get(
    "/requests",
    h(async (req, res) => {
      const status = String(req.query.status ?? "");
      const r = await deps.db.query(
        `SELECT r.*, l.company_name, l.company_code, l.plan AS licensee_plan
           FROM requests r JOIN licensees l ON l.id = r.licensee_id
          WHERE ($1 = '' OR r.status = $1)
          ORDER BY r.created_at DESC LIMIT 500`,
        [["open", "done", "declined"].includes(status) ? status : ""],
      );
      res.json({ requests: r.rows });
    }),
  );

  router.patch(
    "/requests/:id",
    h(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
      const parsed = parseBody(z.object({ status: z.enum(["open", "done", "declined"]) }).strict(), req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const done = parsed.data.status !== "open";
      const r = await deps.db.query(
        `UPDATE requests SET status = $2, handled_by = CASE WHEN $3 THEN $4 ELSE NULL END,
                handled_at = CASE WHEN $3 THEN now() ELSE NULL END
          WHERE id = $1 RETURNING *`,
        [req.params.id, parsed.data.status, done, actorOf(req)],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "not_found" });
      await audit(deps.db, actorOf(req), "request.update", r.rows[0].licensee_id, { request_id: req.params.id, status: parsed.data.status });
      return res.json({ request: r.rows[0] });
    }),
  );

  router.get(
    "/dashboard",
    h(async (_req, res) => {
      const [ls, overdue, tickets, requests] = await Promise.all([
        deps.db.query(
          `SELECT id, company_name, company_code, plan, billing_interval, seats, support_level, extra_storage_blocks, status,
                  cancelled_at, purged_at
             FROM licensees`,
        ),
        deps.db.query(
          `SELECT count(*)::int AS n, COALESCE(sum(amount_due - amount_paid), 0)::bigint AS cents FROM invoices
            WHERE status = 'open' AND due_date IS NOT NULL AND due_date < now()`,
        ),
        deps.db.query("SELECT count(*)::int AS n FROM tickets WHERE status IN ('open','waiting')"),
        deps.db.query("SELECT count(*)::int AS n FROM requests WHERE status = 'open'"),
      ]);
      const live = new Set(["trial", "active", "past_due"]);
      const byStatus: Record<string, number> = {};
      let seats = 0;
      let mrr = 0;
      let trials = 0;
      const today = deps.now().toISOString().slice(0, 10);
      const purges: Array<{ id: string; company_name: string; company_code: string; cancelled_at: Date; data_purge_on: string; due: boolean }> = [];
      for (const l of ls.rows as LicenseeRow[]) {
        const on = dataPurgeOn(l);
        if (on && !l.purged_at) {
          purges.push({ id: l.id, company_name: l.company_name, company_code: l.company_code, cancelled_at: l.cancelled_at!, data_purge_on: on, due: on <= today });
        }
        byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
        if (live.has(l.status)) seats += l.seats;
        if (l.status === "active" || l.status === "past_due") mrr += mrrOf(l);
        if (l.status === "trial") trials += 1;
      }
      res.json({
        licensees: ls.rows.length,
        by_status: byStatus,
        seats,
        mrr: Math.round(mrr * 100) / 100,
        trials_active: trials,
        past_due: byStatus.past_due ?? 0,
        overdue_invoices: overdue.rows[0].n,
        overdue_amount: Number(overdue.rows[0].cents) / 100,
        open_tickets: tickets.rows[0].n,
        open_requests: requests.rows[0].n,
        // Cancelled licensees whose data is still held, soonest purge first ("due" = the purge date has passed).
        data_purges: purges.sort((a, b) => a.data_purge_on.localeCompare(b.data_purge_on)),
        data_purges_due: purges.filter((p) => p.due).length,
        currency: "CAD",
      });
    }),
  );

  return router;
}
