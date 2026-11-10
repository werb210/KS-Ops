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
import { MARKETING_ADDON, dollars, publicPlans } from "../pricing.js";
import { hasGoodMatch, logQuestion, readableArticle, searchArticles, type SearchHit } from "../kb/repo.js";
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
  { path: "/why-keystone", title: "Why switch to Keystone (the cost of a general CRM plus add-ons)" },
  { path: "/compare", title: "How Keystone compares (HubSpot, Salesforce, Zoho, Pipedrive), feature by feature with prices and sources" },
  { path: "/mobile-apps", title: "Mobile apps" },
  { path: "/security", title: "Security and data" },
  { path: "/faq", title: "FAQ" },
  { path: "/contact", title: "Contact" },
  { path: "/try", title: "Try it yourself (self-serve demo)" },
  { path: "/signup", title: "Sign up" },
  { path: "/help", title: "Help articles" },
  { path: "/roadmap", title: "Roadmap: requested, planned, being built and shipped; suggest a feature" },
  { path: "/beta", title: "Beta programme" },
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

// KS_OPS_MAYA_TRAINING_v1 - topic routing. A broker's question is matched to the articles that answer it and the page
// that covers it, so retrieval never depends on the question happening to share words with an article. The matched
// articles go first in HELP ARTICLES; full-text (and semantic) search fills the rest.
export type Topic = { key: string; test: RegExp; slugs: string[]; page: string };

export const TOPICS: Topic[] = [
  { key: "hubspot", test: /\bhub\s?spot\b/i, slugs: ["keystone-vs-hubspot", "why-switch-to-keystone"], page: "/compare" },
  { key: "salesforce", test: /\bsales\s?force\b|\bsfdc\b/i, slugs: ["keystone-vs-salesforce", "why-switch-to-keystone"], page: "/compare" },
  { key: "zoho", test: /\bzoho\b/i, slugs: ["keystone-vs-zoho", "why-switch-to-keystone"], page: "/compare" },
  { key: "pipedrive", test: /\bpipe\s?drive\b/i, slugs: ["keystone-vs-pipedrive", "why-switch-to-keystone"], page: "/compare" },
  { key: "compare", test: /\b(compare|comparison|versus|vs\.?|competitor|other crms?|cheaper|alternative)\b/i, slugs: ["how-keystone-compares", "why-switch-to-keystone"], page: "/compare" },
  { key: "why", test: /\b(why (should|would)|why (switch|choose|use|keystone)|switch(ing)? (to|from)|what makes|better than|worth it)\b/i, slugs: ["why-switch-to-keystone", "questions-before-switching"], page: "/why-keystone" },
  { key: "objection", test: /\b(too )?(expensive|pricey|costly)\b|\balready (use|have|pay)\b|\b(risky|risk|locked in|lock-in|not sure|hesitant)\b/i, slugs: ["questions-before-switching", "why-switch-to-keystone"], page: "/why-keystone" },
  { key: "pricing", test: /\b(price|prices|pricing|cost|costs|how much|per seat|seats?|plans?|starter|growth|pro plan|onboarding fee|discount)\b/i, slugs: ["plans-compared", "allowances-usage-and-overage"], page: "/pricing" },
  { key: "overage", test: /\b(overage|go over|allowance|minutes|texts? included|storage)\b/i, slugs: ["allowances-usage-and-overage"], page: "/pricing" },
  { key: "addon", test: /\b(add-?on|marketing add|campaigns?|email marketing|lead scoring|a\/b)\b/i, slugs: ["marketing-add-on"], page: "/pricing" },
  { key: "support", test: /\b(support levels?|priority support|premium support|dedicated|training)\b/i, slugs: ["support-levels", "switching-to-keystone"], page: "/pricing" },
  { key: "trial", test: /\b(trial|try (it|before)|demo|test drive)\b/i, slugs: ["free-trials-and-demo"], page: "/try" },
  { key: "fraud", test: /\b(fraud|tamper\w*|fake|doctored|stacking|forged|scam)\b/i, slugs: ["fraud-checks-by-plan"], page: "/fraud-protection" },
  { key: "compliance", test: /\b(complian\w*|secur\w*|privacy|pipeda|law 25|quebec|casl|tcpa|consent|retention|legal hold|audit|data residen\w*|canada|canadian|encrypt\w*|sin|ssn|10dlc|toll-?free verif\w*|quiet hours|recording notice|sso|single sign-on|passkey)\b/i, slugs: ["compliance-built-in", "security-and-data-residency"], page: "/security" },
  { key: "automations", test: /\b(automat\w*|workflows?|sequences?|drip|triggers?|task queues?|queues?|round robin|lead rotation|follow-?ups?)\b/i, slugs: ["automations-for-brokers"], page: "/features" },
  { key: "migration", test: /\b(migrat\w*|import\w*|move (over|our data)|moving|switch(ing)? over|transfer|onboard\w*|set ?up time|how long .*set ?up|port\w*( our)? numbers?|keep (our|my) (number|numbers))\b/i, slugs: ["switching-to-keystone", "import-from-hubspot-salesforce-pipedrive"], page: "/faq" },
  { key: "ownership", test: /\b(own (our|my|the) data|data ownership|export\w*|cancel\w*|contract|commitment|lock-?in)\b/i, slugs: ["contracts-and-cancelling", "switching-to-keystone"], page: "/faq" },
  { key: "mobile", test: /\b(mobile|app|apps|iphone|ipad|android|apple watch|watch|dialler|dialer)\b/i, slugs: ["mobile-apps-overview"], page: "/mobile-apps" },
  { key: "lenders", test: /\b(lenders?|submission|submit|lender api|integrat\w*)\b/i, slugs: ["lender-integrations-status"], page: "/features" },
  { key: "roadmap", test: /\b(roadmap|feature request|request a feature|suggest|coming soon|planned|when will)\b/i, slugs: ["roadmap-and-feature-requests", "coming-soon"], page: "/roadmap" },
];

