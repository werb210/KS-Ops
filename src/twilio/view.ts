// KS_OPS_TWILIO_AUTO_v1 - what /ops/provisioning shows about a licensee's Twilio: never a token or secret.
import { twilioOf, type TwilioDeps } from "./account.js";
import { plainStatus } from "./texting.js";

export async function twilioSummary(deps: Pick<TwilioDeps, "db" | "fetch" | "env" | "twilioStore" | "twilioHttp">, licenseeId: string) {
  const { store } = twilioOf(deps as TwilioDeps);
  const [row, regs] = await Promise.all([store.get(licenseeId), store.registrations(licenseeId)]);
  const account = row
    ? {
        subaccount_sid: row.subaccount_sid,
        status: row.account_status,
        status_text:
          row.account_status === "active" ? "Active" : row.account_status === "suspended" ? "Suspended (numbers kept; calls and texts stopped)" : "Closed",
        api_key: Boolean(row.api_key_sid),
        dialler_app: Boolean(row.twiml_app_sid),
        dialler_app_points_at_server: Boolean(row.twiml_app_voice_url),
        sign_in_codes: Boolean(row.verify_service_sid),
        address_sid: row.address_sid,
        bundle:
          row.bundle_required === false ? "Not needed for this country"
          : row.bundle_sid ? `${row.bundle_sid}: ${String(row.bundle_status ?? "").replace(/-/g, " ")}`
          : row.bundle_failure ? row.bundle_failure
          : "Not checked yet",
        close_notice_sent_at: row.close_notice_sent_at,
        closed_at: row.closed_at,
      }
    : null;
  return {
    account,
    texting: regs.map((r) => ({
      kind: r.kind,
      label: r.kind === "toll_free" ? "Toll-free verification" : "US A2P 10DLC",
      status: r.status,
      phone_number: r.phone_number,
      message: plainStatus(r),
      twilio_status: r.twilio_status,
      last_checked_at: r.last_checked_at,
      on_server: r.pushed_status === r.status,
      push_error: r.push_error,
    })),
  };
}
