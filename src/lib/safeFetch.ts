// KS_OPS_v14_BRAND_SCAN - fetching a page someone names on the public sign-up form, without letting them point this
// server at itself or at anything private (SSRF).
//
//   - http and https only, on the standard ports (80, 443), no user name or password in the address;
//   - the host name is resolved here and EVERY address it resolves to must be public; the connection is then made to
//     that checked address (so a second DNS answer cannot swap in a private one);
//   - redirects are followed by hand, at most MAX_REDIRECTS, and each hop is checked again from the start;
//   - a time limit per request and a size limit on the body (counted after decompression).
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 6_000;

export type FetchErrorCode = "bad_url" | "blocked" | "too_large" | "timeout" | "fetch_failed" | "too_many_redirects";

export class SafeFetchError extends Error {
  constructor(public code: FetchErrorCode, message: string) {
    super(message);
  }
}

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
/** Resolves a host name to every address it has. */
export type Resolver = (host: string) => Promise<string[]>;
/** One request to `url`, connecting to the already-checked `address`. Replaced in tests. */
export type RawGet = (url: URL, address: string, limits: { maxBytes: number; timeoutMs: number; accept: string }) => Promise<RawResponse>;

export type SafeFetchOptions = {
  resolve?: Resolver;
  get?: RawGet;
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
  maxRedirects?: number;
};

export type SafeResponse = { url: string; status: number; contentType: string; body: Buffer };

// Addresses a public website never has: this host, private networks, link-local (including cloud metadata at
// 169.254.169.254), carrier-grade NAT, multicast, documentation and reserved ranges.
const BLOCKED = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["100::", 64], ["2001::", 23], ["::", 96],
] as const) BLOCKED.addSubnet(a, p, "ipv6");

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6 address, if any. */
function embeddedV4(ip: string): string | null {
  const l = ip.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when `ip` must never be fetched (not a public unicast address, or not an IP address at all). */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return BLOCKED.check(ip, "ipv4");
  if (kind === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isBlockedAddress(v4);
    return BLOCKED.check(ip, "ipv6");
  }
  return true;
}

/** Checks the address itself (scheme, port, credentials, host name). Returns the parsed URL. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("bad_url", "That doesn't look like a website address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SafeFetchError("bad_url", "Use a website address starting with http:// or https://.");
  if (u.username || u.password) throw new SafeFetchError("bad_url", "Leave the user name and password out of the address.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new SafeFetchError("blocked", "We can only read websites on the standard web ports.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new SafeFetchError("bad_url", "That doesn't look like a website address.");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SafeFetchError("blocked", "We can only read public websites.");
  } else if (!host.includes(".") || /\.(local|localhost|internal|intranet|lan|home|corp|arpa)$/.test(host) || host === "localhost") {
    throw new SafeFetchError("blocked", "We can only read public websites.");
  }
  return u;
}

export const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The checked address to connect to for `u`: every address the host resolves to must be public. */
export async function publicAddressFor(u: URL, resolve: Resolver): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return host;
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new SafeFetchError("fetch_failed", "We couldn't find that website. Check the address.");
  }
  if (!addrs.length) throw new SafeFetchError("fetch_failed", "We couldn't find that website. Check the address.");
  if (addrs.some(isBlockedAddress)) throw new SafeFetchError("blocked", "We can only read public websites.");
  return addrs[0];
}

/** The real request: connects to `address` (never resolves again), stops at the size and time limits. */
export const nodeGet: RawGet = (url, address, { maxBytes, timeoutMs, accept }) =>
  new Promise((resolveP, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const family = net.isIP(address);
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "KeystoneBrandScan/1.0", accept, "accept-encoding": "gzip, deflate, br" },
        lookup: (_host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
          if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        },
        timeout: timeoutMs,
      } as http.RequestOptions,
      (res) => {
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new SafeFetchError("too_large", "That page is too large to read."));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolveP({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on("error", () => reject(new SafeFetchError("fetch_failed", "We couldn't read that website.")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new SafeFetchError("timeout", "That website took too long to answer."));
    }, timeoutMs);
    req.on("timeout", () => {
      req.destroy();
      reject(new SafeFetchError("timeout", "That website took too long to answer."));
    });
    req.on("error", (err) => reject(err instanceof SafeFetchError ? err : new SafeFetchError("fetch_failed", "We couldn't reach that website.")));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });

const header = (h: RawResponse["headers"], name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
};

/** GET `raw` safely, following up to maxRedirects redirects (each checked again). */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  const resolve = opts.resolve ?? systemResolver;
  const get = opts.get ?? nodeGet;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const address = await publicAddressFor(url, resolve);
    const res = await get(url, address, { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, accept: opts.accept ?? "*/*" });
    if (res.status >= 300 && res.status < 400 && header(res.headers, "location")) {
      if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", "That website redirects too many times.");
      let next: string;
      try {
        next = new URL(header(res.headers, "location"), url).toString();
      } catch {
        throw new SafeFetchError("fetch_failed", "That website sent a broken redirect.");
      }
      url = checkUrl(next);
      continue;
    }
    if (res.body.length > opts.maxBytes) throw new SafeFetchError("too_large", "That page is too large to read.");
    return { url: url.toString(), status: res.status, contentType: header(res.headers, "content-type").toLowerCase(), body: res.body };
  }
}
