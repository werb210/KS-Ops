// KS_OPS_ROADMAP_v1 - the public roadmap: items Keystone staff publish (requested, planned, in progress, shipped),
// ideas brokers send from the website (moderated before anything is public) and +1 votes.
// Nothing personal is ever public: the public list is the item's title, summary, area, status and vote count.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Q } from "../db.js";

export const ROADMAP_STATUSES = ["requested", "planned", "in_progress", "shipped"] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];
export const IDEA_STATUSES = ["pending", "approved", "merged", "rejected"] as const;

/** The consent wording the website shows next to its checkbox. Stored with each idea. */
export const IDEA_CONSENT_TEXT =
  "I agree that Keystone may store these details and email me about this idea. My name and email are never shown publicly.";

export const IDEA_THANKS = "Thanks - we read every idea. Once the team has reviewed it, it shows on the roadmap for other brokers to +1.";

const text = (max: number, msg: string) =>
  z.string({ error: (iss) => (iss.input === undefined ? msg : undefined) }).trim().min(1, msg).max(max, `Keep it under ${max} characters`);

export const ideaSchema = z.object({
  title: text(140, "Say what you'd like Keystone to do"),
  details: z.string().trim().max(3000, "Keep it under 3,000 characters").optional(),
  name: text(120, "Enter your name"),
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string({ error: (iss) => (iss.input === undefined ? "Enter a valid email address" : undefined) }).max(200).email("Enter a valid email address"),
  ),
  brokerage: z.string().trim().max(160).optional(),
  consent: z.literal(true, { error: () => "Tick the box so we can store your idea and reply to you" }),
  turnstile_token: z.string().max(4096).optional(),
  website_url: z.any().optional(),
});
export type IdeaInput = z.infer<typeof ideaSchema>;

export const voteSchema = z.object({
  voter_id: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "invalid_voter"),
});

export const itemCreateSchema = z.object({
  title: text(140, "Enter a title"),
  summary: z.string().trim().max(600).default(""),
  status: z.enum(ROADMAP_STATUSES).default("requested"),
  area: z.string().trim().max(60).default(""),
  public: z.boolean().default(true),
});
// Review fix: no defaults on update - with Zod 4, .partial() still fills defaults, so a PATCH of only the status
// would have blanked the summary and area.
export const itemUpdateSchema = z.object({
  title: text(140, "Enter a title").optional(),
  summary: z.string().trim().max(600).optional(),
  status: z.enum(ROADMAP_STATUSES).optional(),
  area: z.string().trim().max(60).optional(),
  public: z.boolean().optional(),
});

export const approveSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  summary: z.string().trim().max(600).optional(),
  status: z.enum(ROADMAP_STATUSES).optional(),
  area: z.string().trim().max(60).optional(),
});
export const mergeSchema = z.object({ item_id: z.string().uuid("Choose the roadmap item to add it to") });
export const rejectSchema = z.object({ note: z.string().trim().max(500).optional() });

/** A salted one-way hash (the same salt approach as the rest of KS-Ops: JWT_SECRET, else a fixed string). */
export function saltedHash(kind: string, value: string): string {
  const salt = String(process.env.JWT_SECRET ?? "ks-ops");
  return createHash("sha256").update(`${salt}:${kind}:${value}`).digest("hex").slice(0, 40);
}

export type PublicItem = { id: string; title: string; summary: string; area: string; status: RoadmapStatus; votes: number; shipped_at: string | null };

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

function publicView(r: Record<string, unknown>): PublicItem {
  return {
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary ?? ""),
    area: String(r.area ?? ""),
    status: r.status as RoadmapStatus,
    votes: Number(r.votes ?? 0),
    shipped_at: iso(r.shipped_at),
  };
}

const ITEM_COLS = `i.id, i.title, i.summary, i.area, i.status, i.public, i.shipped_at, i.created_at, i.updated_at, i.updated_by,
  (SELECT count(*) FROM roadmap_votes v WHERE v.item_id = i.id)::int AS votes`;

/** The public roadmap: public items only, most votes first within each status. */
export async function listPublic(db: Q): Promise<PublicItem[]> {
  const r = await db.query(
    `SELECT ${ITEM_COLS} FROM roadmap_items i WHERE i.public = true
      ORDER BY CASE i.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'requested' THEN 2 ELSE 3 END,
               votes DESC, i.shipped_at DESC NULLS LAST, i.title
      LIMIT 300`,
  );
  return r.rows.map(publicView);
}

/** Everything, for Keystone staff. */
export async function listItemsForStaff(db: Q): Promise<Array<Record<string, unknown>>> {
  const r = await db.query(
    `SELECT ${ITEM_COLS},
            (SELECT count(*) FROM roadmap_ideas d WHERE d.item_id = i.id)::int AS ideas
       FROM roadmap_items i ORDER BY i.updated_at DESC LIMIT 500`,
  );
  return r.rows.map((x) => ({ ...publicView(x), public: Boolean(x.public), ideas: Number(x.ideas ?? 0), updated_at: iso(x.updated_at), updated_by: x.updated_by ?? null }));
}

