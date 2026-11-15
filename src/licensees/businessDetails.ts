// KS_OPS_SETUP_BUSINESS_DETAILS_v1 - the details the short sign-up no longer asks for: the business address, the
// business number, the kind of business and the owner's job title. The owner fills them in from the portal's set-up
// ("Get your phone number"); the brokerage's server relays the form here with its ops key. Saving registers the address
// with the phone system straight away and lets a waiting set-up run carry on, so nobody waits on Keystone staff.
import { z } from "zod";
import type { Deps } from "../deps.js";
import { addressMissing, ensureAddress, twilioOf } from "../twilio/account.js";
import { machineDeps } from "../provisioning/index.js";
import { retryStep, type MachineDeps } from "../provisioning/machine.js";
import { audit, getLicensee, type LicenseeRow } from "./repo.js";
import { BUSINESS_NUMBER_MESSAGES, BUSINESS_TYPES, CA_PROVINCES, US_STATES, composeMailingAddress, normalizeBusinessNumber, normalizePostal, POSTAL_MESSAGES } from "./validation.js";

const blankToUndefined = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim());
const optional = (max: number) => z.preprocess(blankToUndefined, z.string().max(max).optional());

export const businessDetailsSchema = z.object({
  legal_name: optional(160),
  address_line1: z.preprocess(blankToUndefined, z.string({ error: "Street address is required." }).min(3, "Street address is required.").max(200)),
  address_line2: optional(120),
  city: z.preprocess(blankToUndefined, z.string({ error: "City is required." }).min(2, "City is required.").max(120)),
  province_state: z.preprocess((v) => blankToUndefined(v)?.toUpperCase(), z.string({ error: "Choose a province or state." }).length(2, "Choose a province or state.")),
  postal_code: z.preprocess(blankToUndefined, z.string({ error: "Postal or ZIP code is required." }).max(20)),
  country: z.preprocess((v) => blankToUndefined(v)?.toUpperCase(), z.enum(["CA", "US"], { error: "Choose Canada or the United States." }).optional()),
  business_number: optional(30),
  business_type: z.preprocess((v) => blankToUndefined(v)?.toLowerCase(), z.enum(BUSINESS_TYPES, { error: "Choose the kind of business." }).optional()),
  contact_title: optional(80),
  saved_by: optional(200),
});

export type BusinessDetailsInput = z.infer<typeof businessDetailsSchema>;

/** What the portal shows: the details on file and what the phone lines still need. */
export function businessDetailsView(l: LicenseeRow, addressRegistered: boolean) {
  const missing = addressMissing(l);
  return {
    company_name: l.company_name,
    legal_name: l.legal_name ?? "",
    address_line1: l.address_line1 ?? "",
    address_line2: l.address_line2 ?? "",
    city: l.city ?? "",
    province_state: l.province_state ?? "",
    postal_code: l.postal_code ?? "",
    country: String(l.country ?? "CA").toUpperCase() === "US" ? "US" : "CA",
    business_number: l.business_number ?? "",
    business_type: l.business_type ?? "",
    contact_title: l.contact_title ?? "",
    business_types: BUSINESS_TYPES,
    complete: !missing,
    missing,
    address_registered: addressRegistered,
  };
}

/** Field errors that need the country (the province or state, the postal code, the business number). */
export function businessDetailsErrors(v: BusinessDetailsInput, country: "CA" | "US"): Record<string, string> {
  const errors: Record<string, string> = {};
  const regions: readonly string[] = country === "US" ? US_STATES : CA_PROVINCES;
  if (!regions.includes(v.province_state)) errors.province_state = country === "US" ? "Choose a US state." : "Choose a Canadian province or territory.";
  if (!normalizePostal(country, v.postal_code)) errors.postal_code = POSTAL_MESSAGES[country];
  if (v.business_number && !normalizeBusinessNumber(country, v.business_number)) errors.business_number = BUSINESS_NUMBER_MESSAGES[country];
  return errors;
}

