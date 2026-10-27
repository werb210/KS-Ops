// KS_OPS_KB_v1 - the conversation both assistants receive: { role: "user" | "assistant", text } turns, newest last.
import { z } from "zod";

export const turnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(4000),
});
export const turnsSchema = z.array(turnSchema).min(1, "Ask a question first").max(40);
export type Turn = z.infer<typeof turnSchema>;

export const MAX_QUESTION = 1000;
export const HISTORY_TURNS = 8;

/** The newest user turn (the question being asked), clipped. */
export function lastQuestion(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user") return turns[i].text.slice(0, MAX_QUESTION);
  return "";
}

/** What to search for: the question, plus the previous question when this one is a short follow-up ("and on iPad?"). */
export function searchText(turns: Turn[]): string {
  const users = turns.filter((t) => t.role === "user").map((t) => t.text);
  const q = users[users.length - 1] ?? "";
  if (q.split(/\s+/).length <= 6 && users.length > 1) return `${users[users.length - 2].slice(0, 300)} ${q}`.slice(0, MAX_QUESTION);
  return q.slice(0, MAX_QUESTION);
}

/** The last few turns, each clipped, for the model. */
export function history(turns: Turn[]): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.text.slice(0, 1500) }));
}

/** The conversation as plain text for a support ticket or a sales hand-off. */
export function transcriptText(turns: Turn[], names: { user: string; assistant: string }): string {
  return turns.map((t) => `${t.role === "user" ? names.user : names.assistant}: ${t.text}`).join("\n\n");
}
