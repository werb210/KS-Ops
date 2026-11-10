// KS_OPS_NUMBER_PORTING_v1 - "Keep your existing phone number": what a transfer (port) request holds, how it is checked,
// and its statuses in plain English.
//
// Twilio's rules for Canada (and the US): local, mobile and toll-free numbers can be transferred. The carrier that has
// the number now (the "losing carrier") needs a letter of authorization dated within 30 days with the service address
// exactly as it is on their bill, a recent bill, the account number and the PIN if the account has one. It takes up to
// four weeks. Near the end the losing carrier may text the number asking to approve the transfer: it must be approved
// within 90 minutes or the transfer is rejected. Toll-free numbers are submitted in the Twilio Console, local and
// mobile numbers through Twilio's porting form, so Keystone staff submit them and this service tracks each one.
import { z } from "zod";
import { normalizeNaPhone } from "../lib/sms.js";

export const CARRIERS = [
  ["bell", "Bell"], ["rogers", "Rogers"], ["telus", "Telus"], ["fido", "Fido"], ["koodo", "Koodo"], ["virgin", "Virgin Plus"],
  ["freedom", "Freedom Mobile"], ["videotron", "Videotron"], ["shaw", "Shaw"], ["cogeco", "Cogeco"], ["eastlink", "Eastlink"],
  ["sasktel", "SaskTel"], ["att", "AT&T"], ["verizon", "Verizon"], ["tmobile", "T-Mobile"], ["other", "Other"],
] as const;
export type CarrierKey = (typeof CARRIERS)[number][0];
export const CARRIER_KEYS = CARRIERS.map((c) => c[0]) as [CarrierKey, ...CarrierKey[]];
export const carrierLabel = (key: string, other?: string | null): string =>
  key === "other" ? String(other ?? "").trim() || "Other" : (CARRIERS.find((c) => c[0] === key)?.[1] ?? key);

export const NUMBER_TYPES = ["local", "mobile", "toll_free"] as const;
export type NumberType = (typeof NUMBER_TYPES)[number];
export const NUMBER_TYPE_LABELS: Record<NumberType, string> = { local: "Landline / business line", mobile: "Mobile", toll_free: "Toll-free" };

export const STATUSES = ["draft", "ready_to_submit", "submitted", "carrier_approval_pending", "scheduled", "completed", "rejected", "cancelled"] as const;
export type PortStatus = (typeof STATUSES)[number];
export const FINAL: PortStatus[] = ["completed", "rejected", "cancelled"];
export const OPEN: PortStatus[] = STATUSES.filter((s) => !FINAL.includes(s));

export const STATUS_LABELS: Record<PortStatus, string> = {
  draft: "Waiting for your signature",
  ready_to_submit: "Ready: Keystone will submit it",
  submitted: "Submitted to the carrier",
  carrier_approval_pending: "Approve the carrier's text",
  scheduled: "Transfer date set",
  completed: "Transferred",
  rejected: "Rejected by the carrier",
  cancelled: "Cancelled",
};

/** Which staff moves are allowed from each status (draft -> ready_to_submit happens when the letter is signed). */
export const TRANSITIONS: Record<PortStatus, PortStatus[]> = {
  draft: ["cancelled", "rejected"],
  ready_to_submit: ["submitted", "cancelled", "rejected"],
  submitted: ["carrier_approval_pending", "scheduled", "rejected", "cancelled"],
  carrier_approval_pending: ["scheduled", "rejected", "cancelled"],
  scheduled: ["scheduled", "completed", "rejected", "cancelled"],
  completed: [],
  rejected: ["ready_to_submit"], // fixed and sent again
  cancelled: [],
};

export const LOA_MAX_AGE_DAYS = 30;
export const APPROVAL_MINUTES = 90;
export const MAX_BILL_BYTES = 7 * 1024 * 1024;
export const MAX_NUMBERS = 20;

const TOLL_FREE_RE = /^\+18(00|33|44|55|66|77|88)\d{7}$/;
export const isTollFree = (n: string) => TOLL_FREE_RE.test(n);

