// KS_OPS_KB_v1 - "Ask Maya" in the licensee portal's Help Center: Keystone's support assistant.
//
// It answers from the knowledge base only, and says which articles it used (each answer cites them; an answer that
// cites nothing is treated as "no good answer"). The only other thing it is told is the asking brokerage's own setup -
// plan, seats, allowances and this month's usage, trial, and which connections are set up - so it can explain that
// brokerage's setup. That setup comes from KS-Ops's own licensee row (found by the ops key) plus what the brokerage's own
// KS-server sends with the question; nothing about any other licensee is ever read or sent.
//
// When it cannot help, or the person asks for a person, the reply carries offer_support: the portal then offers
// "Contact support", which opens a normal support ticket (KS-server POST /api/support/tickets) with this conversation and
// the articles tried. Every question is logged (kb_questions) for the "no good answer" report and the rate limits.
// Keystone pays for it: it never counts against the licensee's assistant-chat allowance.
import type { Deps } from "../deps.js";
import type { LicenseeRow } from "../licensees/repo.js";
import { pooledAllowances, PLAN_NAMES, isPlan, SUPPORT, type SupportLevel } from "../pricing.js";
import { hasGoodMatch, logQuestion, searchArticles, type SearchHit } from "../kb/repo.js";
import { plainText } from "../kb/markdown.js";
import { plansLabel, type Viewer } from "../kb/model.js";
import { aiConfigured, chatJson, type ChatMessage } from "./openai.js";
import { guardReply, wantsPerson } from "./guard.js";
import { history, lastQuestion, searchText, type Turn } from "./turns.js";

export const ASSISTANT_NAME = "Maya";
export const MAX_ARTICLES = 5;
const ARTICLE_CHARS = 3500;

export type Citation = { slug: string; title: string; category: string };
export type SupportReply = {
  answer: string;
  citations: Citation[];
  /** Offer "Contact support" (no good answer, or they asked for a person). */
  offer_support: boolean;
  /** Articles that looked closest, for "articles tried" on a ticket and as "you might also read". */
  related: Citation[];
  outcome: "answered" | "no_answer" | "escalated";
  ai: boolean;
};

// ---- the brokerage's own setup ----

