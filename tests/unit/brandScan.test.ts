// KS_OPS_v14_BRAND_SCAN - "Use my website": the SSRF guards, the extraction, and the public endpoint. HTTP and DNS are
// mocked (deps.brandScan), except one test that runs the real request function against a local server to prove the
// connection goes to the checked address and never resolves the host name again.
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { analyseCss, firstFamily, googleFamilies, parseColor, scanBrand, type ScanDeps } from "../../src/lib/brandScan.js";
import { checkUrl, isBlockedAddress, nodeGet, safeFetch, SafeFetchError, type RawGet, type RawResponse } from "../../src/lib/safeFetch.js";
import { signupSchema } from "../../src/licensees/validation.js";
import { makeDeps, validSignup } from "../helpers.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

type Site = Record<string, Omit<Partial<RawResponse>, "body"> & { body?: Buffer | string }>;

/** A fake internet: DNS answers from `dns`, pages from `site` (keyed by full URL). Records every request. */
function fakeNet(site: Site, dns: Record<string, string[]> = {}) {
  const requests: Array<{ url: string; address: string }> = [];
  const resolve = vi.fn(async (host: string) => {
    if (!(host in dns) && !/\.example$/.test(host)) throw new Error("ENOTFOUND");
    return dns[host] ?? ["93.184.216.34"];
  });
  const get: RawGet = vi.fn(async (url, address) => {
    requests.push({ url: url.toString(), address });
    const page = site[url.toString()];
    if (!page) return { status: 404, headers: {}, body: Buffer.from("") };
    const body = Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body ?? "");
    return { status: page.status ?? 200, headers: page.headers ?? {}, body };
  });
  return { deps: { resolve, get } as ScanDeps, requests, resolve, get };
}

describe("SSRF guards", () => {
  it("blocks private, loopback, link-local and other non-public addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::5", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "not-an-ip",
    ]) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("accepts only public http(s) addresses on the standard ports", () => {
    for (const bad of [
      "ftp://acme.example/", "file:///etc/passwd", "gopher://acme.example/", "javascript:alert(1)",
      "http://user:pw@acme.example/", "http://acme.example:8080/", "https://acme.example:22/",
      "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
      "http://intranet/", "http://printer.local/", "http://0x7f.0.0.1/", "http://2130706433/",
    ]) expect(() => checkUrl(bad), bad).toThrow(SafeFetchError);
    expect(checkUrl("https://www.acme.example/").hostname).toBe("www.acme.example");
    expect(checkUrl("http://acme.example:80/").hostname).toBe("acme.example");
  });

  it("refuses a host whose DNS answer includes a private address, without connecting", async () => {
    const net = fakeNet({}, { "sneaky.example": ["93.184.216.34", "10.0.0.5"], "inside.example": ["127.0.0.1"] });
    await expect(safeFetch("https://sneaky.example/", { ...net.deps, maxBytes: 1000 })).rejects.toMatchObject({ code: "blocked" });
    await expect(safeFetch("https://inside.example/", { ...net.deps, maxBytes: 1000 })).rejects.toMatchObject({ code: "blocked" });
    expect(net.get).not.toHaveBeenCalled();
  });

  it("connects to the address it checked", async () => {
    const net = fakeNet({ "https://acme.example/": { body: "<html></html>" } }, { "acme.example": ["93.184.216.34"] });
    await safeFetch("https://acme.example/", { ...net.deps, maxBytes: 1000 });
    expect(net.requests).toEqual([{ url: "https://acme.example/", address: "93.184.216.34" }]);
  });

  it("checks every redirect again: a redirect to metadata, loopback or a private host is refused", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/admin", "http://private.example/", "file:///etc/passwd", "http://acme.example:6379/"]) {
      const net = fakeNet(
        { "https://acme.example/": { status: 302, headers: { location } } },
        { "acme.example": ["93.184.216.34"], "private.example": ["192.168.0.10"] },
      );
      await expect(safeFetch("https://acme.example/", { ...net.deps, maxBytes: 1000 }), location).rejects.toBeInstanceOf(SafeFetchError);
      expect(net.requests).toHaveLength(1);
    }
  });

  it("follows a few public redirects, then stops", async () => {
    const ok = fakeNet({
      "http://acme.example/": { status: 301, headers: { location: "https://acme.example/" } },
      "https://acme.example/": { status: 302, headers: { location: "/home" } },
      "https://acme.example/home": { body: "<p>hi</p>", headers: { "content-type": "text/html" } },
    });
    const r = await safeFetch("http://acme.example/", { ...ok.deps, maxBytes: 1000 });
    expect(r.url).toBe("https://acme.example/home");
    const loop = fakeNet({ "https://loop.example/": { status: 302, headers: { location: "https://loop.example/" } } });
    await expect(safeFetch("https://loop.example/", { ...loop.deps, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(loop.requests).toHaveLength(4);
  });

  it("refuses bodies over the size limit", async () => {
    const net = fakeNet({ "https://big.example/": { body: Buffer.alloc(5000, 97) } });
    await expect(safeFetch("https://big.example/", { ...net.deps, maxBytes: 1000 })).rejects.toMatchObject({ code: "too_large" });
  });

  it("the real request connects to the given address (no second DNS lookup), and stops at the size limit", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.write(Buffer.alloc(4000, 98));
        res.end(Buffer.alloc(4000, 98));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<p>host=${req.headers.host}</p>`);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    try {
      // "never-resolves.invalid" cannot be resolved: the only way this works is the pinned address.
      const r = await nodeGet(new URL(`http://never-resolves.invalid:${port}/`), "127.0.0.1", { maxBytes: 1000, timeoutMs: 3000, accept: "text/html" });
      expect(r.status).toBe(200);
      expect(r.body.toString()).toContain(`host=never-resolves.invalid:${port}`);
      await expect(
        nodeGet(new URL(`http://never-resolves.invalid:${port}/big`), "127.0.0.1", { maxBytes: 1000, timeoutMs: 3000, accept: "*/*" }),
      ).rejects.toMatchObject({ code: "too_large" });
    } finally {
      server.close();
    }
  });
});

