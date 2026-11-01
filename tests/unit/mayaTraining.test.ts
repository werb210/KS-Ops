// KS_OPS_MAYA_TRAINING_v1 - the website's sales Maya with sample broker questions. The model is mocked: these tests check
// what Maya is GIVEN (the right articles first, the right page, the tightened rules) and what comes back to the visitor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTER_ARTICLES, type SeedArticle } from "../../src/kb/articles/index.js";
import { WHY_KEYSTONE } from "../../src/kb/articles/whyKeystone.js";
import { answerSales, pageFor, salesArticles, salesMessages, salesSystemPrompt, topicSlugs } from "../../src/assistant/sales.js";
import { guardReply, INTERNAL_COST_REPLY } from "../../src/assistant/guard.js";
import { seedKnowledgeBase, SEED_VERSION } from "../../src/kb/seed.js";
import { fakeDb, jsonResponse } from "../helpers.js";

const row = (a: SeedArticle, i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  slug: a.slug, title: a.title, category: a.category, summary: a.summary, body_md: a.body, plans: a.plans, audience: a.audience,
  status: "published", seed_key: `v${a.since ?? 1}:${a.slug}`, created_by: "keystone", updated_by: "keystone",
  created_at: new Date(), updated_at: new Date(), published_at: new Date(),
});
const ROWS = STARTER_ARTICLES.map(row);

/** A knowledge base with every starter article, answering by SQL content. Full-text search finds nothing, so any article
 * Maya gets for these questions came from topic routing. */
function kbDb() {
  return fakeDb([
    [/FROM kb_articles WHERE slug = \$1 AND status = 'published' AND audience = ANY/, (p) =>
      ROWS.filter((r) => r.slug === p[0] && (p[1] as string[]).includes(r.audience))],
    [/FROM kb_articles/, () => []],
    [/INSERT INTO kb_questions/, () => []],
  ]);
}

const BROKER_QUESTIONS: Array<{ q: string; slugs: string[]; page: string }> = [
  { q: "Why would I switch to Keystone?", slugs: ["why-switch-to-keystone"], page: "/why-keystone" },
  { q: "We use HubSpot today. How is Keystone different?", slugs: ["keystone-vs-hubspot"], page: "/compare" },
  { q: "Is this cheaper than Salesforce for 5 people?", slugs: ["keystone-vs-salesforce"], page: "/compare" },
  { q: "How do you compare with Zoho?", slugs: ["keystone-vs-zoho"], page: "/compare" },
  { q: "pipedrive vs keystone", slugs: ["keystone-vs-pipedrive"], page: "/compare" },
  { q: "How much is Growth per seat?", slugs: ["plans-compared"], page: "/pricing" },
  { q: "What does the marketing add-on include?", slugs: ["marketing-add-on"], page: "/pricing" },
  { q: "Are you PIPEDA and CASL compliant? Where is our data stored?", slugs: ["compliance-built-in"], page: "/security" },
  { q: "How do you catch doctored bank statements?", slugs: ["fraud-checks-by-plan"], page: "/fraud-protection" },
  { q: "Can it send follow-up texts automatically when a deal changes stage?", slugs: ["automations-for-brokers"], page: "/features" },
  { q: "How do we migrate our contacts and deals?", slugs: ["switching-to-keystone", "import-from-hubspot-salesforce-pipedrive"], page: "/faq" },
  { q: "Is there an Android app for my team?", slugs: ["mobile-apps-overview"], page: "/mobile-apps" },
  { q: "Can I submit deals to lenders through an API?", slugs: ["lender-integrations-status"], page: "/features" },
  { q: "Is there a free trial?", slugs: ["free-trials-and-demo"], page: "/try" },
  { q: "It seems expensive and we already have a CRM", slugs: ["questions-before-switching"], page: "/why-keystone" },
  { q: "Can I cancel any time and export our data?", slugs: ["contracts-and-cancelling"], page: "/faq" },
  { q: "How do I request a feature?", slugs: ["roadmap-and-feature-requests"], page: "/roadmap" },
];

