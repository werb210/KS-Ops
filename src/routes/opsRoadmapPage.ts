// KS_OPS_ROADMAP_v1 - the roadmap moderation page served at /ops/roadmap. Same pattern as /ops/beta: plain HTML with a
// little script, a KS-Ops staff token (or OPS_ADMIN_TOKEN) kept in this tab's sessionStorage only, and calls to
// /api/ops/roadmap. Everything brokers sent is written with textContent (never as HTML). Dark text on light
// backgrounds throughout (contrast well over 4.5:1).
import { Router } from "express";

export const ROADMAP_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone roadmap</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:68rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  label.inline { display:inline-flex; align-items:center; gap:.35rem; font-weight:400; }
  input, select, textarea { width:100%; padding:.5rem .6rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  input[type=checkbox] { width:auto; }
  textarea { min-height:4rem; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.45rem .9rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.4rem .4rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); }
  button.danger { background:#fff; color:var(--bad); border-color:var(--bad); }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:0 1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.45rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  .badge { display:inline-block; padding:.05rem .5rem; border-radius:999px; font-size:.8rem; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
  .s-pending { background:#fff3cd; color:#5c4400; } .s-approved, .s-shipped { background:#d1e7dd; color:#0f5132; }
  .s-merged, .s-planned { background:#dbeafe; color:#0b3a75; } .s-rejected, .s-hidden { background:#e9ecef; color:#343a40; }
  .s-requested { background:#ede7f6; color:#3c1f73; } .s-in_progress { background:#ffe5d0; color:#6b2e00; }
  .idea p { margin:.25rem 0; white-space:pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>Roadmap</h1>
  <p class="lead">Ideas brokers send from the website wait here. Nothing is public until you approve it, and only the title and summary you write are shown, never who sent it.</p>
  <section id="signin">
    <h2>Sign in</h2>
    <label for="token">Keystone operations token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Staff token or OPS_ADMIN_TOKEN">
    <p class="hint">Kept in this browser tab only, and forgotten when the tab closes.</p>
    <button id="useToken" type="button">Continue</button>
    <div id="signinMsg" class="msg bad hidden" role="alert"></div>
  </section>

  <div id="app" class="hidden">
    <section aria-labelledby="ideasH">
      <h2 id="ideasH">Ideas waiting for review</h2>
      <div id="ideas"></div>
      <div id="ideaMsg" class="msg hidden" role="status"></div>
    </section>

    <section aria-labelledby="itemsH">
      <h2 id="itemsH">Roadmap items</h2>
      <div class="scroll"><table><thead><tr><th>Title</th><th>Status</th><th>Votes</th><th>Ideas</th><th>Shown</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
    </section>

    <section aria-labelledby="editorH">
      <h2 id="editorH">New roadmap item</h2>
      <form id="itemForm" class="grid" novalidate>
        <div><label for="i_title">Title</label><input id="i_title" maxlength="140" placeholder="Hold queue for the main line"></div>
        <div><label for="i_status">Status</label><select id="i_status"><option value="requested">Requested</option><option value="planned">Planned</option><option value="in_progress">Working on it</option><option value="shipped">Shipped</option></select></div>
        <div><label for="i_area">Area (optional)</label><input id="i_area" maxlength="60" placeholder="Phones"></div>
        <div><label class="inline" style="margin-top:2.2rem"><input id="i_public" type="checkbox" checked> Show on the website</label></div>
        <div style="grid-column:1/-1"><label for="i_summary">Summary (public)</label><textarea id="i_summary" maxlength="600" placeholder="One or two plain sentences brokers will read."></textarea></div>
      </form>
      <button id="saveItem" type="button">Save item</button>
      <button id="cancelEdit" type="button" class="quiet hidden">Cancel editing</button>
      <div id="itemMsg" class="msg hidden" role="status"></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_roadmap_token";
  var STATUS = { requested: "Requested", planned: "Planned", in_progress: "Working on it", shipped: "Shipped", pending: "Waiting", approved: "Published", merged: "Added to an item", rejected: "Not shown" };
  var $ = function (id) { return document.getElementById(id); };
  var token = "", items = [], editing = null;
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function badge(s) { return el("span", STATUS[s] || s, "badge s-" + s); }
  function btn(text, cls, fn) { var b = el("button", text, cls || ""); b.type = "button"; b.onclick = fn; return b; }
  function api(method, path, body) {
    return fetch("/api/ops" + path, {
      method: method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { signOut("Your token was not accepted. Sign in again."); throw new Error("unauthorized"); }
        if (!r.ok) throw new Error(j.message || (j.errors ? Object.keys(j.errors).map(function (k) { return j.errors[k]; }).join(" ") : "") || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }
  function signOut(why) {
    token = ""; try { sessionStorage.removeItem(KEY); } catch (e) {}
    $("app").className = "hidden"; $("signin").className = "";
    if (why) show($("signinMsg"), why, false);
  }
  function renderIdeas(ideas) {
    var box = $("ideas"); box.textContent = "";
    var pending = ideas.filter(function (d) { return d.status === "pending"; });
    if (!pending.length) box.appendChild(el("p", "No ideas waiting. New ones from the website appear here.", "hint"));
    pending.forEach(function (d) {
      var card = el("div", null, "idea"); card.style.borderTop = "1px solid var(--line)"; card.style.padding = ".6rem 0";
      card.appendChild(el("strong", d.title));
      if (d.details) card.appendChild(el("p", d.details));
      card.appendChild(el("p", "From " + d.name + (d.brokerage ? " (" + d.brokerage + ")" : "") + ", " + d.email + ", " + new Date(d.created_at).toLocaleString(), "hint"));
      var title = el("input"); title.value = d.title; title.maxLength = 140; title.setAttribute("aria-label", "Public title");
      var summary = el("textarea"); summary.placeholder = "Public summary (optional)"; summary.setAttribute("aria-label", "Public summary");
      var pick = el("select"); pick.setAttribute("aria-label", "Existing item to add it to");
      pick.appendChild(el("option", "Add to an existing item..."));
      items.forEach(function (i) { var o = el("option", i.title); o.value = i.id; pick.appendChild(o); });
      card.appendChild(title); card.appendChild(summary);
      card.appendChild(btn("Publish as new item", "", function () { act("/roadmap/ideas/" + d.id + "/approve", { title: title.value, summary: summary.value }, "Published."); }));
      card.appendChild(pick);
      card.appendChild(btn("Add to chosen item", "quiet", function () { if (!pick.value || pick.selectedIndex === 0) return show($("ideaMsg"), "Choose an item first.", false); act("/roadmap/ideas/" + d.id + "/merge", { item_id: pick.value }, "Added."); }));
      card.appendChild(btn("Don't show", "danger", function () { act("/roadmap/ideas/" + d.id + "/reject", {}, "Hidden."); }));
      box.appendChild(card);
    });
    var done = ideas.filter(function (d) { return d.status !== "pending"; }).slice(0, 30);
    if (done.length) {
      box.appendChild(el("h3", "Reviewed recently"));
      done.forEach(function (d) { var p = el("p", null, "hint"); p.appendChild(badge(d.status)); p.appendChild(document.createTextNode(" " + d.title + (d.item_title ? " -> " + d.item_title : ""))); box.appendChild(p); });
    }
  }
  function renderItems() {
    var tb = $("items"); tb.textContent = "";
    items.forEach(function (i) {
      var tr = el("tr");
      var t = el("td"); t.appendChild(el("strong", i.title)); if (i.summary) t.appendChild(el("div", i.summary, "hint")); tr.appendChild(t);
      var s = el("td"); s.appendChild(badge(i.status)); tr.appendChild(s);
      tr.appendChild(el("td", String(i.votes))); tr.appendChild(el("td", String(i.ideas)));
      var p = el("td"); p.appendChild(i.public ? el("span", "Yes") : badge("hidden")); tr.appendChild(p);
      var a = el("td");
      a.appendChild(btn("Edit", "quiet", function () { startEdit(i); }));
      a.appendChild(btn("Delete", "danger", function () { if (confirm("Delete \\"" + i.title + "\\" and its votes?")) act("/roadmap/items/" + i.id, null, "Deleted.", "DELETE"); }));
      tr.appendChild(a); tb.appendChild(tr);
    });
  }
  function startEdit(i) {
    editing = i.id; $("editorH").textContent = "Edit roadmap item";
    $("i_title").value = i.title; $("i_summary").value = i.summary || ""; $("i_status").value = i.status; $("i_area").value = i.area || ""; $("i_public").checked = !!i.public;
    $("cancelEdit").className = "quiet"; $("i_title").focus();
  }
  function resetEditor() { editing = null; $("editorH").textContent = "New roadmap item"; $("itemForm").reset(); $("i_public").checked = true; $("cancelEdit").className = "quiet hidden"; }
  function act(path, body, okText, method) {
    return api(method || "POST", path, body).then(function () { show($("ideaMsg"), okText, true); return load(); }).catch(function (e) { if (e.message !== "unauthorized") show($("ideaMsg"), e.message, false); });
  }
  function load() {
    return api("GET", "/roadmap").then(function (j) {
      $("signin").className = "hidden"; $("app").className = "";
      items = j.items || []; renderItems(); renderIdeas(j.ideas || []);
    });
  }
  $("saveItem").onclick = function () {
    var body = { title: $("i_title").value, summary: $("i_summary").value, status: $("i_status").value, area: $("i_area").value, public: $("i_public").checked };
    var call = editing ? api("PATCH", "/roadmap/items/" + editing, body) : api("POST", "/roadmap/items", body);
    call.then(function () { show($("itemMsg"), "Saved.", true); resetEditor(); return load(); }).catch(function (e) { if (e.message !== "unauthorized") show($("itemMsg"), e.message, false); });
  };
  $("cancelEdit").onclick = resetEditor;
  $("useToken").onclick = function () {
    token = $("token").value.trim();
    if (!token) return show($("signinMsg"), "Enter your token.", false);
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    load().catch(function (e) { if (e.message !== "unauthorized") show($("signinMsg"), e.message, false); });
  };
  $("refresh").onclick = function () { load().catch(function () {}); };
  $("signout").onclick = function () { signOut(""); };
  if (token) load().catch(function () {});
})();
</script>
</body>
</html>
`;

export function roadmapPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(ROADMAP_PAGE_HTML);
  });
  return router;
}
