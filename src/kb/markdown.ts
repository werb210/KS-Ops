// KS_OPS_KB_v1 - the small, safe Markdown the knowledge base uses, rendered to HTML here so the website and the portals
// show articles the same way. Every character of the source is escaped first; only these constructs become tags:
//   # / ## / ###      headings (h2, h3, h4: the page's own title is the h1)
//   - item / 1. item  lists          > text   a note (blockquote)
//   **bold**  *italic*  `code`   (no _underscore_ italics: they break words like api_key)
//   [text](https://... | /path | mailto:... | kb:article-slug)   links (anything else stays plain text)
//   ![alt](https://... | /api/public/kb/images/<id>)             images (anything else is dropped)
// A kb:<slug> link points at another article: it is rendered with data-kb-slug, and each reader turns it into its own
// address (the website's /help/<slug>, the portal's article view).

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

const IMAGE_PATH_RE = /^\/api\/public\/kb\/images\/[0-9a-f-]{36}$/i;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type RenderOptions = {
  /** Base for /api/public/kb/images/... (KS-Ops's public address); relative paths stay relative without it. */
  imageBase?: string;
};

function safeHref(raw: string): { href: string; kbSlug?: string } | null {
  const url = raw.trim();
  if (url.startsWith("kb:")) {
    const slug = url.slice(3);
    return SLUG_RE.test(slug) ? { href: `#kb-${slug}`, kbSlug: slug } : null;
  }
  if (/^https?:\/\/[^\s"'<>]+$/i.test(url)) return { href: url };
  if (/^mailto:[^\s"'<>]+$/i.test(url)) return { href: url };
  if (/^\/(?!\/)[^\s"'<>]*$/.test(url)) return { href: url };
  return null;
}

function safeImage(raw: string, opts: RenderOptions): string | null {
  const url = raw.trim();
  if (IMAGE_PATH_RE.test(url)) return `${(opts.imageBase ?? "").replace(/\/+$/, "")}${url}`;
  if (/^https:\/\/[^\s"'<>]+$/i.test(url)) return url;
  return null;
}

/** Inline markup on one already-split line of raw text. Escapes everything it does not turn into a tag. */
export function renderInline(text: string, opts: RenderOptions = {}): string {
  let out = "";
  let i = 0;
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += escapeHtml(text.slice(i, at));
    if (m[2] !== undefined) {
      const src = safeImage(m[2], opts);
      out += src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(m[1] ?? "")}" loading="lazy">` : escapeHtml(m[1] ?? "");
    } else if (m[4] !== undefined) {
      const link = safeHref(m[4]);
      const label = renderInline(m[3] ?? "", opts);
      if (!link) out += label;
      else if (link.kbSlug) out += `<a href="${escapeHtml(link.href)}" data-kb-slug="${link.kbSlug}">${label}</a>`;
      else if (/^https?:/i.test(link.href)) out += `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      else out += `<a href="${escapeHtml(link.href)}">${label}</a>`;
    } else if (m[5] !== undefined) out += `<strong>${renderInline(m[5], opts)}</strong>`;
    else if (m[6] !== undefined) out += `<code>${escapeHtml(m[6])}</code>`;
    else if (m[7] !== undefined) out += `<em>${renderInline(m[7], opts)}</em>`;
    i = at + m[0].length;
  }
  return out + escapeHtml(text.slice(i));
}

type Block =
  | { kind: "p" | "quote"; lines: string[] }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "table"; rows: string[][] };

const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function toBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const line = raw.trimEnd();
    const tail = blocks[blocks.length - 1];
    if (!line.trim()) {
      blocks.push({ kind: "p", lines: [] }); // a paragraph break
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);
    const q = /^\s*>\s?(.*)$/.exec(line);
    const row = /^\s*\|.*\|\s*$/.test(line);
    if (row) {
      const cells = tableCells(line);
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the |---| separator
      if (tail?.kind === "table") tail.rows.push(cells);
      else blocks.push({ kind: "table", rows: [cells] });
    } else if (h) blocks.push({ kind: "h", level: h[1].length, text: h[2].trim() });
    else if (ul) {
      if (tail?.kind === "ul") tail.items.push(ul[1]);
      else blocks.push({ kind: "ul", items: [ul[1]] });
    } else if (ol) {
      if (tail?.kind === "ol") tail.items.push(ol[1]);
      else blocks.push({ kind: "ol", items: [ol[1]] });
    } else if (q) {
      if (tail?.kind === "quote") tail.lines.push(q[1]);
      else blocks.push({ kind: "quote", lines: [q[1]] });
    } else if (tail && (tail.kind === "p" || tail.kind === "quote") && tail.lines.length) tail.lines.push(line.trim());
    else if (tail && (tail.kind === "ul" || tail.kind === "ol") && /^\s{2,}\S/.test(raw)) {
      tail.items[tail.items.length - 1] += ` ${line.trim()}`;
    } else blocks.push({ kind: "p", lines: [line.trim()] });
  }
  return blocks.filter((b) => !((b.kind === "p" || b.kind === "quote") && b.lines.length === 0));
}

/** Markdown to safe HTML. */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  return toBlocks(md)
    .map((b) => {
      if (b.kind === "h") {
        const tag = `h${Math.min(4, b.level + 1)}`;
        return `<${tag}>${renderInline(b.text, opts)}</${tag}>`;
      }
      if ("items" in b) return `<${b.kind}>${b.items.map((it) => `<li>${renderInline(it, opts)}</li>`).join("")}</${b.kind}>`;
      if (b.kind === "table") {
        const [head, ...body] = b.rows;
        const cells = (r: string[], tag: string) => r.map((c) => `<${tag}>${renderInline(c, opts)}</${tag}>`).join("");
        return `<div class="kb-table"><table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody></table></div>`;
      }
      if (!("lines" in b)) return "";
      if (b.kind === "quote") return `<blockquote><p>${renderInline(b.lines.join(" "), opts)}</p></blockquote>`;
      return `<p>${renderInline(b.lines.join(" "), opts)}</p>`;
    })
    .join("\n");
}

/** Plain text (for search snippets, embeddings and the assistant's context): no markup, links as their text. */
export function plainText(md: string): string {
  return String(md ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*_`>#]/g, "")
    .replace(/^\s*[-]\s+/gm, "- ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
