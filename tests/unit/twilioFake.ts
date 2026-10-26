// KS_OPS_TWILIO_AUTO_v1 - an in-memory Twilio behind fetch, for the sub-account, address, bundle, texting and lifecycle
// tests. It answers the REST paths KS-Ops calls (api, numbers, trusthub, messaging, verify), checks Basic auth against
// the account the path names, records every call, and can be told to fail the next matching call.
import type { RegistrationRow, RegKind, TwilioRow, TwilioStore } from "../../src/twilio/store.js";

export const MASTER_SID = `AC${"0".repeat(32)}`;
export const MASTER_TOKEN = "master-token";

type Call = { method: string; url: string; path: string; params: Record<string, string | string[]>; account: string };
type Failure = { match: RegExp; method?: string; status: number; code: number; message: string; times: number };

let seq = 0;
const sid = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(32, "0")}`;

export class FakeTwilio {
  calls: Call[] = [];
  accounts = new Map<string, { sid: string; auth_token: string; friendly_name: string; status: string; parent: string | null }>();
  keys = new Map<string, { sid: string; account: string; friendly_name: string }>();
  apps = new Map<string, { sid: string; account: string; friendly_name: string; voice_url: string | null }>();
  verify = new Map<string, { sid: string; account: string; friendly_name: string }>();
  addresses = new Map<string, Record<string, any>>();
  numbers = new Map<string, { sid: string; account: string; phone_number: string }>();
  /** Regulations per "CA local" etc.; empty = none required (Canada and the US today). */
  regulations = new Map<string, any>();
  bundles = new Map<string, Record<string, any>>();
  tfv = new Map<string, Record<string, any>>();
  profiles = new Map<string, Record<string, any>>();
  products = new Map<string, Record<string, any>>();
  brands = new Map<string, Record<string, any>>();
  services = new Map<string, Record<string, any>>();
  campaigns = new Map<string, Record<string, any>>();
  endUsers = new Map<string, Record<string, any>>();
  docs = new Map<string, Record<string, any>>();
  failures: Failure[] = [];

  constructor() {
    this.accounts.set(MASTER_SID, { sid: MASTER_SID, auth_token: MASTER_TOKEN, friendly_name: "Keystone", status: "active", parent: null });
  }

  /** The next `times` calls whose path matches fail with this Twilio error. */
  failNext(match: RegExp, status: number, code: number, message: string, times = 1, method?: string) {
    this.failures.push({ match, status, code, message, times, method });
  }

  addNumber(account: string, phone: string): string {
    const s = sid("PN");
    this.numbers.set(s, { sid: s, account, phone_number: phone });
    return s;
  }

  creates(re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === "POST" && re.test(c.path));
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    const raw = method === "GET" ? u.searchParams : new URLSearchParams(String(init.body ?? ""));
    const params: Record<string, string | string[]> = {};
    for (const k of new Set(raw.keys())) {
      const all = raw.getAll(k);
      params[k] = all.length > 1 ? all : all[0];
    }
    const auth = Buffer.from(String((init.headers as Record<string, string>)?.Authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    const [user, pass] = auth.split(":");
    const path = `${u.host}${u.pathname}`;
    this.calls.push({ method, url: String(input), path, params, account: user });
    const acct = this.accounts.get(user);
    if (!acct || acct.auth_token !== pass) return this.err(401, 20003, "Authenticate");
    const f = this.failures.find((x) => x.times > 0 && x.match.test(path) && (!x.method || x.method === method));
    if (f) {
      f.times -= 1;
      return this.err(f.status, f.code, f.message);
    }
    try {
      return this.route(method, u.host, u.pathname, params, user);
    } catch (e) {
      return this.err(500, 0, String(e));
    }
  };

  private ok(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
  private err(status: number, code: number, message: string) {
    return new Response(JSON.stringify({ code, message, status, more_info: `https://www.twilio.com/docs/errors/${code}` }), { status });
  }
  private nf() {
    return this.err(404, 20404, "The requested resource was not found");
  }

  private route(method: string, host: string, p: string, q: Record<string, any>, user: string): Response {
    const m = (re: RegExp) => re.exec(p);
    let r: RegExpExecArray | null;
    if (host === "api.twilio.com") {
      if (p === "/2010-04-01/Accounts.json") {
        if (method === "GET") return this.ok({ accounts: [...this.accounts.values()].filter((a) => a.parent === user && (!q.FriendlyName || a.friendly_name === q.FriendlyName)) });
        const a = { sid: sid("AC"), auth_token: `tok-${seq}`, friendly_name: String(q.FriendlyName), status: "active", parent: user };
        this.accounts.set(a.sid, a);
        return this.ok(a, 201);
      }
      if ((r = m(/^\/2010-04-01\/Accounts\/(AC\w+)\.json$/))) {
        const a = this.accounts.get(r[1]);
        if (!a || (a.parent !== user && a.sid !== user)) return this.nf();
        if (method === "POST" && q.Status) {
          if (a.status === "closed") return this.err(400, 20005, "Account is closed");
          a.status = String(q.Status);
        }
        return this.ok(a);
      }
      if ((r = m(/^\/2010-04-01\/Accounts\/(AC\w+)\/(Keys|Applications|Addresses|IncomingPhoneNumbers)(?:\/(\w+))?\.json$/))) {
        const [, account, kind, id] = r;
        if (account !== user) return this.err(403, 20003, "wrong account");
        if (kind === "Keys") {
          if (id) return this.keys.get(id)?.account === account ? this.ok(this.keys.get(id)) : this.nf();
          const k = { sid: sid("SK"), account, friendly_name: String(q.FriendlyName) };
          this.keys.set(k.sid, k);
          return this.ok({ ...k, secret: `secret-${k.sid}` }, 201);
        }
        if (kind === "Applications") {
          if (id) {
            const a = this.apps.get(id);
            if (!a || a.account !== account) return this.nf();
            if (method === "POST" && q.VoiceUrl) a.voice_url = String(q.VoiceUrl);
            return this.ok(a);
          }
          if (method === "GET") return this.ok({ applications: [...this.apps.values()].filter((a) => a.account === account && (!q.FriendlyName || a.friendly_name === q.FriendlyName)) });
          const a = { sid: sid("AP"), account, friendly_name: String(q.FriendlyName), voice_url: q.VoiceUrl ? String(q.VoiceUrl) : null };
          this.apps.set(a.sid, a);
          return this.ok(a, 201);
        }
        if (kind === "Addresses") {
          if (id) return this.addresses.get(id)?.account === account ? this.ok(this.addresses.get(id)) : this.nf();
          if (method === "GET") return this.ok({ addresses: [...this.addresses.values()].filter((a) => a.account === account && a.customer_name === q.CustomerName) });
          const a = { sid: sid("AD"), account, customer_name: q.CustomerName, street: q.Street, city: q.City, region: q.Region, postal_code: q.PostalCode, iso_country: q.IsoCountry };
          this.addresses.set(a.sid, a);
          return this.ok(a, 201);
        }
        if (kind === "IncomingPhoneNumbers") {
          return this.ok({ incoming_phone_numbers: [...this.numbers.values()].filter((n) => n.account === account && n.phone_number === q.PhoneNumber) });
        }
      }
    }
    if (host === "verify.twilio.com") {
      if (p === "/v2/Services") {
        if (method === "GET") return this.ok({ services: [...this.verify.values()].filter((s) => s.account === user) });
        const s = { sid: sid("VA"), account: user, friendly_name: String(q.FriendlyName) };
        this.verify.set(s.sid, s);
        return this.ok(s, 201);
      }
      if ((r = m(/^\/v2\/Services\/(VA\w+)$/))) return this.verify.get(r[1])?.account === user ? this.ok(this.verify.get(r[1])) : this.nf();
    }
    if (host === "numbers.twilio.com") {
      const base = "/v2/RegulatoryCompliance";
      if (p === `${base}/Regulations`) {
        const reg = this.regulations.get(`${q.IsoCountry} ${q.NumberType}`);
        return this.ok({ results: reg ? [reg] : [] });
      }
      if (p === `${base}/EndUsers` || p === `${base}/SupportingDocuments`) {
        const x = { sid: sid(p.endsWith("EndUsers") ? "IT" : "RD"), account: user, type: q.Type, attributes: JSON.parse(String(q.Attributes ?? "{}")) };
        (p.endsWith("EndUsers") ? this.endUsers : this.docs).set(x.sid, x);
        return this.ok(x, 201);
      }
      if (p === `${base}/Bundles`) {
        const b = { sid: sid("BU"), account: user, status: "draft", regulation_sid: q.RegulationSid, items: [] as string[] };
        this.bundles.set(b.sid, b);
        return this.ok(b, 201);
      }
      if ((r = m(/^\/v2\/RegulatoryCompliance\/Bundles\/(BU\w+)(\/ItemAssignments|\/Evaluations)?$/))) {
        const b = this.bundles.get(r[1]);
        if (!b || b.account !== user) return this.nf();
        if (r[2] === "/ItemAssignments") {
          b.items.push(String(q.ObjectSid));
          return this.ok({ sid: sid("BV"), object_sid: q.ObjectSid }, 201);
        }
        if (r[2] === "/Evaluations") return this.ok({ results: [{ results: [{ friendly_name: "Business name does not match the document", passed: false }] }] });
        if (method === "POST" && q.Status) b.status = String(q.Status);
        return this.ok(b);
      }
    }
    if (host === "messaging.twilio.com") {
      if (p === "/v1/Tollfree/Verifications") {
        if (method === "GET") return this.ok({ verifications: [...this.tfv.values()].filter((v) => v.account === user && v.tollfree_phone_number_sid === q.TollfreePhoneNumberSid) });
        const v = { sid: sid("HH"), account: user, status: "PENDING_REVIEW", tollfree_phone_number_sid: q.TollfreePhoneNumberSid, params: q, edit_allowed: false };
        this.tfv.set(v.sid, v);
        return this.ok(v, 201);
      }
      if ((r = m(/^\/v1\/Tollfree\/Verifications\/(HH\w+)$/))) {
        const v = this.tfv.get(r[1]);
        if (!v || v.account !== user) return this.nf();
        if (method === "POST") Object.assign(v, { status: "PENDING_REVIEW", params: q, edited: true });
        return this.ok(v);
      }
      if (p === "/v1/a2p/BrandRegistrations") {
        const b = { sid: sid("BN"), account: user, status: "PENDING", customer_profile_bundle_sid: q.CustomerProfileBundleSid, a2p_profile_bundle_sid: q.A2PProfileBundleSid };
        this.brands.set(b.sid, b);
        return this.ok(b, 201);
      }
      if ((r = m(/^\/v1\/a2p\/BrandRegistrations\/(BN\w+)$/))) return this.brands.get(r[1]) ? this.ok(this.brands.get(r[1])) : this.nf();
      if (p === "/v1/Services") {
        const s = { sid: sid("MG"), account: user, numbers: [] as string[] };
        this.services.set(s.sid, s);
        return this.ok(s, 201);
      }
      if ((r = m(/^\/v1\/Services\/(MG\w+)\/PhoneNumbers$/))) {
        this.services.get(r[1])!.numbers.push(String(q.PhoneNumberSid));
        return this.ok({ sid: q.PhoneNumberSid }, 201);
      }
      if ((r = m(/^\/v1\/Services\/(MG\w+)\/Compliance\/Usa2p(?:\/(QE\w+))?$/))) {
        if (r[2]) return this.campaigns.get(r[2]) ? this.ok(this.campaigns.get(r[2])) : this.nf();
        const c = { sid: sid("QE"), account: user, campaign_status: "PENDING", params: q };
        this.campaigns.set(c.sid, c);
        return this.ok(c, 201);
      }
    }
    if (host === "trusthub.twilio.com") {
      if (p === "/v1/CustomerProfiles" || p === "/v1/TrustProducts") {
        const map = p.endsWith("CustomerProfiles") ? this.profiles : this.products;
        const x = { sid: sid("BU"), account: user, status: "draft", policy_sid: q.PolicySid, entities: [] as string[] };
        map.set(x.sid, x);
        return this.ok(x, 201);
      }
      if (p === "/v1/EndUsers" || p === "/v1/SupportingDocuments") {
        const x = { sid: sid(p.endsWith("EndUsers") ? "IT" : "RD"), account: user, type: q.Type, attributes: JSON.parse(String(q.Attributes ?? "{}")) };
        (p.endsWith("EndUsers") ? this.endUsers : this.docs).set(x.sid, x);
        return this.ok(x, 201);
      }
      if ((r = m(/^\/v1\/(CustomerProfiles|TrustProducts)\/(BU\w+)(\/EntityAssignments|\/Evaluations)?$/))) {
        const x = (r[1] === "CustomerProfiles" ? this.profiles : this.products).get(r[2]);
        if (!x) return this.nf();
        if (r[3] === "/EntityAssignments") {
          x.entities.push(String(q.ObjectSid));
          return this.ok({ sid: sid("BV") }, 201);
        }
        if (r[3] === "/Evaluations") return this.ok({ status: "compliant", results: [] });
        if (method === "POST" && q.Status) x.status = String(q.Status);
        return this.ok(x);
      }
    }
    return this.err(404, 20404, `fake twilio: no route for ${method} ${host}${p}`);
  }
}

