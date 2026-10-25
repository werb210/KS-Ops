// KS_OPS_AUTO_PROVISION_v1 - the provisioning ops page served at /ops/provisioning. Same pattern as /ops/trials: plain
// HTML with a little script, a KS-Ops staff token (or OPS_ADMIN_TOKEN) kept in this tab's sessionStorage only, and calls
// to /api/ops/provisioning. Dark text on light backgrounds throughout (contrast well over 4.5:1); status is always
// written out in words, never shown by colour alone.
import { Router } from "express";

export const PROVISIONING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone provisioning</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; --warn:#664d03; --warnbg:#fff3cd; --info:#084298; --infobg:#cfe2ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:68rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; } h3 { font-size:1rem; margin:1rem 0 .5rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  input, select, textarea { width:100%; padding:.55rem .65rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.45rem .9rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.4rem .4rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); }
  button:disabled { opacity:.6; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  .tag { display:inline-block; padding:.05rem .45rem; border-radius:4px; font-size:.85rem; font-weight:600; border:1px solid currentColor; }
  .s-done, .s-manual { background:var(--okbg); color:var(--ok); }
  .s-failed { background:var(--badbg); color:var(--bad); }
  .s-blocked, .s-waiting_for_setup { background:var(--warnbg); color:var(--warn); }
  .s-running { background:var(--infobg); color:var(--info); }
  .s-pending, .s-cancelled { background:#eef0f3; color:var(--ink); }
  pre.log { background:#f1f3f5; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:.6rem; max-height:22rem; overflow:auto; white-space:pre-wrap; font-size:.85rem; }
  ul.check { margin:.25rem 0 0; padding-left:1.3rem; }
  .run { border-top:1px solid var(--line); padding-top:.75rem; margin-top:.75rem; }
</style>
</head>
<body>
<main>
  <h1>Provisioning</h1>
  <p class="lead">Automatic setup of each licensee's own Keystone copy after payment or a staff free trial, and teardown after cancellation once the retention rules allow it.</p>

  <section id="signin">
    <h2>Sign in</h2>
    <label for="token">Keystone operations token</label>
    <input id="token" type="password" autocomplete="off" placeholder="Staff token or OPS_ADMIN_TOKEN">
    <p class="hint">Kept in this browser tab only, and forgotten when the tab closes.</p>
    <button id="useToken" type="button">Continue</button>
    <div id="signinMsg" class="msg bad hidden" role="alert"></div>
  </section>

  <div id="app" class="hidden">
    <section id="setupBox" class="hidden">
      <h2>Waiting for manual setup</h2>
      <p>Automatic setup is not fully configured. Runs wait here and start by themselves once these are in place (see KS-Ops docs/AUTO_PROVISIONING.md):</p>
      <ul id="setupList" class="check"></ul>
    </section>

    <section>
      <h2>Start a run</h2>
      <label for="q">Find a licensee</label>
      <input id="q" type="search" placeholder="Company, code or contact email">
      <button id="search" type="button" class="quiet">Search</button>
      <label for="pick">Licensee</label>
      <select id="pick"><option value="">Search first</option></select>
      <label for="kind">What</label>
      <select id="kind"><option value="provision">Set up (provision)</option><option value="teardown">Tear down (cancelled licensees only)</option></select>
      <label><input id="dry" type="checkbox" style="width:auto"> Dry run: show the plan only, change nothing</label>
      <button id="start" type="button">Start</button>
      <div id="startMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>Runs</h2>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
      <div id="runs"></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_provisioning_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  var open = {};
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
  function el(tag, attrs, text) { var e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (text !== undefined) e.textContent = text; return e; }
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
  function when(v) { return v ? new Date(v).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "-"; }
  function words(s) { return String(s || "").replace(/_/g, " "); }
  function tag(s) { return el("span", { "class": "tag s-" + s }, words(s)); }
  function stepRow(run, s) {
    var tr = el("tr");
    tr.appendChild(el("td", null, s.label));
    var st = el("td"); st.appendChild(tag(s.status)); tr.appendChild(st);
    tr.appendChild(el("td", null, String(s.attempts)));
    tr.appendChild(el("td", null, s.last_error || (s.done_by ? "done by " + s.done_by : "")));
    var act = el("td");
    if (run.status !== "done" && run.status !== "cancelled" && s.status !== "done" && s.status !== "manual") {
      var retry = el("button", { type: "button", "class": "quiet" }, "Retry step");
      retry.onclick = function () { act1("POST", "/provisioning/runs/" + run.id + "/retry", { step: s.step }); };
      var done = el("button", { type: "button", "class": "quiet" }, "Mark done manually");
      done.onclick = function () {
        var note = prompt("What did you do by hand for: " + s.label + "?");
        if (note) act1("POST", "/provisioning/runs/" + run.id + "/steps/" + s.step + "/done", { note: note });
      };
      act.appendChild(retry); act.appendChild(done);
    }
    tr.appendChild(act);
    return tr;
  }
  function act1(method, path, body) {
    api(method, path, body).then(function () { return load(); }).catch(function (e) { if (e.message !== "unauthorized") alert(e.message); });
  }
  function renderRun(run, full) {
    var box = el("div", { "class": "run" });
    var head = el("h3");
    head.textContent = (run.licensee ? run.licensee.company_name + " (" + run.licensee.company_code + ")" : run.licensee_id) + " - " + run.kind + (run.dry_run ? " (dry run)" : "") + " ";
    head.appendChild(tag(run.status));
    box.appendChild(head);
    box.appendChild(el("p", { "class": "hint" }, "Started " + when(run.created_at) + " by " + run.created_by + " (" + words(run.trigger) + "). Updated " + when(run.updated_at) + "." + (run.last_error ? " Last problem: " + run.last_error : "")));
    if (run.status === "waiting_for_setup" && run.setup_missing && run.setup_missing.length) {
      var ul = el("ul", { "class": "check" });
      run.setup_missing.forEach(function (m) { ul.appendChild(el("li", null, m.label)); });
      box.appendChild(el("p", null, "Waiting for manual setup:")); box.appendChild(ul);
    }
    var wrap = el("div", { "class": "scroll" });
    var t = el("table"); var th = el("tr");
    ["Step", "Status", "Tries", "Details", ""].forEach(function (c) { th.appendChild(el("th", null, c)); });
    var thead = el("thead"); thead.appendChild(th); t.appendChild(thead);
    var tb = el("tbody"); run.steps.forEach(function (s) { tb.appendChild(stepRow(run, s)); }); t.appendChild(tb);
    wrap.appendChild(t); box.appendChild(wrap);
    var logBtn = el("button", { type: "button", "class": "quiet" }, open[run.id] ? "Hide log" : "Show log");
    logBtn.onclick = function () { open[run.id] = !open[run.id]; load(); };
    box.appendChild(logBtn);
    if (run.status !== "done" && run.status !== "cancelled") {
      var cancel = el("button", { type: "button", "class": "quiet" }, "Cancel run");
      cancel.onclick = function () { if (confirm("Cancel this run? Anything already created stays.")) act1("POST", "/provisioning/runs/" + run.id + "/cancel"); };
      box.appendChild(cancel);
    }
    if (full) {
      var pre = el("pre", { "class": "log" });
      pre.textContent = (full.logs || []).map(function (l) { return when(l.created_at) + "  " + l.level.toUpperCase() + "  " + (l.step ? "[" + l.step + "] " : "") + l.message; }).join("\\n") || "No log yet.";
      box.appendChild(pre);
      if (full.status_page) box.appendChild(el("p", { "class": "hint" }, "Customer status page: " + full.status_page));
    }
    return box;
  }
  function load() {
    return api("GET", "/provisioning").then(function (r) {
      $("signin").className = "hidden"; $("app").className = "";
      var missing = (r.setup_missing && r.setup_missing.provision) || [];
      $("setupBox").className = missing.length ? "" : "hidden";
      var sl = $("setupList"); sl.innerHTML = "";
      missing.forEach(function (m) { sl.appendChild(el("li", null, m.label)); });
      var box = $("runs"); box.innerHTML = "";
      if (!r.runs.length) box.appendChild(el("p", null, "No runs yet."));
      return Promise.all(r.runs.map(function (run) {
        return open[run.id] ? api("GET", "/provisioning/runs/" + run.id).then(function (d) { return [run, Object.assign({}, d.run, { status_page: d.status_page })]; }) : Promise.resolve([run, null]);
      })).then(function (pairs) { pairs.forEach(function (p) { box.appendChild(renderRun(p[0], p[1])); }); });
    });
  }
  $("useToken").onclick = function () {
    token = $("token").value.trim(); if (!token) return show($("signinMsg"), "Enter a token.", false);
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    load().catch(function (e) { if (e.message !== "unauthorized") show($("signinMsg"), e.message, false); });
  };
  $("search").onclick = function () {
    api("GET", "/licensees?q=" + encodeURIComponent($("q").value.trim())).then(function (r) {
      var sel = $("pick"); sel.innerHTML = "";
      r.licensees.forEach(function (l) { var o = el("option", { value: l.id }, l.company_name + " (" + l.company_code + ") - " + l.status); sel.appendChild(o); });
      if (!r.licensees.length) sel.appendChild(el("option", { value: "" }, "No match"));
    }).catch(function (e) { show($("startMsg"), e.message, false); });
  };
  $("start").onclick = function () {
    var id = $("pick").value; if (!id) return show($("startMsg"), "Choose a licensee first.", false);
    var kind = $("kind").value, dry = $("dry").checked;
    if (kind === "teardown" && !dry && !confirm("Tear down this licensee? Its Azure resources are deleted once the retention rules allow it.")) return;
    $("start").disabled = true;
    api("POST", "/provisioning", { licensee_id: id, kind: kind, dry_run: dry }).then(function (r) { show($("startMsg"), r.message, true); open[r.run.id] = true; return load(); })
      .catch(function (e) { if (e.message !== "unauthorized") show($("startMsg"), e.message, false); })
      .then(function () { $("start").disabled = false; });
  };
  $("refresh").onclick = function () { load().catch(function () {}); };
  $("signout").onclick = function () { signOut(""); };
  if (token) load().catch(function () {});
  setInterval(function () { if (token && !document.hidden) load().catch(function () {}); }, 15000);
})();
</script>
</body>
</html>
`;

export function provisioningPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(PROVISIONING_PAGE_HTML);
  });
  return router;
}
