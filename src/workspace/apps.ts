// KS_OPS_WORKSPACE_APPS - Keystone's own Microsoft 365 and Google Workspace apps, used by every licensee.
//
// Keystone owns ONE multi-tenant Entra app and ONE Google OAuth client (docs/PROVISIONING.md, "Microsoft 365 and Google
// Workspace: what Todd sets up once"). Their keys live only here, as KS-Ops app settings, and the provisioning
// workflow's workspace_apps step writes them to each licensee's KS-server (masked, like the Twilio settings). A
// brokerage then connects Microsoft 365 with one click by its admin, and each person connects Google with one click.
//
// Both apps list one redirect URI per provider: this server's broker, {KS_OAUTH_BROKER_URL}/microsoft and /google
// (default {KS_OPS_PUBLIC_URL}/api/oauth/callback/...). See ./broker.ts for why and how it forwards.
import { env } from "../config.js";
import { callbackBaseUrl } from "../provisioning/config.js";

/** The broker's base address (no trailing slash), or "" without a public https address. */
export function brokerBaseUrl(e: NodeJS.ProcessEnv = process.env): string {
  const explicit = env("KS_OAUTH_BROKER_URL", e).replace(/\/+$/, "");
  if (/^https:\/\//.test(explicit)) return explicit;
  const base = callbackBaseUrl(e);
  return base ? `${base}/api/oauth/callback` : "";
}

export type WorkspaceSettings = { settings: Record<string, string>; missing: string[] };

/** The App Service settings a licensee's KS-server gets. Missing pairs are left out and listed (never a failure). */
export function workspaceAppSettings(e: NodeJS.ProcessEnv = process.env): WorkspaceSettings {
  const settings: Record<string, string> = {};
  const missing: string[] = [];
  const pair = (id: string, secret: string, label: string) => {
    if (env(id, e) && env(secret, e)) {
      settings[id] = env(id, e);
      settings[secret] = env(secret, e);
    } else missing.push(label);
  };
  pair("KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "Microsoft 365 (KS_M365_CLIENT_ID and KS_M365_CLIENT_SECRET on KS-Ops)");
  pair("KS_GOOGLE_OAUTH_CLIENT_ID", "KS_GOOGLE_OAUTH_CLIENT_SECRET", "Google Workspace (KS_GOOGLE_OAUTH_CLIENT_ID and KS_GOOGLE_OAUTH_CLIENT_SECRET on KS-Ops)");
  const broker = brokerBaseUrl(e);
  if (Object.keys(settings).length && broker) settings.KS_OAUTH_BROKER_URL = broker;
  else if (Object.keys(settings).length) missing.push("the redirect broker address (KS_OPS_PUBLIC_URL on KS-Ops)");
  return { settings, missing };
}

/** Names the workflow may write (anything else KS-Ops hands over is ignored there). */
export const WORKSPACE_SETTING_NAMES = [
  "KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "KS_GOOGLE_OAUTH_CLIENT_ID", "KS_GOOGLE_OAUTH_CLIENT_SECRET", "KS_OAUTH_BROKER_URL",
] as const;
