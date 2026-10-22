// Input rules for licensees: the public sign-up form, staff create and staff edit. Messages are shown to people.
import { z } from "zod";
import { allowedServerHostSuffixes } from "../config.js";
import { BILLING_INTERVALS, MIN_SEATS, PLANS, PLAN_NAMES, SUPPORT_LEVELS } from "../pricing.js";

export const STATUSES = ["pending_payment", "provisioning", "trial", "active", "past_due", "suspended", "cancelled"] as const;
export type LicenseeStatus = (typeof STATUSES)[number];
/** Only these resolve in the company-code directory. */
export const DIRECTORY_STATUSES: readonly LicenseeStatus[] = ["trial", "active", "past_due"];

export const CODE_RE = /^[a-z0-9-]{3,32}$/;

/** Codes that would be confusing or could be mistaken for ours. */
export const RESERVED_CODES = new Set([
  "admin", "api", "app", "apps", "boreal", "client", "clients", "demo-admin", "help", "keystone", "login", "mail",
  "ops", "portal", "root", "server", "signup", "staff", "status", "support", "system", "test", "www",
]);

export function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export type CodeProblem = "invalid" | "reserved";

export function codeProblem(code: string): CodeProblem | null {
  if (!CODE_RE.test(code) || code.startsWith("-") || code.endsWith("-") || code.includes("--")) return "invalid";
  if (RESERVED_CODES.has(code)) return "reserved";
  return null;
}

export const CODE_MESSAGES: Record<CodeProblem | "taken", string> = {
  invalid: "Use 3 to 32 lowercase letters, numbers or single hyphens, starting and ending with a letter or number.",
  reserved: "That code is reserved. Please choose another.",
  taken: "That code is already in use. Please choose another.",
};

export const CA_PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
  "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR",
  "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const text = (label: string, min: number, max: number) =>
  z
    .string({ required_error: `${label} is required.`, invalid_type_error: `${label} is required.` })
    .trim()
    .min(min, min <= 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be ${max} characters or fewer.`);

const optionalText = (label: string, max: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim()),
    z.string().max(max, `${label} must be ${max} characters or fewer.`).optional(),
  );

export const phoneSchema = z
  .string({ required_error: "Phone number is required.", invalid_type_error: "Phone number is required." })
  .trim()
  .refine((v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 && /^[+\d\s().-]+$/.test(v);
  }, "Enter a phone number with area code, for example (403) 555-0123.");

const emailSchema = z
  .string({ required_error: "Email is required.", invalid_type_error: "Email is required." })
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(200, "Email must be 200 characters or fewer.");

/** Adds https:// when missing; rejects anything that is not a web address. */
export const urlSchema = (label: string) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined || String(v).trim() === "") return undefined;
      const s = String(v).trim();
      return /^https?:\/\//i.test(s) ? s : `https://${s}`;
    },
    z
      .string()
      .max(500, `${label} must be 500 characters or fewer.`)
      .refine((s) => {
        try {
          const u = new URL(s);
          return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".");
        } catch {
          return false;
        }
      }, `${label} must be a web address, for example https://example.com.`)
      .transform((s) => s.replace(/\/+$/, ""))
      .optional(),
  );

/** True when the host matches one of the suffixes (".azurewebsites.net" or "azurewebsites.net"), or the list is ["*"]. */
export function hostAllowed(host: string, suffixes: string[]): boolean {
  if (suffixes.includes("*")) return true;
  const h = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some((s) => {
    const bare = s.replace(/^\./, "");
    return bare !== "" && (h === bare ? !s.startsWith(".") : h.endsWith(`.${bare}`));
  });
}

/**
 * A licensee app address (server_url, client_url, portal_url): like urlSchema, but https only. With serverHosts the
 * host must also match OPS_ALLOWED_SERVER_HOST_SUFFIXES (default ".azurewebsites.net,.azurestaticapps.net"; "*" allows
 * any host), read when the request is checked.
 */
