// KS_OPS_KB_v1 - knowledge base pieces that need no database: the safe Markdown, audiences, the reply guard, the
// brokerage-setup facts, the lead form and the starter library's own rules.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { escapeHtml, plainText, renderMarkdown } from "../../src/kb/markdown.js";
import { appliesToPlan, articleCreateSchema, audiencesFor, canRead, plansLabel, slugify, viewerFromRole } from "../../src/kb/model.js";
import { guardReply, INTERNAL_COST_REPLY, wantsPerson } from "../../src/assistant/guard.js";
import { setupFacts } from "../../src/assistant/support.js";
import { cleanPage } from "../../src/assistant/sales.js";
import { followUpDue, leadSchema } from "../../src/assistant/leads.js";
import { orQuery } from "../../src/kb/repo.js";
import { STARTER_ARTICLES } from "../../src/kb/articles/index.js";
import { KB_PAGE_HTML } from "../../src/routes/opsKbPage.js";
import { fakeDb, licenseeRow, makeDeps } from "../helpers.js";

describe("safe Markdown", () => {
  it("escapes HTML and drops unsafe links and images", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![p](http://evil.test/a.png) "q"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;q&quot;");
  });

  it("renders headings, lists, notes, tables, article links and stored images", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const html = renderMarkdown(
      `# Steps\n1. Open **Settings**\n2. Choose *Save*\n\n> A note\n\n| | A |\n|---|---|\n| x | 1 |\n\n[See](kb:add-users-and-roles) ![shot](/api/public/kb/images/${id})`,
      { imageBase: "https://ops.example.test/" },
    );
    expect(html).toContain("<h2>Steps</h2>");
    expect(html).toContain("<ol><li>Open <strong>Settings</strong></li><li>Choose <em>Save</em></li></ol>");
    expect(html).toContain("<blockquote><p>A note</p></blockquote>");
    expect(html).toContain("<thead><tr><th></th><th>A</th></tr></thead><tbody><tr><td>x</td><td>1</td></tr></tbody>");
    expect(html).toContain('href="#kb-add-users-and-roles" data-kb-slug="add-users-and-roles"');
    expect(html).toContain(`src="https://ops.example.test/api/public/kb/images/${id}"`);
  });

  it("keeps snake_case words intact and makes plain text for search", () => {
    expect(renderMarkdown("api_access_key")).toBe("<p>api_access_key</p>");
    expect(plainText("## Hi\n**bold** [link](https://x.test)")).toBe("Hi\nbold link");
    expect(escapeHtml(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
  });
});

describe("audiences and plans", () => {
  it("public < staff < admin", () => {
    expect(audiencesFor("public")).toEqual(["public"]);
    expect(audiencesFor("staff")).toEqual(["public", "all_staff"]);
    expect(audiencesFor("admin")).toEqual(["public", "all_staff", "admins"]);
    expect(canRead("staff", "admins")).toBe(false);
    expect(canRead("admin", "admins")).toBe(true);
    expect(canRead("public", "all_staff")).toBe(false);
  });

  it("only an Admin role reads admin articles", () => {
    expect(viewerFromRole("Admin")).toBe("admin");
    expect(viewerFromRole("Staff")).toBe("staff");
    expect(viewerFromRole("Marketing")).toBe("staff");
    expect(viewerFromRole(undefined)).toBe("staff");
  });

  it("plans: empty means every plan", () => {
    expect(appliesToPlan([], "starter")).toBe(true);
    expect(appliesToPlan(["pro"], "starter")).toBe(false);
    expect(appliesToPlan(["growth", "pro"], "pro")).toBe(true);
    expect(plansLabel(["growth", "pro"])).toBe("Growth and Pro");
    expect(plansLabel(["starter", "growth", "pro"])).toBe("");
  });

  it("validates the article form", () => {
    const ok = articleCreateSchema.safeParse({ title: " Add users ", category: "Users", plans: ["pro", "growth", "pro"] });
    expect(ok.success && ok.data).toMatchObject({ title: "Add users", plans: ["growth", "pro"], audience: "all_staff", status: "draft" });
    expect(articleCreateSchema.safeParse({ title: "x", category: "y", audience: "everyone" }).success).toBe(false);
    expect(articleCreateSchema.safeParse({ title: "x", category: "y", slug: "Bad Slug" }).success).toBe(false);
    expect(slugify("Connect Microsoft 365 & Google!")).toBe("connect-microsoft-365-google");
    expect(orQuery("How do I add a user?")).toBe("how | do | add | user");
  });
});

describe("reply guard", () => {
  it("replaces any reply about internal costs or margins", () => {
    expect(guardReply("Our margin on texts is 60%.")).toEqual({ text: INTERNAL_COST_REPLY, replaced: true });
    expect(guardReply("Twilio charges us less than that.").replaced).toBe(true);
    expect(guardReply("Keystone's cost per minute is low.").replaced).toBe(true);
    expect(guardReply("Overage is $0.04 a minute.").replaced).toBe(false);
  });

  it("removes the private phone line", () => {
    expect(guardReply("Call 587-888-1837 or (587) 888 1837.").text).toBe("Call the Keystone team or the Keystone team.");
  });

  it("spots a request for a person", () => {
    expect(wantsPerson("Can I talk to a real person?")).toBe(true);
    expect(wantsPerson("I want to speak with support")).toBe(true);
    expect(wantsPerson("How do I add a person to a team?")).toBe(false);
  });
});

describe("the brokerage's own setup", () => {
  it("keeps only known, plain values, with plan and allowances from KS-Ops's own record", () => {
    const l = licenseeRow({ plan: "growth", seats: 3, support_level: "priority", status: "active", addons: { marketing: true, bank_connect: true } });
    const lines = setupFacts(l as any, {
      trial: { status: "active", days_left: 9 },
      usage: { minutes: { used: 120, included: 1500 }, texts: { used: "lots" } },
      integrations: { microsoft_365: true, google: "not_set_up", quickbooks: "<script>", other_licensee: true },
      role: "Admin",
      company_name: "Other Brokerage",
    }).join("\n");
    expect(lines).toContain("Plan: Growth, 3 seat(s)");
    expect(lines).toContain("1500 call minutes, 1500 texts, 1000 assistant chats, 75 GB storage");
    expect(lines).toContain("Support level: Priority");
    expect(lines).toContain("Marketing add-on: on.");
    expect(lines).not.toContain("bank");
    expect(lines).toContain("9 day(s) left");
    expect(lines).toContain("120 call minutes used of 1500");
    expect(lines).not.toContain("lots");
    expect(lines).toContain("Microsoft 365 (mail, calendar): connected; Google Workspace: not set up");
    expect(lines).not.toContain("script");
    expect(lines).not.toContain("Other Brokerage");
    expect(lines).toContain("Admin role");
  });
});

describe("website assistant inputs", () => {
  it("cleans the page the visitor is on", () => {
    expect(cleanPage({ path: "/pricing", title: " Pricing ", text: "a\n\nb" })).toEqual({ path: "/pricing", title: "Pricing", text: "a b" });
    expect(cleanPage({ path: "https://evil.test", title: "x" })).toBeNull();
  });

  it("needs consent and a known team size for a lead", () => {
    const base = { name: "Pat", email: "pat@example.test", brokerage: "Pat Capital", team_size: "2-5" };
    expect(leadSchema.safeParse(base).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, consent: false }).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, consent: true, team_size: "lots" }).success).toBe(false);
    expect(leadSchema.safeParse({ ...base, consent: true }).success).toBe(true);
  });

  it("follow-ups are due the next business day", () => {
    expect(followUpDue(new Date("2026-10-30T15:00:00Z")).toISOString()).toBe("2026-11-02T17:00:00.000Z"); // Friday -> Monday
    expect(followUpDue(new Date("2026-10-27T15:00:00Z")).toISOString()).toBe("2026-10-28T17:00:00.000Z");
  });
});

