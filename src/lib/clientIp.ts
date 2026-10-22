// The caller's address for rate limits and logs (BF-Server's approach, src/middleware/clientIp.ts there).
//
// Azure App Service writes X-Forwarded-For as "<ip>:<port>", and req.ip keeps the port. Keying a limiter on that
// keys it per connection (a new source port each time), so the limit never trips. The port is stripped here in a way
// that understands IPv4, bracketed IPv6 and bare IPv6, and the result goes through express-rate-limit's ipKeyGenerator,
// which collapses IPv6 to its /64 so one host cannot rotate addresses inside its own allocation.
//
// The left-most X-Forwarded-For entries are whatever the caller sent; Azure appends the real caller on the right. So
// the right-most public address is used, and private hops (a proxy behind the front end) are skipped.
import type { Request } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { isIP } from "node:net";

/** One X-Forwarded-For entry (or req.ip) without its port or IPv4-mapped prefix. */
export function stripPort(raw: string): string {
  const ip = String(raw ?? "").trim().replace(/^::ffff:/i, "");
  if (!ip) return "";
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) return ip.split(":")[0];
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) return bracketed[1].replace(/^::ffff:/i, "");
  // A bare IPv6 address is full of colons and never carries a port in this form.
  return ip;
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || /^fe[89ab]/.test(l);
}

export function clientIpFromRequest(req: Pick<Request, "headers"> & { ip?: string; socket?: { remoteAddress?: string } }): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  const joined = Array.isArray(forwarded) ? forwarded.join(",") : typeof forwarded === "string" ? forwarded : "";
  const hops = joined.split(",").map(stripPort).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (isIP(hops[i]) && !isPrivateIp(hops[i])) return hops[i];
  }
  return hops[hops.length - 1] || stripPort(req.ip ?? "") || stripPort(req.socket?.remoteAddress ?? "") || "unknown";
}

export function rateLimitKey(req: Request): string {
  const ip = clientIpFromRequest(req);
  return isIP(ip) ? ipKeyGenerator(ip) : ip;
}

const DEFAULT_MESSAGE = { error: "rate_limited", message: "Too many requests. Please wait a few minutes and try again." };

/** Every limiter in the service is made here, so none falls back to the library's per-connection default key. */
export function limiter(limit: number, windowMs: number, message: Options["message"] = DEFAULT_MESSAGE) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message,
    keyGenerator: rateLimitKey,
  });
}