export async function listIdeasForStaff(db: Q): Promise<Array<Record<string, unknown>>> {
  const r = await db.query(
    `SELECT d.id, d.title, d.details, d.name, d.email, d.brokerage, d.status, d.item_id, d.review_note, d.reviewed_by,
            d.reviewed_at, d.created_at, i.title AS item_title
       FROM roadmap_ideas d LEFT JOIN roadmap_items i ON i.id = d.item_id
      ORDER BY (d.status = 'pending') DESC, d.created_at DESC LIMIT 500`,
  );
  return r.rows.map((x) => ({
    id: String(x.id), title: x.title, details: x.details ?? null, name: x.name, email: x.email, brokerage: x.brokerage ?? null,
    status: x.status, item_id: x.item_id ?? null, item_title: x.item_title ?? null, review_note: x.review_note ?? null,
    reviewed_by: x.reviewed_by ?? null, reviewed_at: iso(x.reviewed_at), created_at: iso(x.created_at),
  }));
}

export async function getItem(db: Q, id: string): Promise<PublicItem & { public: boolean } | null> {
  const r = await db.query(`SELECT ${ITEM_COLS} FROM roadmap_items i WHERE i.id = $1`, [id]);
  return r.rows[0] ? { ...publicView(r.rows[0]), public: Boolean(r.rows[0].public) } : null;
}

export async function createItem(db: Q, v: z.infer<typeof itemCreateSchema>, actor: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO roadmap_items (title, summary, status, area, public, shipped_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 = 'shipped' THEN now() END, $6) RETURNING id`,
    [v.title, v.summary, v.status, v.area, v.public, actor],
  );
  return String(r.rows[0].id);
}

export async function updateItem(db: Q, id: string, v: z.infer<typeof itemUpdateSchema>, actor: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE roadmap_items SET
        title = COALESCE($2, title), summary = COALESCE($3, summary), status = COALESCE($4, status),
        area = COALESCE($5, area), public = COALESCE($6, public),
        shipped_at = CASE WHEN COALESCE($4, status) = 'shipped' THEN COALESCE(shipped_at, now()) ELSE NULL END,
        updated_at = now(), updated_by = $7
      WHERE id = $1 RETURNING id`,
    [id, v.title ?? null, v.summary ?? null, v.status ?? null, v.area ?? null, v.public ?? null, actor],
  );
  return r.rows.length > 0;
}

export async function deleteItem(db: Q, id: string): Promise<boolean> {
  const r = await db.query("DELETE FROM roadmap_items WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/** The idea, or null when it is not waiting for review. */
export async function pendingIdea(db: Q, id: string): Promise<Record<string, any> | null> {
  const r = await db.query("SELECT id, title, details, status FROM roadmap_ideas WHERE id = $1 AND status = 'pending'", [id]);
  return r.rows[0] ?? null;
}

export async function closeIdea(db: Q, id: string, status: "approved" | "merged" | "rejected", itemId: string | null, note: string | null, actor: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE roadmap_ideas SET status = $2, item_id = $3, review_note = $4, reviewed_by = $5, reviewed_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, status, itemId, note, actor],
  );
  return r.rows.length > 0;
}

/** +1 (idempotent). Returns the new count, or null when the item is not public. */
export async function vote(db: Q, itemId: string, voterId: string, ip: string, on: boolean): Promise<number | null> {
  const item = await db.query("SELECT id FROM roadmap_items WHERE id = $1 AND public = true AND status <> 'shipped'", [itemId]);
  if (!item.rows.length) return null;
  const voter = saltedHash("voter", voterId);
  if (on) {
    await db.query(
      "INSERT INTO roadmap_votes (item_id, voter_hash, ip_hash) VALUES ($1, $2, $3) ON CONFLICT (item_id, voter_hash) DO NOTHING",
      [itemId, voter, ip ? saltedHash("ip", ip) : null],
    );
  } else {
    await db.query("DELETE FROM roadmap_votes WHERE item_id = $1 AND voter_hash = $2", [itemId, voter]);
  }
  const c = await db.query("SELECT count(*)::int AS n FROM roadmap_votes WHERE item_id = $1", [itemId]);
  return Number(c.rows[0]?.n ?? 0);
}

/** Votes from one address in the last day, for the per-address limit. */
export async function votesFromIp(db: Q, ip: string, since: Date): Promise<number> {
  if (!ip) return 0;
  const r = await db.query("SELECT count(*)::int AS n FROM roadmap_votes WHERE ip_hash = $1 AND created_at > $2", [saltedHash("ip", ip), since]);
  return Number(r.rows[0]?.n ?? 0);
}
