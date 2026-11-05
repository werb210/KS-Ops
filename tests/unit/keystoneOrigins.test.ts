// KS_OPS_KEYSTONE_DOMAIN - the Keystone website on keystonecrm.online can call the website routes (plans, Maya, sign-up)
// without anyone editing PUBLIC_SITE_URL; other sites still can't.
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { makeDeps } from "../helpers.js";

afterEach(() => vi.unstubAllEnvs());

describe("CORS for Keystone's own website", () => {
  it("allows www and the bare domain, plus whatever PUBLIC_SITE_URL lists, and nothing else", async () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://nice-field-065dae410.1.azurestaticapps.net");
    const app = createApp(makeDeps());
    for (const origin of ["https://www.keystonecrm.online", "https://keystonecrm.online", "https://nice-field-065dae410.1.azurestaticapps.net"]) {
      const r = await request(app).options("/api/public/plans").set("Origin", origin).set("Access-Control-Request-Method", "GET");
      expect(r.headers["access-control-allow-origin"]).toBe(origin);
    }
    const bad = await request(app).options("/api/public/plans").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "GET");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
