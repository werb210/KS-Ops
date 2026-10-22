import type { NextFunction, Request, RequestHandler, Response } from "express";
import { clientIpFromRequest } from "./clientIp.js";
import { ZodError, type ZodTypeAny, type z } from "zod";

/** Wraps an async handler so a thrown error reaches the error middleware instead of hanging the request. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** zod issues as { field: message }, using the first message per field. */
export function fieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const field = issue.path.length ? issue.path.join(".") : "form";
    if (!out[field]) out[field] = issue.message;
  }
  return out;
}

export function parseBody<T extends ZodTypeAny>(
  schema: T,
  body: unknown,
  extra?: (raw: Record<string, unknown>) => Record<string, string>,
): { ok: true; data: z.infer<T> } | { ok: false; errors: Record<string, string> } {
  const r = schema.safeParse(body ?? {});
  if (r.success) return { ok: true, data: r.data };
  const errors = fieldErrors(r.error);
  if (extra && body && typeof body === "object") {
    for (const [k, v] of Object.entries(extra(body as Record<string, unknown>))) if (!errors[k]) errors[k] = v;
  }
  return { ok: false, errors };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** The first moment after the period ends (UTC). */
export function periodEnd(period: string): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
}

/** The caller's address without Azure's ":port" (see lib/clientIp.ts). */
export function clientIp(req: Request): string {
  const ip = clientIpFromRequest(req);
  return ip === "unknown" ? "" : ip;
}
