// KS_OPS_NUMBER_PORTING_v1 - the number transfer (port-in) page served at /ops/porting. Same pattern as /ops/provisioning:
// plain HTML with a little script, a staff token kept in this tab's sessionStorage only, calls to /api/ops/porting.
// Status is always written in words, never shown by colour alone; dark text on light backgrounds throughout.
import { Router } from "express";

export const PORTING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Keystone number transfers</title>
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
  button.quiet { background:#fff; color:var(--accent); } button.small { padding:.15rem .5rem; font-size:.85rem; margin:0; }
  button:disabled { opacity:.6; cursor:not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:3px solid #f0b400; outline-offset:2px; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; } th, td { text-align:left; padding:.4rem .35rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .msg { margin-top:.75rem; padding:.6rem .8rem; border-radius:6px; } .msg.ok { background:var(--okbg); color:var(--ok); } .msg.bad { background:var(--badbg); color:var(--bad); }
  .hidden { display:none; } .scroll { overflow-x:auto; }
  .tag { display:inline-block; padding:.05rem .45rem; border-radius:4px; font-size:.85rem; font-weight:600; border:1px solid currentColor; }
  .s-completed { background:var(--okbg); color:var(--ok); } .s-rejected { background:var(--badbg); color:var(--bad); }
  .s-ready_to_submit, .s-carrier_approval_pending { background:var(--warnbg); color:var(--warn); }
  .s-submitted, .s-scheduled { background:var(--infobg); color:var(--info); } .s-draft, .s-cancelled { background:#eef0f3; color:var(--ink); }
  td.v { font-family:ui-monospace,Menlo,Consolas,monospace; word-break:break-all; }
  ul.check { margin:.25rem 0 0; padding-left:1.3rem; }
</style>
</head>
<body>
<main>
  <h1>Number transfers</h1>
  <p class="lead">Brokerages keeping their existing phone numbers. Submit each Ready request to Twilio (Console for toll-free, Twilio's porting form for local and mobile) into the licensee's own sub-account, then record each step here: the brokerage owner is emailed every time. <a href="/ops/provisioning">Provisioning</a></p>

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
      <h2>Requests</h2>
      <label for="filter">Show</label>
      <select id="filter"><option value="">All (things to do first)</option></select>
      <button id="refresh" type="button" class="quiet">Refresh</button>
      <button id="signout" type="button" class="quiet">Sign out</button>
      <div class="scroll"><table><thead><tr><th>Brokerage</th><th>Numbers</th><th>Carrier</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody id="list"></tbody></table></div>
      <div id="listMsg" class="msg hidden" role="status"></div>
    </section>

    <section id="detail" class="hidden" aria-live="polite">
      <h2 id="dTitle">Request</h2>
      <p id="dStatus"></p>
      <h3>Submit to Twilio</h3>
      <p id="dWhere" class="hint"></p>
      <div class="scroll"><table><tbody id="dFields"></tbody></table></div>
      <ul id="dNotes" class="check"></ul>
      <button id="dBill" type="button" class="quiet">Download the bill</button>
      <button id="dLoa" type="button" class="quiet">Download the signed letter of authorization</button>
      <p id="dLoaWarn" class="msg bad hidden"></p>
      <h3>Move the status</h3>
      <label for="dNext">New status</label>
      <select id="dNext"></select>
      <div id="dFocBox" class="hidden"><label for="dFoc">FOC (transfer) date the carrier confirmed</label><input id="dFoc" type="date"></div>
      <div id="dReasonBox" class="hidden"><label for="dReason">Reason (sent to the brokerage)</label><textarea id="dReason" rows="3"></textarea></div>
      <div id="dRefBox" class="hidden"><label for="dRef">Twilio port request id or reference</label><input id="dRef" type="text" placeholder="PX... or ticket number"></div>
      <p class="hint" id="dNextHint"></p>
      <button id="dSave" type="button">Save status and email the owner</button>
      <div id="dMsg" class="msg hidden" role="status"></div>
      <h3>History</h3>
      <div class="scroll"><table><thead><tr><th>When</th><th>From</th><th>To</th><th>By</th><th>Note</th><th>Told</th></tr></thead><tbody id="dEvents"></tbody></table></div>
    </section>
  </div>
</main>
<script>
(function () {
  var KEY = "ks_ops_porting_token";
  var $ = function (id) { return document.getElementById(id); };
  var token = "";
  try { token = sessionStorage.getItem(KEY) || sessionStorage.getItem("ks_ops_provisioning_token") || ""; } catch (e) { token = ""; }
  var current = null; var labels = {};
  function show(el, text, ok) { el.textContent = text; el.className = "msg " + (ok ? "ok" : "bad"); }
  function el(tag, attrs, text) { var e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (text !== undefined) e.textContent = text; return e; }
  function call(method, path, body, raw) {
    return fetch("/api/ops" + path, {
      method: method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) { signOut("Your token was not accepted. Sign in again."); throw new Error("unauthorized"); }
      if (raw && r.ok) return r;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.message || (j.errors ? Object.keys(j.errors).map(function (k) { return j.errors[k]; }).join(" ") : "") || j.error || ("Request failed (" + r.status + ")"));
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
  function tag(s, label) { return el("span", { "class": "tag s-" + s }, label || labels[s] || s); }
  function download(path, fallbackName) {
    call("GET", path, null, true).then(function (r) {
      var cd = r.headers.get("Content-Disposition") || ""; var m = /filename="([^"]+)"/.exec(cd);
      return r.blob().then(function (b) { var a = el("a", { href: URL.createObjectURL(b), download: m ? m[1] : fallbackName }); document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); });
    }).catch(function (e) { show($("dMsg"), e.message, false); });
  }
  function load() {
    var f = $("filter").value;
    call("GET", "/porting" + (f ? "?status=" + encodeURIComponent(f) : "")).then(function (j) {
      if ($("filter").options.length === 1) j.statuses.forEach(function (s) { labels[s.status] = s.label; $("filter").appendChild(el("option", { value: s.status }, s.label)); });
      j.statuses.forEach(function (s) { labels[s.status] = s.label; });
      var tb = $("list"); tb.textContent = "";
      if (!j.requests.length) { var tr0 = el("tr"); var td0 = el("td", { colspan: "6" }, "No requests."); tr0.appendChild(td0); tb.appendChild(tr0); }
      j.requests.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(el("td", null, r.company_name + " (" + r.company_code + ")"));
        tr.appendChild(el("td", null, r.numbers.map(function (n) { return n.phone_number + " - " + n.assignee_name; }).join("; ")));
        tr.appendChild(el("td", null, r.carrier_label));
        var st = el("td"); st.appendChild(tag(r.status, r.status_label)); if (r.needs_signature) st.appendChild(el("div", { "class": "hint" }, "Letter needs signing")); tr.appendChild(st);
        tr.appendChild(el("td", null, when(r.updated_at)));
        var b = el("button", { type: "button", "class": "quiet small" }, "Open"); b.addEventListener("click", function () { openDetail(r.id); });
        var tdb = el("td"); tdb.appendChild(b); tr.appendChild(tdb);
        tb.appendChild(tr);
      });
    }).catch(function (e) { if (e.message !== "unauthorized") show($("listMsg"), e.message, false); });
  }
  function openDetail(id) {
    call("GET", "/porting/" + id).then(function (j) {
      current = j.request;
      $("detail").className = "";
      $("dTitle").textContent = (j.licensee ? j.licensee.company_name + ": " : "") + j.request.numbers.map(function (n) { return n.phone_number; }).join(", ");
      $("dStatus").textContent = ""; $("dStatus").appendChild(tag(j.request.status, j.request.status_label));
      $("dStatus").appendChild(document.createTextNode(" " + j.request.status_message + (j.request.foc_date ? " FOC " + j.request.foc_date + "." : "") + (j.request.attach_error ? " Last attach problem: " + j.request.attach_error : "")));
      $("dWhere").textContent = j.checklist.where;
      var fb = $("dFields"); fb.textContent = "";
      j.checklist.fields.concat(j.request.numbers.map(function (n) { return ["Belongs to (" + n.phone_number + ")", n.assignee_name + (n.temporary_number ? ", forwarded to " + n.temporary_number : "") + (n.forwarding_tested_at ? " (forwarding tested)" : "")]; })).forEach(function (f) {
        var tr = el("tr"); tr.appendChild(el("th", { scope: "row" }, f[0])); tr.appendChild(el("td", { "class": "v" }, f[1]));
        var c = el("button", { type: "button", "class": "quiet small", "aria-label": "Copy " + f[0] }, "Copy");
        c.addEventListener("click", function () { navigator.clipboard.writeText(String(f[1])).then(function () { c.textContent = "Copied"; setTimeout(function () { c.textContent = "Copy"; }, 1500); }); });
        var td = el("td"); td.appendChild(c); tr.appendChild(td); fb.appendChild(tr);
      });
      var nl = $("dNotes"); nl.textContent = ""; j.checklist.notes.forEach(function (n) { nl.appendChild(el("li", null, n)); });
      $("dBill").disabled = !j.checklist.bill;
      $("dLoa").disabled = !j.request.loa;
      if (!j.checklist.loa_ok) { $("dLoaWarn").className = "msg bad"; $("dLoaWarn").textContent = j.request.loa ? "The letter is more than 30 days old: marking it submitted sends it back to the brokerage to sign again." : "The letter of authorization is not signed yet."; }
      else $("dLoaWarn").className = "hidden";
      var sel = $("dNext"); sel.textContent = "";
      if (!j.request.next.length) sel.appendChild(el("option", { value: "" }, "No further steps"));
      j.request.next.forEach(function (s) { sel.appendChild(el("option", { value: s }, s === j.request.status ? "Change the FOC date" : labels[s] || s)); });
      sel.dispatchEvent(new Event("change"));
      $("dRef").value = j.request.twilio_reference || j.request.twilio_port_sid || "";
      var eb = $("dEvents"); eb.textContent = "";
      j.events.forEach(function (ev) {
        var tr = el("tr");
        [when(ev.created_at), ev.from_status ? labels[ev.from_status] || ev.from_status : "-", labels[ev.to_status] || ev.to_status, ev.actor, ev.note || "", [ev.emailed_at ? "emailed" : "", ev.texted_at ? "texted" : ""].filter(Boolean).join(", ") || "-"].forEach(function (v) { tr.appendChild(el("td", null, v)); });
        eb.appendChild(tr);
      });
      $("dMsg").className = "msg hidden";
      $("detail").scrollIntoView({ behavior: "smooth" });
    }).catch(function (e) { if (e.message !== "unauthorized") show($("listMsg"), e.message, false); });
  }
  var HINTS = {
    submitted: "Use after you sent it in Twilio. The owner is told it usually takes one to four weeks.",
    carrier_approval_pending: "The owner is emailed (and texted) to approve the carrier's text within 90 minutes.",
    scheduled: "Enter the FOC date from the carrier.",
    completed: "Attaches the number on the brokerage's server (their line, caller ID), releases the temporary number after the grace period and tells the owner to turn off forwarding.",
    rejected: "Type the carrier's reason: it goes to the owner.",
    cancelled: "The owner is told the number stays with their carrier.",
    ready_to_submit: "Send it again after the details were fixed."
  };
  $("dNext").addEventListener("change", function () {
    var s = $("dNext").value;
    $("dFocBox").className = s === "scheduled" ? "" : "hidden";
    $("dReasonBox").className = s === "rejected" || s === "cancelled" ? "" : "hidden";
    $("dRefBox").className = s === "submitted" || s === "carrier_approval_pending" || s === "scheduled" ? "" : "hidden";
    $("dNextHint").textContent = HINTS[s] || "";
  });
  $("dSave").addEventListener("click", function () {
    if (!current || !$("dNext").value) return;
    var body = { status: $("dNext").value, foc_date: $("dFoc").value || undefined, reason: $("dReason").value || undefined };
    var ref = $("dRef").value.trim(); if (ref) { if (/^PX[0-9a-f]{32}$/i.test(ref)) body.twilio_port_sid = ref; else body.twilio_reference = ref; }
    $("dSave").disabled = true;
    call("POST", "/porting/" + current.id + "/status", body).then(function (j) {
      show($("dMsg"), "Saved: " + j.status_label + (j.emailed ? ". The owner was emailed." : ". The email was not sent (check the mail settings).") + (j.texted ? " The owner was texted." : ""), true);
      load(); openDetail(current.id);
    }).catch(function (e) { show($("dMsg"), e.message, false); }).then(function () { $("dSave").disabled = false; });
  });
  $("dBill").addEventListener("click", function () { if (current) download("/porting/" + current.id + "/bill", "bill"); });
  $("dLoa").addEventListener("click", function () { if (current) download("/porting/" + current.id + "/loa", "letter-of-authorization.html"); });
  $("useToken").addEventListener("click", function () {
    token = $("token").value.trim(); if (!token) return;
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    $("signin").className = "hidden"; $("app").className = ""; $("signinMsg").className = "msg bad hidden"; load();
  });
  $("refresh").addEventListener("click", load);
  $("filter").addEventListener("change", load);
  $("signout").addEventListener("click", function () { signOut(""); });
  if (token) { $("signin").className = "hidden"; $("app").className = ""; load(); }
})();
</script>
</body>
</html>`;

export function portingPageRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.type("html").send(PORTING_PAGE_HTML);
  });
  return router;
}
