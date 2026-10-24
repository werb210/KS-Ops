import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { fakeDb, makeDeps } from "../helpers.js";

const row = {
  company_code: "northwind", company_name: "Northwind Capital", server_url: "https://ks-northwind.example",
  client_url: "https://apply.northwind.example", portal_url: "https://staff.northwind.example",
  logo_url: null, primary_color: "#123456", accent_color: "#2563eb", background_color: null,
};

describe("GET /api/directory/:code", () => {
  it("resolves a live licensee and asks only for live statuses", async () => {
    const db = fakeDb([[/FROM licensees WHERE company_code/, (p) => (p[0] === "northwind" ? [row] : [])]]);
    const res = await request(createApp(makeDeps({ db }))).get("/api/directory/NorthWind");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(row);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const call = db.calls.find((c) => /company_code = \$1/.test(c.sql))!;
    expect(call.params[1]).toEqual(["trial", "active", "past_due"]);
  });

  it("answers unknown_company for unknown or malformed codes", async () => {
    const db = fakeDb();
    const app = createApp(makeDeps({ db }));
    const unknown = await request(app).get("/api/directory/nobody");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "unknown_company" });
    const bad = await request(app).get("/api/directory/x");
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual({ error: "unknown_company" });
    expect(db.calls.filter((c) => /company_code/.test(c.sql))).toHaveLength(1);
  });

  it("is rate limited", async () => {
    const app = createApp(makeDeps());
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await request(app).get("/api/directory/nobody")).status;
    expect(last).toBe(429);
  });
});
