// KS_OPS_KB_v1 - the knowledge base admin page served at /ops/kb. Same pattern as /ops/beta and /ops/trials: plain HTML
// with a little script, a KS-Ops staff token (or OPS_ADMIN_TOKEN) kept in this tab's sessionStorage only, and calls to
// /api/ops/kb/... Keystone staff write and edit articles (title, category, Markdown body with images, plans, audience,
// draft or published, last updated) and read the report of questions the assistants could not answer.
// Dark text on light backgrounds throughout (contrast well over 4.5:1); badges use dark text on pale fills.
import { Router } from "express";

export const KB_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone help articles</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:72rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  label.inline { display:inline-flex; align-items:center; gap:.35rem; font-weight:400; margin-right:1rem; }
  input, select, textarea { width:100%; padding:.55rem .65rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  input[type=checkbox] { width:auto; } input[type=file] { border:none; padding:.25rem 0; }
  textarea { min-height:22rem; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92rem; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.5rem .5rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); } button.danger { background:#fff; color:var(--bad); border-color:var(--bad); }
  button.small { padding:.25rem .6rem; font-size:.9rem; margin:0; }
  button:disabled { opacity:.6; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:0 1rem; }
  .filters { display:grid; grid-template-columns:2fr 1fr 1fr 1fr; gap:.5rem; } @media (max-width:40rem) { .filters { grid-template-columns:1fr; } }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  .badge { display:inline-block; padding:.05rem .5rem; border-radius:999px; font-size:.8rem; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
  .b-published { background:#d1e7dd; color:#0f5132; } .b-draft { background:#fff3cd; color:#5c4400; }
  .b-public { background:#dbeafe; color:#0b3a75; } .b-all_staff { background:#ede7f6; color:#3c1f73; } .b-admins { background:#fde2e1; color:#6b1a14; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:1rem; } @media (max-width:60rem) { .cols { grid-template-columns:1fr; } }
  .preview { border:1px solid var(--line); border-radius:6px; padding:.75rem 1rem; min-height:22rem; overflow:auto; background:#fff; }
  .preview img { max-width:100%; height:auto; border:1px solid var(--line); border-radius:4px; }
  .preview blockquote { margin:.5rem 0; padding:.5rem .8rem; background:#eef4fb; border-left:4px solid var(--accent); }
  .preview code { background:#eef0f3; padding:.05rem .3rem; border-radius:4px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Help articles</h1>
  <p class="lead">The knowledge base every Keystone licensee shares: the Help Center in the portal, Ask Maya, and the public help on the website. Admins only.</p>

  <section id="signin">
    <h2>Sign in</h2>
    <label for="token">Keystone operations token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Staff token or OPS_ADMIN_TOKEN">
    <p class="hint">Kept in this browser tab only, and forgotten when the tab closes.</p>
    <button id="useToken" type="button">Continue</button>
    <div id="signinMsg" class="msg bad hidden" role="alert"></div>
  </section>

  <div id="app" class="hidden">
    <section>
      <h2>Articles</h2>
      <div class="filters">
        <div><label for="fq">Search titles</label><input id="fq" type="search" placeholder="Title, address or category"></div>
        <div><label for="fstatus">Status</label><select id="fstatus"><option value="">Any</option><option value="published">Published</option><option value="draft">Draft</option></select></div>
        <div><label for="faud">Audience</label><select id="faud"><option value="">Any</option><option value="public">Public</option><option value="all_staff">All licensee staff</option><option value="admins">Licensee admins</option></select></div>
        <div><label for="fcat">Category</label><select id="fcat"><option value="">Any</option></select></div>
      </div>
      <div class="scroll"><table><thead><tr><th>Title</th><th>Category</th><th>Audience</th><th>Plans</th><th>Status</th><th>Last updated</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      <button id="newArticle" type="button">New article</button>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
    </section>

    <section id="editor" class="hidden" aria-labelledby="editorTitle">
      <h2 id="editorTitle">New article</h2>
      <form id="articleForm" novalidate>
        <div class="grid">
          <div><label for="a_title">Title</label><input id="a_title" maxlength="200" placeholder="How to add a user"></div>
          <div><label for="a_slug">Address (optional)</label><input id="a_slug" maxlength="120" autocapitalize="none" placeholder="made from the title"><span class="hint">Lowercase letters, numbers and dashes. Used in links: kb:address.</span></div>
          <div><label for="a_category">Category</label><input id="a_category" maxlength="80" list="catList" placeholder="Getting started"><datalist id="catList"></datalist></div>
          <div><label for="a_audience">Audience</label><select id="a_audience"><option value="all_staff">All licensee staff</option><option value="admins">Licensee admins only</option><option value="public">Public (website too)</option></select></div>
          <div><label for="a_status">Status</label><select id="a_status"><option value="draft">Draft</option><option value="published">Published</option></select></div>
          <div><span style="display:block;font-weight:600;margin:.5rem 0 .2rem">Plans it applies to</span>
            <label class="inline"><input type="checkbox" name="plan" value="starter"> Starter</label>
            <label class="inline"><input type="checkbox" name="plan" value="growth"> Growth</label>
            <label class="inline"><input type="checkbox" name="plan" value="pro"> Pro</label>
            <span class="hint" style="display:block">None ticked = every plan.</span></div>
        </div>
        <label for="a_summary">Summary (optional)</label><input id="a_summary" maxlength="400" placeholder="One line shown in search results">
        <div class="cols">
          <div>
            <label for="a_body">Article (Markdown)</label>
            <textarea id="a_body" spellcheck="true" placeholder="## Steps&#10;1. Open **Settings**&#10;2. ..."></textarea>
            <p class="hint"># Heading, - list, 1. steps, **bold**, [link](https://...), [another article](kb:article-address), &gt; note. Mark anything not built yet as "Coming soon".</p>
            <label for="a_image">Add an image (PNG or JPG, up to 2 MB)</label><input id="a_image" type="file" accept="image/png,image/jpeg">
          </div>
          <div><span style="display:block;font-weight:600;margin:.5rem 0 .2rem">Preview</span><div id="preview" class="preview" aria-live="polite"></div></div>
        </div>
      </form>
      <p class="hint" id="meta"></p>
      <button id="save" type="button">Save</button>
      <button id="doPreview" type="button" class="quiet">Update preview</button>
      <button id="close" type="button" class="quiet">Close</button>
      <button id="delete" type="button" class="danger hidden">Delete</button>
      <div id="editMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>Questions with no good answer</h2>
      <p class="hint">What people asked Ask Maya (portal) and the website assistant that no article answered, or that ended with a request for a person. Write articles for the top ones.</p>
      <label for="days" style="max-width:12rem">Period</label>
      <select id="days" style="max-width:12rem"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>
      <p id="totals" class="hint"></p>
      <div class="scroll"><table><thead><tr><th>Question</th><th>Times</th><th>Brokerages</th><th>Website</th><th>Asked for a person</th><th>Last asked</th><th></th></tr></thead><tbody id="report"></tbody></table></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_kb_token";
  var AUD = { public: "Public", all_staff: "All staff", admins: "Admins" };
  var $ = function (id) { return document.getElementById(id); };
  var token = "", current = null, all = [];
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
  function hide(el) { el.className = "msg hidden"; el.textContent = ""; }
  function api(method, path, body) {
    return fetch("/api/ops" + path, {
      method: method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { signOut("Your token was not accepted. Sign in again."); throw new Error("unauthorized"); }
        if (!r.ok) throw new Error(j.message || (j.errors ? Object.keys(j.errors).map(function (k) { return k + ": " + j.errors[k]; }).join(" ") : "") || j.error || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }
  function signOut(msg) {
    token = ""; try { sessionStorage.removeItem(KEY); } catch (e) {}
    $("app").className = "hidden"; $("signin").className = "";
    if (msg) show($("signinMsg"), msg, false);
  }
  function day(v) { return v ? new Date(v).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : "-"; }
  function cell(tr, content) { var td = document.createElement("td"); if (typeof content === "string") td.textContent = content; else if (content) td.appendChild(content); tr.appendChild(td); return td; }
  function badge(cls, text) { var s = document.createElement("span"); s.className = "badge b-" + cls; s.textContent = text; return s; }
  function btn(text, onclick, quiet) { var b = document.createElement("button"); b.type = "button"; b.className = "small" + (quiet ? " quiet" : ""); b.textContent = text; b.onclick = onclick; return b; }
  function empty(body, cols, text) { var tr = document.createElement("tr"); var td = document.createElement("td"); td.colSpan = cols; td.textContent = text; tr.appendChild(td); body.appendChild(tr); }
  function query() {
    var p = [];
    [["q", "fq"], ["status", "fstatus"], ["audience", "faud"], ["category", "fcat"]].forEach(function (x) { var v = $(x[1]).value.trim(); if (v) p.push(x[0] + "=" + encodeURIComponent(v)); });
    return p.length ? "?" + p.join("&") : "";
  }
  function load() {
    return Promise.all([api("GET", "/kb/articles" + query()), api("GET", "/kb/categories")]).then(function (r) {
      all = r[0].articles || [];
      var cats = (r[1].categories || []).map(function (c) { return c.category; });
      var fcat = $("fcat"), keep = fcat.value; fcat.innerHTML = '<option value="">Any</option>';
      var dl = $("catList"); dl.innerHTML = "";
      cats.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = c; fcat.appendChild(o); var d = document.createElement("option"); d.value = c; dl.appendChild(d); });
      fcat.value = keep;
      var body = $("rows"); body.innerHTML = "";
      if (!all.length) empty(body, 7, "No articles match.");
      all.forEach(function (a) {
        var tr = document.createElement("tr");
        cell(tr, a.title); cell(tr, a.category); cell(tr, badge(a.audience, AUD[a.audience] || a.audience));
        cell(tr, a.plans_label || "Every plan"); cell(tr, badge(a.status, a.status === "published" ? "Published" : "Draft"));
        cell(tr, day(a.updated_at)); cell(tr, btn("Edit", function () { edit(a); }, true));
        body.appendChild(tr);
      });
    }).catch(function (e) { if (e.message !== "unauthorized") show($("editMsg"), e.message, false); });
  }
  function loadReport() {
    api("GET", "/kb/report?days=" + $("days").value).then(function (r) {
      var t = r.totals || {};
      $("totals").textContent = "Answered: " + (t.answered || 0) + ". No good answer: " + (t.no_answer || 0) + ". Asked for a person: " + (t.escalated || 0) + ".";
      var body = $("report"); body.innerHTML = "";
      if (!(r.questions || []).length) empty(body, 7, "Nothing yet.");
      (r.questions || []).forEach(function (q) {
        var tr = document.createElement("tr");
        cell(tr, q.question); cell(tr, String(q.times)); cell(tr, String(q.licensees)); cell(tr, String(q.from_website)); cell(tr, String(q.escalated)); cell(tr, day(q.last_asked));
        cell(tr, btn("Write an article", function () { edit(null, q.question); }, true));
        body.appendChild(tr);
      });
    }).catch(function () {});
  }
  function plans() { return Array.prototype.slice.call(document.querySelectorAll("input[name=plan]:checked")).map(function (i) { return i.value; }); }
  function edit(a, title) {
    current = a; hide($("editMsg"));
    $("editor").className = "";
    $("editorTitle").textContent = a ? "Edit: " + a.title : "New article";
    $("a_title").value = a ? a.title : (title || ""); $("a_slug").value = a ? a.slug : ""; $("a_category").value = a ? a.category : "";
    $("a_audience").value = a ? a.audience : "all_staff"; $("a_status").value = a ? a.status : "draft"; $("a_summary").value = a ? (a.summary || "") : "";
    $("a_body").value = a ? (a.body_md || "") : "";
    Array.prototype.forEach.call(document.querySelectorAll("input[name=plan]"), function (i) { i.checked = !!(a && a.plans.indexOf(i.value) >= 0); });
    $("delete").className = a ? "danger" : "danger hidden";
    $("meta").textContent = a ? ("Last updated " + day(a.updated_at) + (a.updated_by ? " by " + a.updated_by : "") + (a.seeded ? ". From the starter library." : ".")) : "";
    preview(); $("a_title").focus();
  }
  function preview() {
    api("POST", "/kb/preview", { body_md: $("a_body").value }).then(function (r) { $("preview").innerHTML = r.html || '<p class="hint">Nothing to preview yet.</p>'; }).catch(function () {});
  }
  function save() {
    var body = { title: $("a_title").value, category: $("a_category").value, audience: $("a_audience").value, status: $("a_status").value,
      summary: $("a_summary").value, body_md: $("a_body").value, plans: plans() };
    var slug = $("a_slug").value.trim(); if (slug) body.slug = slug;
    $("save").disabled = true;
    (current ? api("PATCH", "/kb/articles/" + current.id, body) : api("POST", "/kb/articles", body)).then(function (r) {
      current = r.article; show($("editMsg"), "Saved. " + (r.article.status === "published" ? "It is live now." : "It is a draft: only you can see it."), true);
      $("a_slug").value = r.article.slug; $("delete").className = "danger";
      $("editorTitle").textContent = "Edit: " + r.article.title; load();
    }).catch(function (e) { if (e.message !== "unauthorized") show($("editMsg"), e.message, false); }).then(function () { $("save").disabled = false; });
  }
  function del() {
    if (!current || !confirm("Delete \\"" + current.title + "\\"? This cannot be undone.")) return;
    api("DELETE", "/kb/articles/" + current.id).then(function () { $("editor").className = "hidden"; current = null; load(); })
      .catch(function (e) { show($("editMsg"), e.message, false); });
  }
  $("a_image").onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      api("POST", "/kb/images", { content_type: f.type, data_base64: String(reader.result), filename: f.name }).then(function (r) {
        var ta = $("a_body"), at = ta.selectionStart || ta.value.length;
        ta.value = ta.value.slice(0, at) + "\\n" + r.markdown + "\\n" + ta.value.slice(at); preview();
        show($("editMsg"), "Image added to the article.", true);
      }).catch(function (e) { show($("editMsg"), e.message, false); });
      $("a_image").value = "";
    };
    reader.readAsDataURL(f);
  };
  var t; $("a_body").oninput = function () { clearTimeout(t); t = setTimeout(preview, 600); };
  $("useToken").onclick = function () { token = $("token").value.trim(); if (!token) return; try { sessionStorage.setItem(KEY, token); } catch (e) {} start(); };
  $("signout").onclick = function () { signOut(""); };
  $("refresh").onclick = load; $("newArticle").onclick = function () { edit(null); };
  $("save").onclick = save; $("doPreview").onclick = preview; $("close").onclick = function () { $("editor").className = "hidden"; };
  $("delete").onclick = del; $("days").onchange = loadReport;
  ["fstatus", "faud", "fcat"].forEach(function (id) { $(id).onchange = load; });
  var ft; $("fq").oninput = function () { clearTimeout(ft); ft = setTimeout(load, 300); };
  function start() { hide($("signinMsg")); $("signin").className = "hidden"; $("app").className = ""; load(); loadReport(); }
  if (token) start();
})();
</script>
</body>
</html>`;

export function kbPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.send(KB_PAGE_HTML);
  });
  return router;
}
