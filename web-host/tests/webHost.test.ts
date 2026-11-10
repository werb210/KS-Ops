// KS_SHARED_HOSTING_v1 - the shared web host with the registry and the blob store faked: host -> site, SPA fallback,
// unknown host, cache headers, content types, staticwebapp.config.json headers, and no way out of a site's folder.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildHostMap, cachedRegistry, type Registry } from "../src/registry.js";
import { createHandler, isHashedAsset, safePath, YEAR } from "../src/server.js";
import type { SiteStore } from "../src/store.js";
import { headersFor, parseSwaConfig, routePattern } from "../src/swaConfig.js";

const ROWS = [
  { code: "northwind", status: "active", portal_hosts: ["northwind.portal.keystone.test"], client_hosts: ["northwind.app.keystone.test", "apply.northwindcapital.ca"] },
  { code: "prairie", status: "trial", portal_hosts: ["prairie.portal.keystone.test"], client_hosts: ["prairie.app.keystone.test"] },
  { code: "gone", status: "cancelled", portal_hosts: ["gone.portal.keystone.test"], client_hosts: [] },
];

const SWA = JSON.stringify({
  navigationFallback: { rewrite: "/index.html", exclude: ["/images/*", "*.{css,js}"] },
  globalHeaders: { "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY", "Bad Header": "x" },
  routes: [{ route: "/sw.js", headers: { "Cache-Control": "no-store" } }],
  mimeTypes: { ".wasm2": "application/x-test" },
});

function files(): Record<string, string> {
  return {
    "northwind/portal/index.html": '<!doctype html><div id="root">northwind portal</div>',
    "northwind/portal/assets/index-3f9a1c2b.js": "console.log('portal')",
    "northwind/portal/assets/index-3f9a1c2b.css": "body{}",
    "northwind/portal/favicon.svg": "<svg/>",
    "northwind/portal/sw.js": "self.x=1",
    "northwind/portal/staticwebapp.config.json": SWA,
    "northwind/portal/data.wasm2": "x",
    "northwind/client/index.html": '<!doctype html><div id="root">northwind client</div>',
    "prairie/portal/index.html": '<!doctype html><div id="root">prairie portal</div>',
    "prairie/portal/secret.txt": "prairie only",
    "prairie/client/index.html": '<!doctype html><div id="root">prairie client</div>',
  };
}

function fakeStore(f = files()): SiteStore & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async get(name, opts = {}) {
      gets.push(name);
      if (!(name in f)) return null;
      return { body: opts.head ? null : Readable.from([Buffer.from(f[name])]), contentLength: Buffer.byteLength(f[name]), etag: `"${name.length}"` };
    },
    async text(name) {
      return name in f ? f[name] : null;
    },
  };
}

const registry = (rows = ROWS): Registry => ({ lookup: async (h) => buildHostMap(rows).get(h.toLowerCase().replace(/:\d+$/, "")) ?? null });

function app(store = fakeStore(), reg = registry()) {
  const handler = createHandler({ registry: reg, store });
  return { server: createServer((req, res) => void handler(req, res)), store };
}

const get = (host: string, path: string) => {
  const { server, store } = app();
  return { req: request(server).get(path).set("Host", host), store };
};

describe("host -> site", () => {
  it("serves each brokerage's portal and client app by host name (port and case ignored)", async () => {
    expect((await get("northwind.portal.keystone.test", "/").req).text).toContain("northwind portal");
    expect((await get("Northwind.APP.keystone.test:443", "/").req).text).toContain("northwind client");
    expect((await get("apply.northwindcapital.ca", "/").req).text).toContain("northwind client");
    expect((await get("prairie.portal.keystone.test", "/").req).text).toContain("prairie portal");
    const r = await get("prairie.app.keystone.test", "/").req;
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.text).toContain("prairie client");
  });

  it("an unknown host gets a plain 404 page; a closed brokerage a 410", async () => {
    const r = await get("nobody.portal.keystone.test", "/").req;
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.text).toContain("There is no Keystone site at this address.");
    const none = await get("", "/").req;
    expect(none.status).toBe(404);
    expect((await get("gone.portal.keystone.test", "/").req).status).toBe(410);
  });

  it("answers health checks without a brokerage, and only GET and HEAD", async () => {
    expect((await get("anything", "/healthz").req).body).toEqual({ status: "ok" });
    const { server } = app();
    expect((await request(server).post("/").set("Host", "northwind.portal.keystone.test")).status).toBe(405);
    const head = await request(server).head("/assets/index-3f9a1c2b.js").set("Host", "northwind.portal.keystone.test");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength("console.log('portal')")));
  });
});

