// KS_OPS_TWILIO_AUTO_v1 - texting registration for each licensee, through the Twilio APIs:
//   toll_free  toll-free verification (Messaging API, Tollfree/Verifications) for the licensee's toll-free line, so it
//              can text US and Canadian mobiles. Until approved, a toll-free number cannot text anyone.
//   a2p_10dlc  US A2P 10DLC for a US local line: Keystone is the ISV; each licensee gets a secondary customer profile
//              and an A2P trust product in its own sub-account (Trust Hub), then a Standard brand, a messaging service
//              holding the line, and a campaign once the brand is approved. Canadian local lines need none of this to
//              text Canadian mobiles (and cannot be registered for US texting at all).
// Submissions use the sign-up details and the client app's "Text me updates" consent. Status is polled (every 2 hours
// while pending), kept in texting_registrations, shown in plain English on /ops/provisioning and pushed to the
// licensee's KS-server (PUT /api/provision/texting) for its Settings > Phone lines page and its US texting rules.
import { audit, opsKeyOf, type LicenseeRow } from "../licensees/repo.js";
import { bodies, sendQuietly } from "../lib/email.js";
import { opsPublicUrl, salesEmail } from "../config.js";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "../licensees/validation.js";
import { isvProfileSid, notificationEmail } from "./config.js";
import { API, isTransient, logTwilioError, MESSAGING, plainTwilioError, TRUSTHUB, type TwilioCreds } from "./http.js";
import { subCreds, twilioOf, type TwilioDeps } from "./account.js";
import type { RegistrationRow, RegKind, RegStatus } from "./store.js";

const MIN = 60_000;
export const CHECK_EVERY_MS = 2 * 60 * MIN;
export const SECONDARY_PROFILE_POLICY = "RNdfbf3fae0e1107f8aded0e7cead80bf5";
export const A2P_TRUST_PRODUCT_POLICY = "RNb0d4771c2c98518d916a3d4cd70a8f8b";
export const CARRIER_TIME = "usually 3-10 business days";

/** The client app's consent wording (KS-Client src/lib/smsUpdatesConsent.ts), quoted in every submission. */
export const CONSENT_TEXT =
  "Text me updates about my application: status updates, document requests and signing reminders. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. Not required to apply.";

const TOLL_FREE_RE = /^\+18(00|33|44|55|66|77|88)\d{7}$/;
// Canadian and other non-US NANP area codes (the same lists as KS-server src/lib/smsFrom.ts).
const NON_US_AREA = new Set(["204","226","236","249","250","257","263","289","306","343","354","365","367","368","382","387","403","416","418","428","431","437","438","450","460","468","474","506","514","519","548","579","581","584","587","600","604","613","622","633","639","644","647","655","672","677","683","688","705","709","742","753","778","780","782","807","819","825","867","873","879","902","905","942",
  "242","246","264","268","284","345","441","473","649","658","664","721","758","767","784","809","829","849","868","869","876"]);

export function isUsLocal(n: string | null | undefined): boolean {
  const m = /^\+1(\d{3})\d{7}$/.exec(String(n ?? ""));
  return Boolean(m) && !TOLL_FREE_RE.test(String(n)) && !NON_US_AREA.has(m![1]);
}

/** The status in plain English, for staff (KS-Ops page) and the brokerage (Settings > Phone lines). */
export function plainStatus(r: Pick<RegistrationRow, "kind" | "status" | "phone_number" | "reason">): string {
  const line = r.kind === "toll_free" ? `your toll-free line${r.phone_number ? ` ${r.phone_number}` : ""}` : `your business line${r.phone_number ? ` ${r.phone_number}` : ""}`;
  const what = r.kind === "toll_free" ? `Texting from ${line}` : `Texting US mobiles from ${line} (US A2P 10DLC registration)`;
  switch (r.status) {
    case "approved":
      return r.kind === "toll_free" ? `${what} is approved by the carriers. Texts to US mobiles go out from it.` : `${what} is approved by the carriers.`;
    case "pending":
    case "submitted":
      return `${what}: approval pending with carriers (${CARRIER_TIME}). Until then, texts to US mobiles wait; Canadian mobiles get texts from your business line.`;
    case "rejected":
      return `${what} was not approved${r.reason ? `: ${r.reason}` : ""}. Keystone support has been told and will fix and resubmit it.`;
    case "needs_info":
      return `${what} has not been sent for approval yet${r.reason ? `: ${r.reason}` : ""}. Keystone support has been told.`;
    case "not_needed":
      return r.reason || `${what} is not needed.`;
  }
  return what;
}

