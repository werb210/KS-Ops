// KS_OPS_KB_v1 - Keystone Maya on the Keystone website: the sales assistant for prospects.
//
// It answers questions about features, plans, pricing, add-ons, trials, security and data residency (Canada),
// onboarding and how Keystone compares, from three things only:
//   - the live plan catalogue (the same object GET /api/public/plans returns, src/pricing.ts publicPlans());
//   - the published PUBLIC knowledge base articles;
//   - the website's own pages: the page the visitor is on (its path, title and text, sent by the widget) and the site map.
// Its context never contains internal costs or margins, and every reply is checked again (guard.ts). Features an article
// marks "coming soon" are described as coming soon.
// It can offer: start the self-serve demo (/try), sign up (/signup), book a live demo, or talk to a person. Booking a
// demo and talking to a person go through the lead form (leads.ts), which captures the lead into the Keystone CRM and
// hands off to sales.
import type { Deps } from "../deps.js";
import { publicPlans } from "../pricing.js";
import { hasGoodMatch, logQuestion, searchArticles, type SearchHit } from "../kb/repo.js";
import { aiConfigured, chatJson, type ChatMessage } from "./openai.js";
import { guardReply, wantsPerson } from "./guard.js";
import { articleBlock } from "./support.js";
import { history, lastQuestion, searchText, type Turn } from "./turns.js";

export const SALES_ASSISTANT_NAME = "Maya";

export const SITE_PAGES: ReadonlyArray<{ path: string; title: string }> = [
  { path: "/", title: "Home" },
  { path: "/features", title: "Features" },
  { path: "/fraud-protection", title: "Fraud protection" },
  { path: "/pricing", title: "Pricing" },
  { path: "/compare", title: "How Keystone compares (HubSpot, Pipedrive, Salesforce)" },
  { path: "/mobile-apps", title: "Mobile apps" },
  { path: "/security", title: "Security and data" },
  { path: "/faq", title: "FAQ" },
  { path: "/contact", title: "Contact" },
  { path: "/try", title: "Try it yourself (self-serve demo)" },
  { path: "/signup", title: "Sign up" },
  { path: "/help", title: "Help articles" },
];

export const ACTIONS = {
  start_demo: { kind: "start_demo", label: "Try the demo yourself", href: "/try" },
  signup: { kind: "signup", label: "Sign up", href: "/signup" },
  pricing: { kind: "pricing", label: "See pricing", href: "/pricing" },
  book_demo: { kind: "book_demo", label: "Book a live demo", href: null },
  talk_to_person: { kind: "talk_to_person", label: "Talk to a person", href: null },
} as const;
export type ActionKey = keyof typeof ACTIONS;
const isAction = (v: unknown): v is ActionKey => typeof v === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, v);

export type PageContext = { path: string; title: string; text: string };
export type SalesReply = {
  answer: string;
  citations: Array<{ slug: string; title: string; category: string }>;
  actions: Array<(typeof ACTIONS)[ActionKey]>;
  outcome: "answered" | "no_answer" | "escalated";
  ai: boolean;
};

/** The page the visitor is on, cleaned: a site path, a short title and at most 3,000 characters of its text. */
export function cleanPage(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const path = typeof r.path === "string" && /^\/[A-Za-z0-9/_-]{0,80}$/.test(r.path) ? r.path : null;
  if (!path) return null;
  const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const text = typeof r.text === "string" ? r.text.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000) : "";
  return { path, title, text };
}

/** The catalogue as the model sees it: what /api/public/plans says, prices in CAD. */
export function catalogueText(): string {
  return JSON.stringify(publicPlans());
}

export function salesSystemPrompt(): string {
  return [
    `You are ${SALES_ASSISTANT_NAME}, Keystone's assistant on the Keystone website. Keystone is white-label CRM and loan-origination software for commercial lending and business financing brokerages, licensed per seat, with Starter, Growth and Pro plans. Prices are in Canadian dollars (CAD).`,
    "Rules:",
    "- Answer only from the PLAN CATALOGUE, the HELP ARTICLES and the WEBSITE PAGES below. If they do not answer it, say you are not sure and offer talk_to_person. Never invent features, prices, discounts or dates.",
    "- Seat prices are per seat per month; the annual price is the monthly rate when billed yearly. Quote prices exactly as the catalogue gives them, with CAD.",
    "- Never discuss Keystone's internal costs, margins, what Keystone pays its suppliers, or how prices are made. Say you can only share the published prices.",
    "- When an article says something is coming soon, say it is coming soon. Never present it as available.",
    "- Data is hosted in Canada (Microsoft Azure, Canada Central), as the security articles say.",
    "- Compare with other software fairly and only with facts from the articles; never criticise another company.",
    "- Plain English, friendly, under 150 words. Use **bold** sparingly. Link pages as markdown links with the site paths given (for example [Pricing](/pricing)).",
    "- Never give out phone numbers.",
    "- Offer next steps in actions, chosen from: start_demo, signup, pricing, book_demo, talk_to_person. Offer book_demo when they want to see it with a person, talk_to_person when they want a person or you cannot answer.",
    'Reply with JSON only: {"answer": "...", "sources": ["article-slug"], "actions": ["start_demo"], "confident": true}',
  ].join("\n");
}