describe("SPA fallback", () => {
  it("app routes get index.html; a missing file with an extension is a 404", async () => {
    const deep = await get("northwind.portal.keystone.test", "/clients/42/documents?tab=2").req;
    expect(deep.status).toBe(200);
    expect(deep.text).toContain("northwind portal");
    expect(deep.headers["cache-control"]).toBe("no-cache");
    expect((await get("northwind.portal.keystone.test", "/assets/missing-12345678.js").req).status).toBe(404);
    expect((await get("northwind.portal.keystone.test", "/robots.txt").req).status).toBe(404);
  });

  it("honours navigationFallback.exclude from staticwebapp.config.json", async () => {
    expect((await get("northwind.portal.keystone.test", "/images/logo").req).status).toBe(404);
    expect((await get("northwind.portal.keystone.test", "/settings").req).status).toBe(200);
  });
});

describe("cache headers and content types", () => {
  it("hashed assets for a year, index.html and other files no-cache", async () => {
    const js = await get("northwind.portal.keystone.test", "/assets/index-3f9a1c2b.js").req;
    expect(js.headers["cache-control"]).toBe(YEAR);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const css = await get("northwind.portal.keystone.test", "/assets/index-3f9a1c2b.css").req;
    expect(css.headers["cache-control"]).toBe(YEAR);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    const index = await get("northwind.portal.keystone.test", "/index.html").req;
    expect(index.headers["cache-control"]).toBe("no-cache");
    const svg = await get("northwind.portal.keystone.test", "/favicon.svg").req;
    expect(svg.headers["cache-control"]).toBe("no-cache");
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    expect(isHashedAsset("/assets/vendor.B7x_k2Qa.js")).toBe(true);
    expect(isHashedAsset("/sw.js")).toBe(false);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const { server } = app();
    const first = await request(server).get("/favicon.svg").set("Host", "northwind.portal.keystone.test");
    const again = await request(server).get("/favicon.svg").set("Host", "northwind.portal.keystone.test").set("If-None-Match", String(first.headers.etag));
    expect(again.status).toBe(304);
  });
});

