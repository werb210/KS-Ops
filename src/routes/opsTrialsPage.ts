// KS_OPS_v13_ADMIN_TRIAL - the free-trial ops page served at /ops/trials. Same pattern as /ops/quickbooks: plain HTML
// with a little script, a KS-Ops staff token (or OPS_ADMIN_TOKEN) kept in this tab's sessionStorage only, and calls to
// /api/ops/trials and /api/ops/licensees. Dark text on light backgrounds throughout (contrast well over 4.5:1).
import { Router } from "express";

export const TRIALS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone free trials</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:60rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  input, select { width:100%; padding:.55rem .65rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.5rem .5rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); }
  button:disabled { opacity:.6; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:0 1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  ol.plan { margin:.25rem 0 0; padding-left:1.3rem; }
</style>
</head>
<body>
<main>
  <h1>Free trials</h1>
  <p class="lead">Start a 14-day free trial with no payment, for a prospect or an existing licensee. Admins only.</p>
  <section>
    <h2>How the trial works</h2>
    <ol class="plan">
      <li>Days 1 to 14: free, with every Pro feature.</li>
      <li>Days 15 to 28: billed for the plan and billing interval they signed up for - Starter or Growth, monthly or annual (an annual plan is invoiced for the year on day 15). Stripe emails the invoice. Still with every Pro feature.</li>
      <li>From day 29: the features of the plan they signed up for.</li>
      <li>This trial is separate from the 14-day Pro trial a brokerage's admin can start in the app: one never uses up the other.</li>
    </ol>
    <p class="hint">The contact is emailed these dates. Who started the trial is recorded in the audit log.</p>
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
      <h2>Existing licensee or sign-up</h2>
      <label for="q">Find a licensee</label>
      <input id="q" type="search" placeholder="Company, code or contact email">
      <button id="search" type="button" class="quiet">Search</button>
      <label for="pick">Licensee</label>
      <select id="pick"><option value="">Search first</option></select>
      <label for="pickPlan">Bill from day 15 as</label>
      <select id="pickPlan">
        <option value="">The plan and interval they signed up for</option>
        <option value="starter|monthly">Starter, monthly</option><option value="starter|annual">Starter, annual</option>
        <option value="growth|monthly">Growth, monthly</option><option value="growth|annual">Growth, annual</option>
      </select>
      <button id="startExisting" type="button">Start free trial</button>
      <div id="existingMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>New prospect</h2>
      <form id="prospect" class="grid" novalidate>
        <div><label for="company_name">Company name</label><input id="company_name" name="company_name" autocomplete="organization"></div>
        <div><label for="legal_name">Legal name</label><input id="legal_name" name="legal_name"></div>
        <div><label for="company_code">Company code</label><input id="company_code" name="company_code" autocapitalize="none"><span class="hint">3 to 32 lowercase letters, numbers and hyphens.</span></div>
        <div><label for="seats">Seats</label><input id="seats" name="seats" type="number" min="1" value="1"></div>
        <div><label for="contact_name">Contact name</label><input id="contact_name" name="contact_name" autocomplete="name"></div>
        <div><label for="contact_email">Contact email</label><input id="contact_email" name="contact_email" type="email" autocomplete="email"></div>
        <div><label for="contact_phone">Contact phone</label><input id="contact_phone" name="contact_phone" type="tel" autocomplete="tel"></div>
        <div><label for="country">Country</label><select id="country" name="country"><option value="CA">Canada</option><option value="US">United States</option></select></div>
        <div><label for="province_state">Province or state</label><input id="province_state" name="province_state" placeholder="AB"></div>
        <div><label for="plan">Plan (billed from day 15)</label><select id="plan" name="plan"><option value="starter">Starter</option><option value="growth">Growth</option></select></div>
        <div><label for="billing_interval">Billing</label><select id="billing_interval" name="billing_interval"><option value="monthly">Monthly</option><option value="annual">Annual (the year is invoiced on day 15)</option></select></div>
      </form>
      <button id="startNew" type="button">Create and start free trial</button>
      <div id="newMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>Trials started</h2>
      <div class="scroll"><table><thead><tr><th>Company</th><th>Started</th><th>By</th><th>Billing from</th><th>Plan</th><th>Pro until</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_trials_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
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
  function load() {
    return api("GET", "/trials").then(function (r) {
      $("signin").className = "hidden"; $("app").className = "";
      var body = $("rows"); body.innerHTML = "";
      r.trials.forEach(function (t) {
        var tr = document.createElement("tr");
        [t.company_name + " (" + t.company_code + ")", day(t.started_at), t.started_by || "", day(t.billing_starts_at), (t.plan || "") + (t.billing_interval ? ", " + t.billing_interval : ""), day(t.pro_until), t.ended_at ? "ended (" + (t.end_reason || "") + ")" : t.status]
          .forEach(function (c) { var td = document.createElement("td"); td.textContent = c; tr.appendChild(td); });
        body.appendChild(tr);
      });
      if (!r.trials.length) { var tr = document.createElement("tr"); var td = document.createElement("td"); td.colSpan = 7; td.textContent = "No trials yet."; tr.appendChild(td); body.appendChild(tr); }
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
      r.licensees.forEach(function (l) { var o = document.createElement("option"); o.value = l.id; o.textContent = l.company_name + " (" + l.company_code + ") - " + l.status + ", " + l.plan; sel.appendChild(o); });
      if (!r.licensees.length) { var o = document.createElement("option"); o.value = ""; o.textContent = "No match"; sel.appendChild(o); }
    }).catch(function (e) { show($("existingMsg"), e.message, false); });
  };
  function start(body, msgEl, btn) {
    btn.disabled = true;
    api("POST", "/trials", body).then(function (r) { show(msgEl, r.message, true); return load(); })
      .catch(function (e) { if (e.message !== "unauthorized") show(msgEl, e.message, false); })
      .then(function () { btn.disabled = false; });
  }
  $("startExisting").onclick = function () {
    var id = $("pick").value; if (!id) return show($("existingMsg"), "Choose a licensee first.", false);
    var choice = $("pickPlan").value; var body = { licensee_id: id };
    if (choice) { body.plan = choice.split("|")[0]; body.billing_interval = choice.split("|")[1]; }
    if (!confirm("Start a free trial for this licensee? It is billed from day 15 for " + (choice ? choice.replace("|", ", ") : "the plan it signed up for") + ".")) return;
    start(body, $("existingMsg"), $("startExisting"));
  };
  $("startNew").onclick = function () {
    var f = {}; Array.prototype.forEach.call($("prospect").elements, function (el) { if (el.name) f[el.name] = el.value.trim(); });
    f.seats = Number(f.seats) || 1;
    start({ licensee: f }, $("newMsg"), $("startNew"));
  };
  $("refresh").onclick = function () { load().catch(function () {}); };
  $("signout").onclick = function () { signOut(""); };
  if (token) load().catch(function () {});
})();
</script>
</body>
</html>
`;

export function trialsPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(TRIALS_PAGE_HTML);
  });
  return router;
}
