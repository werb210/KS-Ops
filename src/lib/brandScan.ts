// KS_OPS_v14_BRAND_SCAN - "Use my website" on the sign-up branding step. Reads the brokerage's own home page (and at
// most MAX_CSS of its same-site style sheets) and suggests a logo, favicon, brand colours and font. Nothing is saved
// here: the website pre-fills the form, the person can change everything, and a chosen logo goes through the normal
// sign-up logo upload (lib/logo.ts, licensee_logos).
//
// What is fetched: the page (HTML only), up to MAX_CSS same-site style sheets, and up to MAX_LOGO_FETCHES logo images
// (only to hand them back for upload; any host, through the same SSRF checks). Everything goes through safeFetch.
import { checkLogo, MAX_LOGO_BYTES } from "./logo.js";
import { safeFetch, SafeFetchError, type RawGet, type Resolver } from "./safeFetch.js";

export const MAX_HTML_BYTES = 1_500_000;
export const MAX_CSS_BYTES = 400_000;
export const MAX_CSS = 3;
export const MAX_LOGO_FETCHES = 3;
/** The whole scan stops starting new requests after this long. */
export const SCAN_BUDGET_MS = 15_000;

export type ScanDeps = { resolve?: Resolver; get?: RawGet; now?: () => number };

export type ScanLogo = { source_url: string | null; content_type: string; data_base64: string; filename: string };
export type FontSuggestion = { family: string; source: "google" | "self_hosted" | "system" };
export type BrandScan = {
  url: string;
  site_name: string | null;
  logo: ScanLogo | null;
  logo_candidates: string[];
  favicon_url: string | null;
  colors: { theme_color: string | null; variables: Record<string, string>; palette: string[]; body_background: string | null };
  fonts: { body: string | null; headings: string | null; google: string[]; font_faces: string[] };
  suggestions: { primary_color: string | null; accent_color: string | null; background_color: string | null; font: FontSuggestion | null };
};

// ---------------------------------------------------------------- HTML helpers

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/gi, "/");

export function attrs(tagSource: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/<>"']+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  const inner = tagSource.replace(/^<\s*[\w:-]+/, "").replace(/\/?>$/, "");
  while ((m = re.exec(inner))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** Every opening tag `name` with its attributes and its position. */
export function tags(html: string, name: string): Array<{ a: Record<string, string>; at: number; src: string }> {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  const out: Array<{ a: Record<string, string>; at: number; src: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ a: attrs(m[0]), at: m.index, src: m[0] });
  return out;
}

const abs = (href: string | undefined, base: string): string | null => {
  if (!href || /^(data|javascript|mailto|tel):/i.test(href.trim())) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, "");
/** Same site: the same host, or one is a sub-domain of the other (www.acme.ca, cdn.acme.ca, acme.ca). */
export function sameSite(a: string, b: string): boolean {
  try {
    const x = siteOf(new URL(a).hostname), y = siteOf(new URL(b).hostname);
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- colours

/** A CSS colour as #RRGGBB, or null (named colours other than white/black, transparent, var() ...). */
export function parseColor(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s*!important$/, "");
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    if (m[1].length === 4 && m[1][3] === "0") return null;
    return `#${m[1].slice(0, 3).split("").map((c) => c + c).join("")}`.toUpperCase();
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[2] !== undefined && parseInt(m[2], 16) < 128 ? null : `#${m[1]}`.toUpperCase();
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const ch = (s: string) => (s.endsWith("%") ? (parseFloat(s) * 255) / 100 : parseFloat(s));
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (alpha < 0.5) return null;
    return `#${hex(ch(m[1]))}${hex(ch(m[2]))}${hex(ch(m[3]))}`.toUpperCase();
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (alpha < 0.5) return null;
    const h = (parseFloat(m[1]) % 360) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t: number) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return `#${hex(f(h + 1 / 3) * 255)}${hex(f(h) * 255)}${hex(f(h - 1 / 3) * 255)}`.toUpperCase();
  }
  if (v === "white") return "#FFFFFF";
  if (v === "black") return "#000000";
  return null;
}

const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** Greys, near-white and near-black are not brand colours. */
export function isGreyish(c: string): boolean {
  const [r, g, b] = rgb(c);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min < 30 || max < 35 || min > 235;
}
const distance = (a: string, b: string) => {
  const x = rgb(a), y = rgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

// ---------------------------------------------------------------- CSS

type Rule = { selector: string; body: string };
export function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i");
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|inherit|initial|unset|revert|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica neue|helvetica|arial|noto sans|liberation sans|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji)$/i;

