// KS_OPS_TWILIO_AUTO_v1 - a licensee's own Twilio sub-account under Keystone's master account, and everything the
// licensee's KS-server needs inside it: an API key (voice access tokens for the diallers), a TwiML app (outgoing calls
// from the apps), a Verify service (sign-in codes), the business address, and a regulatory bundle when Twilio's rules
// ask for one. Every function checks before it creates, keeps what it made in licensee_twilio, and is safe to run
// again. Every Twilio failure is logged with its code and returned as a plain sentence for staff.
import type { Deps } from "../deps.js";
import { decryptSecret, encryptionKey, encryptSecret } from "../lib/crypto.js";
import { audit, type LicenseeRow } from "../licensees/repo.js";
import { masterCreds, notificationEmail, subaccountName } from "./config.js";
import { API, isTransient, logTwilioError, NUMBERS, plainTwilioError, TwilioError, twilioHttp, VERIFY, type TwilioCreds, type TwilioHttp } from "./http.js";
import { pgTwilioStore, type TwilioRow, type TwilioStore } from "./store.js";

export type TwilioDeps = Pick<Deps, "db" | "fetch" | "mailer" | "now"> & {
  env?: NodeJS.ProcessEnv;
  twilioStore?: TwilioStore;
  twilioHttp?: TwilioHttp;
};

export function twilioOf(deps: TwilioDeps): { store: TwilioStore; http: TwilioHttp; env: NodeJS.ProcessEnv } {
  return { store: deps.twilioStore ?? pgTwilioStore(deps.db), http: deps.twilioHttp ?? twilioHttp(deps.fetch), env: deps.env ?? process.env };
}

/** done: finished. blocked: Keystone-level setup missing (retried later). retry: try again soon. failed: needs a person. */
export type TwilioOutcome =
  | { kind: "done"; message: string; output?: Record<string, unknown> }
  | { kind: "wait"; message: string; retryMs: number }
  | { kind: "blocked"; message: string }
  | { kind: "failed"; message: string };

const MIN = 60_000;

export const MASTER_MISSING =
  "Keystone's Twilio master account is not connected to KS-Ops yet: set KS_TWILIO_ACCOUNT_SID and KS_TWILIO_AUTH_TOKEN on the ks-ops app (see docs/PROVISIONING.md).";
const KEY_MISSING = "OPS_ENCRYPTION_KEY is not set on KS-Ops, so the sub-account's credentials cannot be stored safely.";

