// KS_OPS_TV_PAIRING_v1 - pairing an Apple TV scoreboard with a brokerage's server (see migrations/030_tv_pairings.sql).
//   start   -> the TV gets { code, device_secret } (the code is shown, the secret never leaves the TV)
//   claim   -> the brokerage's server says "this code is mine, here is its screen token"; the server address and brand
//              come from our own licensee record (or BF_SERVER_URL for Boreal Financial), never from the request
//   collect -> the TV, with its secret, gets { server_url, token, company } once; the token is then wiped here
import { randomInt } from "node:crypto";
import type { Q } from "../db.js";
import { matchesHash, newSecret, sha256Hex } from "../lib/crypto.js";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: read off a TV across a room
export const CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 10 * 60_000;

export function newCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Upper-case, without spaces or dashes; null unless it could be one of our codes. */
export function normalizeCode(v: unknown): string | null {
  const s = String(v ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export async function startPairing(db: Q, now: Date): Promise<{ code: string; device_secret: string; expires_in: number }> {
  await db.query(`DELETE FROM tv_pairings WHERE expires_at < $1`, [now]);
  const device_secret = newSecret(24);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const r = await db.query(
      `INSERT INTO tv_pairings (code, device_secret_hash, expires_at) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, sha256Hex(device_secret), new Date(now.getTime() + PAIRING_TTL_MS)],
    );
    if (r.rowCount) return { code, device_secret, expires_in: PAIRING_TTL_MS / 1000 };
  }
  throw new Error("could not find a free pairing code");
}

export type ClaimTarget = { licensee_id: string | null; server_url: string; company_name: string; logo_url: string | null; primary_color: string | null };
export type ClaimResult = { ok: true } | { ok: false; status: number; error: string; message: string };

export async function claimPairing(db: Q, rawCode: unknown, rawToken: unknown, target: ClaimTarget, now: Date): Promise<ClaimResult> {
  const code = normalizeCode(rawCode);
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const notFound = { ok: false as const, status: 404, error: "code_not_found", message: "That code was not found or has expired. Check the code on the TV." };
  if (!code) return notFound;
  if (token.length < 20 || token.length > 4000) return { ok: false, status: 400, error: "token_required", message: "The screen token is missing." };
  if (!/^https:\/\//i.test(target.server_url)) return { ok: false, status: 503, error: "no_server", message: "Your server address is not set up yet." };
  const r = await db.query(
    `UPDATE tv_pairings SET claimed_at = $2, licensee_id = $3, server_url = $4, screen_token = $5, company_name = $6, logo_url = $7, primary_color = $8
      WHERE code = $1 AND expires_at > $2 AND claimed_at IS NULL RETURNING code`,
    [code, now, target.licensee_id, target.server_url.replace(/\/+$/, ""), token, target.company_name, target.logo_url, target.primary_color],
  );
  return r.rowCount ? { ok: true } : notFound;
}

export type CollectResult =
  | { state: "waiting" }
  | { state: "expired" }
  | { state: "paired"; server_url: string; token: string; company: { name: string; logo_url: string | null; primary_color: string | null } };

export async function collectPairing(db: Q, rawCode: unknown, secret: unknown, now: Date): Promise<CollectResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { state: "expired" };
  const r = await db.query(`SELECT * FROM tv_pairings WHERE code = $1`, [code]);
  const row = r.rows[0];
  // A wrong secret looks the same as an unknown code.
  if (!row || !matchesHash(secret, row.device_secret_hash) || row.collected_at) return { state: "expired" };
  if (!row.claimed_at) return new Date(row.expires_at).getTime() > now.getTime() ? { state: "waiting" } : { state: "expired" };
  await db.query(`UPDATE tv_pairings SET collected_at = $2, screen_token = NULL WHERE code = $1`, [code, now]);
  return {
    state: "paired",
    server_url: String(row.server_url),
    token: String(row.screen_token),
    company: { name: String(row.company_name ?? ""), logo_url: row.logo_url ?? null, primary_color: row.primary_color ?? null },
  };
}