export type SaveResult =
  | { ok: true; licensee: LicenseeRow; address_registered: boolean; phone_message: string }
  | { ok: false; errors: Record<string, string> };

type D = Pick<Deps, "db" | "fetch" | "mailer" | "now">;

async function addressRegistered(md: MachineDeps, licenseeId: string): Promise<boolean> {
  try {
    const row = await twilioOf(md).store.get(licenseeId);
    return Boolean(row?.address_sid);
  } catch (err) {
    console.error("[business-details] phone system row not read", { licensee: licenseeId, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function readBusinessDetails(deps: D, l: LicenseeRow, md: MachineDeps = machineDeps(deps)) {
  return businessDetailsView(l, await addressRegistered(md, l.id));
}

export async function saveBusinessDetails(deps: D, l: LicenseeRow, v: BusinessDetailsInput, md: MachineDeps = machineDeps(deps)): Promise<SaveResult> {
  const country = (v.country ?? (String(l.country ?? "CA").toUpperCase() === "US" ? "US" : "CA")) as "CA" | "US";
  const errors = businessDetailsErrors(v, country);
  if (Object.keys(errors).length) return { ok: false, errors };
  const next = {
    legal_name: v.legal_name ?? l.legal_name ?? l.company_name,
    address_line1: v.address_line1,
    address_line2: v.address_line2 ?? null,
    city: v.city,
    province_state: v.province_state,
    postal_code: normalizePostal(country, v.postal_code)!,
    country,
    business_number: v.business_number ? normalizeBusinessNumber(country, v.business_number) : l.business_number ?? null,
    business_type: v.business_type ?? l.business_type ?? null,
    contact_title: v.contact_title ?? l.contact_title ?? null,
  };
  const mailing = composeMailingAddress(next);
  await deps.db.query(
    `UPDATE licensees SET legal_name = $2, address_line1 = $3, address_line2 = $4, city = $5, province_state = $6, postal_code = $7,
            country = $8, business_number = $9, business_type = $10, contact_title = $11, mailing_address = $12, updated_at = now()
      WHERE id = $1`,
    [l.id, next.legal_name, next.address_line1, next.address_line2, next.city, next.province_state, next.postal_code, next.country,
      next.business_number, next.business_type, next.contact_title, mailing],
  );
  const actor = `licensee:${l.company_code}${v.saved_by ? ` (${v.saved_by})` : ""}`;
  await audit(deps.db, actor, "licensee.business_details_saved", l.id, { city: next.city, province_state: next.province_state, country: next.country, has_business_number: Boolean(next.business_number) });
  const saved = (await getLicensee(deps.db, l.id)) ?? ({ ...l, ...next, mailing_address: mailing } as LicenseeRow);

  // Register the address with the phone system now, and let a set-up run that was waiting on it carry on.
  let registered = false;
  let phoneMessage = "Saved. Your phone lines will use this address.";
  try {
    const out = await ensureAddress(md, saved);
    registered = out.kind === "done" && !(out.output as { address_pending?: boolean } | undefined)?.address_pending;
    if (!registered) phoneMessage = "Saved. Your address is registered with the phone system as soon as your phone account is ready; there is nothing more for you to do.";
    const run = await md.store.liveRun(saved.id, "provision");
    if (run && run.status !== "done" && run.status !== "cancelled") {
      const steps = await md.store.steps(run.id);
      const first = ["twilio_address", "twilio_bundle", "phone_numbers", "texting_registration"]
        .map((k) => steps.find((s) => s.step === k))
        .find((s) => s && (s.status === "failed" || s.status === "blocked"));
      if (first) await retryStep(md, run.id, first.step, actor);
    }
  } catch (err) {
    console.error("[business-details] address not registered with the phone system", { licensee: l.id, message: err instanceof Error ? err.message : String(err) });
    phoneMessage = "Saved. We could not register the address with the phone system just now; it is tried again by itself.";
  }
  return { ok: true, licensee: saved, address_registered: registered, phone_message: phoneMessage };
}