/** The topics a question is about, in TOPICS order (the specific vendor topics come first). */
export function topicsFor(question: string): Topic[] {
  return TOPICS.filter((t) => t.test.test(question));
}

/** The article slugs to put first for a question, at most `max`, without repeats. */
export function topicSlugs(question: string, max = 4): string[] {
  const out: string[] = [];
  for (const t of topicsFor(question)) for (const s of t.slugs) if (!out.includes(s)) out.push(s);
  return out.slice(0, max);
}

/** The website page that best answers a question, or null. */
export function pageFor(question: string): string | null {
  return topicsFor(question)[0]?.page ?? null;
}

/** KS_OPS_MAYA_PRICES - questions about price get the published prices even when the AI is off or fails. */
export function asksAboutPrice(question: string): boolean {
  return /\b(cost|costs|price|prices|pricing|priced|how much|fee|fees|charge|charges|per seat|per user|per month|monthly|subscription)\b/i.test(question);
}

const money = (n: number) => `$${n.toLocaleString("en-CA", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** The published prices in plain words, from the live catalogue (the same numbers as the pricing page). */
export function priceAnswer(): string {
  const { plans } = publicPlans();
  const lines = plans.map((p) => {
    const onboarding = p.onboarding_fee > 0 ? `, plus a one-time ${money(p.onboarding_fee)} onboarding fee` : "";
    const min = p.min_seats > 1 ? ` (at least ${p.min_seats} seats)` : "";
    return `**${p.name}** is ${money(p.seat_price_annual)} per seat a month billed yearly, or ${money(p.seat_price_monthly)} month to month${min}${onboarding}.`;
  });
  // One paragraph: the website's chat panel shows text as it comes and does not turn line breaks into a list.
  return [
    "Keystone is priced per seat, in Canadian dollars.",
    ...lines,
    `The optional ${MARKETING_ADDON.name} is ${money(dollars(MARKETING_ADDON.price_cents))} a month for the whole brokerage. Full details are on the [Pricing](/pricing) page.`,
  ].join(" ");
}

export function salesSystemPrompt(): string {
  return [
    `You are ${SALES_ASSISTANT_NAME}, Keystone's assistant on the Keystone website. Keystone is white-label CRM and loan-origination software for commercial lending and business financing brokerages, licensed per seat, with Starter, Growth and Pro plans and a Marketing add-on. Prices are in Canadian dollars (CAD). You talk to brokers deciding whether to switch.`,
    "How to answer:",
    "- Answer the question in the first sentence. Then at most two or three short sentences or a short list of facts. Under 90 words unless they ask for detail. No greeting, no filler, no repeating the question.",
    "- End with one link to the page that covers it, as a markdown link with the site path (for example [Pricing](/pricing)). Use the RELEVANT PAGE when one is given.",
    "- Answer only from the PLAN CATALOGUE, the HELP ARTICLES and the WEBSITE PAGES below. If they don't answer it, say so in one sentence and offer talk_to_person. Never invent features, prices, discounts, dates or integrations.",
    "- Prices: quote them exactly as the catalogue gives them, per seat per month, in CAD; say whether billed yearly or monthly. Do the arithmetic for a team size when asked (seats x seat price, plus the one-time onboarding fee).",
    "- Other CRMs: use only the figures and facts in the comparison articles, in that vendor's own currency, and say they are list prices from the vendor's public pages and when they were checked. Be fair: say where the other product is strong. Never criticise another company.",
    "- Objections (too expensive, we already have a CRM, switching is risky, will my team learn it): acknowledge in a few words, give the one most relevant fact, and offer the next step (try the demo or talk to a person).",
    "- When an article says something is coming soon, say it is coming soon. Never present it as available.",
    "- Never discuss Keystone's internal costs, margins, what Keystone pays its suppliers, or how prices are set. Say you can only share the published prices.",
    "- Never give out any phone number. To reach a person, offer talk_to_person.",
    "- Offer next steps in actions, chosen from: start_demo, signup, pricing, book_demo, talk_to_person. Offer book_demo when they want to see it with a person, talk_to_person when they want a person or you cannot answer.",
    "- List in sources the slugs of the articles you used.",
    'Reply with JSON only: {"answer": "...", "sources": ["article-slug"], "actions": ["start_demo"], "confident": true}',
  ].join("\n");
}

