// KS_OPS_ROADMAP_v1 - staff API for the public roadmap. Mounted under /api/ops behind requireStaff. The page at
// /ops/roadmap calls it.
//   GET    /api/ops/roadmap                         { items (all, with votes and idea counts), ideas (pending first) }
//   POST   /api/ops/roadmap/items                   create { title, summary?, status?, area?, public? }
//   PATCH  /api/ops/roadmap/items/:id               edit any of those
//   DELETE /api/ops/roadmap/items/:id               remove (its votes go too; linked ideas keep their text)
//   POST   /api/ops/roadmap/ideas/:id/approve       publish as a new item { title?, summary?, status?, area? }
//   POST   /api/ops/roadmap/ideas/:id/merge         add to an existing item { item_id }
//   POST   /api/ops/roadmap/ideas/:id/reject        { note? }
// Every change is in the audit log.
import { Router } from "express";
import type { Deps } from "../deps.js";
import { actorOf } from "../auth/staff.js";
import { h, parseBody, UUID_RE } from "../lib/http.js";
import { audit } from "../licensees/repo.js";
import {
  approveSchema, closeIdea, createItem, deleteItem, getItem, itemCreateSchema, itemUpdateSchema, listIdeasForStaff,
  listItemsForStaff, mergeSchema, pendingIdea, rejectSchema, updateItem,
} from "../roadmap/roadmap.js";

const NOT_FOUND = { error: "not_found", message: "That roadmap item does not exist." };
const NO_IDEA = { error: "not_found", message: "That idea does not exist or has already been reviewed." };

export function opsRoadmapRouter(deps: Deps): Router {
  const router = Router();

  router.get(
    "/roadmap",
    h(async (_req, res) => {
      const [items, ideas] = await Promise.all([listItemsForStaff(deps.db), listIdeasForStaff(deps.db)]);
      res.setHeader("Cache-Control", "no-store");
      res.json({ items, ideas });
    }),
  );

  router.post(
    "/roadmap/items",
    h(async (req, res) => {
      const parsed = parseBody(itemCreateSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const actor = actorOf(req);
      const id = await createItem(deps.db, parsed.data, actor);
      await audit(deps.db, actor, "roadmap.item_create", null, { id, title: parsed.data.title, status: parsed.data.status, public: parsed.data.public });
      return res.status(201).json({ item: await getItem(deps.db, id) });
    }),
  );

  router.patch(
    "/roadmap/items/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json(NOT_FOUND);
      const parsed = parseBody(itemUpdateSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const actor = actorOf(req);
      if (!(await updateItem(deps.db, id, parsed.data, actor))) return res.status(404).json(NOT_FOUND);
      await audit(deps.db, actor, "roadmap.item_update", null, { id, ...parsed.data });
      return res.json({ item: await getItem(deps.db, id) });
    }),
  );

  router.delete(
    "/roadmap/items/:id",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json(NOT_FOUND);
      const actor = actorOf(req);
      if (!(await deleteItem(deps.db, id))) return res.status(404).json(NOT_FOUND);
      await audit(deps.db, actor, "roadmap.item_delete", null, { id });
      return res.json({ ok: true });
    }),
  );

  router.post(
    "/roadmap/ideas/:id/approve",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json(NO_IDEA);
      const parsed = parseBody(approveSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const idea = await pendingIdea(deps.db, id);
      if (!idea) return res.status(404).json(NO_IDEA);
      const actor = actorOf(req);
      // Review fix: claim the idea first (one conditional update), so two staff approving at once make one item.
      if (!(await closeIdea(deps.db, id, "approved", null, null, actor))) return res.status(404).json(NO_IDEA);
      // The public item is written by staff (or is the idea's own title): the broker's details never go with it.
      const itemId = await createItem(
        deps.db,
        { title: parsed.data.title ?? String(idea.title), summary: parsed.data.summary ?? "", status: parsed.data.status ?? "requested", area: parsed.data.area ?? "", public: true },
        actor,
      );
      await deps.db.query("UPDATE roadmap_ideas SET item_id = $2 WHERE id = $1", [id, itemId]);
      await audit(deps.db, actor, "roadmap.idea_approve", null, { idea: id, item: itemId });
      return res.status(201).json({ item: await getItem(deps.db, itemId) });
    }),
  );

  router.post(
    "/roadmap/ideas/:id/merge",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json(NO_IDEA);
      const parsed = parseBody(mergeSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      if (!(await getItem(deps.db, parsed.data.item_id))) return res.status(400).json({ errors: { item_id: "That roadmap item does not exist." } });
      const actor = actorOf(req);
      if (!(await closeIdea(deps.db, id, "merged", parsed.data.item_id, null, actor))) return res.status(404).json(NO_IDEA);
      await audit(deps.db, actor, "roadmap.idea_merge", null, { idea: id, item: parsed.data.item_id });
      return res.json({ ok: true });
    }),
  );

  router.post(
    "/roadmap/ideas/:id/reject",
    h(async (req, res) => {
      const id = String(req.params.id);
      if (!UUID_RE.test(id)) return res.status(404).json(NO_IDEA);
      const parsed = parseBody(rejectSchema, req.body);
      if (!parsed.ok) return res.status(400).json({ errors: parsed.errors });
      const actor = actorOf(req);
      if (!(await closeIdea(deps.db, id, "rejected", null, parsed.data.note || null, actor))) return res.status(404).json(NO_IDEA);
      await audit(deps.db, actor, "roadmap.idea_reject", null, { idea: id });
      return res.json({ ok: true });
    }),
  );

  return router;
}
