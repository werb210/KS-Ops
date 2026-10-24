// Intuit OAuth tokens and QuickBooks API calls. Tokens are stored encrypted (AES-256-GCM, KS_QBO_TOKEN_ENCRYPTION_KEY)
// in qbo_connection. The access token lasts an hour; it is refreshed 5 minutes before it runs out, and every refresh
// stores the refresh token Intuit returns (Intuit rotates them). A refresh is saved only when the row's version has
// not moved, so two instances refreshing at once keep the newer pair instead of overwriting it.
import { createHash } from "node:crypto";
import type { Q } from "../db.js";
import type { Deps } from "../deps.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import {
  INTUIT_AUTHORIZE_URL, INTUIT_REVOKE_URL, INTUIT_TOKEN_URL, QBO_MINOR_VERSION, QBO_SCOPE, qboConfig, type QboConfig,
} from "./config.js";

type Obj = Record<string, any>;
export type QboDeps = Pick<Deps, "db" | "fetch" | "now">;

export class QboError extends Error {
  constructor(message: string, public status = 0, public code: string | null = null, public body: unknown = null) {
    super(message);
    this.name = "QboError";
  }
}

export class QboNotConnected extends Error {
  constructor(reason = "quickbooks_not_connected") {
    super(reason);
    this.name = "QboNotConnected";
  }
}

export type ConnectionRow = {
  realm_id: string;
  environment: string;
  company_name: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_expires_at: Date;
  refresh_expires_at: Date | null;
  version: number;
  connected_by: string | null;
  connected_at: Date;
  refreshed_at: Date | null;
};

export type TokenSet = { access_token: string; refresh_token: string; expires_in: number; x_refresh_token_expires_in?: number };

const REFRESH_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

function basicAuth(cfg: QboConfig): string {
  return "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
}

export async function getConnection(db: Q): Promise<ConnectionRow | null> {
  const r = await db.query("SELECT * FROM qbo_connection WHERE id = 1");
  return (r.rows[0] as ConnectionRow) ?? null;
}

export function authorizeUrl(cfg: QboConfig, state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: redirectUri,
    state,
  });
  return `${INTUIT_AUTHORIZE_URL}?${q.toString()}`;
}

