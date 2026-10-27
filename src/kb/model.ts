// KS_OPS_KB_v1 - knowledge base articles: audiences, who may read what, and the article form.
import { z } from "zod";
import { PLANS, type Plan } from "../pricing.js";

export const AUDIENCES = ["public", "all_staff", "admins"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<Audience, string> = {
  public: "Public (website and every licensee user)",
  all_staff: "All licensee staff",
  admins: "Licensee admins only",
};
export const STATUSES = ["draft", "published"] as const;
export type ArticleStatus = (typeof STATUSES)[number];

/** Who is reading: a website visitor, a licensee's staff member, or a licensee Admin. */
export type Viewer = "public" | "staff" | "admin";

/** The audiences a viewer may read. Admins read everything a staff member reads, staff everything public. */
export function audiencesFor(viewer: Viewer): Audience[] {
  if (viewer === "admin") return ["public", "all_staff", "admins"];
  if (viewer === "staff") return ["public", "all_staff"];
  return ["public"];
}

/** The licensee server says which role the person has; only "admin" (any case) gets the admin articles. */
export function viewerFromRole(role: unknown): Viewer {
  return String(role ?? "").trim().toLowerCase() === "admin" ? "admin" : "staff";
}

export function canRead(viewer: Viewer, audience: string): boolean {
  return (audiencesFor(viewer) as string[]).includes(audience);
}

/** An article applies to a plan when it lists no plans or lists that one. */
export function appliesToPlan(plans: readonly string[] | null | undefined, plan: string | null | undefined): boolean {
  if (!plans || plans.length === 0) return true;
  return Boolean(plan && plans.includes(plan));
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const clean = (max: number, msg: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : v),
    z.string().min(1, msg).max(max, `At most ${max} characters`),
  );

const planList = z
  .array(z.enum(PLANS))
  .max(PLANS.length)
  .transform((v) => [...new Set(v)].sort((a, b) => PLANS.indexOf(a) - PLANS.indexOf(b)) as Plan[]);

export const articleCreateSchema = z.object({
  title: clean(200, "Add a title"),
  slug: z.string().trim().toLowerCase().max(120).regex(SLUG_RE, "Lowercase letters, numbers and dashes only").optional(),
  category: clean(80, "Choose a category"),
  summary: z.string().trim().max(400, "At most 400 characters").optional().default(""),
  body_md: z.string().max(100_000, "The article is too long").default(""),
  plans: planList.optional().default([]),
  audience: z.enum(AUDIENCES, { error: "Choose public, all staff or admins" }).default("all_staff"),
  status: z.enum(STATUSES, { error: "Choose draft or published" }).default("draft"),
});
export type ArticleInput = z.infer<typeof articleCreateSchema>;

export const articlePatchSchema = z
  .object({
    title: clean(200, "Add a title"),
    slug: z.string().trim().toLowerCase().max(120).regex(SLUG_RE, "Lowercase letters, numbers and dashes only"),
    category: clean(80, "Choose a category"),
    summary: z.string().trim().max(400, "At most 400 characters"),
    body_md: z.string().max(100_000, "The article is too long"),
    plans: planList,
    audience: z.enum(AUDIENCES, { error: "Choose public, all staff or admins" }),
    status: z.enum(STATUSES, { error: "Choose draft or published" }),
  })
  .partial();
export type ArticlePatch = z.infer<typeof articlePatchSchema>;

/** A body that reads well needs a little text; a published article must have one. */
export function publishProblem(a: { status: string; body_md: string }): string | null {
  if (a.status === "published" && a.body_md.trim().length < 20) return "Write the article before publishing it.";
  return null;
}

export const PLAN_LABELS: Record<Plan, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

/** "Growth and Pro", "Pro", "" for every plan. */
export function plansLabel(plans: readonly string[] | null | undefined): string {
  const names = (plans ?? []).filter((p): p is Plan => (PLANS as readonly string[]).includes(p)).map((p) => PLAN_LABELS[p]);
  if (!names.length || names.length === PLANS.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