export const appUrlSchema = (label: string, opts: { serverHosts?: boolean } = {}) =>
  z.preprocess(
    (v) => {
      if (v === null || v === undefined || String(v).trim() === "") return undefined;
      const s = String(v).trim();
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    },
    z
      .string()
      .max(500, `${label} must be 500 characters or fewer.`)
      .superRefine((s, ctx) => {
        let u: URL;
        try {
          u = new URL(s);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a web address, for example https://example.com.` });
          return;
        }
        if (u.protocol !== "https:") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must start with https://.` });
          return;
        }
        if (!u.hostname.includes(".") || u.username || u.password) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a web address, for example https://example.com.` });
          return;
        }
        if (opts.serverHosts) {
          const suffixes = allowedServerHostSuffixes();
          if (!hostAllowed(u.hostname, suffixes)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${label} must be on ${suffixes.join(" or ")} (OPS_ALLOWED_SERVER_HOST_SUFFIXES).`,
            });
          }
        }
      })
      .transform((s) => s.replace(/\/+$/, ""))
      .optional(),
  );

const colorSchema = z.preprocess(
  (v) => (v === null || v === undefined || String(v).trim() === "" ? undefined : String(v).trim()),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colour must look like #1A2B3C.").optional(),
);

const codeSchema = z
  .string({ required_error: "Company code is required.", invalid_type_error: "Company code is required." })
  .transform(normalizeCode)
  .superRefine((code, ctx) => {
    const p = codeProblem(code);
    if (p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: CODE_MESSAGES[p] });
  });

const planSchema = z.enum(PLANS, { errorMap: () => ({ message: "Choose Starter, Growth or Pro." }) });
const intervalSchema = z.enum(BILLING_INTERVALS, { errorMap: () => ({ message: "Choose annual or monthly billing." }) });
const supportSchema = z.enum(SUPPORT_LEVELS, {
  errorMap: () => ({ message: "Choose Email, Priority, Premium or Dedicated support." }),
});
const seatsSchema = z.coerce
  .number({ invalid_type_error: "Seats must be a whole number." })
  .int("Seats must be a whole number.")
  .min(1, "You need at least 1 seat.")
  .max(1000, "For more than 1,000 seats, please contact us.");

function regionCheck(country: string | undefined, region: string | undefined, ctx: z.RefinementCtx, path = "province_state") {
  if (!region) return;
  const list = country === "US" ? US_STATES : country === "CA" ? CA_PROVINCES : null;
  if (list && !list.includes(region)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: country === "US" ? "Choose a US state." : "Choose a Canadian province or territory.",
    });
  }
}

function minSeatsCheck(plan: string | undefined, seats: number | undefined, ctx: z.RefinementCtx) {
  if (!plan || seats === undefined) return;
  const min = MIN_SEATS[plan as keyof typeof MIN_SEATS];
  if (min && seats < min) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["seats"],
      message: `The ${PLAN_NAMES[plan as keyof typeof PLAN_NAMES]} plan needs at least ${min} seats.`,
    });
  }
}

const region = z.preprocess(
  (v) => (v === null || v === undefined ? v : String(v).trim().toUpperCase()),
  z.string({ required_error: "Province or state is required.", invalid_type_error: "Province or state is required." })
    .min(2, "Province or state is required."),
);

export const signupSchema = z
  .object({
    company_name: text("Company name", 2, 120),
    legal_name: text("Legal name", 2, 160),
    company_code: codeSchema,
    country: z.enum(["CA", "US"], { errorMap: () => ({ message: "Choose Canada or the United States." }) }),
    province_state: region,
    mailing_address: text("Mailing address", 5, 500),
    website: urlSchema("Website"),
    contact_name: text("Contact name", 2, 120),
    contact_email: emailSchema,
    contact_phone: phoneSchema,
    seats: seatsSchema,
    plan: planSchema,
    billing_interval: intervalSchema,
    support_level: supportSchema,
    primary_color: colorSchema,
    logo_url: urlSchema("Logo address"),
    assistant_name: optionalText("Assistant name", 40),
    accept_terms: z.literal(true, { errorMap: () => ({ message: "Please accept the terms of service." }) }),
    accept_privacy: z.literal(true, { errorMap: () => ({ message: "Please accept the privacy policy." }) }),
    turnstile_token: z.string().optional(),
    website_url: z.any().optional(),
  })
  .superRefine((v, ctx) => {
    regionCheck(v.country, v.province_state, ctx);
    minSeatsCheck(v.plan, v.seats, ctx);
  });
export type SignupInput = z.infer<typeof signupSchema>;

/**
 * zod skips an object's cross-field checks when any single field is wrong. These run on the raw body as well, so the
 * person sees every problem at once.
 */
export function crossFieldErrors(raw: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  const country = String(raw.country ?? "").trim().toUpperCase();
  const region = String(raw.province_state ?? "").trim().toUpperCase();
  const plan = String(raw.plan ?? "");
  const seats = Number(raw.seats);
  const ctx = {
    addIssue: (i: { path?: (string | number)[]; message?: string }) => {
      const k = String(i.path?.[0] ?? "form");
      if (!errors[k] && i.message) errors[k] = i.message;
    },
  } as unknown as z.RefinementCtx;
  if (region) regionCheck(country, region, ctx);
  if (Number.isInteger(seats) && (PLANS as readonly string[]).includes(plan)) minSeatsCheck(plan, seats, ctx);
  return errors;
}

/** POST /api/ops/licensees (contract field "billing"; "billing_interval" is accepted too). */
export const staffCreateSchema = z
  .object({
    company_name: text("Company name", 2, 120),
    legal_name: text("Legal name", 2, 160),
    company_code: codeSchema,
    contact_name: text("Contact name", 2, 120),
    contact_email: emailSchema,
    contact_phone: phoneSchema,
    plan: planSchema,
    billing: intervalSchema.optional(),
    billing_interval: intervalSchema.optional(),
    support_level: supportSchema.default("email"),
    seats: seatsSchema,
    country: z.enum(["CA", "US"], { errorMap: () => ({ message: "Choose Canada or the United States." }) }).default("CA"),
    province_state: z.preprocess((v) => (v ? String(v).trim().toUpperCase() : undefined), z.string().optional()),
    mailing_address: optionalText("Mailing address", 500),
    website: urlSchema("Website"),
    server_url: appUrlSchema("Server address", { serverHosts: true }),
    client_url: appUrlSchema("Client app address"),
    portal_url: appUrlSchema("Staff portal address"),
    logo_url: urlSchema("Logo address"),
    primary_color: colorSchema,
    assistant_name: optionalText("Assistant name", 40),
    status: z.enum(STATUSES).optional(),
    extra_storage_blocks: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    regionCheck(v.country, v.province_state, ctx);
    minSeatsCheck(v.plan, v.seats, ctx);
  })
  .transform(({ billing, billing_interval, ...rest }) => ({
    ...rest,
    billing_interval: billing_interval ?? billing ?? "monthly",
  }));
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

const nullableUrl = (label: string) =>
  z.preprocess((v) => (v === "" ? null : v), z.union([z.null(), urlSchema(label)]));
const nullableAppUrl = (label: string, opts: { serverHosts?: boolean } = {}) =>
  z.preprocess((v) => (v === "" ? null : v), appUrlSchema(label, opts).nullable());

/** PATCH /api/ops/licensees/:id - every field optional; null clears the optional ones. */
export const staffPatchSchema = z
  .object({
    company_name: text("Company name", 2, 120),
    legal_name: text("Legal name", 2, 160),
    company_code: codeSchema,
    contact_name: text("Contact name", 2, 120),
    contact_email: emailSchema,
    contact_phone: phoneSchema,
    country: z.enum(["CA", "US"]),
    province_state: z.preprocess((v) => (v ? String(v).trim().toUpperCase() : null), z.string().nullable()),
    mailing_address: z.string().trim().max(500).nullable(),
    website: nullableUrl("Website"),
    status: z.enum(STATUSES, { errorMap: () => ({ message: "Unknown status." }) }),
    plan: planSchema,
    billing_interval: intervalSchema,
    billing: intervalSchema,
    support_level: supportSchema,
    seats: seatsSchema,
    extra_storage_blocks: z.coerce
      .number()
      .int("Extra storage must be a whole number of 50 GB blocks.")
      .min(0, "Extra storage cannot be negative.")
      .max(1000, "Extra storage is limited to 1,000 blocks."),
    server_url: nullableAppUrl("Server address", { serverHosts: true }),
    client_url: nullableAppUrl("Client app address"),
    portal_url: nullableAppUrl("Staff portal address"),
    logo_url: nullableUrl("Logo address"),
    primary_color: z.preprocess((v) => (v === "" ? null : v), z.union([z.null(), colorSchema])),
    assistant_name: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(40).nullable()),
    onboarding_fee_paid: z.boolean(),
    // KS_OPS_BANK_CONNECT_ADDON - staff-only add-ons (not plan features), merged into the stored set.
    addons: z
      .object({ bank_connect: z.boolean({ invalid_type_error: "bank_connect must be true or false." }) })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  .transform(({ billing, ...rest }) => (billing && !rest.billing_interval ? { ...rest, billing_interval: billing } : rest));
export type StaffPatchInput = z.infer<typeof staffPatchSchema>;
