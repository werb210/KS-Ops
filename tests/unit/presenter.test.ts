// KS_OPS_v13_PRESENTER - the staff presenter link: only staff can get one, the demo portal can check it, and it is
// refused when tampered with, expired, of another type, or once the person is off the allowlist.
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { signStaffToken } from "../../src/auth/staff.js";
import { PRESENTER_TTL_SECONDS, signPresenterToken, verifyPresenterToken } from "../../src/routes/presenter.js";
import { makeDeps } from "../helpers.js";

const PORTAL = "https://demo-portal.example.test";
const staff = { id: "33333333-3333-4333-8333-333333333333", email: "ada@boreal.example", name: "Ada Admin", role: "Admin" as const };

afterEach(() => {
  delete process.env.KS_DEMO_PORTAL_URL;
  delete process.env.OPS_ADMIN_EMAILS;
});

describe("presenter link", () => {
  it("needs a staff token", async () => {
    process.env.KS_DEMO_PORTAL_URL = PORTAL;
    const res = await request(createApp(makeDeps())).post("/api/ops/demo/presenter-link");
    expect(res.status).toBe(401);
  });

  it("gives staff a link to /demo/present with the token in the fragment, which the portal can verify", async () => {
    process.env.KS_DEMO_PORTAL_URL = PORTAL;
    const app = createApp(makeDeps());
    const res = await request(app).post("/api/ops/demo/presenter-link").set("Authorization", `Bearer ${signStaffToken(staff)}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.url).toBe(`${PORTAL}/demo/present#p=${encodeURIComponent(res.body.token)}`);
    const left = new Date(res.body.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan((PRESENTER_TTL_SECONDS - 60) * 1000);

    const ok = await request(app).post("/api/public/demo/presenter/verify").set("Origin", PORTAL).send({ token: res.body.token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, presenter: { name: "Ada Admin" } });
    expect(ok.headers["access-control-allow-origin"]).toBe(PORTAL);
    // No email or id goes back to the page.
    expect(JSON.stringify(ok.body)).not.toContain("ada@boreal.example");
  });

  it("works with the break-glass token too", async () => {
    process.env.KS_DEMO_PORTAL_URL = PORTAL;
    const app = createApp(makeDeps());
    const res = await request(app).post("/api/ops/demo/presenter-link").set("Authorization", `Bearer ${process.env.OPS_ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(verifyPresenterToken(res.body.token)).toMatchObject({ id: "break-glass" });
  });

  it("503 without the demo portal address", async () => {
    const res = await request(createApp(makeDeps())).post("/api/ops/demo/presenter-link").set("Authorization", `Bearer ${signStaffToken(staff)}`);
    expect(res.status).toBe(503);
  });

  it("refuses a staff token, a tampered or expired token, and someone taken off the allowlist", async () => {
    const app = createApp(makeDeps());
    const verify = (token: unknown) => request(app).post("/api/public/demo/presenter/verify").send({ token });
    expect((await verify(signStaffToken(staff))).status).toBe(401);
    const good = signPresenterToken(staff);
    expect((await verify(`${good.slice(0, -3)}abc`)).status).toBe(401);
    expect((await verify(signPresenterToken(staff, -10))).status).toBe(401);
    expect((await verify(jwt.sign({ typ: "ks-demo-presenter" }, "another-secret-that-is-long-enough-0123456789", { subject: "x", audience: "ks-demo-portal", issuer: "ks-ops" }))).status).toBe(401);
    expect((await verify(undefined)).status).toBe(401);
    expect((await verify(good)).status).toBe(200);
    process.env.OPS_ADMIN_EMAILS = "someone-else@boreal.example";
    expect((await verify(good)).status).toBe(401);
  });
});