describe("reading the brand", () => {
  it("parses CSS colours and font lists", () => {
    expect(parseColor("#0e6655")).toBe("#0E6655");
    expect(parseColor("#abc")).toBe("#AABBCC");
    expect(parseColor("rgb(14, 102, 85)")).toBe("#0E6655");
    expect(parseColor("rgb(14 102 85 / 0.2)")).toBeNull();
    expect(parseColor("hsl(0, 100%, 50%)")).toBe("#FF0000");
    expect(parseColor("transparent")).toBeNull();
    expect(firstFamily(`"Lato", Helvetica, Arial, sans-serif`, {})).toBe("Lato");
    expect(firstFamily(`var(--font), sans-serif`, { "--font": "'Source Sans 3'" })).toBe("Source Sans 3");
    expect(firstFamily(`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`, {})).toBeNull();
    expect(googleFamilies("https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&family=Merriweather&display=swap")).toEqual(["Open Sans", "Merriweather"]);
    expect(googleFamilies("https://fonts.googleapis.com/css?family=Lato|Roboto+Slab:400")).toEqual(["Lato", "Roboto Slab"]);
    const a = analyseCss(`:root{--brand:#7a1f3d}body{font-family:Lato,sans-serif;background:#fffaf0}h1,h2{font-family:"Playfair Display",serif}.x{color:#7a1f3d}.y{color:#7a1f3d}.z{color:#d4a017}@font-face{font-family:"Acme Sans";src:url(a.woff2)}`);
    expect(a.vars["--brand"]).toBe("#7a1f3d");
    expect(a.faces).toEqual(["Acme Sans"]);
    expect(firstFamily(a.headingFont, a.vars)).toBe("Playfair Display");
  });

  const HOME = `<!doctype html><html><head><title>Prairie Capital | Business loans</title>
    <meta name="theme-color" content="#7A1F3D">
    <link rel="icon" href="/favicon-32.png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta property="og:image" content="https://cdn.other.example/social.jpg">
    <link rel="stylesheet" href="/css/site.css">
    <link rel="stylesheet" href="https://cdn.prairie.example/theme.css">
    <link rel="stylesheet" href="https://tracker.other.example/x.css">
    <link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap" rel="stylesheet">
    <style>.cta{background:#D4A017}</style></head>
    <body><header><a class="site-logo" href="/"><img src="/img/prairie-logo.png" alt="Prairie Capital"></a></header><main>hi</main></body></html>`;

  function prairie() {
    return fakeNet({
      "https://prairie.example/": { body: HOME, headers: { "content-type": "text/html; charset=utf-8" } },
      "https://prairie.example/css/site.css": { body: `:root{--color-primary:#7a1f3d;--color-accent:#d4a017;--bg:#fffaf0}body{font-family:Lato,Arial,sans-serif;background-color:var(--bg)}h1{font-family:Lato}.btn{background:#7a1f3d}`, headers: { "content-type": "text/css" } },
      "https://cdn.prairie.example/theme.css": { body: `.a{color:#7a1f3d}`, headers: { "content-type": "text/css" } },
      "https://prairie.example/img/prairie-logo.png": { body: PNG, headers: { "content-type": "image/png" } },
    });
  }

  it("suggests the logo, favicon, colours and font from the home page and its own style sheets", async () => {
    const net = prairie();
    const s = await scanBrand("prairie.example", net.deps);
    expect(s.url).toBe("https://prairie.example/");
    expect(s.site_name).toBe("Prairie Capital | Business loans");
    expect(s.suggestions).toEqual({
      primary_color: "#7A1F3D",
      accent_color: "#D4A017",
      background_color: "#FFFAF0",
      font: { family: "Lato", source: "google" },
    });
    expect(s.favicon_url).toBe("https://prairie.example/favicon-32.png");
    expect(s.logo).toMatchObject({ source_url: "https://prairie.example/img/prairie-logo.png", content_type: "image/png", filename: "prairie-logo.png" });
    expect(Buffer.from(s.logo!.data_base64, "base64").equals(PNG)).toBe(true);
    expect(s.logo_candidates[0]).toBe("https://prairie.example/img/prairie-logo.png");
    // Same-site style sheets only, at most three; nothing from other sites (the tracker, the social image).
    const fetched = net.requests.map((r) => r.url);
    expect(fetched).not.toContain("https://tracker.other.example/x.css");
    expect(fetched).not.toContain("https://cdn.other.example/social.jpg");
    expect(fetched.filter((u) => u.endsWith(".css"))).toHaveLength(3);
    expect(fetched).not.toContain("https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap");
  });

  it("uses an inline SVG logo, and skips SVGs with scripts", async () => {
    const svg = `<a class="logo" href="/"><svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg></a>`;
    const net = fakeNet({ "https://svg.example/": { body: `<html><body>${svg}</body></html>`, headers: { "content-type": "text/html" } } });
    const s = await scanBrand("https://svg.example/", net.deps);
    expect(s.logo).toMatchObject({ content_type: "image/svg+xml", source_url: null });
    expect(Buffer.from(s.logo!.data_base64, "base64").toString()).toContain('xmlns="http://www.w3.org/2000/svg"');
    const evil = fakeNet({ "https://evil.example/": { body: `<a class="logo"><svg onload="alert(1)"><rect/></svg></a>`, headers: { "content-type": "text/html" } } });
    expect((await scanBrand("https://evil.example/", evil.deps)).logo).toBeNull();
  });

  it("explains what went wrong", async () => {
    const net = fakeNet(
      { "https://pdf.example/": { body: "%PDF", headers: { "content-type": "application/pdf" } }, "https://gone.example/": { status: 500, body: "x" } },
      { "local.example": ["192.168.1.20"] },
    );
    await expect(scanBrand("https://local.example/", net.deps)).rejects.toMatchObject({ code: "blocked", status: 400 });
    await expect(scanBrand("https://pdf.example/", net.deps)).rejects.toMatchObject({ code: "not_html", status: 422 });
    await expect(scanBrand("https://gone.example/", net.deps)).rejects.toMatchObject({ code: "fetch_failed", status: 502 });
    await expect(scanBrand("", net.deps)).rejects.toMatchObject({ code: "bad_url", status: 400 });
    await expect(scanBrand("http://localhost:3000/", net.deps)).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /api/public/brand-scan", () => {
  it("returns the suggestions", async () => {
    const net = prairieNet();
    const res = await request(createApp(makeDeps({ brandScan: net.deps }))).post("/api/public/brand-scan").send({ url: "https://prairie.example" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ ok: true, suggestions: { primary_color: "#7A1F3D" } });
  });

  it("refuses private addresses with a plain message", async () => {
    const net = fakeNet({});
    const res = await request(createApp(makeDeps({ brandScan: net.deps }))).post("/api/public/brand-scan").send({ url: "http://169.254.169.254/" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "blocked", message: "We can only read public websites." });
    expect(net.get).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    const net = fakeNet({});
    const app = createApp(makeDeps({ brandScan: net.deps }));
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(app).post("/api/public/brand-scan").send({ url: "https://nowhere.invalid/" })).status;
    expect(last).toBe(429);
  });
});

function prairieNet() {
  return fakeNet({
    "https://prairie.example/": { body: `<html><head><meta name="theme-color" content="#7a1f3d"></head><body></body></html>`, headers: { "content-type": "text/html" } },
  });
}

describe("font on sign-up (KS_OPS_v14_BRAND_FONT)", () => {
  it("accepts a font family name and refuses anything else", () => {
    const ok = signupSchema.safeParse({ ...validSignup(), font_family: "  Source  Sans 3 " });
    expect(ok.success && ok.data.font_family).toBe("Source Sans 3");
    for (const bad of ["Lato; } body { display:none", "url(https://x)", "x".repeat(61), "<script>"]) {
      expect(signupSchema.safeParse({ ...validSignup(), font_family: bad }).success, bad).toBe(false);
    }
    const none = signupSchema.safeParse({ ...validSignup(), font_family: "" });
    expect(none.success && none.data.font_family).toBeUndefined();
  });
});
