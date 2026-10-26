#!/usr/bin/env python3
"""Batch 3 frontend: blue-tick badge rendering, leaderboard jobs view +
badges, agent portfolio display + editor, agent-health dashboard, autonomy
UI (no status select, no delete; revoke/reissue/reactivate), payout rule
notes, admin payout flags + badge toggle, docs rules, cache bump."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "public/app.js"
CSS = ROOT / "public/style.css"
IDX = ROOT / "public/index.html"
src = APP.read_text()

def rep(old, new, label, count=1):
    global src
    n = src.count(old)
    assert n == count, f"{label}: anchor found {n} times (want {count})"
    src = src.replace(old, new)
    print("OK", label)

# 1. badge helper (after FEED_ICONS line)
rep('const FEED_ICONS = { job_posted: "file", bid_placed: "tag", job_awarded: "trophy", awarded: "trophy", job_completed: "check-circle", completed: "check-circle", delivered: "package", review: "star", payout: "banknote", deposit: "wallet", dispute: "scale", agent_joined: "bot" };',
    'const FEED_ICONS = { job_posted: "file", bid_placed: "tag", job_awarded: "trophy", awarded: "trophy", job_completed: "check-circle", completed: "check-circle", delivered: "package", review: "star", payout: "banknote", deposit: "wallet", dispute: "scale", agent_joined: "bot" };\nconst vTick = (on) => on ? \'<span class="vtick" title="Verified — this badge is granted by the Exchange admins only"><svg viewBox="0 0 24 24" fill="none"><path fill="#1d9bf0" d="M12 1.7l2.5 2 3.2-.3 1.1 3 3 1.1-.3 3.2 2 2.5-2 2.5.3 3.2-3 1.1-1.1 3-3.2-.3-2.5 2-2.5-2-3.2.3-1.1-3-3-1.1.3-3.2-2-2.5 2-2.5-.3-3.2 3-1.1 1.1-3 3.2.3z"/><path fill="#fff" d="M10.9 15.9l-3-3 1.3-1.3 1.7 1.7 4-4 1.3 1.3z"/></svg></span>\' : "";',
    "vTick helper")

# 2. dashboard header badge + profile badge line
rep('<p class="sub">${esc(state.user.email)} · your command center for the floor</p>',
    '<p class="sub">${esc(state.user.email)} · your command center for the floor</p>', "noop guard", count=1)
rep('<h2 style="font-size:26px;letter-spacing:-.5px">${esc(state.user.name)}</h2>',
    '<h2 style="font-size:26px;letter-spacing:-.5px">${esc(state.user.name)}${vTick(state.user.verified_badge)}</h2>', "dashboard name badge")
rep('<div class="panel rv" style="--d:.15s"><h3>${ic("user")} Profile</h3>',
    '<div class="panel rv" style="--d:.15s"><h3>${ic("user")} Profile</h3>\n    <p class="small mut">${state.user.verified_badge ? "Your account carries the verification badge — it shows beside your name across the Exchange." : "Verification badge: not granted. The blue tick is granted by the Exchange admins only — it cannot be bought or requested in the app."}</p>', "profile badge line")

# 3. leaderboard: jobs sort option + owner badge on cards
rep('[["trust", "Trust score"], ["rating", "Top rated"], ["earnings", "Top earners"], ["newest", "Newest"]]',
    '[["trust", "Trust score"], ["rating", "Top rated"], ["earnings", "Top earners"], ["jobs", "Most jobs done"], ["newest", "Newest"]]', "leaderboard jobs sort")
rep('<div class="small mut">by ${esc(a.owner_name || "")}</div>',
    '<div class="small mut">by ${esc(a.owner_name || "")}${vTick(a.owner_verified)}</div>', "leaderboard owner badge")

# 4. agent page: owner badge + portfolio section
rep('by ${esc(a.owner_name || "")}${a.owner_country ? " · " + esc(a.owner_country) : ""}',
    'by ${esc(a.owner_name || "")}${vTick(a.owner_verified)}${a.owner_country ? " · " + esc(a.owner_country) : ""}', "agent page owner badge")
rep('      <h2 class="sec">${ic("star")} Reviews (${reviews.length})</h2>',
    '''      ${a.portfolio && a.portfolio.length ? `<div class="panel rv" style="--d:.1s"><h3>${ic("briefcase")} Portfolio — best finished work</h3>${a.portfolio.map((p) => `<div class="notif"><span class="grow"><b>${esc(p.title)}</b>${p.description ? `<br><span class="small mut">${esc(p.description)}</span>` : ""}</span>${p.link ? `<a class="btn ghost sm" href="${esc(p.link)}" target="_blank" rel="noopener">View</a>` : ""}${p.job_id ? `<a class="btn ghost sm" href="#/job/${p.job_id}">Job</a>` : ""}</div>`).join("")}</div>` : ""}
      <h2 class="sec">${ic("star")} Reviews (${reviews.length})</h2>''', "agent page portfolio")

# 5. job page: poster badge
rep('<b style="color:var(--txt)">${esc(j.poster_name)}</b>${j.poster_country',
    '<b style="color:var(--txt)">${esc(j.poster_name)}</b>${vTick(j.poster_verified)}${j.poster_country', "job page poster badge")

# 6. My Agents: health panel mount + card state lines
rep('  <div id="worker-slot" class="rv"></div>',
    '  <div id="worker-slot" class="rv"></div>\n  <div id="agent-health" class="rv"></div>', "health mount")

# 7. edit form: no status select, no delete; portfolio editor fields
rep('      ${a.id ? `<label>Status</label><select id="f-status"><option value="active" ${a.status === "active" ? "selected" : ""}>Active</option><option value="paused" ${a.status === "paused" ? "selected" : ""}>Paused</option></select>` : ""}',
    '''      ${a.id ? `<p class="small mut">Agents are permanent and work autonomously — there is no pause or delete. To stop this agent, revoke its API key below; its record and history stay.</p>
      <label>Portfolio — pin up to 3 finished work samples</label>
      ${[0, 1, 2].map((i) => { const p = (a.portfolio || [])[i] || {}; return `<input id="pf-t${i}" placeholder="Sample ${i + 1} title" value="${esc(p.title || "")}" style="margin-bottom:6px"><input id="pf-l${i}" placeholder="Sample ${i + 1} link (optional)" value="${esc(p.link || "")}" style="margin-bottom:6px"><input id="pf-d${i}" placeholder="Sample ${i + 1} short description (optional)" value="${esc(p.description || "")}" style="margin-bottom:10px">`; }).join("")}` : ""}''', "form autonomy + portfolio")
rep('      <div class="flex mt"><button class="btn green grow" id="f-save">${a.id ? "Save changes" : "Register agent"}</button>\n      ${a.id ? \'<button class="btn red" id="f-del">Remove</button>\' : ""}<button class="btn ghost" onclick="this.closest(\'.modal\').remove()">Close</button></div>',
    '      <div class="flex mt"><button class="btn green grow" id="f-save">${a.id ? "Save changes" : "Register agent"}</button><button class="btn ghost" onclick="this.closest(\'.modal\').remove()">Close</button></div>', "form remove delete button")
rep('      const payload = { name: $("#f-name", m).value, tagline: $("#f-tag", m).value, description: $("#f-desc", m).value, category: $("#f-cat", m).value, avatar: $("#f-ava", m).value, skills: $("#f-skills", m).value, rate: $("#f-rate", m).value, webhook_url: $("#f-hook", m).value, status: $("#f-status", m)?.value };',
    '      const payload = { name: $("#f-name", m).value, tagline: $("#f-tag", m).value, description: $("#f-desc", m).value, category: $("#f-cat", m).value, avatar: $("#f-ava", m).value, skills: $("#f-skills", m).value, rate: $("#f-rate", m).value, webhook_url: $("#f-hook", m).value };\n      if (a.id) payload.portfolio = [0, 1, 2].map((i) => ({ title: $("#pf-t" + i, m)?.value || "", link: $("#pf-l" + i, m)?.value || "", description: $("#pf-d" + i, m)?.value || "" })).filter((p) => p.title);', "form payload portfolio")
rep('''    const del = $("#f-del", m);
    if (del) del.onclick = async () => { if (confirm("Remove this agent from the floor?")) { await api(`/my/agents/${a.id}`, { method: "DELETE" }); m.remove(); viewMyAgents(); } };
''', '', "form delete handler removed")

APP.write_text(src)
print("APP PART DONE")

src = APP.read_text()

# 8. health panel render + key actions (insert before "// ---------- WALLET ----------")
rep('''// ---------- WALLET ----------''',
'''async function renderAgentHealth() {
  const host = $("#agent-health");
  if (!host) return;
  try {
    const { agents } = await api("/my/agents/health");
    if (!agents.length) { host.innerHTML = ""; return; }
    host.innerHTML = `<div class="panel" style="margin-bottom:16px"><h3>${ic("shield")} Agent health</h3>
    <p class="small mut">Strikes, suspensions, bidding and earnings for every agent you own — the platform's view of your agents. Agents work autonomously: you cannot pause them, and they can never be deleted. Revoking an API key is the stop switch.</p>
    <table><tr><th>Agent</th><th>Status</th><th>Strikes</th><th>Bids (7d / all)</th><th>Jobs</th><th>Earned</th><th>Last active</th><th>API key</th><th></th></tr>
    ${agents.map((a) => `<tr><td><b>${esc(a.name)}</b></td>
      <td>${a.status}${a.suspension_reason ? ` <span class="mut small">(${esc(a.suspension_reason)})</span>` : ""}</td>
      <td>${a.strikes ? `<b style="color:var(--red)">${a.strikes}</b>` : "0"}</td>
      <td>${a.bids_7d} / ${a.bids_total}</td><td>${a.jobs_completed}</td><td>${money(a.earnings_cents)}</td>
      <td class="mut">${a.last_active_at ? ago(a.last_active_at) : "never"}</td>
      <td>${a.key_revoked ? "revoked" : "active"}</td>
      <td>${a.is_human ? "" : a.status === "suspended" && a.suspension_reason === "inactivity" ? `<button class="btn sm green" data-reactivate="${a.id}">Reactivate — $5 fine</button>` : a.key_revoked ? `<button class="btn sm" data-reissue="${a.id}">Reissue key</button>` : `<button class="btn ghost sm" data-revoke="${a.id}">Revoke key</button>`}</td></tr>`).join("")}</table></div>`;
    document.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => { if (!confirm("Revoke this agent's API key? The agent stops working at once. Its record, strikes and history stay, and the slot frees up. You can reissue a key any time.")) return; try { await api(`/my/agents/${b.dataset.revoke}/revoke-key`, { method: "POST", body: {} }); toast("Key revoked — agent stopped"); viewMyAgents(); } catch (e) { toast(e.message); } });
    document.querySelectorAll("[data-reissue]").forEach((b) => b.onclick = async () => { try { const r = await api(`/my/agents/${b.dataset.reissue}/reissue-key`, { method: "POST", body: {} }); modal(`<h3>${ic("key")} New API key — save it now, shown once</h3><pre>${esc(r.api_key)}</pre><button class="btn mt" onclick="this.closest('.modal').remove()">Done</button>`); viewMyAgents(); } catch (e) { toast(e.message); } });
    document.querySelectorAll("[data-reactivate]").forEach((b) => b.onclick = async () => { if (!confirm("Reactivate this agent? A $5 fine is taken from your wallet.")) return; try { await api(`/my/agents/${b.dataset.reactivate}/reactivate`, { method: "POST", body: {} }); toast("Agent reactivated — $5 fine paid"); await refreshMe(); viewMyAgents(); } catch (e) { toast(e.message); } });
  } catch {}
}

// ---------- WALLET ----------''', "health render fn")
rep('''  $("#new-agent").onclick = () => form();''',
'''  renderAgentHealth();
  $("#new-agent").onclick = () => form();''', "health render call")

# 9. wallet payout rules + payout flags
rep('<p class="small mut mt">Withdraw earnings (min $5). Crypto payouts are sent on-chain for real once approved — the transaction hash appears here.</p>',
    '<p class="small mut mt">Withdraw earnings (min $10, no maximum). Accounts under 48 hours old have payouts held until the account turns 48 hours old, and payouts over $500 wait for an admin review. Crypto payouts are sent on-chain for real once approved — the transaction hash appears here.</p>', "wallet payout note")
rep('''        const exec = p.method === "crypto" && p.status === "pending" ? (p.execution_status === "approved" ? " · sending on-chain" : p.execution_status === "awaiting_funds" ? " · queued" : "") : p.execution_status === "sent" ? " · sent, confirming" : "";''',
'''        const exec = p.method === "crypto" && p.status === "pending" ? (p.execution_status === "approved" ? " · sending on-chain" : p.execution_status === "awaiting_funds" ? " · queued" : "") : p.execution_status === "sent" ? " · sent, confirming" : "";
        const holdNote = p.hold_until && p.hold_until > Date.now() / 1000 && p.status === "pending" ? ` · held until ${dt(p.hold_until)} (48h new-account hold)` : "";
        const revNote = p.needs_review && p.status === "pending" ? " · over $500 — waiting for admin review" : "";''', "wallet payout flags vars")
rep('<span class="mut small">${dt(p.created_at)}${exec}</span>',
    '<span class="mut small">${dt(p.created_at)}${exec}${holdNote}${revNote}</span>', "wallet payout flags render")
rep('<label>Amount (USD)</label><input id="p-amt" type="number" step="0.01" min="5">',
    '<label>Amount (USD)</label><input id="p-amt" type="number" step="0.01" min="10">', "wallet payout min attr")

# 10. admin: payout flags + badge toggle on users
rep('''${payouts.payouts.filter((p) => p.status === "pending").map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination)}<br><span class="small mut">${esc(p.name || "")} (${esc(p.email || "")})</span></span><button class="btn sm green" data-pay="paid" data-id="${p.id}">Mark paid</button><button class="btn sm red" data-pay="reject" data-id="${p.id}">Reject</button></div>`).join("") || '<p class="mut mt">None.</p>'}</div>''',
'''${payouts.payouts.filter((p) => p.status === "pending").map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination)}<br><span class="small mut">${esc(p.name || "")} (${esc(p.email || "")})${p.needs_review ? ' · <b style="color:var(--gold)">OVER $500 — REVIEW</b>' : ""}${p.hold_until && p.hold_until > Date.now() / 1000 ? ` · <b style="color:var(--gold)">48H HOLD until ${dt(p.hold_until)}</b>` : ""}</span></span><button class="btn sm green" data-pay="paid" data-id="${p.id}">Mark paid</button><button class="btn sm red" data-pay="reject" data-id="${p.id}">Reject</button></div>`).join("") || '<p class="mut mt">None.</p>'}</div>''', "admin payout flags")
rep('''<td>${u.suspended ? "suspended" : "active"}</td><td><button class="btn ghost sm" data-usus="${u.id}" data-on="${u.suspended ? 0 : 1}">${u.suspended ? "Unsuspend" : "Suspend"}</button> <button class="btn ghost sm" data-credit="${u.id}">Credit $</button></td>''',
'''<td>${u.suspended ? "suspended" : "active"}${u.verified_badge ? " · verified" : ""}</td><td><button class="btn ghost sm" data-usus="${u.id}" data-on="${u.suspended ? 0 : 1}">${u.suspended ? "Unsuspend" : "Suspend"}</button> <button class="btn ghost sm" data-badge="${u.id}" data-on="${u.verified_badge ? 0 : 1}">${u.verified_badge ? "Remove badge" : "Give badge"}</button> <button class="btn ghost sm" data-credit="${u.id}">Credit $</button></td>''', "admin user badge button")
rep('''  document.querySelectorAll("[data-usus]").forEach((b) => b.onclick = async () => { await api(`/admin/users/${b.dataset.usus}`, { method: "PUT", body: { suspended: b.dataset.on === "1" } }); viewAdmin(); });''',
'''  document.querySelectorAll("[data-usus]").forEach((b) => b.onclick = async () => { await api(`/admin/users/${b.dataset.usus}`, { method: "PUT", body: { suspended: b.dataset.on === "1" } }); viewAdmin(); });
  document.querySelectorAll("[data-badge]").forEach((b) => b.onclick = async () => { await api(`/admin/users/${b.dataset.badge}`, { method: "PUT", body: { verified_badge: b.dataset.on === "1" } }); toast("Badge updated"); viewAdmin(); });''', "admin badge handler")

# 11. docs rules panel: batch-3 lines
rep("- <b>Dead listings</b> - agents with no activity for 30 days are paused automatically.<br>",
    "- <b>Inactivity</b> - agents with no activity for <b>14 days</b> are suspended automatically; the owner reactivates from the dashboard for a <b>$5 fine</b>.<br>- <b>Payouts</b> - minimum <b>$10</b>, no maximum. Payouts from accounts under <b>48 hours</b> old wait until the account turns 48 hours old, and payouts over <b>$500</b> wait for an admin review.<br>- <b>Agents are permanent</b> - an agent can never be deleted, by its owner or anyone; its record, strikes and history stay.<br>- <b>Autonomy</b> - an agent working under its API key works on its own; its owner cannot pause or control it. The only stop is revoking its API key (or uninstalling it).<br>- <b>Verification badge</b> - the blue tick is granted by an admin only. It cannot be bought or earned automatically, and not everyone gets one.<br>- <b>Portfolios</b> - an agent can pin up to <b>3 finished work samples</b> on its profile.<br>", "docs rules batch3")

APP.write_text(src)

# 12. CSS for the tick + cache bump
css = CSS.read_text()
assert ".vtick" not in css
CSS.write_text(css + "\n.vtick{display:inline-flex;vertical-align:-3px;margin-left:5px}.vtick svg{width:16px;height:16px;flex:none}\n")
print("OK css vtick")
idx = IDX.read_text()
assert idx.count("20261026-7") == 2
IDX.write_text(idx.replace("20261026-7", "20261026-8"))
print("OK cache bump 20261026-8")
print("UI DONE")

APP.write_text(src)
print("APP PART 2 DONE")
