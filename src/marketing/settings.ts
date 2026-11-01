// KS_OPS_PROSPECT_MARKETING_v1 - the marketing sender: who the email is from, the footer's business details, the
// SendGrid key, and what is still missing (shown as warnings in the staff portal's Keystone Marketing screen).
//
//   KS_MARKETING_FROM            the From address for marketing (e.g. hello@<keystone domain>). Until it is set the
//                                transactional sender SENDGRID_FROM is used, with a warning.
//   KS_MARKETING_FROM_NAME       display name (default "Keystone")
//   KS_MARKETING_REPLY_TO        where replies go (default KS_SALES_EMAIL)
//   KS_MARKETING_BUSINESS_NAME   sender identification in the footer (default "Keystone")
//   KS_MARKETING_LEGAL_NAME      the legal entity sending (default "2630108 Alberta Ltd.", Boreal's company, until
//                                Keystone's own company exists)
//   KS_MARKETING_ADDRESS         the physical mailing address in every footer (default Boreal's business address)
//   KS_MARKETING_SENDGRID_API_KEY  a separate SendGrid key (e.g. a Keystone subuser); default SENDGRID_API_KEY
//   KS_MARKETING_WEBHOOK_PUBLIC_KEY  the Event Webhook's verification key (Signed Event Webhook), or
//   KS_MARKETING_WEBHOOK_TOKEN   a long random token put in the webhook URL (?token=...) instead
//   KS_MARKETING_UNSUBSCRIBE_SECRET  signs unsubscribe links (default: OPS_JWT_SECRET)
//   KS_MARKETING_REPLY_MAILBOX   the Microsoft 365 mailbox checked for replies (default MS_GRAPH_SEND_AS; needs the
//                                Graph app's Mail.Read application permission)
import { env, opsPublicUrl, salesEmail } from "../config.js";
import { graphConfigured } from "../lib/email.js";

export const DEFAULT_ADDRESS = "450 Sparling Crt SW, Edmonton, AB T6X 1G9, Canada";
export const DEFAULT_LEGAL_NAME = "2630108 Alberta Ltd.";
export const DEFAULT_BUSINESS_NAME = "Keystone";

export type Sender = {
  from: string;
  from_name: string;
  from_configured: boolean;
  reply_to: string;
  business_name: string;
  legal_name: string;
  address: string;
  address_is_default: boolean;
};

export function sender(e: NodeJS.ProcessEnv = process.env): Sender {
  const own = env("KS_MARKETING_FROM", e);
  return {
    from: (own || env("SENDGRID_FROM", e)).toLowerCase(),
    from_name: env("KS_MARKETING_FROM_NAME", e) || DEFAULT_BUSINESS_NAME,
    from_configured: own !== "",
    reply_to: env("KS_MARKETING_REPLY_TO", e) || salesEmail(e),
    business_name: env("KS_MARKETING_BUSINESS_NAME", e) || DEFAULT_BUSINESS_NAME,
    legal_name: env("KS_MARKETING_LEGAL_NAME", e) || DEFAULT_LEGAL_NAME,
    address: env("KS_MARKETING_ADDRESS", e) || DEFAULT_ADDRESS,
    address_is_default: env("KS_MARKETING_ADDRESS", e) === "",
  };
}

export const sendgridKey = (e: NodeJS.ProcessEnv = process.env) => env("KS_MARKETING_SENDGRID_API_KEY", e) || env("SENDGRID_API_KEY", e);

export function unsubscribeSecret(e: NodeJS.ProcessEnv = process.env): string {
  const s = env("KS_MARKETING_UNSUBSCRIBE_SECRET", e) || env("OPS_JWT_SECRET", e);
  return s.length >= 32 ? s : "";
}

export const replyMailbox = (e: NodeJS.ProcessEnv = process.env) =>
  graphConfigured() ? env("KS_MARKETING_REPLY_MAILBOX", e) || env("MS_GRAPH_SEND_AS", e) : "";

export const webhookConfigured = (e: NodeJS.ProcessEnv = process.env) =>
  env("KS_MARKETING_WEBHOOK_PUBLIC_KEY", e) !== "" || env("KS_MARKETING_WEBHOOK_TOKEN", e).length >= 24;

/** Why marketing email cannot be sent right now (null when it can). */
export function sendingProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  if (!sendgridKey(e)) return "SendGrid is not set up on KS-Ops (SENDGRID_API_KEY or KS_MARKETING_SENDGRID_API_KEY).";
  if (!sender(e).from) return "No sender address: set KS_MARKETING_FROM on KS-Ops.";
  if (!opsPublicUrl(undefined, e)) return "KS-Ops does not know its public address (KS_OPS_PUBLIC_URL), so unsubscribe links cannot be made.";
  if (!unsubscribeSecret(e)) return "No secret to sign unsubscribe links (OPS_JWT_SECRET or KS_MARKETING_UNSUBSCRIBE_SECRET, 32+ characters).";
  return null;
}