/** In-memory TwilioStore (same behaviour as the Postgres one). */
export function memoryTwilioStore(): TwilioStore & { rows: Map<string, TwilioRow>; regs: Map<string, RegistrationRow> } {
  const rows = new Map<string, TwilioRow>();
  const regs = new Map<string, RegistrationRow>();
  const key = (id: string, kind: string) => `${id}:${kind}`;
  const clean = <T extends object>(p: T) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  const store = {
    rows,
    regs,
    async get(id: string) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async insert(row: Pick<TwilioRow, "licensee_id" | "subaccount_sid" | "auth_token_encrypted" | "friendly_name">) {
      if (!rows.has(row.licensee_id)) {
        rows.set(row.licensee_id, {
          api_key_sid: null, api_key_secret_encrypted: null, twiml_app_sid: null, twiml_app_voice_url: null, verify_service_sid: null,
          address_sid: null, bundle_required: null, bundle_sid: null, bundle_status: null, bundle_end_user_sid: null, bundle_document_sid: null,
          bundle_failure: null, account_status: "active", status_changed_at: null, close_notice_sent_at: null, closed_at: null,
          created_at: new Date(), updated_at: new Date(), ...row,
        });
      }
      return { ...rows.get(row.licensee_id)! };
    },
    async update(id: string, patch: Partial<TwilioRow>) {
      const r = rows.get(id);
      if (r) Object.assign(r, clean(patch), { updated_at: new Date() });
    },
    async listOpen() {
      return [...rows.values()].filter((r) => r.account_status !== "closed").map((r) => ({ ...r }));
    },
    async registration(id: string, kind: RegKind) {
      const r = regs.get(key(id, kind));
      return r ? { ...r } : null;
    },
    async registrations(id: string) {
      return [...regs.values()].filter((r) => r.licensee_id === id).sort((a, b) => a.kind.localeCompare(b.kind)).map((r) => ({ ...r }));
    },
    async upsertRegistration(id: string, kind: RegKind, patch: Partial<RegistrationRow>) {
      if (!regs.has(key(id, kind))) {
        regs.set(key(id, kind), {
          licensee_id: id, kind, status: "needs_info", phone_number: null, phone_number_sid: null, verification_sid: null,
          customer_profile_sid: null, trust_product_sid: null, brand_sid: null, messaging_service_sid: null, campaign_sid: null,
          twilio_status: null, reason: null, submitted_at: null, approved_at: null, last_checked_at: null, next_check_at: null,
          pushed_status: null, pushed_at: null, push_error: null, created_at: new Date(), updated_at: new Date(),
        });
      }
      Object.assign(regs.get(key(id, kind))!, clean(patch), { updated_at: new Date() });
      return { ...regs.get(key(id, kind))! };
    },
    async dueRegistrations(now: Date, limit: number) {
      return [...regs.values()].filter((r) => (r.status === "submitted" || r.status === "pending") && (!r.next_check_at || r.next_check_at <= now)).slice(0, limit).map((r) => ({ ...r }));
    },
    async unpushedRegistrations(limit: number) {
      return [...regs.values()].filter((r) => r.pushed_status !== r.status).slice(0, limit).map((r) => ({ ...r }));
    },
  };
  return store;
}