describe("the starter library", () => {
  const slugs = new Set(STARTER_ARTICLES.map((a) => a.slug));

  it("has 40 to 62 unique articles covering every area", () => {
    expect(STARTER_ARTICLES.length).toBeGreaterThanOrEqual(40);
    expect(STARTER_ARTICLES.length).toBeLessThanOrEqual(62);
    expect(slugs.size).toBe(STARTER_ARTICLES.length);
    const cats = new Set(STARTER_ARTICLES.map((a) => a.category));
    for (const c of ["Getting started", "Users and teams", "Branding", "Client app and applications", "Pipeline", "Documents and OCR",
      "Fraud protection", "Lenders", "CRM", "Email and calendar", "Phone", "Marketing", "Reports", "Plans and billing",
      "Security and privacy", "Integrations and API", "Importing and exporting", "Getting support"]) {
      expect(cats.has(c), c).toBe(true);
    }
  });

  it("never names internal costs, margins or the private line, and every article link resolves", () => {
    for (const a of STARTER_ARTICLES) {
      const text = `${a.title}\n${a.summary}\n${a.body}`;
      expect(guardReply(text).replaced, a.slug).toBe(false);
      expect(text, a.slug).not.toMatch(/587[\s.\-)]*888/);
      expect(text, a.slug).not.toMatch(/boreal/i);
      for (const m of a.body.matchAll(/kb:([a-z0-9-]+)/g)) expect(slugs.has(m[1]), `${a.slug} -> ${m[1]}`).toBe(true);
    }
  });

  it("states the published usage prices and the e-signing allowance", () => {
    const all = STARTER_ARTICLES.map((a) => a.body).join("\n");
    expect(all).toContain("$0.04");
    expect(all).toContain("$0.03");
    expect(all).toContain("**4 signings a month**");
    expect(all).toContain("$2.50");
  });
});

describe("KB routes without a database", () => {
  it("staff routes need a staff token; the admin page holds no data", async () => {
    const app = createApp(makeDeps({ db: fakeDb() }));
    expect((await request(app).get("/api/ops/kb/articles")).status).toBe(401);
    expect((await request(app).post("/api/ops/kb/articles").send({ title: "x" })).status).toBe(401);
    const page = await request(app).get("/ops/kb");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(KB_PAGE_HTML).toContain("Questions with no good answer");
  });

  it("licensee routes need the licensee's ops key", async () => {
    const app = createApp(makeDeps({ db: fakeDb() }));
    const r = await request(app).post("/api/licensees/22222222-2222-4222-8222-222222222222/kb/search").send({ q: "users" });
    expect(r.status).toBe(401);
  });
});
