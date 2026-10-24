// KS_STAFF_DIRECTORY_v1 - POST /api/staff-directory/lookup { identifier } -> { matches: [{ name, server_url }] }
//
// The Keystone dialler and iPad portal ask which brokerage(s) a staff member belongs to from their work email or
// mobile number (see src/staffDirectory.ts). Not leaking who has an account:
//   - every answer is 200 with the same shape; an unknown or unusable identifier is simply { matches: [] }
//   - the same query runs either way and the answer is held to a minimum time, so timing does not tell them apart
//   - only the brokerage's display name and server address are returned, never the person's details
//   - tight rate limits per caller address (rateLimitKey, the Azure-safe key) and per identifier
import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import type { Deps } from "../deps.js";
import { limiter, limiterBy } from "../lib/clientIp.js";
import { h } from "../lib/http.js";
import { lookupStaff, normalizeIdentifier } from "../staffDirectory.js";

const LIMITED = { error: "rate_limited", message: "Too many tries. Please wait a few minutes and try again." };

/** Minimum time for every answer (ms). STAFF_DIRECTORY_MIN_MS overrides it (tests use 0). */
export function minAnswerMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.STAFF_DIRECTORY_MIN_MS);
  return Number.isFinite(v) && v >= 0 ? v : 400;
}

function identifierKey(req: Request): string | null {
  const id = normalizeIdentifier((req.body as { identifier?: unknown } | undefined)?.identifier);
  return id ? createHash("sha256").update(`${id.kind}:${id.value}`).digest("hex") : null;
}

export function staffDirectoryRouter(deps: Deps): Router {
  const router = Router();
  router.post(
    "/lookup",
    limiter(10, 15 * 60_000, LIMITED),
    limiterBy(6, 60 * 60_000, identifierKey, LIMITED),
    h(async (req, res) => {
      const started = Date.now();
      res.setHeader("Cache-Control", "no-store");
      const raw = (req.body as { identifier?: unknown } | undefined)?.identifier;
      const matches = await lookupStaff(deps.db, typeof raw === "string" ? raw.slice(0, 254) : "");
      const wait = minAnswerMs() - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return res.json({ matches });
    }),
  );
  return router;
}
