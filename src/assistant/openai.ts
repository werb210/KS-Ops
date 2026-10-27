// KS_OPS_KB_v1 - Keystone's own OpenAI calls for the knowledge base and the two Keystone Maya assistants (support in
// the licensee portal, sales on the website). Keystone pays for these: they never touch a licensee's AI allowance.
//   OPENAI_API_KEY          the key (the same secret KS-Ops already hands to new licensee copies); unset = no AI:
//                           search falls back to full text and the assistants answer with the best articles only
//   OPENAI_MODEL            chat model, default gpt-4o-mini (the same default as KS-Agent)
//   OPENAI_EMBEDDING_MODEL  default text-embedding-3-small
// Plain fetch through deps.fetch (as KS-Agent does), so tests replace the network.
import { env } from "../config.js";

export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const CHAT_TIMEOUT_MS = 15_000;
export const EMBED_TIMEOUT_MS = 8_000;

export const openaiKey = () => env("OPENAI_API_KEY");
export const aiConfigured = () => openaiKey() !== "";
export const chatModel = () => env("OPENAI_MODEL") || DEFAULT_CHAT_MODEL;
export const embeddingModel = () => env("OPENAI_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function post(fetchImpl: typeof fetch, path: string, body: unknown, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://api.openai.com/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = (await r.text()).slice(0, 200);
      } catch {
        /* no body */
      }
      throw new Error(`openai_${path.replace(/\W+/g, "_")}_status_${r.status}${detail ? `: ${detail}` : ""}`);
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** One chat completion that must answer a JSON object. Throws on any failure (callers fall back). */
export async function chatJson(fetchImpl: typeof fetch, messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<Record<string, unknown>> {
  if (!aiConfigured()) throw new Error("openai_not_configured");
  const j = await post(
    fetchImpl,
    "chat/completions",
    { model: chatModel(), messages, temperature: 0.2, max_tokens: opts.maxTokens ?? 700, response_format: { type: "json_object" } },
    CHAT_TIMEOUT_MS,
  );
  const text = String(j?.choices?.[0]?.message?.content ?? "");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("openai_reply_not_an_object");
  return parsed as Record<string, unknown>;
}

/** Embeddings for some texts, in order. Throws on any failure. */
export async function embed(fetchImpl: typeof fetch, texts: string[]): Promise<number[][]> {
  if (!aiConfigured()) throw new Error("openai_not_configured");
  const j = await post(fetchImpl, "embeddings", { model: embeddingModel(), input: texts.map((t) => t.slice(0, 8000)) }, EMBED_TIMEOUT_MS);
  const data = Array.isArray(j?.data) ? j.data : [];
  const out = data
    .slice()
    .sort((a: any, b: any) => Number(a.index) - Number(b.index))
    .map((d: any) => (Array.isArray(d.embedding) ? d.embedding.map(Number) : []));
  if (out.length !== texts.length || out.some((v: number[]) => !v.length)) throw new Error("openai_embeddings_incomplete");
  return out;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