describe("topic routing for broker questions", () => {
  for (const t of BROKER_QUESTIONS) {
    it(`"${t.q}" -> ${t.slugs.join(", ")} and ${t.page}`, () => {
      const got = topicSlugs(t.q);
      for (const s of t.slugs) expect(got, t.q).toContain(s);
      expect(got.length).toBeLessThanOrEqual(4);
      expect(pageFor(t.q)).toBe(t.page);
    });
  }

  it("every routed slug is a public starter article", () => {
    const pub = new Set(STARTER_ARTICLES.filter((a) => a.audience === "public").map((a) => a.slug));
    for (const t of BROKER_QUESTIONS) for (const s of topicSlugs(t.q, 99)) expect(pub.has(s), s).toBe(true);
  });

  it("puts topic articles first, then search hits, without repeats, and never a non-public article", async () => {
    const db = kbDb();
    const searched = [{ ...ROWS.find((r) => r.slug === "plans-compared")!, score: 0.5, fts_rank: 0.2, similarity: 0 }] as any;
    const hits = await salesArticles(db, "How much does HubSpot cost compared to you?", searched);
    expect(hits.map((h) => h.slug).slice(0, 2)).toEqual(["keystone-vs-hubspot", "why-switch-to-keystone"]);
    expect(hits.filter((h) => h.slug === "plans-compared")).toHaveLength(1);
    expect(hits.every((h) => h.audience === "public")).toBe(true);
  });
});

describe("what the sales Maya is told", () => {
  it("answers directly and briefly, links the page, and keeps the hard rules", () => {
    const p = salesSystemPrompt();
    expect(p).toMatch(/Answer the question in the first sentence/);
    expect(p).toMatch(/Under 90 words/);
    expect(p).toMatch(/markdown link with the site path/);
    expect(p).toMatch(/Never discuss Keystone's internal costs, margins/);
    expect(p).toMatch(/Never give out any phone number/);
    expect(p).toMatch(/coming soon/);
    expect(p).toMatch(/Objections/);
    expect(p).not.toMatch(/587/);
  });

  it("sends the routed articles, the relevant page and the visitor's page", async () => {
    const db = kbDb();
    const turns = [{ role: "user" as const, text: "Why would I switch from HubSpot?" }];
    const hits = await salesArticles(db, turns[0].text, []);
    const msgs = salesMessages({ turns, page: { path: "/compare", title: "Compare", text: "HubSpot Sales Hub" }, hits, catalogue: "{}" });
    const all = msgs.map((m) => m.content).join("\n");
    expect(all).toContain("### keystone-vs-hubspot");
    expect(all).toContain("CAD $1,819");
    expect(all).toContain("RELEVANT PAGE: /compare");
    expect(all).toContain("The visitor is on /compare");
    expect(all).toContain("/why-keystone - Why switch");
    expect(all).toContain("/roadmap - Roadmap");
  });
});

describe("answering a broker (model mocked)", () => {
  let reply: Record<string, unknown> = {};
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "https://api.openai.com/v1/chat/completions") {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    }
    return jsonResponse({ data: [] });
  });
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    bodies.length = 0;
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("cites the comparison article it used", async () => {
    reply = { answer: "HubSpot lists CAD $1,819 a month for 5 people. See [Compare](/compare).", sources: ["keystone-vs-hubspot", "not-an-article"], actions: ["start_demo"], confident: true };
    const r = await answerSales({ db: kbDb(), fetch: fetchImpl as unknown as typeof fetch }, { askerRef: null, turns: [{ role: "user", text: "What would HubSpot cost us instead?" }], page: null });
    expect(r.citations.map((c) => c.slug)).toEqual(["keystone-vs-hubspot"]);
    expect(r.outcome).toBe("answered");
    expect(JSON.stringify(bodies[0].messages)).toContain("### keystone-vs-hubspot");
  });

  it("security question: the compliance article reaches the model", async () => {
    reply = { answer: "Your data stays in Canada. See [Security](/security).", sources: ["compliance-built-in"], actions: [], confident: true };
    const r = await answerSales({ db: kbDb(), fetch: fetchImpl as unknown as typeof fetch }, { askerRef: null, turns: [{ role: "user", text: "Do you handle CASL quiet hours and Quebec Law 25?" }], page: null });
    const sent = JSON.stringify(bodies[0].messages);
    expect(sent).toContain("### compliance-built-in");
    expect(sent).toContain("RELEVANT PAGE: /security");
    expect(r.citations[0].slug).toBe("compliance-built-in");
  });

  it("never passes on internal costs or the private line", async () => {
    reply = { answer: "Our margin on texts is high. Call 587-888-1837.", sources: [], actions: [], confident: true };
    const r = await answerSales({ db: kbDb(), fetch: fetchImpl as unknown as typeof fetch }, { askerRef: null, turns: [{ role: "user", text: "What do texts cost you?" }], page: null });
    expect(r.answer).toBe(INTERNAL_COST_REPLY);
    expect(guardReply("Call 587 888 1837 today").text).not.toMatch(/587/);
  });

  it("without AI it still offers the routed articles", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await answerSales({ db: kbDb(), fetch: fetchImpl as unknown as typeof fetch }, { askerRef: null, turns: [{ role: "user", text: "How do I move from Pipedrive?" }], page: null });
    expect(r.ai).toBe(false);
    expect(r.citations.map((c) => c.slug)).toContain("keystone-vs-pipedrive");
    expect(bodies).toHaveLength(0);
  });
});