/** What is missing from the sign-up to submit a registration ("" when complete). */
export function registrationMissing(l: LicenseeRow): string {
  const missing: string[] = [];
  if (!l.business_number) missing.push(l.country === "US" ? "the EIN" : "the business number");
  if (!/^https?:\/\//.test(String(l.website ?? ""))) missing.push("the business website");
  if (!l.address_line1 || !l.city || !l.postal_code || !l.province_state) missing.push("the full business address");
  if (!l.contact_title) missing.push("the contact's job title");
  return missing.join(", ");
}

function e164(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return String(raw ?? "").startsWith("+") ? `+${d}` : `+${d}`;
}

function names(l: LicenseeRow) {
  const [first, ...rest] = String(l.contact_name ?? "").trim().split(/\s+/);
  return { first: first || l.contact_name, last: rest.join(" ") || first || l.contact_name };
}

/** The public page that shows the opt-in (Twilio asks for a link to it). */
export function optInUrl(l: Pick<LicenseeRow, "company_code">, e: NodeJS.ProcessEnv = process.env): string {
  return `${opsPublicUrl(undefined, e)}/api/public/texting-opt-in/${encodeURIComponent(l.company_code)}`;
}

function useCaseSummary(l: LicenseeRow): string {
  return `${l.company_name} is a business-financing broker. Applicants who tick the optional, unticked "Text me updates about my application" box in ${l.company_name}'s client app (when they verify their mobile number, or later in Settings) get texts about their own application only: status updates, document requests, signing reminders and replies from their advisor. No marketing. Consent wording: "${CONSENT_TEXT}"`;
}

function sampleMessage(l: LicenseeRow): string {
  return `${l.company_name}: your application has been sent to a lender. We still need your last 3 months of bank statements - upload them in the app${l.client_url ? ` at ${l.client_url}` : ""}. Reply STOP to opt out.`;
}

function entityType(t: string | null | undefined): string {
  if (t === "sole_proprietor") return "SOLE_PROPRIETOR";
  if (t === "non_profit") return "NON_PROFIT";
  return "PRIVATE_PROFIT";
}

/** Trust Hub's business_type values. */
function trustHubBusinessType(t: string | null | undefined): string {
  return ({ corporation: "Corporation", llc: "Limited Liability Corporation", partnership: "Partnership", sole_proprietor: "Sole Proprietorship", non_profit: "Non-profit Corporation", cooperative: "Co-operative" } as Record<string, string>)[String(t)] ?? "Corporation";
}

type Log = (m: string) => Promise<void>;
type NumberInfo = { kind: string; number?: string; status?: string };

async function save(deps: TwilioDeps, licenseeId: string, kind: RegKind, patch: Partial<RegistrationRow>): Promise<RegistrationRow> {
  const { store } = twilioOf(deps);
  const before = await store.registration(licenseeId, kind);
  const changed = patch.status !== undefined && (patch.status !== before?.status || (patch.reason ?? null) !== (before?.reason ?? null));
  const row = await store.upsertRegistration(licenseeId, kind, {
    ...patch,
    ...(changed ? { pushed_status: null, approved_at: patch.status === "approved" ? deps.now() : before?.approved_at ?? null } : {}),
  });
  if (changed) {
    await audit(deps.db, "ks-ops twilio", "licensee.texting_status", licenseeId, { kind, from: before?.status ?? null, to: row.status, reason: row.reason });
  }
  return row;
}

async function numberSid(deps: TwilioDeps, sub: TwilioCreds, phone: string): Promise<string | null> {
  const { http } = twilioOf(deps);
  const r = await http.get(sub, `${API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`, { PhoneNumber: phone, PageSize: 5 }, "find the number in the sub-account");
  const n = ((r?.incoming_phone_numbers ?? []) as any[])[0];
  return n?.sid ? String(n.sid) : null;
}

function tollFreeParams(deps: TwilioDeps, l: LicenseeRow, pnSid: string): Record<string, any> {
  const { env } = twilioOf(deps);
  const n = names(l);
  return {
    BusinessName: l.legal_name,
    DoingBusinessAs: l.company_name !== l.legal_name ? l.company_name : undefined,
    BusinessWebsite: l.website,
    NotificationEmail: notificationEmail(env),
    UseCaseCategories: ["ACCOUNT_NOTIFICATIONS", "CUSTOMER_CARE"],
    UseCaseSummary: useCaseSummary(l),
    ProductionMessageSample: sampleMessage(l),
    OptInImageUrls: [optInUrl(l, env)],
    OptInType: "WEB_FORM",
    MessageVolume: "1,000",
    TollfreePhoneNumberSid: pnSid,
    BusinessStreetAddress: l.address_line1,
    BusinessStreetAddress2: l.address_line2 || undefined,
    BusinessCity: l.city,
    BusinessStateProvinceRegion: String(l.province_state ?? "").toUpperCase(),
    BusinessPostalCode: l.postal_code,
    BusinessCountry: l.country === "US" ? "US" : "CA",
    BusinessContactFirstName: n.first,
    BusinessContactLastName: n.last,
    BusinessContactEmail: l.contact_email,
    BusinessContactPhone: e164(l.contact_phone),
    BusinessRegistrationNumber: l.business_number,
    BusinessRegistrationType: l.country === "US" ? "EIN" : "CRA",
    BusinessRegistrationCountry: l.country === "US" ? "US" : "CA",
    EntityType: entityType(l.business_type),
    AdditionalInformation: `Opt-in: the unticked "Text me updates" box in the client app, shown at ${optInUrl(l, env)}. Contact's title: ${l.contact_title ?? ""}. Kind of business: ${BUSINESS_TYPE_LABELS[l.business_type as BusinessType] ?? "not given"}.`,
    ExternalReferenceId: l.id,
  };
}

/** Twilio's toll-free verification status -> ours. */
function tollFreeStatus(v: any): { status: RegStatus; reason: string | null; twilio: string } {
  const s = String(v?.status ?? "");
  if (s === "TWILIO_APPROVED") return { status: "approved", reason: null, twilio: s };
  if (s === "TWILIO_REJECTED") {
    const reasons = ((v?.rejection_reasons ?? []) as any[]).map((x) => String(x?.reason ?? x?.description ?? "")).filter(Boolean);
    const reason = [v?.rejection_reason ? String(v.rejection_reason) : "", ...reasons].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("; ");
    return { status: "rejected", reason: reason || "no reason given", twilio: s };
  }
  return { status: "pending", reason: null, twilio: s || "PENDING_REVIEW" };
}

/** Submits (or adopts, or resubmits after a fix) the toll-free verification. Safe to call again. */
export async function submitTollFree(deps: TwilioDeps, l: LicenseeRow, tollFree: string | null, log: Log = async () => {}): Promise<RegistrationRow> {
  const { store, http, env } = twilioOf(deps);
  if (!tollFree) {
    return save(deps, l.id, "toll_free", {
      status: "not_needed",
      reason: l.plan === "starter"
        ? "Your plan has no toll-free line, so texts to US mobiles cannot be sent (they need the toll-free line on Growth or Pro). Canadian mobiles get texts from your business line."
        : "No toll-free line yet.",
      phone_number: null,
    });
  }
  const current = await store.registration(l.id, "toll_free");
  if (current?.verification_sid && current.phone_number === tollFree && current.status !== "rejected" && current.status !== "needs_info") return current;
  const missing = registrationMissing(l);
  if (missing) {
    return save(deps, l.id, "toll_free", { status: "needs_info", reason: `missing ${missing}`, phone_number: tollFree });
  }
  const sub = subCreds(await store.get(l.id), env);
  if (!sub) return save(deps, l.id, "toll_free", { status: "needs_info", reason: "no Twilio sub-account yet", phone_number: tollFree });
  try {
    const pn = await numberSid(deps, sub, tollFree);
    if (!pn) return save(deps, l.id, "toll_free", { status: "needs_info", reason: `the toll-free number ${tollFree} is not in the licensee's Twilio account`, phone_number: tollFree });
    const params = tollFreeParams(deps, l, pn);
    let v: any;
    if (current?.verification_sid && current.status === "rejected" && current.phone_number === tollFree) {
      const old = await http.get(sub, `${MESSAGING}/Tollfree/Verifications/${current.verification_sid}`, {}, "read the toll-free verification");
      if (old?.edit_allowed) {
        v = await http.post(sub, `${MESSAGING}/Tollfree/Verifications/${current.verification_sid}`, { ...params, EditReason: "Details corrected by Keystone support" }, "resubmit the toll-free verification");
        await log(`toll-free verification ${current.verification_sid} resubmitted`);
      }
    }
    if (!v) {
      const list = await http.get(sub, `${MESSAGING}/Tollfree/Verifications`, { TollfreePhoneNumberSid: pn, PageSize: 20 }, "look for a toll-free verification");
      const existing = ((list?.verifications ?? []) as any[]).find((x) => String(x.status) !== "TWILIO_REJECTED");
      v = existing ?? (await http.post(sub, `${MESSAGING}/Tollfree/Verifications`, params, "submit the toll-free verification"));
      await log(`${existing ? "found the" : "submitted the"} toll-free verification ${v.sid} for ${tollFree}`);
    }
    const st = tollFreeStatus(v);
    return save(deps, l.id, "toll_free", {
      status: st.status, reason: st.reason, twilio_status: st.twilio, phone_number: tollFree, phone_number_sid: pn,
      verification_sid: String(v.sid), submitted_at: current?.submitted_at ?? deps.now(), last_checked_at: deps.now(),
      next_check_at: new Date(deps.now().getTime() + CHECK_EVERY_MS),
    });
  } catch (err) {
    logTwilioError("toll-free verification", err, { licensee: l.id });
    return save(deps, l.id, "toll_free", {
      status: isTransient(err) && current?.verification_sid ? current.status : "needs_info",
      reason: plainTwilioError(err), phone_number: tollFree,
      next_check_at: new Date(deps.now().getTime() + CHECK_EVERY_MS),
    });
  }
}

/**
 * US A2P 10DLC for a US local line, through the ISV flow. Each part is created once and its id kept, so a retry
 * carries on where the last one stopped. The campaign is made once the brand is approved (by refreshRegistration).
 */
export async function submitA2p(deps: TwilioDeps, l: LicenseeRow, local: string | null, log: Log = async () => {}): Promise<RegistrationRow> {
  const { store, http, env } = twilioOf(deps);
  if (!local || !isUsLocal(local)) {
    return save(deps, l.id, "a2p_10dlc", {
      status: "not_needed",
      reason: local
        ? "Your business line is Canadian: it texts Canadian mobiles without registration. US mobiles get texts from your toll-free line once it is approved."
        : "No business line yet.",
      phone_number: local,
    });
  }
  const isv = isvProfileSid(env);
  if (!isv) return save(deps, l.id, "a2p_10dlc", { status: "needs_info", reason: "Keystone's ISV profile in Twilio Trust Hub is not set up yet (KS_TWILIO_ISV_PROFILE_SID)", phone_number: local });
  const missing = registrationMissing(l);
  if (missing) return save(deps, l.id, "a2p_10dlc", { status: "needs_info", reason: `missing ${missing}`, phone_number: local });
  const row = await store.get(l.id);
  const sub = subCreds(row, env);
  if (!row || !sub || !row.address_sid) return save(deps, l.id, "a2p_10dlc", { status: "needs_info", reason: "no Twilio sub-account or registered address yet", phone_number: local });
  let reg = await store.registration(l.id, "a2p_10dlc");
  if (reg?.campaign_sid && reg.status !== "rejected") return reg;
  const email = notificationEmail(env);
  const n = names(l);
  try {
    // 1. Secondary customer profile (the licensee), with Keystone's primary profile attached.
    let profile = reg?.customer_profile_sid ?? null;
    if (!profile) {
      const p = await http.post(sub, `${TRUSTHUB}/CustomerProfiles`, { FriendlyName: `${l.legal_name} (Keystone)`.slice(0, 64), Email: email, PolicySid: SECONDARY_PROFILE_POLICY }, "create the business profile");
      profile = String(p.sid);
      reg = await save(deps, l.id, "a2p_10dlc", { status: "submitted", reason: null, phone_number: local, customer_profile_sid: profile });
      const business = await http.post(sub, `${TRUSTHUB}/EndUsers`, {
        FriendlyName: `${l.legal_name} business information`.slice(0, 64),
        Type: "customer_profile_business_information",
        Attributes: JSON.stringify({
          business_name: l.legal_name,
          business_identity: "direct_customer",
          business_type: trustHubBusinessType(l.business_type),
          business_industry: "FINANCIAL",
          business_registration_identifier: l.country === "US" ? "EIN" : "CBN",
          business_registration_number: l.business_number,
          business_regions_of_operation: "USA_AND_CANADA",
          website_url: l.website,
        }),
      }, "add the business details");
      const rep = await http.post(sub, `${TRUSTHUB}/EndUsers`, {
        FriendlyName: `${l.contact_name} (authorized representative)`.slice(0, 64),
        Type: "authorized_representative_1",
        Attributes: JSON.stringify({ first_name: n.first, last_name: n.last, email: l.contact_email, phone_number: e164(l.contact_phone), business_title: l.contact_title, job_position: "Director" }),
      }, "add the authorized contact");
      const doc = await http.post(sub, `${TRUSTHUB}/SupportingDocuments`, { FriendlyName: "Business address", Type: "customer_profile_address", Attributes: JSON.stringify({ address_sids: row.address_sid }) }, "add the business address");
      for (const sid of [business.sid, rep.sid, doc.sid, isv]) {
        await http.post(sub, `${TRUSTHUB}/CustomerProfiles/${profile}/EntityAssignments`, { ObjectSid: sid }, "attach the profile's details");
      }
      const ev = await http.post(sub, `${TRUSTHUB}/CustomerProfiles/${profile}/Evaluations`, { PolicySid: SECONDARY_PROFILE_POLICY }, "check the business profile");
      if (String(ev?.status) === "noncompliant") {
        const why = ((ev?.results ?? []) as any[]).filter((x) => x.passed === false).map((x) => String(x.friendly_name ?? x.object_type)).join(", ");
        return save(deps, l.id, "a2p_10dlc", { status: "needs_info", reason: `Twilio says the business profile is incomplete${why ? `: ${why}` : ""}` });
      }
      await http.post(sub, `${TRUSTHUB}/CustomerProfiles/${profile}`, { Status: "pending-review" }, "submit the business profile");
      await log(`business profile ${profile} submitted to Twilio`);
    }
    // 2. A2P trust product (the messaging profile).
    let product = reg?.trust_product_sid ?? null;
    if (!product) {
      const tp = await http.post(sub, `${TRUSTHUB}/TrustProducts`, { FriendlyName: `${l.legal_name} A2P`.slice(0, 64), Email: email, PolicySid: A2P_TRUST_PRODUCT_POLICY }, "create the A2P messaging profile");
      product = String(tp.sid);
      reg = await save(deps, l.id, "a2p_10dlc", { trust_product_sid: product });
      const info = await http.post(sub, `${TRUSTHUB}/EndUsers`, {
        FriendlyName: `${l.legal_name} messaging profile`.slice(0, 64),
        Type: "us_a2p_messaging_profile_information",
        Attributes: JSON.stringify({ company_type: l.business_type === "non_profit" ? "non-profit" : "private" }),
      }, "add the messaging profile details");
      for (const sid of [info.sid, profile]) {
        await http.post(sub, `${TRUSTHUB}/TrustProducts/${product}/EntityAssignments`, { ObjectSid: sid }, "attach the messaging profile's details");
      }
      await http.post(sub, `${TRUSTHUB}/TrustProducts/${product}/Evaluations`, { PolicySid: A2P_TRUST_PRODUCT_POLICY }, "check the messaging profile");
      await http.post(sub, `${TRUSTHUB}/TrustProducts/${product}`, { Status: "pending-review" }, "submit the messaging profile");
    }
    // 3. The brand.
    if (!reg?.brand_sid) {
      const b = await http.post(sub, `${MESSAGING}/a2p/BrandRegistrations`, { CustomerProfileBundleSid: profile, A2PProfileBundleSid: product }, "register the brand");
      reg = await save(deps, l.id, "a2p_10dlc", { brand_sid: String(b.sid), twilio_status: `brand ${String(b.status ?? "PENDING")}` });
      await log(`brand ${b.sid} registered; the campaign follows once it is approved`);
    }
    // 4. The messaging service holding the line.
    if (!reg?.messaging_service_sid) {
      const svc = await http.post(sub, `${MESSAGING}/Services`, { FriendlyName: "Keystone texting", UseInboundWebhookOnNumber: true }, "create the messaging service");
      const pn = await numberSid(deps, sub, local);
      if (pn) await http.post(sub, `${MESSAGING}/Services/${svc.sid}/PhoneNumbers`, { PhoneNumberSid: pn }, "add the business line to the messaging service");
      reg = await save(deps, l.id, "a2p_10dlc", { messaging_service_sid: String(svc.sid), phone_number_sid: pn });
    }
    return save(deps, l.id, "a2p_10dlc", {
      status: "pending", reason: null, submitted_at: reg?.submitted_at ?? deps.now(), last_checked_at: deps.now(),
      next_check_at: new Date(deps.now().getTime() + CHECK_EVERY_MS),
    });
  } catch (err) {
    logTwilioError("A2P 10DLC registration", err, { licensee: l.id });
    return save(deps, l.id, "a2p_10dlc", {
      status: isTransient(err) ? (reg?.status ?? "submitted") : "needs_info", reason: plainTwilioError(err),
      next_check_at: new Date(deps.now().getTime() + 10 * MIN),
    });
  }
}

async function createCampaign(deps: TwilioDeps, l: LicenseeRow, sub: TwilioCreds, reg: RegistrationRow): Promise<any> {
  const { http } = twilioOf(deps);
  return http.post(sub, `${MESSAGING}/Services/${reg.messaging_service_sid}/Compliance/Usa2p`, {
    BrandRegistrationSid: reg.brand_sid,
    Description: useCaseSummary(l).slice(0, 1024),
    MessageFlow: `Applicants opt in in ${l.company_name}'s client app (${l.client_url ?? "the client app"}) by ticking the optional, unticked "Text me updates about my application" box when they verify their mobile number, or later in Settings. Consent wording: "${CONSENT_TEXT}" Shown at ${optInUrl(l)}.`,
    MessageSamples: [sampleMessage(l), `${l.company_name}: your documents are ready to sign. Open the app to sign them. Reply STOP to opt out.`],
    UsAppToPersonUsecase: "ACCOUNT_NOTIFICATION",
    HasEmbeddedLinks: true,
    HasEmbeddedPhone: false,
    OptInMessage: `${l.company_name}: you'll get texts about your application. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    OptOutMessage: `${l.company_name}: you won't get any more texts from us. Reply START to get them again.`,
    HelpMessage: `${l.company_name}: for help, contact ${l.contact_email}. Reply STOP to opt out.`,
  }, "register the campaign");
}

/** Checks one pending registration with Twilio and moves it on. Never throws; failures are logged and retried. */
export async function refreshRegistration(deps: TwilioDeps, l: LicenseeRow, reg: RegistrationRow): Promise<RegistrationRow> {
  const { store, http, env } = twilioOf(deps);
  const sub = subCreds(await store.get(l.id), env);
  const next = new Date(deps.now().getTime() + CHECK_EVERY_MS);
  if (!sub) return save(deps, l.id, reg.kind, { last_checked_at: deps.now(), next_check_at: next });
  try {
    if (reg.kind === "toll_free" && reg.verification_sid) {
      const v = await http.get(sub, `${MESSAGING}/Tollfree/Verifications/${reg.verification_sid}`, {}, "check the toll-free verification");
      const st = tollFreeStatus(v);
      return save(deps, l.id, "toll_free", { status: st.status, reason: st.reason, twilio_status: st.twilio, last_checked_at: deps.now(), next_check_at: st.status === "pending" ? next : null });
    }
    if (reg.kind === "a2p_10dlc") {
      if (reg.campaign_sid && reg.messaging_service_sid) {
        const c = await http.get(sub, `${MESSAGING}/Services/${reg.messaging_service_sid}/Compliance/Usa2p/${reg.campaign_sid}`, {}, "check the campaign");
        const cs = String(c?.campaign_status ?? "");
        if (cs === "VERIFIED") return save(deps, l.id, "a2p_10dlc", { status: "approved", reason: null, twilio_status: `campaign ${cs}`, last_checked_at: deps.now(), next_check_at: null });
        if (cs === "FAILED") {
          const why = ((c?.errors ?? []) as any[]).map((e) => String(e?.description ?? e?.message ?? "")).filter(Boolean).join("; ");
          return save(deps, l.id, "a2p_10dlc", { status: "rejected", reason: `campaign not approved${why ? `: ${why}` : ""}`, twilio_status: `campaign ${cs}`, last_checked_at: deps.now(), next_check_at: null });
        }
        return save(deps, l.id, "a2p_10dlc", { status: "pending", twilio_status: `campaign ${cs || "PENDING"}`, last_checked_at: deps.now(), next_check_at: next });
      }
      if (reg.brand_sid) {
        const b = await http.get(sub, `${MESSAGING}/a2p/BrandRegistrations/${reg.brand_sid}`, {}, "check the brand");
        const bs = String(b?.status ?? "");
        if (bs === "FAILED") {
          return save(deps, l.id, "a2p_10dlc", { status: "rejected", reason: `brand not approved${b?.failure_reason ? `: ${String(b.failure_reason)}` : ""}`, twilio_status: `brand ${bs}`, last_checked_at: deps.now(), next_check_at: null });
        }
        if (bs === "APPROVED" && reg.messaging_service_sid) {
          const c = await createCampaign(deps, l, sub, reg);
          await audit(deps.db, "ks-ops twilio", "licensee.a2p_campaign_submitted", l.id, { campaign_sid: c.sid });
          return save(deps, l.id, "a2p_10dlc", { status: "pending", campaign_sid: String(c.sid), twilio_status: `campaign ${String(c.campaign_status ?? "PENDING")}`, last_checked_at: deps.now(), next_check_at: next });
        }
        return save(deps, l.id, "a2p_10dlc", { status: "pending", twilio_status: `brand ${bs || "PENDING"}`, last_checked_at: deps.now(), next_check_at: next });
      }
    }
    return save(deps, l.id, reg.kind, { last_checked_at: deps.now(), next_check_at: next });
  } catch (err) {
    logTwilioError("texting status check", err, { licensee: l.id, kind: reg.kind });
    return save(deps, l.id, reg.kind, { last_checked_at: deps.now(), next_check_at: next });
  }
}

/** The licensee's business and toll-free lines, from the phone_numbers step's results. */
export function linesFrom(results: unknown): { local: string | null; tollFree: string | null } {
  const list = (Array.isArray(results) ? results : []) as NumberInfo[];
  const ok = (x: NumberInfo) => x.status === "bought" || x.status === "already_had";
  const local = list.find((x) => x.kind === "main" && ok(x) && x.number)?.number ?? null;
  const tollFree = list.find((x) => x.kind === "toll_free" && ok(x) && x.number)?.number ?? null;
  return { local, tollFree };
}

/** Submits both registrations for a licensee; returns the rows (for the step's log and output). */
export async function submitTexting(deps: TwilioDeps, l: LicenseeRow, lines: { local: string | null; tollFree: string | null }, log: Log = async () => {}): Promise<RegistrationRow[]> {
  const tf = await submitTollFree(deps, l, lines.tollFree, log);
  const a2p = await submitA2p(deps, l, lines.local, log);
  for (const r of [tf, a2p]) if (r.status === "needs_info" || r.status === "rejected") await tellSales(deps, l, r);
  return [tf, a2p];
}

async function tellSales(deps: TwilioDeps, l: LicenseeRow, r: RegistrationRow): Promise<void> {
  const { env } = twilioOf(deps);
  await sendQuietly(deps.mailer, {
    to: [salesEmail(env)],
    subject: `Texting registration needs attention: ${l.company_name} (${l.company_code})`,
    ...bodies([
      plainStatus(r),
      r.status === "needs_info"
        ? "Add what is missing on the licensee in KS-Ops, then press \"Resubmit texting\" on /ops/provisioning."
        : "Read the reason, correct the licensee's details in KS-Ops, then press \"Resubmit texting\" on /ops/provisioning.",
    ]),
  }, "texting registration notice");
}

/** Pushes the licensee's registrations to its KS-server (PUT /api/provision/texting). */
export async function pushTexting(deps: TwilioDeps, l: LicenseeRow): Promise<{ ok: boolean; error?: string }> {
  const { store } = twilioOf(deps);
  const key = opsKeyOf(l);
  if (!l.server_url || !key) return { ok: false, error: "no server address or ops key" };
  const regs = await store.registrations(l.id);
  try {
    const r = await deps.fetch(`${l.server_url.replace(/\/+$/, "")}/api/provision/texting`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key, "X-KS-Ops-User": "ks-ops texting" },
      body: JSON.stringify({ registrations: regs.map((x) => ({ kind: x.kind, status: x.status, phone_number: x.phone_number, reason: x.reason, message: plainStatus(x) })) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const error = `KS-server answered ${r.status}`;
      for (const x of regs) await store.upsertRegistration(l.id, x.kind, { push_error: error });
      return { ok: false, error };
    }
    for (const x of regs) await store.upsertRegistration(l.id, x.kind, { pushed_status: x.status, pushed_at: deps.now(), push_error: null });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const x of regs) await store.upsertRegistration(l.id, x.kind, { push_error: error.slice(0, 500) });
    return { ok: false, error };
  }
}