describe("staticwebapp.config.json headers", () => {
  it("adds globalHeaders and matching route headers, and its own mimeTypes; never serves the file itself", async () => {
    const r = await get("northwind.portal.keystone.test", "/").req;
    expect(r.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["bad header"]).toBeUndefined();
    expect((await get("northwind.portal.keystone.test", "/sw.js").req).headers["cache-control"]).toBe("no-store");
    expect((await get("northwind.portal.keystone.test", "/data.wasm2").req).headers["content-type"]).toBe("application/x-test");
    expect((await get("northwind.portal.keystone.test", "/staticwebapp.config.json").req).status).toBe(404);
    // A site without the file has no extra headers.
    expect((await get("prairie.portal.keystone.test", "/").req).headers["content-security-policy"]).toBeUndefined();
  });

  it("route patterns work like Static Web Apps' wildcards; a broken file is ignored", () => {
    expect(routePattern("/assets/*").test("/assets/a/b.js")).toBe(true);
    expect(routePattern("/assets/*").test("/other/a.js")).toBe(false);
    expect(routePattern("*.{png,svg}").test("/img/x.svg")).toBe(true);
    expect(routePattern("*.{png,svg}").test("/img/x.svgz")).toBe(false);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(headersFor(parseSwaConfig("{not json"), "/")).toEqual({});
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("no path traversal", () => {
  it("refuses .., encoded .., backslashes and NUL, and never asks the store outside the site's folder", async () => {
    for (const path of ["/../prairie/portal/secret.txt", "/%2e%2e/prairie/portal/secret.txt", "/assets/%2E%2E/%2E%2E/prairie/portal/secret.txt", "/..%2fprairie%2fportal%2fsecret.txt", "/%5c..%5cprairie", "/a%00b", "/./index.html", "/%E0%A4%A"]) {
      const { server, store } = app();
      const r = await request(server).get(path).set("Host", "northwind.portal.keystone.test");
      expect([400, 404]).toContain(r.status);
      expect(r.text).not.toContain("prairie only");
      expect(store.gets.every((g) => g.startsWith("northwind/portal/"))).toBe(true);
    }
    expect(safePath("/a/b/../c")).toEqual({ ok: false });
    expect(safePath("//a//b/")).toEqual({ ok: true, rel: "a/b/" });
    expect(safePath("/")).toEqual({ ok: true, rel: "" });
  });

  it("another brokerage's files are not reachable from this host", async () => {
    const r = await get("northwind.portal.keystone.test", "/secret.txt").req;
    expect(r.status).toBe(404);
  });
});

describe("registry cache", () => {
  it("reads the hosts once a minute, and keeps the last good list when the database fails", async () => {
    let t = 0;
    const rows = [...ROWS];
    const q = { query: vi.fn(async () => ({ rows })) };
    const reg = cachedRegistry(q, { now: () => t });
    expect(await reg.lookup("northwind.portal.keystone.test")).toEqual({ code: "northwind", app: "portal", status: "active" });
    expect(await reg.lookup("prairie.app.keystone.test")).toEqual({ code: "prairie", app: "client", status: "trial" });
    expect(q.query).toHaveBeenCalledTimes(1);
    expect(q.query.mock.calls[0]).toEqual(["SELECT code, status, portal_hosts, client_hosts, api_hosts FROM ks_tenants", []]);
    t = 61_000;
    q.query.mockRejectedValueOnce(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reg.lookup("northwind.portal.keystone.test")).toMatchObject({ code: "northwind" });
    expect(err).toHaveBeenCalledWith("[web-host] registry not read", "connection reset");
    err.mockRestore();
  });

  it("a request while the registry cannot be read at all gets a 503, logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = cachedRegistry({ query: async () => { throw new Error("down"); } });
    const { server } = app(fakeStore(), reg);
    expect((await request(server).get("/").set("Host", "northwind.portal.keystone.test")).status).toBe(503);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// KS_SHARED_APP_BUILD_v1
describe("shared app build", () => {
  const rows = [{ code: "acme", status: "active", portal_hosts: ["acme.portal.keystone.test"], client_hosts: ["acme.app.keystone.test"], api_hosts: ["acme.api.keystone.test"] }];
  const shared = () => fakeStore({ "_shared/portal/index.html": "shared portal", "_shared/client/index.html": "shared client", "_shared/portal/assets/app-abcdef12.js": "js" });
  const mk = (store = shared()) => {
    const handler = createHandler({ registry: { lookup: async (h) => buildHostMap(rows).get(h) ?? null }, store });
    return createServer((req, res) => void handler(req, res));
  };
  it("serves the shared build to a brokerage without its own build", async () => {
    expect((await request(mk()).get("/").set("Host", "acme.portal.keystone.test")).text).toBe("shared portal");
    expect((await request(mk()).get("/settings/team").set("Host", "acme.app.keystone.test")).text).toBe("shared client");
    expect((await request(mk()).get("/assets/app-abcdef12.js").set("Host", "acme.portal.keystone.test")).text).toBe("js");
  });
  it("prefers the brokerage's own build when it has one", async () => {
    const store = fakeStore({ "_shared/portal/index.html": "shared portal", "acme/portal/index.html": "own portal" });
    expect((await request(mk(store)).get("/").set("Host", "acme.portal.keystone.test")).text).toBe("own portal");
  });
  it("tells the app its brokerage and addresses at /ks-config.js", async () => {
    const r = await request(mk()).get("/ks-config.js").set("Host", "acme.portal.keystone.test");
    expect(r.headers["content-type"]).toContain("javascript");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).toBe('window.__KS_CONFIG__={"code":"acme","app":"portal","server_url":"https://acme.api.keystone.test","portal_url":"https://acme.portal.keystone.test","client_url":"https://acme.app.keystone.test"};');
  });
});