async function tokenRequest(deps: Pick<Deps, "fetch">, cfg: QboConfig, form: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await deps.fetch(INTUIT_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new QboError(`Intuit token request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let body: Obj = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new QboError(`Intuit token request answered ${res.status}: ${body.error ?? body.raw ?? "no tokens"}`, res.status, body.error ?? null, body);
  }
  return body as TokenSet;
}

export function exchangeCode(deps: Pick<Deps, "fetch">, cfg: QboConfig, code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest(deps, cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

function expiry(now: Date, seconds: unknown): Date | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(now.getTime() + n * 1000) : null;
}

/** Saves a new connection (replacing any earlier one). */
export async function saveConnection(
  deps: QboDeps,
  cfg: QboConfig,
  realmId: string,
  t: TokenSet,
  by: string,
): Promise<void> {
  const now = deps.now();
  await deps.db.query(
    `INSERT INTO qbo_connection (id, realm_id, environment, access_token_encrypted, refresh_token_encrypted,
                                 access_expires_at, refresh_expires_at, version, connected_by, connected_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, 1, $7, $8, now())
     ON CONFLICT (id) DO UPDATE SET realm_id = EXCLUDED.realm_id, environment = EXCLUDED.environment,
       company_name = NULL, access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, access_expires_at = EXCLUDED.access_expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at, version = qbo_connection.version + 1,
       connected_by = EXCLUDED.connected_by, connected_at = EXCLUDED.connected_at, refreshed_at = NULL, updated_at = now()`,
    [
      realmId,
      cfg.environment,
      encryptSecret(t.access_token, cfg.key),
      encryptSecret(t.refresh_token, cfg.key),
      expiry(now, t.expires_in) ?? new Date(now.getTime() + 3600_000),
      expiry(now, t.x_refresh_token_expires_in),
      by,
      now,
    ],
  );
}

/** A valid access token and the realm, refreshing (and rotating the refresh token) when it is about to run out. */
export async function accessToken(deps: QboDeps, cfg: QboConfig, opts: { force?: boolean } = {}): Promise<{ token: string; realmId: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await getConnection(deps.db);
    if (!c) throw new QboNotConnected();
    if (c.environment !== cfg.environment) throw new QboNotConnected("quickbooks_environment_changed");
    const fresh = new Date(c.access_expires_at).getTime() - REFRESH_MARGIN_MS > deps.now().getTime();
    if (fresh && !opts.force) return { token: decryptSecret(c.access_token_encrypted, cfg.key), realmId: c.realm_id };
    let t: TokenSet;
    try {
      t = await tokenRequest(deps, cfg, { grant_type: "refresh_token", refresh_token: decryptSecret(c.refresh_token_encrypted, cfg.key) });
    } catch (err) {
      // Another instance may have rotated the refresh token a moment ago: look again before giving up.
      const now = await getConnection(deps.db);
      if (now && now.version !== c.version) continue;
      if (err instanceof QboError && err.code === "invalid_grant") {
        console.error("[qbo] the refresh token was refused (invalid_grant): reconnect QuickBooks in Keystone operations");
        throw new QboNotConnected("quickbooks_reconnect_needed");
      }
      throw err;
    }
    const now = deps.now();
    const upd = await deps.db.query(
      `UPDATE qbo_connection SET access_token_encrypted = $2, refresh_token_encrypted = $3, access_expires_at = $4,
              refresh_expires_at = COALESCE($5, refresh_expires_at), version = version + 1, refreshed_at = $6, updated_at = now()
        WHERE id = 1 AND version = $1 RETURNING realm_id`,
      [
        c.version,
        encryptSecret(t.access_token, cfg.key),
        encryptSecret(t.refresh_token, cfg.key),
        expiry(now, t.expires_in) ?? new Date(now.getTime() + 3600_000),
        expiry(now, t.x_refresh_token_expires_in),
        now,
      ],
    );
    if (upd.rows.length) return { token: t.access_token, realmId: c.realm_id };
    console.warn("[qbo] the connection changed while refreshing; using the newer tokens");
    opts = {};
  }
  throw new QboError("could not refresh the QuickBooks token (the connection kept changing)");
}

/** Revokes the refresh token at Intuit. Returns false (logged) when Intuit did not confirm. */
export async function revokeToken(deps: Pick<Deps, "fetch">, cfg: QboConfig, refreshToken: string): Promise<boolean> {
  try {
    const res = await deps.fetch(INTUIT_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(cfg), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[qbo] Intuit revoke answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[qbo] Intuit revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** A QuickBooks requestid (idempotency) from a stable key: Intuit replays the first answer for a repeated id. */
export function requestIdFor(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function faultMessage(body: Obj): { message: string; code: string | null } {
  const err = body?.Fault?.Error?.[0] ?? body?.fault?.error?.[0];
  if (!err) return { message: JSON.stringify(body).slice(0, 300), code: null };
  return { message: [err.Message ?? err.message, err.Detail ?? err.detail].filter(Boolean).join(": "), code: String(err.code ?? "") || null };
}

export type QboApi = {
  realmId: string;
  get: (path: string) => Promise<Obj>;
  post: (path: string, body: unknown, opts?: { requestId?: string }) => Promise<Obj>;
  query: (sql: string) => Promise<Obj>;
};

/** An API helper bound to the connected company. A 401 refreshes the token once and tries again. */
export async function qboApi(deps: QboDeps, cfg: QboConfig | null = qboConfig()): Promise<QboApi> {
  if (!cfg) throw new QboNotConnected("quickbooks_not_configured");
  let { token, realmId } = await accessToken(deps, cfg);
  const call = async (method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<Obj> => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${cfg.apiBase}/v3/company/${encodeURIComponent(realmId)}/${path}${sep}minorversion=${QBO_MINOR_VERSION}` +
      (requestId ? `&requestid=${encodeURIComponent(requestId)}` : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new QboError(`QuickBooks ${method} ${path.split("?")[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 401 && attempt === 0) {
        ({ token, realmId } = await accessToken(deps, cfg, { force: true }));
        continue;
      }
      const text = await res.text();
      let json: Obj = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      if (!res.ok || json.Fault) {
        const f = faultMessage(json);
        throw new QboError(`QuickBooks ${method} ${path.split("?")[0]} answered ${res.status}: ${f.message}`, res.status, f.code, json);
      }
      return json;
    }
    throw new QboError(`QuickBooks ${method} ${path.split("?")[0]}: unauthorized after a token refresh`, 401);
  };
  return {
    realmId,
    get: (path) => call("GET", path),
    post: (path, body, opts) => call("POST", path, body, opts?.requestId),
    query: (sql) => call("GET", `query?query=${encodeURIComponent(sql)}`),
  };
}

/** Quotes a value for a QuickBooks query (backslash-escaped single quotes). */
export const qboQuote = (v: string) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
