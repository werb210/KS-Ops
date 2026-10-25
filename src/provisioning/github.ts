// KS_OPS_AUTO_PROVISION_v1 - the one GitHub call KS-Ops makes: start the provisioning (or teardown) workflow in the
// KS-Ops repository. Credentials, in order:
//   KS_PROVISION_GITHUB_TOKEN                     a fine-grained token with Actions: read and write on KS-Ops only
//   KS_PROVISION_GITHUB_APP_ID + _PRIVATE_KEY     a GitHub App; a one-hour installation token is made per call,
//   (+ KS_PROVISION_GITHUB_INSTALLATION_ID)       narrowed to the KS-Ops repository and actions: write
import jwt from "jsonwebtoken";
import { env } from "../config.js";
import { githubRepo } from "./config.js";

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ks-ops-provisioning" };

export class GithubNotConfigured extends Error {
  constructor() {
    super("github_not_configured");
  }
}

/** The PEM key; app settings often hold it with literal "\n" sequences. */
function pem(raw: string): string {
  return raw.includes("-----BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
}

export async function githubToken(fetchImpl: typeof fetch, e: NodeJS.ProcessEnv = process.env): Promise<string> {
  const pat = env("KS_PROVISION_GITHUB_TOKEN", e);
  if (pat) return pat;
  const appId = env("KS_PROVISION_GITHUB_APP_ID", e);
  const key = env("KS_PROVISION_GITHUB_APP_PRIVATE_KEY", e);
  if (!appId || !key) throw new GithubNotConfigured();
  const now = Math.floor(Date.now() / 1000);
  const appJwt = jwt.sign({ iat: now - 60, exp: now + 540, iss: appId }, pem(key), { algorithm: "RS256" });
  const auth = { ...HEADERS, Authorization: `Bearer ${appJwt}` };
  const repo = githubRepo(e);
  let installation = env("KS_PROVISION_GITHUB_INSTALLATION_ID", e);
  if (!installation) {
    const r = await fetchImpl(`${API}/repos/${repo}/installation`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`github_installation_lookup_${r.status}`);
    installation = String(((await r.json()) as { id?: number }).id ?? "");
  }
  const r = await fetchImpl(`${API}/app/installations/${installation}/access_tokens`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { actions: "write" } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`github_installation_token_${r.status}`);
  return String(((await r.json()) as { token?: string }).token ?? "");
}

/** POST /repos/{repo}/actions/workflows/{file}/dispatches on main. Throws with the status on failure. */
export async function dispatchWorkflow(
  fetchImpl: typeof fetch,
  file: string,
  inputs: Record<string, string>,
  e: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = await githubToken(fetchImpl, e);
  const r = await fetchImpl(`${API}/repos/${githubRepo(e)}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: env("KS_PROVISION_GITHUB_REF", e) || "main", inputs }),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 204 && !r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`github_dispatch_${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}