/** The voice webhook the TwiML app (and every bought number) points at on the licensee's KS-server. */
export function voiceUrlFor(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/api/webhooks/twilio/voice/twiml`;
}

/** The sub-account's own credentials (decrypted), or null without a row or key. */
export function subCreds(row: Pick<TwilioRow, "subaccount_sid" | "auth_token_encrypted"> | null, env: NodeJS.ProcessEnv = process.env): TwilioCreds | null {
  const key = encryptionKey(String(env.OPS_ENCRYPTION_KEY ?? "").trim());
  if (!row || !key) return null;
  return { accountSid: row.subaccount_sid, authToken: decryptSecret(row.auth_token_encrypted, key) };
}

function outcomeFor(err: unknown, where: string, licenseeId: string): TwilioOutcome {
  logTwilioError(where, err, { licensee: licenseeId });
  const message = plainTwilioError(err);
  return isTransient(err) ? { kind: "wait", message, retryMs: 5 * MIN } : { kind: "failed", message };
}

const notFound = (err: unknown) => err instanceof TwilioError && (err.status === 404 || err.code === 20404);

/**
 * The sub-account, its API key, TwiML app and Verify service. Finds a sub-account made earlier with the same name
 * (e.g. the row was lost) instead of making a second one.
 */
export async function ensureSubaccount(deps: TwilioDeps, l: LicenseeRow, log: (m: string) => Promise<void> = async () => {}): Promise<TwilioOutcome> {
  const { store, http, env } = twilioOf(deps);
  const master = masterCreds(env);
  if (!master) return { kind: "blocked", message: MASTER_MISSING };
  const key = encryptionKey(String(env.OPS_ENCRYPTION_KEY ?? "").trim());
  if (!key) return { kind: "failed", message: KEY_MISSING };
  try {
    let row = await store.get(l.id);
    if (!row) {
      const name = subaccountName(l);
      const found = await http.get(master, `${API}/Accounts.json`, { FriendlyName: name, PageSize: 20 }, "look for the licensee's sub-account");
      const existing = ((found?.accounts ?? []) as any[]).find((a) => a.friendly_name === name && a.status !== "closed" && a.sid !== master.accountSid);
      const acc = existing ?? (await http.post(master, `${API}/Accounts.json`, { FriendlyName: name }, "create the licensee's sub-account"));
      if (!acc?.sid || !acc?.auth_token) throw new TwilioError("Twilio did not return the sub-account's credentials", 502, null, null, "create the licensee's sub-account");
      row = await store.insert({ licensee_id: l.id, subaccount_sid: String(acc.sid), auth_token_encrypted: encryptSecret(String(acc.auth_token), key), friendly_name: name });
      if (String(acc.status ?? "active") !== "active") await store.update(l.id, { account_status: acc.status === "suspended" ? "suspended" : "active" });
      await audit(deps.db, "ks-ops twilio", existing ? "licensee.twilio_subaccount_found" : "licensee.twilio_subaccount_created", l.id, { subaccount_sid: acc.sid, friendly_name: name });
      await log(`${existing ? "found the existing" : "created the"} Twilio sub-account ${acc.sid} (${name})`);
    }
    if (row.account_status === "closed") return { kind: "failed", message: `The licensee's Twilio sub-account ${row.subaccount_sid} was closed. A closed Twilio account cannot be reopened; a person must decide what to do.` };
    const sub = subCreds(row, env)!;

    // API key for voice access tokens (TWILIO_API_KEY / TWILIO_API_SECRET). Twilio shows a key's secret only once.
    let keySid = row.api_key_sid;
    if (keySid && row.api_key_secret_encrypted) {
      try {
        await http.get(sub, `${API}/Accounts/${sub.accountSid}/Keys/${keySid}.json`, {}, "check the voice API key");
      } catch (err) {
        if (!notFound(err)) throw err;
        await log(`the voice API key ${keySid} is gone from Twilio; making a new one`);
        keySid = null;
      }
    } else keySid = null;
    if (!keySid) {
      const k = await http.post(sub, `${API}/Accounts/${sub.accountSid}/Keys.json`, { FriendlyName: "Keystone voice tokens" }, "create the voice API key");
      if (!k?.sid || !k?.secret) throw new TwilioError("Twilio did not return the API key secret", 502, null, null, "create the voice API key");
      await store.update(l.id, { api_key_sid: String(k.sid), api_key_secret_encrypted: encryptSecret(String(k.secret), key) });
      await audit(deps.db, "ks-ops twilio", "licensee.twilio_api_key_created", l.id, { api_key_sid: k.sid });
      await log(`created the voice API key ${k.sid}`);
    }

    // TwiML app for calls placed from the apps (TWILIO_VOICE_APP_SID). Its voice URL is set once the server answers.
    let appSid = row.twiml_app_sid;
    if (appSid) {
      try {
        await http.get(sub, `${API}/Accounts/${sub.accountSid}/Applications/${appSid}.json`, {}, "check the dialler's TwiML app");
      } catch (err) {
        if (!notFound(err)) throw err;
        appSid = null;
      }
    }
    if (!appSid) {
      const list = await http.get(sub, `${API}/Accounts/${sub.accountSid}/Applications.json`, { FriendlyName: "Keystone dialler", PageSize: 20 }, "look for the dialler's TwiML app");
      const found = ((list?.applications ?? []) as any[]).find((a) => a.friendly_name === "Keystone dialler");
      const voiceUrl = l.server_url ? voiceUrlFor(l.server_url) : undefined;
      const app = found ?? (await http.post(sub, `${API}/Accounts/${sub.accountSid}/Applications.json`, { FriendlyName: "Keystone dialler", VoiceUrl: voiceUrl, VoiceMethod: voiceUrl ? "POST" : undefined }, "create the dialler's TwiML app"));
      await store.update(l.id, { twiml_app_sid: String(app.sid), twiml_app_voice_url: app.voice_url ? String(app.voice_url) : null });
      await log(`${found ? "found" : "created"} the dialler's TwiML app ${app.sid}`);
    }

    // Verify service for the one-time sign-in codes (TWILIO_VERIFY_SERVICE_SID). Texts say "Your <company> code is".
    let verifySid = row.verify_service_sid;
    if (verifySid) {
      try {
        await http.get(sub, `${VERIFY}/Services/${verifySid}`, {}, "check the sign-in code service");
      } catch (err) {
        if (!notFound(err)) throw err;
        verifySid = null;
      }
    }
    if (!verifySid) {
      const friendly = l.company_name.replace(/[^A-Za-z0-9 .,&'-]/g, "").trim().slice(0, 30) || "Keystone";
      const list = await http.get(sub, `${VERIFY}/Services`, { PageSize: 50 }, "look for the sign-in code service");
      const found = ((list?.services ?? []) as any[]).find((s) => s.friendly_name === friendly);
      const svc = found ?? (await http.post(sub, `${VERIFY}/Services`, { FriendlyName: friendly }, "create the sign-in code service"));
      await store.update(l.id, { verify_service_sid: String(svc.sid) });
      await log(`${found ? "found" : "created"} the sign-in code service ${svc.sid}`);
    }
    const done = (await store.get(l.id))!;
    return {
      kind: "done",
      message: `Twilio sub-account ${done.subaccount_sid} ready (API key, dialler app and sign-in code service)`,
      output: { subaccount_sid: done.subaccount_sid, api_key_sid: done.api_key_sid, twiml_app_sid: done.twiml_app_sid, verify_service_sid: done.verify_service_sid },
    };
  } catch (err) {
    return outcomeFor(err, "sub-account setup", l.id);
  }
}

/** What the address needs, as the plain list of what is missing ("" when complete). */
export function addressMissing(l: LicenseeRow): string {
  const missing: string[] = [];
  if (!String(l.legal_name ?? "").trim()) missing.push("legal name");
  if (!String(l.address_line1 ?? "").trim()) missing.push("street address");
  if (!String(l.city ?? "").trim()) missing.push("city");
  if (!/^[A-Z]{2}$/.test(String(l.province_state ?? "").trim().toUpperCase())) missing.push("province or state");
  if (!String(l.postal_code ?? "").trim()) missing.push("postal or ZIP code");
  return missing.join(", ");
}

/** The business address in the sub-account (Addresses API): needed to buy some numbers and for texting registration. */
export async function ensureAddress(deps: TwilioDeps, l: LicenseeRow, log: (m: string) => Promise<void> = async () => {}): Promise<TwilioOutcome> {
  const { store, http, env } = twilioOf(deps);
  const row = await store.get(l.id);
  const sub = subCreds(row, env);
  if (!row || !sub) return { kind: "failed", message: "The licensee has no Twilio sub-account yet (run the sub-account step first)." };
  const missing = addressMissing(l);
  if (missing) return { kind: "failed", message: `The licensee's business address is incomplete (${missing}). Add it on the licensee in KS-Ops, then press Retry step.` };
  const country = String(l.country ?? "CA").toUpperCase() === "US" ? "US" : "CA";
  try {
    if (row.address_sid) {
      try {
        await http.get(sub, `${API}/Accounts/${sub.accountSid}/Addresses/${row.address_sid}.json`, {}, "check the business address");
        return { kind: "done", message: `business address ${row.address_sid} already registered`, output: { address_sid: row.address_sid } };
      } catch (err) {
        if (!notFound(err)) throw err;
        await log(`the business address ${row.address_sid} is gone from Twilio; registering it again`);
      }
    }
    const list = await http.get(sub, `${API}/Accounts/${sub.accountSid}/Addresses.json`, { CustomerName: l.legal_name, IsoCountry: country, PageSize: 50 }, "look for the business address");
    const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const found = ((list?.addresses ?? []) as any[]).find((a) => norm(a.street) === norm(l.address_line1) && norm(a.postal_code) === norm(l.postal_code));
    const addr = found ?? (await http.post(sub, `${API}/Accounts/${sub.accountSid}/Addresses.json`, {
      CustomerName: l.legal_name,
      FriendlyName: "Business address",
      Street: l.address_line1,
      StreetSecondary: l.address_line2 || undefined,
      City: l.city,
      Region: String(l.province_state).toUpperCase(),
      PostalCode: l.postal_code,
      IsoCountry: country,
      EmergencyEnabled: false,
    }, "register the business address"));
    await store.update(l.id, { address_sid: String(addr.sid) });
    await audit(deps.db, "ks-ops twilio", "licensee.twilio_address_registered", l.id, { address_sid: addr.sid, found: Boolean(found) });
    return { kind: "done", message: `business address ${addr.sid} registered`, output: { address_sid: addr.sid } };
  } catch (err) {
    return outcomeFor(err, "business address", l.id);
  }
}

/** The licensee's KS-server webhooks: the TwiML app's voice URL, once the server has an address. */
export async function pointVoiceApp(deps: TwilioDeps, l: LicenseeRow): Promise<TwilioOutcome> {
  const { store, http, env } = twilioOf(deps);
  const row = await store.get(l.id);
  const sub = subCreds(row, env);
  if (!row || !sub || !row.twiml_app_sid) return { kind: "failed", message: "The licensee has no Twilio dialler app yet (run the sub-account step first)." };
  if (!l.server_url) return { kind: "failed", message: "The licensee has no server address yet." };
  const voiceUrl = voiceUrlFor(l.server_url);
  if (row.twiml_app_voice_url === voiceUrl) return { kind: "done", message: "the dialler app already points at the server" };
  try {
    await http.post(sub, `${API}/Accounts/${sub.accountSid}/Applications/${row.twiml_app_sid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: "POST" }, "point the dialler app at the server");
    await store.update(l.id, { twiml_app_voice_url: voiceUrl });
    return { kind: "done", message: `the dialler app calls ${voiceUrl}` };
  } catch (err) {
    return outcomeFor(err, "dialler app", l.id);
  }
}

/** The number types this licensee buys: a local line always, a toll-free line on Growth and Pro. */
export function numberTypes(l: Pick<LicenseeRow, "plan">): Array<"local" | "toll-free"> {
  return l.plan === "starter" ? ["local"] : ["local", "toll-free"];
}

const BUNDLE_WAIT_MS = 14 * 24 * 60 * MIN;

/** Regulation fields we can fill from the sign-up (others need a person). */
function endUserAttributes(l: LicenseeRow, fields: string[]): { attributes: Record<string, string>; unknown: string[] } {
  const [first, ...rest] = String(l.contact_name ?? "").trim().split(/\s+/);
  const known: Record<string, string> = {
    business_name: l.legal_name,
    business_website: l.website ?? "",
    website: l.website ?? "",
    business_registration_number: l.business_number ?? "",
    business_registration_identifier: l.country === "US" ? "EIN" : "CBN",
    first_name: first ?? "",
    last_name: rest.join(" "),
    email: l.contact_email,
    phone_number: l.contact_phone,
    business_title: l.contact_title ?? "",
  };
  const attributes: Record<string, string> = {};
  const unknown: string[] = [];
  for (const f of fields) {
    if (known[f]) attributes[f] = known[f];
    else unknown.push(f);
  }
  return { attributes, unknown };
}

/**
 * A regulatory bundle when Twilio's rules (Regulations API) ask for one for this country and number type; Canada and
 * the US need none today, which is recorded and the step is done. When one is needed: an end user from the sign-up,
 * the registered address as its supporting document, submitted for Twilio's review; the step then waits for approval
 * (checked hourly, up to 14 days). A requirement that needs an uploaded document fails with what to upload.
 */
export async function ensureBundle(deps: TwilioDeps, l: LicenseeRow, startedAt: Date | null, log: (m: string) => Promise<void> = async () => {}): Promise<TwilioOutcome> {
  const { store, http, env } = twilioOf(deps);
  const row = await store.get(l.id);
  const sub = subCreds(row, env);
  if (!row || !sub) return { kind: "failed", message: "The licensee has no Twilio sub-account yet (run the sub-account step first)." };
  const country = String(l.country ?? "CA").toUpperCase() === "US" ? "US" : "CA";
  try {
    if (row.bundle_sid) return await checkBundle(deps, l, row, sub, startedAt);
    const needed: Array<{ type: string; regulation: any }> = [];
    for (const type of numberTypes(l)) {
      const r = await http.get(sub, `${NUMBERS}/Regulations`, { IsoCountry: country, NumberType: type, EndUserType: "business", IncludeConstraints: true }, `read Twilio's rules for ${country} ${type} numbers`);
      const reg = ((r?.results ?? []) as any[])[0];
      if (reg) needed.push({ type, regulation: reg });
    }
    if (!needed.length) {
      await store.update(l.id, { bundle_required: false, bundle_status: "not_required", bundle_failure: null });
      return { kind: "done", message: `no regulatory bundle needed for ${country} ${numberTypes(l).join(" and ")} numbers`, output: { bundle_required: false } };
    }
    if (needed.length > 1) await log(`Twilio asks for bundles for ${needed.map((n) => n.type).join(" and ")} numbers; the ${needed[0].type} one is made here`);
    const { type, regulation } = needed[0];
    const req = regulation.requirements ?? {};
    const endUserReq = ((req.end_user ?? []) as any[])[0];
    const fields: string[] = ((endUserReq?.fields ?? endUserReq?.detailed_fields?.map((f: any) => f.machine_name) ?? []) as string[]);
    const { attributes, unknown } = endUserAttributes(l, fields);
    const groups = ((req.supporting_document ?? []) as any[][]);
    const docs: Array<{ type: string; name: string }> = [];
    const needsUpload: string[] = [];
    for (const group of groups) {
      const options = (Array.isArray(group) ? group : [group]).flatMap((g: any) => g?.accepted_documents ?? []);
      const addressDoc = options.find((d: any) => {
        const f = ((d.fields ?? d.detailed_fields?.map((x: any) => x.machine_name) ?? []) as string[]);
        return f.length > 0 && f.every((x) => x === "address_sids");
      });
      if (addressDoc) docs.push({ type: String(addressDoc.type), name: String(addressDoc.name ?? addressDoc.type) });
      else needsUpload.push(String((Array.isArray(group) ? group[0] : group)?.name ?? "a document"));
    }
    if (unknown.length || needsUpload.length) {
      const what = [
        ...(unknown.length ? [`details we do not collect (${unknown.join(", ")})`] : []),
        ...(needsUpload.length ? [`an uploaded document (${needsUpload.join("; ")})`] : []),
      ].join(" and ");
      const message = `Twilio's rules for ${country} ${type} numbers need ${what}. Make the bundle by hand in the licensee's sub-account (${row.subaccount_sid}) in the Twilio console, then press "Mark done manually" with its BU... id.`;
      await store.update(l.id, { bundle_required: true, bundle_status: "needs_person", bundle_failure: message });
      return { kind: "failed", message };
    }
    if (!row.address_sid) return { kind: "failed", message: "The business address is not registered in Twilio yet (run the address step first)." };
    const endUser = await http.post(sub, `${NUMBERS}/EndUsers`, { FriendlyName: l.legal_name, Type: "business", Attributes: JSON.stringify(attributes) }, "create the bundle's business details");
    const docSids: string[] = [];
    for (const d of docs) {
      const doc = await http.post(sub, `${NUMBERS}/SupportingDocuments`, { FriendlyName: d.name, Type: d.type, Attributes: JSON.stringify({ address_sids: [row.address_sid] }) }, "add the address to the bundle");
      docSids.push(String(doc.sid));
    }
    const bundle = await http.post(sub, `${NUMBERS}/Bundles`, {
      FriendlyName: `${l.legal_name} ${country} ${type}`.slice(0, 64),
      Email: notificationEmail(env),
      RegulationSid: regulation.sid,
      EndUserType: "business",
    }, "create the regulatory bundle");
    await store.update(l.id, { bundle_required: true, bundle_sid: String(bundle.sid), bundle_status: "draft", bundle_end_user_sid: String(endUser.sid), bundle_document_sid: docSids[0] ?? null, bundle_failure: null });
    for (const sid of [String(endUser.sid), ...docSids]) {
      await http.post(sub, `${NUMBERS}/Bundles/${bundle.sid}/ItemAssignments`, { ObjectSid: sid }, "attach the bundle's details");
    }
    await http.post(sub, `${NUMBERS}/Bundles/${bundle.sid}`, { Status: "pending-review" }, "submit the regulatory bundle");
    await store.update(l.id, { bundle_status: "pending-review" });
    await audit(deps.db, "ks-ops twilio", "licensee.twilio_bundle_submitted", l.id, { bundle_sid: bundle.sid, country, type });
    await log(`regulatory bundle ${bundle.sid} submitted to Twilio for review`);
    return { kind: "wait", message: `Regulatory bundle ${bundle.sid} is with Twilio for review (usually 1-3 business days). Checked every hour.`, retryMs: 60 * MIN };
  } catch (err) {
    return outcomeFor(err, "regulatory bundle", l.id);
  }
}

async function checkBundle(deps: TwilioDeps, l: LicenseeRow, row: TwilioRow, sub: TwilioCreds, startedAt: Date | null): Promise<TwilioOutcome> {
  const { store, http } = twilioOf(deps);
  const b = await http.get(sub, `${NUMBERS}/Bundles/${row.bundle_sid}`, {}, "check the regulatory bundle");
  const status = String(b?.status ?? "");
  if (status !== row.bundle_status) await store.update(l.id, { bundle_status: status });
  if (status === "twilio-approved" || status === "provisionally-approved") {
    return { kind: "done", message: `regulatory bundle ${row.bundle_sid} approved`, output: { bundle_sid: row.bundle_sid, bundle_required: true } };
  }
  if (status === "twilio-rejected") {
    let reason = String(b?.failure_reason ?? "");
    try {
      const ev = await http.get(sub, `${NUMBERS}/Bundles/${row.bundle_sid}/Evaluations`, { PageSize: 1 }, "read why the bundle was rejected");
      const results = (((ev?.results ?? [])[0]?.results ?? []) as any[]);
      const why = results.filter((x) => x.passed === false).map((x) => String(x.friendly_name ?? x.object_type ?? "")).filter(Boolean);
      if (why.length) reason = `${reason ? `${reason}; ` : ""}${why.join(", ")}`;
    } catch (err) {
      logTwilioError("bundle evaluation", err, { licensee: l.id });
    }
    const message = `Twilio rejected the regulatory bundle ${row.bundle_sid}${reason ? `: ${reason}` : ""}. Fix the details in the Twilio console and resubmit it there, then press Retry step.`;
    await store.update(l.id, { bundle_failure: message });
    return { kind: "failed", message };
  }
  if (status === "draft") {
    await http.post(sub, `${NUMBERS}/Bundles/${row.bundle_sid}`, { Status: "pending-review" }, "submit the regulatory bundle");
    await store.update(l.id, { bundle_status: "pending-review" });
  }
  const started = startedAt ? startedAt.getTime() : deps.now().getTime();
  if (deps.now().getTime() - started > BUNDLE_WAIT_MS) {
    return { kind: "failed", message: `Twilio has not approved the regulatory bundle ${row.bundle_sid} after 14 days (status ${status}). Ask Twilio support, then press Retry step.` };
  }
  return { kind: "wait", message: `Regulatory bundle ${row.bundle_sid} is with Twilio for review (status ${status || "unknown"}, usually 1-3 business days). Checked every hour.`, retryMs: 60 * MIN };
}

/**
 * The Twilio app settings for the licensee's KS-server, handed to the provisioning workflow (which writes them to the
 * App Service). Secrets are decrypted here and only ever travel to the workflow over the run's one-off token.
 */
export async function serverSettings(deps: TwilioDeps, l: LicenseeRow): Promise<{ ok: true; settings: Record<string, string> } | { ok: false; error: string }> {
  const { store, env } = twilioOf(deps);
  const row = await store.get(l.id);
  const key = encryptionKey(String(env.OPS_ENCRYPTION_KEY ?? "").trim());
  if (!row || !key) return { ok: false, error: "no_subaccount" };
  if (!row.api_key_sid || !row.api_key_secret_encrypted || !row.twiml_app_sid || !row.verify_service_sid) return { ok: false, error: "subaccount_incomplete" };
  const settings: Record<string, string> = {
    TWILIO_ACCOUNT_SID: row.subaccount_sid,
    TWILIO_AUTH_TOKEN: decryptSecret(row.auth_token_encrypted, key),
    TWILIO_API_KEY: row.api_key_sid,
    TWILIO_API_SECRET: decryptSecret(row.api_key_secret_encrypted, key),
    TWILIO_VOICE_APP_SID: row.twiml_app_sid,
    TWILIO_VERIFY_SERVICE_SID: row.verify_service_sid,
  };
  if (row.address_sid) settings.TWILIO_ADDRESS_SID = row.address_sid;
  if (row.bundle_sid && (row.bundle_status === "twilio-approved" || row.bundle_status === "provisionally-approved")) settings.TWILIO_BUNDLE_SID = row.bundle_sid;
  if (l.server_url && /^https:\/\//.test(l.server_url)) settings.KS_SERVER_URL = l.server_url.replace(/\/+$/, "");
  return { ok: true, settings };
}

/** The names the workflow writes (never the values): for the dry-run plan and the docs. */
export const SERVER_TWILIO_SETTINGS = [
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY", "TWILIO_API_SECRET", "TWILIO_VOICE_APP_SID",
  "TWILIO_VERIFY_SERVICE_SID", "TWILIO_ADDRESS_SID", "TWILIO_BUNDLE_SID", "KS_SERVER_URL",
] as const;
