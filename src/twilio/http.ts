// KS_OPS_TWILIO_AUTO_v1 - the Twilio REST API, called with plain fetch (KS-Ops does not ship the Twilio SDK). Every
// call names the account it acts for (Keystone's master account, or a licensee's sub-account), so the same client
// serves both. Failures become TwilioError with Twilio's numeric code, and plainTwilioError() turns them into a
// sentence staff can act on. Tests replace fetch with tests/unit/twilioFake.ts.
export type TwilioCreds = { accountSid: string; authToken: string };
export type Params = Record<string, string | number | boolean | string[] | undefined | null>;

export const API = "https://api.twilio.com/2010-04-01";
export const NUMBERS = "https://numbers.twilio.com/v2/RegulatoryCompliance";
export const TRUSTHUB = "https://trusthub.twilio.com/v1";
export const MESSAGING = "https://messaging.twilio.com/v1";
export const VERIFY = "https://verify.twilio.com/v2";

export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly moreInfo: string | null,
    readonly op: string,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

/** Form body as Twilio expects it: arrays repeat the key, booleans are "true"/"false", empty values are left out. */
export function formBody(params: Params): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) body.append(k, String(item));
    else body.append(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  }
  return body.toString();
}

export type TwilioHttp = {
  get: (creds: TwilioCreds, url: string, query?: Params, op?: string) => Promise<any>;
  post: (creds: TwilioCreds, url: string, params?: Params, op?: string) => Promise<any>;
};

/** The real client over fetch. 30 seconds per call. */
export function twilioHttp(fetchImpl: typeof fetch): TwilioHttp {
  const call = async (creds: TwilioCreds, method: "GET" | "POST", url: string, params: Params, op: string) => {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
    const qs = method === "GET" ? formBody(params) : "";
    let r: Response;
    try {
      r = await fetchImpl(qs ? `${url}?${qs}` : url, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: method === "POST" ? formBody(params) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new TwilioError(`Twilio could not be reached: ${err instanceof Error ? err.message : String(err)}`, 0, null, null, op);
    }
    const text = await r.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    if (!r.ok) {
      const code = Number(json?.code);
      throw new TwilioError(
        String(json?.message ?? `Twilio answered ${r.status}`),
        r.status,
        Number.isFinite(code) && code > 0 ? code : null,
        json?.more_info ? String(json.more_info) : null,
        op,
      );
    }
    return json;
  };
  return {
    get: (creds, url, query = {}, op = "read") => call(creds, "GET", url, query, op),
    post: (creds, url, params = {}, op = "write") => call(creds, "POST", url, params, op),
  };
}

const PLAIN: Record<number, string> = {
  20003: "Twilio refused the account credentials. Check KS_TWILIO_ACCOUNT_SID and KS_TWILIO_AUTH_TOKEN on KS-Ops (or the sub-account's token).",
  20005: "The Twilio account is not active (suspended or closed). Reactivate it in the Twilio console before trying again.",
  20008: "Twilio does not allow this with a trial account. Upgrade Keystone's Twilio account to a paid account.",
  20404: "Twilio could not find that item. It may have been deleted in the Twilio console; Retry step makes a new one.",
  20429: "Twilio is rate limiting us. The step tries again by itself.",
  21631: "Twilio needs a registered business address for this number.",
  21649: "Twilio needs an approved regulatory bundle for this number.",
  30034: "US carriers block texts from this number until its A2P 10DLC registration is approved.",
};

/** One sentence for staff: what went wrong and what to do. Never contains a secret. */
export function plainTwilioError(err: unknown): string {
  if (err instanceof TwilioError) {
    const known = err.code ? PLAIN[err.code] : undefined;
    const base = known ?? (err.status === 0 ? err.message : `Twilio refused the request: ${err.message}`);
    return `${base}${err.code ? ` (Twilio error ${err.code}, while trying to ${err.op})` : ` (while trying to ${err.op})`}`.slice(0, 900);
  }
  return `Unexpected error talking to Twilio: ${err instanceof Error ? err.message : String(err)}`.slice(0, 900);
}

/** Worth trying again later by itself (network, rate limit, Twilio's own 5xx). */
export function isTransient(err: unknown): boolean {
  return err instanceof TwilioError && (err.status === 0 || err.status === 429 || err.status >= 500 || err.code === 20429);
}

/** Logs a Twilio failure with its code and the licensee; the caller still decides what to do. Never logs a token. */
export function logTwilioError(where: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err as Partial<TwilioError> | null;
  console.error(`[twilio] ${where} failed`, {
    ...extra,
    op: e?.op ?? null,
    status: e?.status ?? null,
    code: e?.code ?? null,
    message: err instanceof Error ? err.message : String(err),
    plain: plainTwilioError(err),
  });
}
