// Keystone's own QuickBooks Online (Intuit OAuth 2.0). Off unless KS_QBO_CLIENT_ID, KS_QBO_CLIENT_SECRET and a valid
// KS_QBO_TOKEN_ENCRYPTION_KEY are all set; then nothing is queued, the worker does nothing and the routes say so.
import { env } from "../config.js";
import { encryptionKey } from "../lib/crypto.js";

export type QboEnvironment = "sandbox" | "production";

export const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";
export const CALLBACK_PATH = "/api/ops/quickbooks/oauth/callback";

export type QboConfig = {
  clientId: string;
  clientSecret: string;
  key: Buffer;
  environment: QboEnvironment;
  apiBase: string;
};

/** KS_QBO_ENVIRONMENT: "production", anything else (or unset) is sandbox. */
export function qboEnvironment(e: NodeJS.ProcessEnv = process.env): QboEnvironment {
  return env("KS_QBO_ENVIRONMENT", e).toLowerCase() === "production" ? "production" : "sandbox";
}

export function qboApiBase(environment: QboEnvironment): string {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

/** What is missing, for the status route and the startup log. Empty when the feature is on. */
export function qboMissing(e: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!env("KS_QBO_CLIENT_ID", e)) missing.push("KS_QBO_CLIENT_ID");
  if (!env("KS_QBO_CLIENT_SECRET", e)) missing.push("KS_QBO_CLIENT_SECRET");
  if (!encryptionKey(env("KS_QBO_TOKEN_ENCRYPTION_KEY", e))) missing.push("KS_QBO_TOKEN_ENCRYPTION_KEY (32 bytes: 64 hex characters or base64)");
  return missing;
}

export function qboConfig(e: NodeJS.ProcessEnv = process.env): QboConfig | null {
  if (qboMissing(e).length) return null;
  const environment = qboEnvironment(e);
  return {
    clientId: env("KS_QBO_CLIENT_ID", e),
    clientSecret: env("KS_QBO_CLIENT_SECRET", e),
    key: encryptionKey(env("KS_QBO_TOKEN_ENCRYPTION_KEY", e))!,
    environment,
    apiBase: qboApiBase(environment),
  };
}

export const qboConfigured = (e: NodeJS.ProcessEnv = process.env) => qboConfig(e) !== null;

/**
 * The address Intuit sends the browser back to. KS_QBO_REDIRECT_URI when set; otherwise this server's own address
 * (KS_OPS_PUBLIC_URL, or Azure's WEBSITE_HOSTNAME, or the request's host) + /api/ops/quickbooks/oauth/callback.
 */
export function qboRedirectUri(requestOrigin?: string, e: NodeJS.ProcessEnv = process.env): string {
  const explicit = env("KS_QBO_REDIRECT_URI", e);
  if (explicit) return explicit;
  const base =
    env("KS_OPS_PUBLIC_URL", e).replace(/\/+$/, "") ||
    (env("WEBSITE_HOSTNAME", e) ? `https://${env("WEBSITE_HOSTNAME", e)}` : "") ||
    (requestOrigin ?? "").replace(/\/+$/, "");
  return `${base}${CALLBACK_PATH}`;
}
