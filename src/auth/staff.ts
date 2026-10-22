// Boreal staff sign-in for the staff API. The BF staff portal sends the user's BF-Server token to
// POST /api/ops/auth/exchange; KS-Ops asks BF-Server who that is (GET {BF_SERVER_URL}/api/auth/me) and, for Admin
// users only, returns its own short-lived token. OPS_ADMIN_TOKEN is a break-glass bearer for emergencies.
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config.js";
import { safeEqual } from "../lib/crypto.js";

export type StaffUser = { id: string; email: string | null; name: string | null; role: "Admin"; via: "bf" | "break_glass" };

const TOKEN_TYPE = "ks-ops-staff";
export const STAFF_TOKEN_TTL_SECONDS = 60 * 60;

export function jwtSecret(): string {
  const s = env("OPS_JWT_SECRET");
  return s.length >= 32 ? s : "";
}

export function signStaffToken(user: Omit<StaffUser, "via">, ttl = STAFF_TOKEN_TTL_SECONDS): string {
  const secret = jwtSecret();
  if (!secret) throw new Error("OPS_JWT_SECRET is not set (needs 32 or more characters)");
  return jwt.sign({ typ: TOKEN_TYPE, email: user.email, name: user.name, role: user.role }, secret, {
    algorithm: "HS256",
    subject: user.id,
    expiresIn: ttl,
    issuer: "ks-ops",
  });
}

export function verifyStaffToken(token: string): StaffUser | null {
  const secret = jwtSecret();
  if (!secret) return null;
  try {
    const p = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "ks-ops" }) as jwt.JwtPayload;
    if (p.typ !== TOKEN_TYPE || p.role !== "Admin" || !p.sub) return null;
    return { id: p.sub, email: p.email ?? null, name: p.name ?? null, role: "Admin", via: "bf" };
  } catch {
    return null;
  }
}

/** Reads the BF-Server /api/auth/me body. It answers { ok, data: { user: { id, role, email, first_name, ... } } } and
 *  repeats user/role at the top level; either shape is accepted. */
export function bfIdentity(body: any): { id: string; role: string; email: string | null; name: string | null } | null {
  const u = body?.data?.user ?? body?.user ?? null;
  const id = String(u?.id ?? body?.userId ?? "").trim();
  const role = String(u?.role ?? body?.role ?? "").trim();
  if (!id || !role) return null;
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || null;
  return { id, role, email: u?.email ? String(u.email) : null, name };
}

export const isAdminRole = (role: string) => role.trim().toLowerCase() === "admin";

export type ExchangeResult =
  | { ok: true; token: string; expires_in: number; user: Omit<StaffUser, "via"> }
  | { ok: false; status: number; error: string; message: string };

export async function exchangeBfToken(bfToken: unknown, fetchImpl: typeof fetch): Promise<ExchangeResult> {
  if (typeof bfToken !== "string" || bfToken.trim().length < 10) {
    return { ok: false, status: 400, error: "bf_token_required", message: "Sign in to the staff portal first." };
  }
  const base = env("BF_SERVER_URL").replace(/\/+$/, "");
  if (!base || !jwtSecret()) {
    return { ok: false, status: 503, error: "auth_not_configured", message: "Staff sign-in is not set up on this server." };
  }
  let res: Response | globalThis.Response;
  try {
    res = await fetchImpl(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${bfToken.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("[auth] BF-Server check failed", err instanceof Error ? err.message : String(err));
    return { ok: false, status: 502, error: "bf_server_unreachable", message: "Could not check your sign-in. Please try again." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 401, error: "invalid_bf_token", message: "Your staff portal sign-in has expired. Please sign in again." };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: "bf_server_error", message: "Could not check your sign-in. Please try again." };
  }
  const who = bfIdentity(await res.json().catch(() => null));
  if (!who) return { ok: false, status: 401, error: "invalid_bf_token", message: "Your staff portal sign-in could not be read." };
  if (!isAdminRole(who.role)) {
    return { ok: false, status: 403, error: "admin_only", message: "Only Admin users can open Keystone operations." };
  }
  const user = { id: who.id, email: who.email, name: who.name, role: "Admin" as const };
  return { ok: true, token: signStaffToken(user), expires_in: STAFF_TOKEN_TTL_SECONDS, user };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffUser;
    }
  }
}

/** Bearer staff token (or OPS_ADMIN_TOKEN) required. */
export function requireStaff(req: Request, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization ?? "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return res.status(401).json({ error: "unauthorized", message: "Sign in required." });
  const breakGlass = env("OPS_ADMIN_TOKEN");
  if (breakGlass.length >= 32 && safeEqual(token, breakGlass)) {
    req.staff = { id: "break-glass", email: null, name: "Break-glass admin", role: "Admin", via: "break_glass" };
    return next();
  }
  const user = verifyStaffToken(token);
  if (!user) return res.status(401).json({ error: "unauthorized", message: "Your session has expired. Please sign in again." });
  req.staff = user;
  return next();
}

export const actorOf = (req: Request) => (req.staff ? `${req.staff.email ?? req.staff.id}` : "unknown");