/** "+14035550188" -> "(403) 555-0188". */
export function pretty(n: string | null | undefined): string {
  const d = String(n ?? "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n ?? "");
}

/** "998877665" -> "•••••7665"; never more than the last four characters. */
export function maskTail(v: string | null | undefined): string {
  const s = String(v ?? "");
  return s ? `${"•".repeat(Math.max(4, Math.min(8, s.length - 4)))}${s.slice(-4)}` : "";
}

const NAME = (what: string, max = 120) => z.string({ error: `Enter ${what}.` }).trim().min(1, `Enter ${what}.`).max(max, `Use ${max} characters or fewer.`);

export const addressSchema = z.object({
  line1: NAME("the street address exactly as it is on your bill", 200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: NAME("the city", 100),
  region: z.string({ error: "Choose the province or state." }).trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the 2-letter province or state, e.g. AB."),
  postal_code: z.string({ error: "Enter the postal or ZIP code." }).trim().toUpperCase().min(5, "Enter the postal or ZIP code.").max(10),
  country: z.enum(["CA", "US"], { error: "Choose Canada or the United States." }),
});

export const numberSchema = z.object({
  phone_number: z.string({ error: "Enter the phone number." }).transform((v, ctx) => {
    const n = normalizeNaPhone(v);
    if (!n) { ctx.addIssue({ code: "custom", message: "Enter a 10-digit Canadian or US number, e.g. (403) 555-0100." }); return z.NEVER; }
    return n;
  }),
  number_type: z.enum(NUMBER_TYPES, { error: "Choose landline, mobile or toll-free." }),
  user_id: z.string().trim().max(100).nullable().optional(),
  assignee_name: z.string().trim().max(200).optional(),
  temporary_number: z.string().nullable().optional(),
});

export const billSchema = z.object({
  filename: z.string({ error: "Upload a recent bill." }).trim().min(1, "Upload a recent bill.").max(200),
  content_type: z.string({ error: "Upload a recent bill." }).trim().max(100),
  data_base64: z.string({ error: "Upload a recent bill." }).min(8, "Upload a recent bill."),
});

export const requestSchema = z.object({
  carrier: z.enum(CARRIER_KEYS, { error: "Choose the carrier the number is with now." }),
  carrier_other: z.string().trim().max(80).optional().nullable(),
  account_number: z.string({ error: "Enter the account number from your bill." }).trim()
    .min(1, "Enter the account number from your bill.").max(40, "Account numbers are 40 characters or fewer.")
    .regex(/^[A-Za-z0-9 -]+$/, "Use the letters and digits of the account number only."),
  pin: z.string().trim().max(20, "PINs are 20 characters or fewer.").optional().nullable(),
  account_name: NAME("the name on the account, exactly as it is on your bill", 120),
  service_address: addressSchema,
  numbers: z.array(numberSchema, { error: "Add the number you want to keep." }).min(1, "Add the number you want to keep.").max(MAX_NUMBERS),
  bill: billSchema,
  forwarding_tested: z.boolean().optional(),
  company_name: z.string().max(200).optional(),
  requested_by: z.object({ id: z.string().max(100).nullable().optional(), name: z.string().max(200).optional(), email: z.string().max(254).nullable().optional() }).optional(),
});
export type RequestInput = z.infer<typeof requestSchema>;

/** The bill as bytes, when it is a PDF, PNG or JPEG of 7 MB or less (checked by its bytes, not its name). */
export function decodeBill(b: { content_type: string; data_base64: string }): { ok: true; bytes: Buffer; contentType: string } | { ok: false; error: string } {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b.data_base64, "base64");
  } catch {
    return { ok: false, error: "The bill could not be read. Upload it again." };
  }
  if (!bytes.length) return { ok: false, error: "Upload a recent bill." };
  if (bytes.length > MAX_BILL_BYTES) return { ok: false, error: "The bill must be 7 MB or smaller." };
  const head = bytes.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { ok: true, bytes, contentType: "application/pdf" };
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ok: true, bytes, contentType: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ok: true, bytes, contentType: "image/jpeg" };
  return { ok: false, error: "Upload the bill as a PDF, PNG or JPG." };
}

/** Checks that need more than the schema: carrier "Other" named, toll-free numbers typed as toll-free, no repeats. */
export function crossCheck(v: RequestInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (v.carrier === "other" && !String(v.carrier_other ?? "").trim()) errors.carrier_other = "Type the carrier's name.";
  const seen = new Set<string>();
  v.numbers.forEach((n, i) => {
    if (isTollFree(n.phone_number) && n.number_type !== "toll_free") errors[`numbers.${i}.number_type`] = "This is a toll-free number: choose toll-free.";
    if (!isTollFree(n.phone_number) && n.number_type === "toll_free") errors[`numbers.${i}.number_type`] = "This is not a toll-free number: choose landline or mobile.";
    if (seen.has(n.phone_number)) errors[`numbers.${i}.phone_number`] = "This number is already in the list.";
    seen.add(n.phone_number);
  });
  // Twilio takes toll-free and local/mobile numbers in separate submissions.
  const types = new Set(v.numbers.map((n) => (isTollFree(n.phone_number) || n.number_type === "toll_free" ? "tf" : "local")));
  if (types.size > 1) errors.numbers = "Put toll-free numbers in their own request (the carrier handles them separately).";
  return errors;
}

/** What the brokerage sees for each status, in plain English. */
export function statusMessage(s: PortStatus, extra: { foc_date?: string | null; reason?: string | null } = {}): string {
  switch (s) {
    case "draft": return "Sign the letter of authorization so Keystone can send your transfer to the carrier.";
    case "ready_to_submit": return "Everything is in. Keystone support will submit your transfer to the carrier within one business day.";
    case "submitted": return "Your transfer is with your current carrier. It usually takes one to four weeks. Keep your forwarding on.";
    case "carrier_approval_pending": return `Your current carrier may text the number asking you to approve the transfer. Reply to approve it within ${APPROVAL_MINUTES} minutes, or the transfer is rejected.`;
    case "scheduled": return `The transfer is set for ${extra.foc_date ?? "a date the carrier confirmed"}. Keep your forwarding on until it is done.`;
    case "completed": return "Your number now rings in Keystone. Turn off the call forwarding on it.";
    case "rejected": return `The carrier rejected the transfer${extra.reason ? `: ${extra.reason}` : ""}. Keystone support will tell you what to fix.`;
    case "cancelled": return "This transfer was cancelled. The number stays with your current carrier.";
  }
}