/** Topic articles first (published public ones only), then the search hits, without repeats. */
export async function salesArticles(db: Deps["db"], question: string, searched: SearchHit[], limit = 5): Promise<SearchHit[]> {
  const pinned: SearchHit[] = [];
  for (const slug of topicSlugs(question)) {
    const a = await readableArticle(db, "public", slug);
    if (a) pinned.push({ ...a, score: 1, fts_rank: 0, similarity: 0 });
  }
  const seen = new Set(pinned.map((a) => a.slug));
  return [...pinned, ...searched.filter((a) => !seen.has(a.slug))].slice(0, limit);
}

/** Everything the model is sent, in order (exported for the tests). */
export function salesMessages(input: { turns: Turn[]; page: PageContext | null; hits: SearchHit[]; catalogue: string }): ChatMessage[] {
  const pages = SITE_PAGES.map((p) => `${p.path} - ${p.title}`).join("\n");
  const here = input.page ? `\nThe visitor is on ${input.page.path} (${input.page.title}). Text of that page:\n${input.page.text}` : "";
  const best = pageFor(lastQuestion(input.turns));
  return [
    { role: "system", content: salesSystemPrompt() },
    { role: "system", content: `PLAN CATALOGUE (live, CAD)\n${input.catalogue}` },
    { role: "system", content: `HELP ARTICLES\n\n${input.hits.length ? articleBlock(input.hits) : "None matched."}` },
    { role: "system", content: `WEBSITE PAGES\n${pages}${best ? `\nRELEVANT PAGE: ${best}` : ""}${here}` },
    ...history(input.turns),
  ];
}

export async function answerSales(
  deps: Pick<Deps, "db" | "fetch">,
  input: { askerRef: string | null; turns: Turn[]; page: PageContext | null },
): Promise<SalesReply> {
  const question = lastQuestion(input.turns);
  const result = await searchArticles(deps.db, { viewer: "public", q: searchText(input.turns), limit: 5, fetch: deps.fetch });
  const hits: SearchHit[] = await salesArticles(deps.db, searchText(input.turns), result.hits);
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
    // KS_OPS_MAYA_PRICES - without the AI, a price question still gets the prices, not a list of unrelated articles.
    if (asksAboutPrice(question)) {
      await log("answered", []);
      return { answer: priceAnswer(), citations: [], actions: [ACTIONS.pricing, ACTIONS.start_demo, ACTIONS.signup], outcome: "answered", ai: false };
    }
    const good = hasGoodMatch(result) || hits.length > 0;
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

  const messages = salesMessages({ turns: input.turns, page: input.page, hits, catalogue: catalogueText() });
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