export async function answerSales(
  deps: Pick<Deps, "db" | "fetch">,
  input: { askerRef: string | null; turns: Turn[]; page: PageContext | null },
): Promise<SalesReply> {
  const question = lastQuestion(input.turns);
  const result = await searchArticles(deps.db, { viewer: "public", q: searchText(input.turns), limit: 4, fetch: deps.fetch });
  const hits: SearchHit[] = result.hits;
  const log = (outcome: SalesReply["outcome"], used: SearchHit[]) =>
    logQuestion(deps.db, {
      channel: "website",
      licensee_id: null,
      asker_ref: input.askerRef,
      question,
      outcome,
      top_score: result.semantic ? result.best_similarity : result.best_rank,
      article_ids: used.map((a) => a.id),
    });
  const cite = (a: SearchHit) => ({ slug: a.slug, title: a.title, category: a.category });

  if (wantsPerson(question)) {
    await log("escalated", []);
    return {
      answer: "Happy to put you in touch with the Keystone team. Leave your details and someone will get back to you, usually within one business day.",
      citations: [],
      actions: [ACTIONS.talk_to_person, ACTIONS.book_demo],
      outcome: "escalated",
      ai: false,
    };
  }

  const fallback = async (): Promise<SalesReply> => {
    const good = hasGoodMatch(result);
    await log(good ? "answered" : "no_answer", good ? hits.slice(0, 3) : []);
    return {
      answer: good
        ? "These help articles cover that. You can also try the demo yourself, or talk to the team."
        : "I'm not sure about that one. The Keystone team can answer it: leave your details and they'll get back to you.",
      citations: good ? hits.slice(0, 3).map(cite) : [],
      actions: good ? [ACTIONS.start_demo, ACTIONS.pricing] : [ACTIONS.talk_to_person, ACTIONS.start_demo],
      outcome: good ? "answered" : "no_answer",
      ai: false,
    };
  };
  if (!aiConfigured()) return fallback();

  const pages = SITE_PAGES.map((p) => `${p.path} - ${p.title}`).join("\n");
  const here = input.page ? `\nThe visitor is on ${input.page.path} (${input.page.title}). Text of that page:\n${input.page.text}` : "";
  const messages: ChatMessage[] = [
    { role: "system", content: salesSystemPrompt() },
    { role: "system", content: `PLAN CATALOGUE (live, CAD)\n${catalogueText()}` },
    { role: "system", content: `HELP ARTICLES\n\n${hits.length ? articleBlock(hits) : "None matched."}` },
    { role: "system", content: `WEBSITE PAGES\n${pages}${here}` },
    ...history(input.turns),
  ];
  let parsed: Record<string, unknown>;
  try {
    parsed = await chatJson(deps.fetch, messages, { maxTokens: 600 });
  } catch (err) {
    console.warn(`[kb] sales assistant fell back to articles: ${err instanceof Error ? err.message : String(err)}`);
    return fallback();
  }
  const raw = typeof parsed.answer === "string" ? parsed.answer : "";
  if (!raw.trim()) return fallback();
  const guarded = guardReply(raw);
  const bySlug = new Map(hits.map((a) => [a.slug, a]));
  const used = (Array.isArray(parsed.sources) ? parsed.sources : [])
    .map((s) => String(s ?? "").trim())
    .filter((s, i, all) => bySlug.has(s) && all.indexOf(s) === i)
    .map((s) => bySlug.get(s)!);
  const actions = [...new Set((Array.isArray(parsed.actions) ? parsed.actions : []).filter(isAction))].slice(0, 3).map((k) => ACTIONS[k]);
  const confident = parsed.confident !== false && !guarded.replaced;
  const outcome: SalesReply["outcome"] = confident ? "answered" : "no_answer";
  if (!confident && !actions.some((a) => a.kind === "talk_to_person")) actions.push(ACTIONS.talk_to_person);
  await log(outcome, used);
  return { answer: guarded.text, citations: used.map(cite), actions, outcome, ai: true };
}