describe("the sales articles (seed v2)", () => {
  it("are public, new in v2, and follow the starter rules", () => {
    expect(SEED_VERSION).toBe(2);
    for (const a of WHY_KEYSTONE) {
      expect(a.audience, a.slug).toBe("public");
      expect(a.since, a.slug).toBe(2);
      const text = `${a.title}\n${a.summary}\n${a.body}`;
      expect(guardReply(text).replaced, a.slug).toBe(false);
      expect(text, a.slug).not.toMatch(/587[\s.\-)]*888|boreal/i);
    }
  });

  it("quote the compare page's figures (KS-Website src/data/compare.ts, checked October 26, 2026)", () => {
    const body = (slug: string) => WHY_KEYSTONE.find((a) => a.slug === slug)!.body;
    expect(body("keystone-vs-hubspot")).toMatch(/CAD \$1,819[\s\S]*CAD \$5,650[\s\S]*CAD \$27,478/);
    expect(body("keystone-vs-salesforce")).toMatch(/from USD \$1,775[\s\S]*from USD \$21,300/);
    expect(body("keystone-vs-zoho")).toMatch(/from CAD \$182 \+ USD \$49/);
    expect(body("keystone-vs-pipedrive")).toMatch(/from CAD \$408\.33/);
    for (const s of ["keystone-vs-hubspot", "keystone-vs-salesforce", "keystone-vs-zoho", "keystone-vs-pipedrive"]) {
      expect(body(s), s).toMatch(/checked October 26, 2026/);
      expect(body(s), s).toMatch(/Sources:/);
    }
  });

  it("say not-yet-built things are coming soon", () => {
    const text = WHY_KEYSTONE.map((a) => a.body).join("\n");
    expect(text).toMatch(/## Coming soon\n- Sending deals straight into a lender's own system/);
    expect(text).toMatch(/## Coming soon\nAndroid apps for staff/);
  });

  it("a copy seeded at v1 gets only the v2 articles; a fresh copy gets everything", async () => {
    const inserted: string[] = [];
    const ran = new Set<number>([1]);
    const db = fakeDb([
      [/SELECT 1 FROM kb_seed_runs WHERE version/, (p) => (ran.has(Number(p[0])) ? [{ "?column?": 1 }] : [])],
      [/INSERT INTO kb_articles/, (p) => { inserted.push(String(p[0])); return [{ id: "x" }]; }],
      [/INSERT INTO kb_seed_runs/, (p) => { ran.add(Number(p[0])); return []; }],
    ]);
    expect(await seedKnowledgeBase(db)).toBe(WHY_KEYSTONE.length);
    expect(inserted.sort()).toEqual(WHY_KEYSTONE.map((a) => a.slug).sort());
    expect(await seedKnowledgeBase(db)).toBe(0);

    ran.clear();
    inserted.length = 0;
    expect(await seedKnowledgeBase(db)).toBe(STARTER_ARTICLES.length);
  });
});
