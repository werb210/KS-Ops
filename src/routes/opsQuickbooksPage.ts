// The QuickBooks ops page served at /ops/quickbooks. Plain HTML with a little script: it asks for a KS-Ops staff token
// (or the break-glass OPS_ADMIN_TOKEN), keeps it in this tab's sessionStorage only, and calls /api/ops/quickbooks/*.
// Dark text on light backgrounds throughout (contrast well over 4.5:1).
export const QBO_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone QuickBooks</title>
<style>
  :root { --ink:#14171c; --muted:#454d59; --line:#cfd5dd; --bg:#f6f7f9; --card:#ffffff; --accent:#0b4f8a; --ok:#0f5132; --okbg:#d1e7dd; --bad:#842029; --badbg:#f8d7da; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:56rem; margin:0 auto; padding:1.5rem 1rem 3rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:0 0 .75rem; }
  p.lead { color:var(--muted); margin:0 0 1.25rem; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.2rem; margin-bottom:1rem; }
  label { display:block; font-weight:600; margin:.5rem 0 .2rem; }
  input { width:100%; padding:.55rem .65rem; font:inherit; color:var(--ink); background:#fff; border:1px solid #8a94a3; border-radius:6px; }
  .hint { color:var(--muted); font-size:.9rem; }
  button { font:inherit; font-weight:600; padding:.55rem 1rem; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; margin:.5rem .5rem 0 0; }
  button.quiet { background:#fff; color:var(--accent); }
  button.danger { background:#fff; color:var(--bad); border-color:var(--bad); }
  button:focus-visible, input:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  .pill { display:inline-block; padding:.1rem .6rem; border-radius:999px; font-weight:600; font-size:.9rem; }
  .pill.ok { background:var(--okbg); color:var(--ok); } .pill.bad { background:var(--badbg); color:var(--bad); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.3rem 1rem; margin:.75rem 0 0; } dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:0 1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; } td.err { color:var(--bad); overflow-wrap:anywhere; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>QuickBooks for Keystone</h1>
  <p class="lead">Keystone's own QuickBooks Online: Stripe invoices, payments, refunds and fees for licensees are posted here.</p>

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
      <h2>Connection</h2>
      <div id="state"></div>
      <dl id="details"></dl>
      <button id="connect" type="button">Connect QuickBooks</button>
      <button id="disconnect" type="button" class="danger">Disconnect</button>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
      <div id="connMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>Settings</h2>
      <p class="hint">QuickBooks ids (from the address bar in QuickBooks, or its API). Leave empty when not used.</p>
      <form id="settings" class="grid">
        <div><label for="tax_code_id">Sales tax code</label><input id="tax_code_id" name="tax_code_id"><span class="hint">Used on lines when Stripe charged tax.</span></div>
        <div><label for="exempt_tax_code_id">No-tax code</label><input id="exempt_tax_code_id" name="exempt_tax_code_id"><span class="hint">Used when Stripe charged no tax, and on fees.</span></div>
        <div><label for="income_account_id">Income account</label><input id="income_account_id" name="income_account_id"><span class="hint">For the Keystone items KS-Ops creates. Empty: the first Income account.</span></div>
        <div><label for="deposit_account_id">Stripe clearing / bank account</label><input id="deposit_account_id" name="deposit_account_id"><span class="hint">Payments land here; refunds and fees are paid from it. Empty: Undeposited Funds, credit memos, no fees.</span></div>
        <div><label for="fee_account_id">Stripe fee expense account</label><input id="fee_account_id" name="fee_account_id"><span class="hint">Needed (with the account above) to record Stripe fees.</span></div>
      </form>
      <button id="saveSettings" type="button">Save settings</button>
      <div id="setMsg" class="msg hidden" role="status"></div>
    </section>

    <section>
      <h2>Posting queue</h2>
      <p id="counts" class="hint"></p>
      <div class="scroll"><table><thead><tr><th>What</th><th>Stripe id</th><th>Licensee</th><th>Status</th><th>QuickBooks</th><th>Problem</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_qbo_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = sessionStorage.getItem(KEY) || ""; } catch (e) { token = ""; }
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
  function api(method, path, body) {
    return fetch("/api/ops/quickbooks" + path, {
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
  function row(cells) {
    var tr = document.createElement("tr");
    cells.forEach(function (c) { var td = document.createElement("td"); if (c && c.err) { td.className = "err"; td.textContent = c.err; } else if (c && c.node) { td.appendChild(c.node); } else { td.textContent = c == null ? "" : String(c); } tr.appendChild(td); });
    return tr;
  }
  function load() {
    return api("GET", "/status").then(function (s) {
      $("signin").className = "hidden"; $("app").className = "";
      var st = $("state"); st.innerHTML = "";
      var pill = document.createElement("span");
      pill.className = "pill " + (s.connected ? "ok" : "bad");
      pill.textContent = !s.configured ? "Not set up on the server" : s.connected ? "Connected" : "Not connected";
      st.appendChild(pill);
      var d = $("details"); d.innerHTML = "";
      var add = function (k, v) { var dt = document.createElement("dt"); dt.textContent = k; var dd = document.createElement("dd"); dd.textContent = v == null || v === "" ? "-" : String(v); d.appendChild(dt); d.appendChild(dd); };
      if (!s.configured) add("Missing settings", s.missing.join(", "));
      add("Environment", s.environment);
      add("Intuit redirect address", s.redirect_uri);
      if (s.connection) {
        add("Company", s.connection.company_name || ("Realm " + s.connection.realm_id));
        add("Connected by", s.connection.connected_by);
        add("Connected at", new Date(s.connection.connected_at).toLocaleString());
        add("Reconnect before", s.connection.refresh_expires_at ? new Date(s.connection.refresh_expires_at).toLocaleDateString() : "");
        if (!s.connection.environment_matches) add("Warning", "Connected in " + s.connection.environment + " but the server is set to " + s.environment + ". Reconnect.");
      }
      $("connect").disabled = !s.configured; $("connect").textContent = s.connected ? "Reconnect QuickBooks" : "Connect QuickBooks";
      $("disconnect").className = s.connected ? "danger" : "danger hidden";
      Object.keys(s.settings || {}).forEach(function (k) { var el = $(k); if (el) el.value = s.settings[k] || ""; });
      var o = s.outbox; $("counts").textContent = o.pending + " waiting (" + o.failing + " with problems), " + o.done + " posted, " + o.skipped + " skipped.";
      return api("GET", "/outbox");
    }).then(function (r) {
      var body = $("rows"); body.innerHTML = "";
      r.items.forEach(function (it) {
        var btn = null;
        if (it.status !== "done") { btn = document.createElement("button"); btn.type = "button"; btn.className = "quiet"; btn.textContent = "Retry now"; btn.onclick = function () { api("POST", "/outbox/" + it.id + "/retry").then(load).catch(function (e) { alert(e.message); }); }; }
        body.appendChild(row([it.kind, it.stripe_id, it.company_name || "", it.status + (it.attempts ? " (" + it.attempts + " tries)" : ""), it.qbo_id || it.note || "", it.last_error ? { err: it.last_error } : "", btn ? { node: btn } : ""]));
      });
      if (!r.items.length) body.appendChild(row(["Nothing yet", "", "", "", "", "", ""]));
    });
  }
  $("useToken").onclick = function () {
    token = $("token").value.trim(); if (!token) return show($("signinMsg"), "Enter a token.", false);
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    load().catch(function (e) { if (e.message !== "unauthorized") show($("signinMsg"), e.message, false); });
  };
  $("signout").onclick = function () { signOut(""); };
  $("refresh").onclick = function () { load().catch(function (e) { show($("connMsg"), e.message, false); }); };
  $("connect").onclick = function () { api("POST", "/connect").then(function (r) { window.location.assign(r.authorize_url); }).catch(function (e) { show($("connMsg"), e.message, false); }); };
  $("disconnect").onclick = function () {
    if (!confirm("Disconnect QuickBooks? Posting stops until someone connects again.")) return;
    api("POST", "/disconnect").then(function (r) { show($("connMsg"), r.message || "Disconnected.", r.revoked !== false); return load(); }).catch(function (e) { show($("connMsg"), e.message, false); });
  };
  $("saveSettings").onclick = function () {
    var body = {}; ["tax_code_id", "exempt_tax_code_id", "income_account_id", "deposit_account_id", "fee_account_id"].forEach(function (k) { body[k] = $(k).value.trim(); });
    api("PATCH", "/settings", body).then(function () { show($("setMsg"), "Saved.", true); }).catch(function (e) { show($("setMsg"), e.message, false); });
  };
  if (token) load().catch(function () {});
})();
</script>
</body>
</html>
`;
