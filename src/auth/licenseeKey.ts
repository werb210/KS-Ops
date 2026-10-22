// Calls from a licensee's KS-server: X-KS-Ops-Key must match the hash stored for the licensee in the URL.
import type { NextFunction, Request, Response } from "express";
import type { Q } from "../db.js";
import { matchesHash } from "../lib/crypto.js";
import { UUID_RE } from "../lib/http.js";
import { getLicensee, type LicenseeRow } from "../licensees/repo.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      licensee?: LicenseeRow;
    }
  }
}

export function requireLicenseeKey(db: Q) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? "");
      const given = req.headers["x-ks-ops-key"];
      if (!UUID_RE.test(id) || typeof given !== "string" || !given) {
        return res.status(401).json({ error: "invalid_ops_key" });
      }
      const l = await getLicensee(db, id);
      // The same answer for an unknown licensee and a wrong key, so ids cannot be probed.
      if (!l || !matchesHash(given, l.ops_key_hash)) return res.status(401).json({ error: "invalid_ops_key" });
      req.licensee = l;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