const INTEGRATION_LABELS: Record<string, string> = {
  microsoft_365: "Microsoft 365 (mail, calendar)",
  google: "Google Workspace",
  quickbooks: "QuickBooks Online",
  phone: "Phone and texting",
  e_signing: "E-signing",
  bulk_email: "Bulk email for campaigns",
  sso: "Single sign-on",
  operations_link: "Link to Keystone (usage, tickets)",
};
const STATUS_WORDS = new Set(["connected", "not_connected", "not_set_up", "set_up", "error", "expired"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The setup facts the assistant may use, as short lines. Only known keys with plain values are kept from what the
 * licensee's server sent; plan, seats, support level and the pooled allowances come from KS-Ops's own record.
 */
export function setupFacts(l: Pick<LicenseeRow, "plan" | "seats" | "support_level" | "status" | "addons">, raw: unknown): string[] {
  const ctx = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  const lines: string[] = [];
  const plan = isPlan(l.plan) ? l.plan : null;
  if (plan) {
    const a = pooledAllowances(plan, Number(l.seats) || 1);
    lines.push(`Plan: ${PLAN_NAMES[plan]}, ${Number(l.seats) || 1} seat(s). Account status: ${l.status}.`);
    lines.push(
      `Pooled monthly allowances: ${a.minutes} call minutes, ${a.texts} texts, ${a.assistant_chats === null ? "unlimited" : a.assistant_chats} assistant chats, ${a.storage_gb} GB storage.`,
    );
  }
  const lvl = l.support_level as SupportLevel;
  if (SUPPORT[lvl]) lines.push(`Support level: ${SUPPORT[lvl].name} (first reply ${SUPPORT[lvl].first_reply}).`);
  if (l.addons && typeof l.addons === "object" && (l.addons as Record<string, boolean>).marketing === true) lines.push("Marketing add-on: on.");
  const trial = ctx.trial && typeof ctx.trial === "object" ? ctx.trial : null;
  if (trial && typeof trial.status === "string" && /^[a-z_]{1,20}$/.test(trial.status)) {
    const days = num(trial.days_left);
    lines.push(`In-app Pro trial: ${trial.status.replace(/_/g, " ")}${days !== null && trial.status === "active" ? `, ${days} day(s) left` : ""}.`);
  }
  const usage = ctx.usage && typeof ctx.usage === "object" ? ctx.usage : null;
  if (usage) {
    const parts: string[] = [];
    for (const [k, label] of [["minutes", "call minutes"], ["texts", "texts"], ["assistant_chats", "assistant chats"], ["signings", "e-signings"], ["storage_gb", "GB storage"]] as const) {
      const u = usage[k];
      if (!u || typeof u !== "object") continue;
      const used = num(u.used);
      const incl = num(u.included);
      if (used === null) continue;
      parts.push(`${used} ${label} used${incl !== null ? ` of ${incl}` : ""}`);
    }
    if (parts.length) lines.push(`This month so far: ${parts.join(", ")}.`);
  }
  const integ = ctx.integrations && typeof ctx.integrations === "object" ? ctx.integrations : null;
  if (integ) {
    const parts: string[] = [];
    for (const [key, label] of Object.entries(INTEGRATION_LABELS)) {
      const v = integ[key];
      if (typeof v === "boolean") parts.push(`${label}: ${v ? "connected" : "not connected"}`);
      else if (typeof v === "string" && STATUS_WORDS.has(v)) parts.push(`${label}: ${v.replace(/_/g, " ")}`);
    }
    if (parts.length) lines.push(`Connections: ${parts.join("; ")}.`);
  }
  if (typeof ctx.role === "string" && /^[A-Za-z]{2,20}$/.test(ctx.role)) lines.push(`The person asking has the ${ctx.role} role.`);
  return lines;
}

// ---- prompting ----

const cite = (a: SearchHit): Citation => ({ slug: a.slug, title: a.title, category: a.category });

export function articleBlock(hits: SearchHit[]): string {
  let budget = 14_000;
  const parts: string[] = [];
  for (const a of hits) {
    const body = plainText(a.body_md).slice(0, Math.min(ARTICLE_CHARS, budget));
    budget -= body.length;
    const plans = plansLabel(a.plans);
    parts.push(`### ${a.slug}\nTitle: ${a.title}\nCategory: ${a.category}${plans ? `\nPlans: ${plans} only` : ""}\n${body}`);
    if (budget <= 0) break;
  }
  return parts.join("\n\n");
}

export function supportSystemPrompt(company: string): string {
  return [
    `You are ${ASSISTANT_NAME}, Keystone's support assistant inside the Keystone staff portal. Keystone is CRM and loan-origination software for commercial lending brokerages. You are helping a member of staff at ${company}.`,
    "Rules:",
    "- Answer only from the HELP ARTICLES and the BROKERAGE SETUP below. If they do not answer the question, say so plainly, do not guess, and set needs_person to true.",
    "- Put the slug of every article you used in sources. Never cite an article you did not use.",
    "- When an article says something is coming soon, say it is coming soon. Never describe it as working.",
    "- When an article is limited to some plans, say which plans have it, and compare with this brokerage's plan.",
    "- Use the BROKERAGE SETUP only to explain this brokerage's own plan, allowances, usage and connections. You know nothing about any other brokerage and must never guess about one.",
    "- Never mention Keystone's internal costs, margins or what Keystone pays its suppliers. Never give out phone numbers.",
    "- Write plain English: a one-line answer, then short numbered steps when there are steps. Under 180 words. Use **bold** for button and menu names.",
    "- If the person asks for a person, or the problem needs someone to look at their account, set needs_person to true.",
    'Reply with JSON only: {"answer": "...", "sources": ["slug"], "confident": true, "needs_person": false}',
  ].join("\n");
}

// ---- answering ----

export async function answerSupport(
  deps: Pick<Deps, "db" | "fetch">,
  input: { licensee: LicenseeRow; viewer: Exclude<Viewer, "public">; askerRef: string | null; turns: Turn[]; context: unknown },
): Promise<SupportReply> {
  const question = lastQuestion(input.turns);
  const result = await searchArticles(deps.db, { viewer: input.viewer, q: searchText(input.turns), limit: MAX_ARTICLES, fetch: deps.fetch });
  const hits = result.hits;
  const good = hasGoodMatch(result);
  const related = hits.slice(0, 3).map(cite);
  const log = (outcome: SupportReply["outcome"], used: SearchHit[]) =>
    logQuestion(deps.db, {
      channel: "portal",
      licensee_id: input.licensee.id,
      asker_ref: input.askerRef,
      question,
      outcome,
      top_score: result.semantic ? result.best_similarity : result.best_rank,
      article_ids: used.map((a) => a.id),
    });

  if (wantsPerson(question)) {
    await log("escalated", hits.slice(0, 3));
    return {
      answer: "Of course. Use **Contact support** below and I'll send this conversation to the Keystone support team, with the articles we looked at. They reply by email.",
      citations: [],
      offer_support: true,
      related,
      outcome: "escalated",
      ai: false,
    };
  }

  const fallback = async (): Promise<SupportReply> => {
    if (good) {
      await log("answered", hits.slice(0, 3));
      return {
        answer: "These help articles look closest to your question. If they don't solve it, use **Contact support** and the team will help.",
        citations: related,
        offer_support: true,
        related,
        outcome: "answered",
        ai: false,
      };
    }
    await log("no_answer", []);
    return {
      answer: "I couldn't find a help article that answers this. Use **Contact support** and the Keystone support team will help. They reply by email.",
      citations: [],
      offer_support: true,
      related,
      outcome: "no_answer",
      ai: false,
    };
  };

  if (!hits.length || !aiConfigured()) return fallback();

  const company = String(input.licensee.company_name ?? "the brokerage");
  const facts = setupFacts(input.licensee, input.context);
  const messages: ChatMessage[] = [
    { role: "system", content: supportSystemPrompt(company) },
    { role: "system", content: `HELP ARTICLES\n\n${articleBlock(hits)}` },
    { role: "system", content: `BROKERAGE SETUP (${company} only)\n${facts.length ? facts.join("\n") : "Not available."}` },
    ...history(input.turns),
  ];
  let parsed: Record<string, unknown>;
  try {
    parsed = await chatJson(deps.fetch, messages);
  } catch (err) {
    console.warn(`[kb] support assistant fell back to articles: ${err instanceof Error ? err.message : String(err)}`);
    return fallback();
  }
  const bySlug = new Map(hits.map((a) => [a.slug, a]));
  const sources = (Array.isArray(parsed.sources) ? parsed.sources : [])
    .map((s) => String(s ?? "").trim())
    .filter((s, i, all) => bySlug.has(s) && all.indexOf(s) === i);
  const used = sources.map((s) => bySlug.get(s)!);
  const raw = typeof parsed.answer === "string" ? parsed.answer : "";
  if (!raw.trim()) return fallback();
  const guarded = guardReply(raw);
  const confident = parsed.confident !== false;
  const needsPerson = parsed.needs_person === true;
  const grounded = used.length > 0;
  const outcome: SupportReply["outcome"] = grounded && confident && !needsPerson ? "answered" : "no_answer";
  await log(outcome, used.length ? used : hits.slice(0, 3));
  return {
    answer: grounded || guarded.replaced ? guarded.text : `${guarded.text}\n\nI couldn't find this in the help articles, so please check with the support team.`,
    citations: used.map(cite),
    offer_support: outcome !== "answered",
    related,
    outcome,
    ai: true,
  };
}