/** The first real family in a font-family list ("Lato", 'Open Sans', sans-serif -> Lato), resolving var(--x). */
export function firstFamily(value: string | null, vars: Record<string, string>): string | null {
  if (!value) return null;
  let v = value;
  for (let i = 0; i < 3; i++) {
    const m = /var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/.exec(v);
    if (!m) break;
    v = v.replace(m[0], vars[m[1]] ?? m[2] ?? "");
  }
  for (const part of v.split(",")) {
    const name = part.trim().replace(/^["']|["']$/g, "").replace(/\s*!important$/, "").trim();
    if (name && !GENERIC.test(name) && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(name)) return name;
  }
  return null;
}

/** Families named in a Google Fonts stylesheet address (css and css2). */
export function googleFamilies(href: string): string[] {
  try {
    const u = new URL(href, "https://fonts.googleapis.com/");
    if (u.hostname !== "fonts.googleapis.com") return [];
    return u.searchParams
      .getAll("family")
      .flatMap((f) => f.split("|"))
      .map((f) => f.split(":")[0].replace(/\+/g, " ").trim())
      .filter((f) => /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/.test(f));
  } catch {
    return [];
  }
}

const COLOR_PROPS = /^(color|background|background-color|border-color|border|border-top|border-bottom|fill|stroke|outline-color|text-decoration-color)$/i;

export function analyseCss(css: string) {
  const vars: Record<string, string> = {};
  const counts = new Map<string, number>();
  const faces: string[] = [];
  const google: string[] = [];
  let bodyFont: string | null = null, headingFont: string | null = null, bodyBg: string | null = null;
  for (const m of css.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) google.push(...googleFamilies(m[1]));
  for (const r of rules(css)) {
    for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
    if (/^@font-face$/i.test(r.selector) || /@font-face\s*$/i.test(r.selector)) {
      const fam = firstFamily(decl(r.body, "font-family"), vars);
      if (fam && !faces.includes(fam)) faces.push(fam);
      continue;
    }
    for (const d of r.body.split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      if (!COLOR_PROPS.test(prop)) continue;
      for (const tok of d.slice(i + 1).match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? []) {
        const c = parseColor(tok);
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const sels = r.selector.toLowerCase().split(",").map((s) => s.trim());
    if (sels.some((s) => s === "body" || s === "html" || s === ":root")) {
      bodyFont ??= decl(r.body, "font-family");
      const bg = decl(r.body, "background-color") ?? decl(r.body, "background");
      if (bg && !bodyBg) bodyBg = bg;
    }
    if (sels.some((s) => /^h[1-3]$/.test(s))) headingFont ??= decl(r.body, "font-family");
  }
  return { vars, counts, faces, google, bodyFont, headingFont, bodyBg };
}

/** The colour a custom property ends up as (following var() a few levels), or null. */
function varColor(name: string, vars: Record<string, string>): string | null {
  let v = vars[name];
  for (let i = 0; v && i < 4; i++) {
    const c = parseColor(v);
    if (c) return c;
    const m = /^var\(\s*(--[\w-]+)/.exec(v.trim());
    if (!m) {
      // "--brand-rgb: 14 102 85" style triplets
      const trip = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/.exec(v.trim());
      return trip ? parseColor(`rgb(${trip[1]}, ${trip[2]}, ${trip[3]})`) : null;
    }
    v = vars[m[1]];
  }
  return null;
}

function pickVar(vars: Record<string, string>, re: RegExp, avoid: RegExp = /$^/): string | null {
  for (const name of Object.keys(vars)) {
    if (!re.test(name) || avoid.test(name)) continue;
    const c = varColor(name, vars);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------- logos

/** Logo candidates in order of preference, as absolute addresses or inline SVG markup. */
export function logoCandidates(html: string, base: string): { urls: string[]; inlineSvg: string | null; marked: number } {
  const urls: string[] = [];
  const add = (u: string | null) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  const isLogo = (s: string | undefined) => /logo|brand/i.test(s ?? "");
  // 1. An <img> that says it is the logo (class, id, alt or file name), header ones first.
  const headerEnd = (() => {
    const i = html.search(/<\/header>/i);
    return i < 0 ? html.length * 0.3 : i;
  })();
  const imgs = tags(html, "img").filter((t) => isLogo(t.a.class) || isLogo(t.a.id) || isLogo(t.a.alt) || isLogo(t.a.src) || isLogo(html.slice(Math.max(0, t.at - 200), t.at).match(/<a\b[^>]*>[^<]*$/)?.[0]));
  imgs.sort((x, y) => Number(x.at > headerEnd) - Number(y.at > headerEnd));
  for (const t of imgs) add(abs(t.a.src ?? t.a["data-src"] ?? t.a.srcset?.split(/\s+/)[0], base));
  const marked = urls.length;
  // 2. An inline <svg> logo.
  let inlineSvg: string | null = null;
  for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
    const open = m[0].slice(0, m[0].indexOf(">") + 1);
    const before = html.slice(Math.max(0, (m.index ?? 0) - 300), m.index);
    const a = attrs(open);
    if (isLogo(a.class) || isLogo(a.id) || isLogo(a["aria-label"]) || /<(a|div|span)\b[^>]*(class|id)=["'][^"']*logo[^"']*["'][^>]*>\s*$/i.test(before)) {
      inlineSvg = /xmlns=/.test(open) ? m[0] : m[0].replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      break;
    }
  }
  // 3. apple-touch-icon, 4. og:image, 5. a large PNG/SVG icon.
  for (const t of tags(html, "link")) if (/apple-touch-icon/i.test(t.a.rel ?? "")) add(abs(t.a.href, base));
  for (const t of tags(html, "meta")) if (/^og:(image|logo)$/i.test(t.a.property ?? t.a.name ?? "")) add(abs(t.a.content, base));
  for (const t of tags(html, "link")) if (/\bicon\b/i.test(t.a.rel ?? "") && /\.(png|svg)(\?|$)/i.test(t.a.href ?? "")) add(abs(t.a.href, base));
  return { urls, inlineSvg, marked };
}

export function faviconOf(html: string, base: string): string | null {
  for (const t of tags(html, "link")) if (/(^|\s)(shortcut\s+)?icon(\s|$)/i.test(t.a.rel ?? "")) {
    const u = abs(t.a.href, base);
    if (u) return u;
  }
  return abs("/favicon.ico", base);
}

// ---------------------------------------------------------------- the scan

export class BrandScanError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

const filenameOf = (u: string, type: string) => {
  const ext = type === "image/svg+xml" ? "svg" : type === "image/png" ? "png" : "jpg";
  try {
    const last = new URL(u).pathname.split("/").pop() ?? "";
    const stem = last.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
    return `${stem || "logo"}.${ext}`;
  } catch {
    return `logo.${ext}`;
  }
};

/** Adds https:// to a bare host name ("acme.ca"). */
export function normaliseSiteUrl(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) throw new BrandScanError("bad_url", "Enter your website address.", 400);
  if (s.length > 500) throw new BrandScanError("bad_url", "That address is too long.", 400);
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

export async function scanBrand(rawUrl: unknown, deps: ScanDeps = {}): Promise<BrandScan> {
  const now = deps.now ?? Date.now;
  const started = now();
  const inBudget = () => now() - started < SCAN_BUDGET_MS;
  const io = { resolve: deps.resolve, get: deps.get };
  const start = normaliseSiteUrl(rawUrl);

  let page;
  try {
    page = await safeFetch(start, { ...io, maxBytes: MAX_HTML_BYTES, accept: "text/html,application/xhtml+xml" });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      const status = err.code === "bad_url" || err.code === "blocked" ? 400 : err.code === "timeout" ? 504 : 502;
      throw new BrandScanError(err.code, err.message, status);
    }
    throw err;
  }
  if (page.status >= 400) throw new BrandScanError("fetch_failed", `That website answered with an error (${page.status}).`, 502);
  if (page.contentType && !/text\/html|application\/xhtml/.test(page.contentType)) {
    throw new BrandScanError("not_html", "That address isn't a web page. Try your home page.", 422);
  }
  const html = page.body.toString("utf8");
  const base = (() => {
    const b = tags(html, "base")[0]?.a.href;
    return (b && abs(b, page.url)) || page.url;
  })();

  // Styles: inline <style>, style="" attributes, and up to MAX_CSS same-site style sheets.
  let css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  css += "\n" + [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => `x{${decodeEntities(m[1])}}`).join("\n");
  const google: string[] = [];
  const sheets: string[] = [];
  for (const t of tags(html, "link")) {
    const href = abs(t.a.href, base);
    if (!href) continue;
    if (/fonts\.googleapis\.com/i.test(href)) {
      google.push(...googleFamilies(href));
      continue;
    }
    if (/\bstylesheet\b/i.test(t.a.rel ?? "") && sameSite(href, page.url) && !sheets.includes(href)) sheets.push(href);
  }
  for (const href of sheets.slice(0, MAX_CSS)) {
    if (!inBudget()) break;
    try {
      const r = await safeFetch(href, { ...io, maxBytes: MAX_CSS_BYTES, accept: "text/css" });
      if (r.status < 400 && (!r.contentType || /css|text\/plain/.test(r.contentType))) css += "\n" + r.body.toString("utf8");
    } catch {
      /* a style sheet we cannot read is skipped */
    }
  }
  const a = analyseCss(css);
  google.push(...a.google);

  // Colours.
  const themeMeta = tags(html, "meta").find((t) => (t.a.name ?? "").toLowerCase() === "theme-color");
  const themeColor = themeMeta ? parseColor(themeMeta.a.content ?? "") : null;
  const palette = [...a.counts.entries()].filter(([c]) => !isGreyish(c)).sort((x, y) => y[1] - x[1]).map(([c]) => c);
  const brandVars: Record<string, string> = {};
  for (const name of Object.keys(a.vars)) {
    if (!/(primary|brand|accent|secondary|main|theme|background|bg|surface)/i.test(name)) continue;
    const c = varColor(name, a.vars);
    if (c) brandVars[name] = c;
  }
  const primary =
    (themeColor && !isGreyish(themeColor) ? themeColor : null) ??
    pickVar(a.vars, /(primary|brand|main|theme)/i, /(text|foreground|fg|light|lighter|contrast|on-)/i) ??
    palette[0] ??
    null;
  const accentCandidate =
    pickVar(a.vars, /(accent|secondary|highlight)/i, /(text|foreground|fg|contrast|on-)/i) ??
    palette.find((c) => !primary || distance(c, primary) > 60) ??
    null;
  const accent = accentCandidate && primary && distance(accentCandidate, primary) < 20 ? null : accentCandidate;
  const bodyBg = (() => {
    const raw = a.bodyBg ? firstColorIn(a.bodyBg, a.vars) : null;
    return raw ?? pickVar(a.vars, /^--(color-)?(background|bg|body-bg|surface)$/i);
  })();

  // Fonts.
  const body = firstFamily(a.bodyFont, a.vars);
  const headings = firstFamily(a.headingFont, a.vars);
  const uniqGoogle = [...new Set(google)];
  const fontName = body ?? headings ?? uniqGoogle[0] ?? a.faces[0] ?? null;
  const font: FontSuggestion | null = fontName
    ? { family: fontName, source: uniqGoogle.some((g) => g.toLowerCase() === fontName.toLowerCase()) ? "google" : a.faces.includes(fontName) ? "self_hosted" : "system" }
    : null;

  // Logo: the first candidate that passes the sign-up logo checks (PNG, JPG or plain SVG, under 500 KB).
  const cands = logoCandidates(html, base);
  let logo: ScanLogo | null = null;
  const imgCands = cands.urls;
  const tryUrl = async (u: string) => {
    try {
      const r = await safeFetch(u, { ...io, maxBytes: MAX_LOGO_BYTES, accept: "image/png,image/jpeg,image/svg+xml,image/*;q=0.5" });
      if (r.status >= 400) return null;
      const checked = checkLogo({ content_type: r.contentType, data_base64: r.body.toString("base64") });
      return checked.ok ? { source_url: r.url, content_type: checked.logo.contentType, data_base64: r.body.toString("base64"), filename: filenameOf(r.url, checked.logo.contentType) } : null;
    } catch {
      return null;
    }
  };
  // An <img> marked as the logo wins; then an inline SVG logo; then the icons. At most MAX_LOGO_FETCHES fetches.
  let fetches = 0;
  const attempt = async (list: string[]) => {
    for (const u of list) {
      if (logo || fetches >= MAX_LOGO_FETCHES || !inBudget()) return;
      fetches++;
      logo = await tryUrl(u);
    }
  };
  await attempt(imgCands.slice(0, Math.min(cands.marked, 2)));
  if (!logo && cands.inlineSvg) {
    const checked = checkLogo({ content_type: "image/svg+xml", data_base64: Buffer.from(cands.inlineSvg).toString("base64") });
    if (checked.ok) logo = { source_url: null, content_type: "image/svg+xml", data_base64: checked.logo.data.toString("base64"), filename: "logo.svg" };
  }
  await attempt(imgCands.slice(Math.min(cands.marked, 2)));

  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1];
  const ogSite = tags(html, "meta").find((t) => (t.a.property ?? "").toLowerCase() === "og:site_name")?.a.content;
  return {
    url: page.url,
    site_name: (ogSite ?? (title ? decodeEntities(title) : null))?.trim().slice(0, 120) || null,
    logo,
    logo_candidates: imgCands.slice(0, 10),
    favicon_url: faviconOf(html, base),
    colors: { theme_color: themeColor, variables: brandVars, palette: palette.slice(0, 8), body_background: bodyBg },
    fonts: { body, headings, google: uniqGoogle.slice(0, 10), font_faces: a.faces.slice(0, 10) },
    suggestions: { primary_color: primary, accent_color: accent, background_color: bodyBg, font },
  };
}

function firstColorIn(value: string, vars: Record<string, string>): string | null {
  const m = /var\(\s*(--[\w-]+)/.exec(value);
  if (m) return varColor(m[1], vars);
  for (const tok of value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\bwhite\b|\bblack\b/gi) ?? []) {
    const c = parseColor(tok);
    if (c) return c;
  }
  return null;
}
