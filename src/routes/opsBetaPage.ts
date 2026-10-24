// KS_OPS_BETA_v1 - the beta features ops page served at /ops/beta. Same pattern as /ops/trials and /ops/quickbooks:
// plain HTML with a little script, a KS-Ops staff token (or OPS_ADMIN_TOKEN) kept in this tab's sessionStorage only,
// and calls to /api/ops/beta/... and /api/ops/licensees. Dark text on light backgrounds throughout (contrast well over
// 4.5:1); status badges use dark text on pale fills.
import { Router } from "express";

export const BETA_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone beta features</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:64rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; } h3 { font-size:1rem; margin:1rem 0 .5rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  label.inline { display:inline-flex; align-items:center; gap:.35rem; font-weight:400; margin-right:1rem; }
  input, select, textarea { width:100%; padding:.55rem .65rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  input[type=checkbox] { width:auto; }
  textarea { min-height:5rem; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.5rem .5rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); }
  button.small { padding:.25rem .6rem; font-size:.9rem; margin:0; }
  button:disabled { opacity:.6; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:0 1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  .badge { display:inline-block; padding:.05rem .5rem; border-radius:999px; font-size:.8rem; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
  .b-private_beta { background:#ede7f6; color:#3c1f73; } .b-public_beta { background:#dbeafe; color:#0b3a75; }
  .b-ga { background:#d1e7dd; color:#0f5132; } .b-retired { background:#e9ecef; color:#343a40; }
  .b-open { background:#fff3cd; color:#5c4400; }
  ol.plan { margin:.25rem 0 0; padding-left:1.3rem; }
  .fb { border-top:1px solid var(--line); padding:.5rem 0; } .fb p { margin:.2rem 0; white-space:pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>Beta features</h1>
  <p class="lead">Early-access features for Keystone licensees: create them, open or close them, choose who is in and read their feedback. Admins only.</p>
  <section>
    <h2>How it works</h2>
    <ol class="plan">
      <li><strong>Private beta</strong>: invite only. Enrol licensees below; nobody else sees it.</li>
      <li><strong>Public beta</strong>: shown on every eligible licensee's Labs page. Their admin can join or leave at any time while it is open. Close it to stop new joins.</li>
      <li><strong>Generally available</strong>: on for every licensee on an allowed plan. It can no longer be switched off.</li>
      <li><strong>Retired</strong>: off for everyone and hidden.</li>
    </ol>
    <p class="hint">Changes reach licensees' servers with the plan push: at once for one licensee, within 5 minutes for a catalogue change. In code, check <code>isEnabled("your_key")</code>.</p>
  </section>

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
      <h2>Features</h2>
      <div class="scroll"><table><thead><tr><th>Feature</th><th>Status</th><th>Plans</th><th>Joining</th><th>In</th><th>Feedback</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      <button id="newFeature" type="button">New feature</button>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
    </section>

    <section id="editor" class="hidden" aria-labelledby="editorTitle">
      <h2 id="editorTitle">New feature</h2>
      <form id="featureForm" class="grid" novalidate>
        <div><label for="f_key">Key</label><input id="f_key" name="key" autocapitalize="none" placeholder="ai_call_notes"><span class="hint">Used in code: isEnabled("key"). Lowercase letters, numbers and underscores. Cannot be changed later.</span></div>
        <div><label for="f_name">Name</label><input id="f_name" name="name" placeholder="AI call notes"></div>
        <div><label for="f_status">Status</label><select id="f_status" name="status"><option value="private_beta">Private beta</option><option value="public_beta">Public beta</option><option value="ga">Generally available</option><option value="retired">Retired</option></select></div>
        <div><span style="display:block;font-weight:600;margin:.5rem 0 .2rem">Plans that may join</span>
          <label class="inline"><input type="checkbox" name="plan" value="starter"> Starter</label>
          <label class="inline"><input type="checkbox" name="plan" value="growth"> Growth</label>
          <label class="inline"><input type="checkbox" name="plan" value="pro"> Pro</label>
          <span class="hint" style="display:block">None ticked = every plan.</span></div>
        <div><label class="inline" style="margin-top:2rem"><input id="f_open" type="checkbox" name="open" checked> Open to new members</label></div>
        <div><label for="f_feedback">Feedback link (optional)</label><input id="f_feedback" name="feedback_url" type="url" placeholder="https://"></div>
        <div><label for="f_docs">Help link (optional)</label><input id="f_docs" name="docs_url" type="url" placeholder="https://"></div>
        <div style="grid-column:1/-1"><label for="f_desc">Description</label><textarea id="f_desc" name="description" placeholder="What it does and what to try. Licensee admins read this."></textarea></div>
      </form>
      <button id="save" type="button">Save</button>
      <button id="cancel" type="button" class="quiet">Close</button>
      <div id="editMsg" class="msg hidden" role="status"></div>

      <div id="members" class="hidden">
        <h3>Licensees in this feature</h3>
        <div class="scroll"><table><thead><tr><th>Licensee</th><th>Plan</th><th>Joined</th><th>How</th><th></th></tr></thead><tbody id="memberRows"></tbody></table></div>
        <label for="q">Enrol a licensee</label>
        <input id="q" type="search" placeholder="Company, code or contact email">
        <button id="search" type="button" class="quiet">Search</button>
        <select id="pick" aria-label="Licensee to enrol"><option value="">Search first</option></select>
        <button id="enrol" type="button">Enrol</button>
        <div id="memberMsg" class="msg hidden" role="status"></div>
        <h3>Feedback received</h3>
        <div id="feedback"></div>
      </div>
    </section>

    <section>
      <h2>Website beta programme sign-ups</h2>
      <div class="scroll"><table><thead><tr><th>When</th><th>Name</th><th>Email</th><th>Brokerage</th><th>Interests</th></tr></thead><tbody id="signups"></tbody></table></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_beta_token";
  var STATUS = { private_beta: "Private beta", public_beta: "Public beta", ga: "Generally available", retired: "Retired" };
  var $ = function (id) { return document.getElementById(id); };
  var token = "", current = null;
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

  function load() {
    return api("GET", "/beta/features").then(function (r) {
      $("signin").className = "hidden"; $("app").className = "";
      var body = $("rows"); body.innerHTML = "";
      r.features.forEach(function (f) {
        var tr = document.createElement("tr");
        var name = document.createElement("div"); var strong = document.createElement("strong"); strong.textContent = f.name; name.appendChild(strong);
        var code = document.createElement("div"); code.className = "hint"; code.textContent = f.key; name.appendChild(code);
        cell(tr, name);
        cell(tr, badge(f.status, STATUS[f.status] || f.status));
        cell(tr, f.plans.length ? f.plans.join(", ") : "All plans");
        var joining = document.createElement("div");
        if (f.status === "public_beta" || f.status === "private_beta") {
          joining.appendChild(badge(f.open ? "open" : "retired", f.open ? "Open" : "Closed"));
          joining.appendChild(document.createTextNode(" "));
          joining.appendChild(btn(f.open ? "Close" : "Open", function () { patch(f.key, { open: !f.open }); }, true));
        } else joining.textContent = "-";
        cell(tr, joining);
        cell(tr, String(f.enrolled_count));
        cell(tr, String(f.feedback_count));
        cell(tr, btn("Manage", function () { openFeature(f.key); }));
        body.appendChild(tr);
      });
      if (!r.features.length) empty(body, 7, "No beta features yet. Choose New feature to add one.");
      return loadSignups();
    });
  }
  function loadSignups() {
    return api("GET", "/beta/signups").then(function (r) {
      var body = $("signups"); body.innerHTML = "";
      r.signups.forEach(function (s) {
        var tr = document.createElement("tr");
        [day(s.created_at), s.name, s.email, s.brokerage, (s.interests || []).join(", ") || "-"].forEach(function (c) { cell(tr, c); });
        body.appendChild(tr);
      });
      if (!r.signups.length) empty(body, 5, "No sign-ups yet.");
    });
  }
  function patch(key, body) {
    return api("PATCH", "/beta/features/" + encodeURIComponent(key), body).then(function () { return load(); })
      .catch(function (e) { if (e.message !== "unauthorized") alert(e.message); });
  }
  function fillForm(f) {
    var form = $("featureForm");
    $("f_key").value = f ? f.key : ""; $("f_key").disabled = !!f;
    $("f_name").value = f ? f.name : ""; $("f_status").value = f ? f.status : "private_beta";
    $("f_open").checked = f ? f.open : true; $("f_feedback").value = f && f.feedback_url ? f.feedback_url : "";
    $("f_docs").value = f && f.docs_url ? f.docs_url : ""; $("f_desc").value = f ? f.description : "";
    Array.prototype.forEach.call(form.querySelectorAll("input[name=plan]"), function (c) { c.checked = !!f && f.plans.indexOf(c.value) >= 0; });
  }
  function formBody() {
    var plans = Array.prototype.filter.call($("featureForm").querySelectorAll("input[name=plan]"), function (c) { return c.checked; }).map(function (c) { return c.value; });
    return { name: $("f_name").value.trim(), status: $("f_status").value, plans: plans, open: $("f_open").checked,
      feedback_url: $("f_feedback").value.trim(), docs_url: $("f_docs").value.trim(), description: $("f_desc").value.trim() };
  }
  function openFeature(key) {
    hide($("editMsg")); hide($("memberMsg"));
    return api("GET", "/beta/features/" + encodeURIComponent(key)).then(function (r) {
      current = r.feature; fillForm(r.feature);
      $("editorTitle").textContent = r.feature.name; $("editor").className = ""; $("members").className = "";
      var body = $("memberRows"); body.innerHTML = "";
      r.enrolments.forEach(function (m) {
        var tr = document.createElement("tr");
        cell(tr, m.company_name + " (" + m.company_code + ")"); cell(tr, m.plan); cell(tr, day(m.enrolled_at));
        cell(tr, m.source === "licensee" ? "Joined themselves" : "Enrolled by " + (m.enrolled_by || "staff"));
        cell(tr, btn("Remove", function () {
          if (!confirm("Remove " + m.company_name + " from " + current.name + "? The feature switches off for them.")) return;
          api("DELETE", "/beta/features/" + encodeURIComponent(current.key) + "/enrolments/" + m.licensee_id).then(function () { return openFeature(current.key); }).then(load)
            .catch(function (e) { if (e.message !== "unauthorized") show($("memberMsg"), e.message, false); });
        }, true));
        body.appendChild(tr);
      });
      if (!r.enrolments.length) empty(body, 5, "Nobody yet.");
      var fb = $("feedback"); fb.innerHTML = "";
      r.feedback.forEach(function (x) {
        var d = document.createElement("div"); d.className = "fb";
        var head = document.createElement("p"); head.className = "hint";
        head.textContent = day(x.created_at) + " - " + (x.company_name || "Unknown licensee") + (x.author_name ? ", " + x.author_name : "") + (x.author_email ? " (" + x.author_email + ")" : "") + (x.rating ? " - " + x.rating + " of 5" : "");
        var msg = document.createElement("p"); msg.textContent = x.message;
        d.appendChild(head); d.appendChild(msg); fb.appendChild(d);
      });
      if (!r.feedback.length) { var p = document.createElement("p"); p.className = "hint"; p.textContent = "No feedback yet."; fb.appendChild(p); }
      $("editor").scrollIntoView({ behavior: "smooth" });
    }).catch(function (e) { if (e.message !== "unauthorized") alert(e.message); });
  }
  $("newFeature").onclick = function () {
    current = null; fillForm(null); hide($("editMsg"));
    $("editorTitle").textContent = "New feature"; $("editor").className = ""; $("members").className = "hidden";
    $("f_key").focus();
  };
  $("cancel").onclick = function () { $("editor").className = "hidden"; current = null; };
  $("save").onclick = function () {
    var body = formBody(), btnEl = $("save"); btnEl.disabled = true;
    var p = current ? api("PATCH", "/beta/features/" + encodeURIComponent(current.key), body)
                    : api("POST", "/beta/features", Object.assign({ key: $("f_key").value.trim() }, body));
    p.then(function (r) {
        var text = "Saved." + (r.pushes_queued ? " Licensee servers are updated within 5 minutes." : "");
        return load().then(function () { return openFeature(r.feature.key); }).then(function () { show($("editMsg"), text, true); });
      })
      .catch(function (e) { if (e.message !== "unauthorized") show($("editMsg"), e.message, false); })
      .then(function () { btnEl.disabled = false; });
  };
  $("search").onclick = function () {
    api("GET", "/licensees?q=" + encodeURIComponent($("q").value.trim())).then(function (r) {
      var sel = $("pick"); sel.innerHTML = "";
      r.licensees.forEach(function (l) { var o = document.createElement("option"); o.value = l.id; o.textContent = l.company_name + " (" + l.company_code + ") - " + l.status + ", " + l.plan; sel.appendChild(o); });
      if (!r.licensees.length) { var o = document.createElement("option"); o.value = ""; o.textContent = "No match"; sel.appendChild(o); }
    }).catch(function (e) { if (e.message !== "unauthorized") show($("memberMsg"), e.message, false); });
  };
  $("enrol").onclick = function () {
    var id = $("pick").value; if (!id || !current) return show($("memberMsg"), "Choose a licensee first.", false);
    api("POST", "/beta/features/" + encodeURIComponent(current.key) + "/enrolments", { licensee_id: id })
      .then(function (r) { return openFeature(current.key).then(load).then(function () {
        show($("memberMsg"), r.plan_push && !r.plan_push.ok ? "Enrolled. Their server could not be reached yet; it is retried every 5 minutes." : "Enrolled.", !(r.plan_push && !r.plan_push.ok)); }); })
      .catch(function (e) { if (e.message !== "unauthorized") show($("memberMsg"), e.message, false); });
  };
  $("useToken").onclick = function () {
    token = $("token").value.trim(); if (!token) return show($("signinMsg"), "Enter a token.", false);
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

export function betaPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(BETA_PAGE_HTML);
  });
  return router;
}
