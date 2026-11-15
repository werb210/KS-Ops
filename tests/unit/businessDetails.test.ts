// KS_OPS_SETUP_BUSINESS_DETAILS_v1 - the owner adds the business address and the rest from the portal's set-up; saving
// registers the address with the phone system and lets a waiting set-up run carry on.
import { describe, expect, it } from "vitest";
import { businessDetailsSchema, businessDetailsView, readBusinessDetails, saveBusinessDetails } from "../../src/licensees/businessDetails.js";
import { ensureSubaccount } from "../../src/twilio/account.js";
import type { LicenseeRow } from "../../src/licensees/repo.js";
import { FakeTwilio, memoryTwilioStore } from "./twilioFake.js";
import { configuredEnv, licensee, LICENSEE_ID, machine } from "./provisioningFakes.js";

const quick = (over: Partial<LicenseeRow> = {}) =>
  licensee({ address_line1: null, address_line2: null, city: null, postal_code: null, province_state: null, business_number: null, business_type: null, contact_title: null, ...over });

function setup(l: LicenseeRow) {
  const tw = new FakeTwilio();
  const twilioStore = memoryTwilioStore();
  const m = machine(l, { twilioStore, fetch: (async (url: string | URL, init: RequestInit = {}) => tw.fetch(String(url), init)) as unknown as typeof fetch });
  m.db.on(/^UPDATE licensees SET legal_name = \$2, address_line1 = \$3/, (p) => {
    m.state.l = { ...m.state.l, legal_name: p[1], address_line1: p[2], address_line2: p[3], city: p[4], province_state: p[5], postal_code: p[6],
      country: p[7], business_number: p[8], business_type: p[9], contact_title: p[10], mailing_address: p[11] } as LicenseeRow;
    return { rows: [], rowCount: 1 };
  });
  return { tw, twilioStore, ...m };
}

const form = { address_line1: "100 Main St SW", address_line2: "", city: "Calgary", province_state: "ab", postal_code: "t2p1p6", business_number: "", business_type: "corporation", contact_title: "Owner" };

describe("business details from set-up", () => {
  it("says what the phone lines still need after the short sign-up", () => {
    const v = businessDetailsView(quick(), false);
    expect(v.complete).toBe(false);
    expect(v.missing).toMatch(/street address/);
    expect(v.address_registered).toBe(false);
  });

  it("asks for the street, city, province and postal code in plain words; the business number can wait", () => {
    const r = businessDetailsSchema.safeParse({ address_line1: "", city: "", province_state: "", postal_code: "" });
    expect(r.success).toBe(false);
    const ok = businessDetailsSchema.safeParse(form);
    expect(ok.success).toBe(true);
  });

  it("refuses a postal code or province that does not fit the country", async () => {
    const t = setup(quick());
    const v = businessDetailsSchema.parse({ ...form, province_state: "TX", postal_code: "90210" });
    const r = await saveBusinessDetails(t.deps, t.state.l, v, t.deps);
    expect(r).toMatchObject({ ok: false, errors: { province_state: expect.any(String), postal_code: expect.any(String) } });
    expect(t.state.l.address_line1).toBeNull();
  });

  it("saves the details and registers the address with the phone system at once", async () => {
    const t = setup(quick());
    await ensureSubaccount(t.deps, t.state.l);
    const r = await saveBusinessDetails(t.deps, t.state.l, businessDetailsSchema.parse(form), t.deps);
    expect(r.ok).toBe(true);
    expect(t.state.l).toMatchObject({ address_line1: "100 Main St SW", city: "Calgary", province_state: "AB", postal_code: "T2P 1P6", business_type: "corporation", contact_title: "Owner" });
    expect(t.state.l.mailing_address).toMatch(/100 Main St SW, Calgary AB T2P 1P6/);
    const sid = (await t.twilioStore.get(LICENSEE_ID))!.address_sid!;
    expect(t.tw.addresses.get(sid)).toMatchObject({ street: "100 Main St SW", region: "AB" });
    const view = await readBusinessDetails(t.deps, t.state.l, t.deps);
    expect(view).toMatchObject({ complete: true, address_registered: true });
  });

  it("a set-up run that stopped at the phone lines carries on once the address is in", async () => {
    const t = setup(quick());
    await ensureSubaccount(t.deps, t.state.l);
    const { run } = await t.deps.store.createRun({ licensee_id: LICENSEE_ID, kind: "provision", trigger: "test", dry_run: false, region: "canadacentral", created_by: "test" });
    await t.deps.store.updateStep(run.id, "phone_numbers", { status: "failed", last_error: "Twilio needs a registered address" });
    await t.deps.store.updateRun(run.id, { status: "failed" });
    await saveBusinessDetails(t.deps, t.state.l, businessDetailsSchema.parse(form), t.deps);
    const steps = await t.deps.store.steps(run.id);
    expect(steps.find((s) => s.step === "phone_numbers")!.status).toBe("pending");
    expect((await t.deps.store.getRun(run.id))!.status).toBe("running");
  });

  it("keeps the details even when the phone account is not ready yet", async () => {
    const t = setup(quick());
    const r = await saveBusinessDetails(t.deps, t.state.l, businessDetailsSchema.parse(form), t.deps);
    expect(r).toMatchObject({ ok: true, address_registered: false });
    expect(t.state.l.city).toBe("Calgary");
  });
});
void configuredEnv;