// ---- sending domain authentication (SendGrid "Sender Authentication > Domain Authentication") ----

export type DomainCheck = { domain: string; authenticated: boolean | null; error: string | null; checked_at: string };
let domainCache: { key: string; at: number; value: DomainCheck } | null = null;
const DOMAIN_CACHE_MS = 10 * 60_000;

export const domainOf = (email: string) => email.split("@")[1]?.trim().toLowerCase() ?? "";

/** Whether the From address's domain is authenticated in SendGrid (cached 10 minutes; null when it cannot be checked). */
export async function checkSendingDomain(fetchImpl: typeof fetch, now: Date, force = false): Promise<DomainCheck> {
  const s = sender();
  const domain = domainOf(s.from);
  const key = `${domain}|${sendgridKey() ? "k" : ""}`;
  if (!force && domainCache && domainCache.key === key && now.getTime() - domainCache.at < DOMAIN_CACHE_MS) return domainCache.value;
  const done = (authenticated: boolean | null, error: string | null): DomainCheck => {
    const value = { domain, authenticated, error, checked_at: now.toISOString() };
    domainCache = { key, at: now.getTime(), value };
    return value;
  };
  if (!domain) return done(null, "No sender address yet.");
  if (!sendgridKey()) return done(null, "SendGrid is not set up on KS-Ops.");
  try {
    const r = await fetchImpl("https://api.sendgrid.com/v3/whitelabel/domains?limit=200", {
      headers: { Authorization: `Bearer ${sendgridKey()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401 || r.status === 403) {
      return done(null, "The SendGrid key cannot read Sender Authentication (give it read access to Sender Authentication to check).");
    }
    if (!r.ok) return done(null, `SendGrid answered ${r.status}.`);
    const list = (await r.json()) as Array<{ domain?: string; valid?: boolean }>;
    const ok = (Array.isArray(list) ? list : []).some((d) => {
      const dd = String(d.domain ?? "").toLowerCase();
      return d.valid === true && dd !== "" && (domain === dd || domain.endsWith(`.${dd}`));
    });
    return done(ok, null);
  } catch (err) {
    console.warn(`[marketing] sending domain check failed: ${err instanceof Error ? err.message : String(err)}`);
    return done(null, "Could not reach SendGrid to check the domain.");
  }
}

export function resetDomainCache() {
  domainCache = null;
}

export type MarketingStatus = {
  can_send: boolean;
  sending_problem: string | null;
  sender: Sender;
  domain: DomainCheck;
  tracking_configured: boolean;
  reply_detection: { mailbox: string | null };
  public_url: string;
  warnings: string[];
};

export async function marketingStatus(fetchImpl: typeof fetch, now: Date, force = false): Promise<MarketingStatus> {
  const s = sender();
  const problem = sendingProblem();
  const domain = await checkSendingDomain(fetchImpl, now, force);
  const warnings: string[] = [];
  if (problem) warnings.push(problem);
  if (!s.from_configured) {
    warnings.push(
      `KS_MARKETING_FROM is not set: marketing goes out from ${s.from || "(no address)"} for now. Set it once Keystone's domain is chosen and authenticated in SendGrid.`,
    );
  }
  if (domain.authenticated === false) {
    warnings.push(`The sending domain ${domain.domain} is not authenticated in SendGrid. Authenticate it (SPF/DKIM) before sending, or mail will land in junk or be rejected.`);
  } else if (domain.authenticated === null && domain.error) {
    warnings.push(`Could not confirm the sending domain is authenticated: ${domain.error}`);
  }
  if (s.address_is_default) warnings.push(`The footer uses the default mailing address (${s.address}). Set KS_MARKETING_ADDRESS when Keystone has its own.`);
  if (!webhookConfigured()) warnings.push("Open, click, bounce and spam tracking is off: set up the SendGrid Event Webhook for KS-Ops (KS_MARKETING_WEBHOOK_PUBLIC_KEY).");
  if (!replyMailbox()) warnings.push("Replies are not detected automatically (Microsoft 365 mailbox not set up); use \"Mark replied\" on the prospect to stop their sequences.");
  return {
    can_send: problem === null,
    sending_problem: problem,
    sender: s,
    domain,
    tracking_configured: webhookConfigured(),
    reply_detection: { mailbox: replyMailbox() || null },
    public_url: opsPublicUrl(),
    warnings,
  };
}
