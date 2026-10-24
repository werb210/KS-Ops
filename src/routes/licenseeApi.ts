// Calls from a licensee's KS-server (X-KS-Ops-Key): usage reports, upgrade/storage requests, support tickets and the
// shared fraud watchlist (opt-in, hashes only - see src/watchlist.ts).
import { Router } from "express";
import { z } from "zod";
import { supportEmail } from "../config.js";
import type { Deps } from "../deps.js";
import { requireLicenseeKey } from "../auth/licenseeKey.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { h, parseBody } from "../lib/http.js";
import { dataPurgeOn, markPurged } from "../licensees/repo.js";
import { futureGeneratedAt, storeUsageReport, usageReportSchema } from "../sync/usage.js";
import { replaceStaffDirectory, staffDirectorySchema } from "../staffDirectory.js";
import { checkEntries, checkSchema, optInSchema, replaceReport, reportSchema, setOptIn, withdraw, withdrawSchema } from "../watchlist.js";

const requestSchema = z
  .object({
    kind: z.enum(["upgrade", "storage", "other"]).optional(),
    plan: z.string().max(40).optional(),
    requested_plan: z.string().max(40).optional(),
    current_plan: z.string().max(40).optional(),
    extra_storage_blocks: z.coerce.number().int().min(0).max(1000).optional(),
    requested_by: z.string().max(200).optional(),
    message: z.string().max(5000).optional(),
  })
  .passthrough();

const ticketSchema = z
  .object({
    subject: z.string({ required_error: "subject is required" }).trim().min(1, "subject is required").max(200),
    body: z.string().trim().max(20_000).optional(),
    message: z.string().trim().max(20_000).optional(),
    requester_name: z.string().trim().max(200).optional(),
    requester_email: z.string().trim().max(200).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  })
  .refine((v) => Boolean(v.body || v.message), { message: "body is required", path: ["body"] });

export function licenseeApiRouter(deps: Deps): Router {
  const router = Router();
  const auth = requireLicenseeKey(deps.db);

  router.post(
    "/:id/usage-reports",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(usageReportSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_report", errors: parsed.errors });
      if (parsed.data.licensee_id && parsed.data.licensee_id !== req.licensee!.id) {
        return res.status(400).json({ error: "licensee_mismatch" });
      }
      if (futureGeneratedAt(parsed.data, deps.now())) {
        return res.status(400).json({
          error: "invalid_report",
          errors: { generated_at: "generated_at is in the future. Check the server's clock." },
        });
      }
      const r = await storeUsageReport(deps.db, req.licensee!.id, parsed.data, "push");
      return res.status(200).json({ ok: true, stored: r.stored, period: r.period, ...(r.stored ? {} : { reason: "newer_report_already_stored" }) });
    }),
  );

  // KS_STAFF_DIRECTORY_v1 - KS-server sends the full list of its active staff identifiers (hashes only); it replaces the
  // previous list. Used by POST /api/staff-directory/lookup.
  router.post(
    "/:id/staff-directory",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(staffDirectorySchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_staff_directory", errors: parsed.errors });
      const stored = await replaceStaffDirectory(deps.db, req.licensee!.id, parsed.data.entries, deps.now());
      return res.json({ ok: true, stored });
    }),
  );

  // KS-server reports that a cancelled licensee's data was deleted and purged (after the 180-day hold).
  router.post(
    "/:id/purged",
    auth,
    h(async (req, res) => {
      const l = req.licensee!;
      const r = await markPurged(deps.db, l.id, deps.now(), `ks-server:${l.company_code}`);
      if (r === "not_cancelled") return res.status(409).json({ error: r });
      if (r === "not_due") return res.status(409).json({ error: r, data_purge_on: dataPurgeOn(l) });
      return res.json({ ok: true, result: r });
    }),
  );

  router.post(
    "/:id/requests",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(requestSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      const v = parsed.data;
      const requestedPlan = v.requested_plan ?? v.plan ?? null;
      const kind = v.kind ?? (requestedPlan ? "upgrade" : v.extra_storage_blocks ? "storage" : "other");
      const r = await deps.db.query(
        `INSERT INTO requests (licensee_id, kind, current_plan, requested_plan, requested_extra_storage_blocks,
                               requested_by, message, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          req.licensee!.id,
          kind,
          v.current_plan ?? req.licensee!.plan,
          requestedPlan,
          v.extra_storage_blocks ?? null,
          v.requested_by ?? null,
          v.message ?? null,
          JSON.stringify(req.body ?? {}),
        ],
      );
      return res.status(201).json({ ok: true, request_id: r.rows[0].id });
    }),
  );

  router.post(
    "/:id/tickets",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(ticketSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_ticket", errors: parsed.errors });
      const v = parsed.data;
      const l = req.licensee!;
      const t = await deps.db.query(
        `INSERT INTO tickets (licensee_id, subject, priority, source, requester_name, requester_email)
         VALUES ($1, $2, $3, 'licensee', $4, $5) RETURNING id`,
        [l.id, v.subject, v.priority ?? "normal", v.requester_name ?? null, v.requester_email ?? null],
      );
      const ticketId = t.rows[0].id as string;
      const text = (v.body ?? v.message)!;
      await deps.db.query(
        `INSERT INTO ticket_messages (ticket_id, author_type, author_name, author_email, body)
         VALUES ($1, 'licensee', $2, $3, $4)`,
        [ticketId, v.requester_name ?? null, v.requester_email ?? null, text],
      );
      await sendQuietly(
        deps.mailer,
        {
          to: [supportEmail()],
          subject: `Support ticket from ${l.company_name}: ${v.subject}`,
          ...bodies([
            `${v.requester_name ?? "An admin"}${v.requester_email ? ` (${v.requester_email})` : ""} at ${l.company_name} opened a support ticket.`,
            `Priority: ${v.priority ?? "normal"}`,
            text,
          ]),
        },
        "ticket notice",
      );
      return res.status(201).json({ ok: true, ticket_id: ticketId });
    }),
  );

  // ---- shared fraud watchlist (KS-server v9). Report and check need the licensee to have opted in.
  router.post(
    "/:id/watchlist/opt-in",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(optInSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      const r = await setOptIn(deps.db, req.licensee!.id, parsed.data.opt_in, deps.now());
      return res.json({ ok: true, opt_in: parsed.data.opt_in, removed: r.removed });
    }),
  );

  router.post(
    "/:id/watchlist/report",
    auth,
    h(async (req, res) => {
      if (!req.licensee!.watchlist_opt_in) return res.status(403).json({ error: "watchlist_not_opted_in" });
      const parsed = parseBody(reportSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      const stored = await replaceReport(deps.db, req.licensee!.id, parsed.data.application_ref, parsed.data.entries);
      return res.status(200).json({ ok: true, stored });
    }),
  );

  router.post(
    "/:id/watchlist/withdraw",
    auth,
    h(async (req, res) => {
      const parsed = parseBody(withdrawSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      return res.json({ ok: true, removed: await withdraw(deps.db, req.licensee!.id, parsed.data.application_ref) });
    }),
  );

  router.post(
    "/:id/watchlist/check",
    auth,
    h(async (req, res) => {
      if (!req.licensee!.watchlist_opt_in) return res.status(403).json({ error: "watchlist_not_opted_in" });
      const parsed = parseBody(checkSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ error: "invalid_request", errors: parsed.errors });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, matches: await checkEntries(deps.db, req.licensee!.id, parsed.data.entries) });
    }),
  );

  return router;
}
