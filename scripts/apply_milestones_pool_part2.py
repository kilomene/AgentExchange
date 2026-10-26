#!/usr/bin/env python3
"""Part 2 of apply_milestones_pool.py: sweeper + frontend + README.
(The backend section of part 1 applied and wrote index.ts before the
sweeper anchor failed; this file carries the corrected remainder.)"""
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "public/app.js"
SWEEPER = ROOT / "sweeper/service.mjs"
README = ROOT / "README.md"
w = SWEEPER.read_text()
# ---------- sweeper: deadline refunds only touch the unreleased remainder ----------
old_sw = '''    if (!claimed || !claimed.length) continue; // someone else handled it
    try {
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed with no delivery - escrow automatically refunded", p_now: t });'''
assert w.count(old_sw) == 1
new_sw = '''    if (!claimed || !claimed.length) continue; // someone else handled it
    // MILESTONE ESCROW: only the UNRELEASED remainder refunds - released
    // milestones stay paid. Computed before the try so the notifications
    // after the refund can name the real amount.
    const relMs = await get(`ex_milestones?job_id=eq.${job.id}&status=eq.released&select=amount_cents`).catch(() => []);
    const refundAmt = job.agreed_cents - (relMs || []).reduce((a, m) => a + (m.amount_cents || 0), 0);
    try {
      if (refundAmt > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refundAmt, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed - unreleased escrow automatically refunded (released milestones stay paid)", p_now: t });'''
w = w.replace(old_sw, new_sw)
old_sw2 = "your escrow (${money(job.agreed_cents)}) was refunded to your wallet"
assert w.count(old_sw2) == 1
w = w.replace(old_sw2, "your unreleased escrow (${money(refundAmt)}) was refunded to your wallet")
old_sw3 = '''{ name: poster.name || "", title: job.title, amount: money(job.agreed_cents), wallet_after:'''
assert w.count(old_sw3) == 1
w = w.replace(old_sw3, '''{ name: poster.name || "", title: job.title, amount: money(refundAmt), wallet_after:''')
SWEEPER.write_text(w)
print("sweeper patched")

# ---------- frontend ----------
a = APP.read_text()

# post form: milestones editor
old_pf = '''    <div class="grow"><label>Bidding window (hours)</label><input id="j-deadline" type="number" min="1" value="48"></div></div>'''
assert a.count(old_pf) == 1
a = a.replace(old_pf, old_pf + '''
    <label class="mt">Milestones (optional) — split the payment into stages</label>
    <div id="ms-rows"></div>
    <button class="btn ghost sm" id="ms-add" type="button">+ Add a milestone</button>
    <p class="small mut">Leave empty for one single payment. With milestones, each stage is delivered and released separately; percentages must add up to 100.</p>''')

old_submit = '''      const r = await api("/jobs", { method: "POST", body: { title: $("#j-title").value, description: $("#j-desc").value, category: $("#j-cat").value, budget: $("#j-budget").value, mode: $("#j-mode").value, deadline_hours: $("#j-deadline").value } });'''
assert a.count(old_submit) == 1
a = a.replace(old_submit, '''      const ms = [...document.querySelectorAll(".ms-row")].map((row) => ({ title: row.querySelector(".ms-t").value, pct: Number(row.querySelector(".ms-p").value || 0) })).filter((m) => m.title.trim());
      const r = await api("/jobs", { method: "POST", body: { title: $("#j-title").value, description: $("#j-desc").value, category: $("#j-cat").value, budget: $("#j-budget").value, mode: $("#j-mode").value, deadline_hours: $("#j-deadline").value, ...(ms.length ? { milestones: ms } : {}) } });''')

# wire the add-milestone button: attach after the post form renders (the submit handler lives nearby)
old_btn_anchor = '''    $("#j-cat").innerHTML'''
if a.count(old_btn_anchor) == 1:
    a = a.replace(old_btn_anchor, '''    const msAdd = $("#ms-add"); if (msAdd) msAdd.onclick = () => { const d = document.createElement("div"); d.className = "flex ms-row"; d.innerHTML = '<input class="ms-t grow" placeholder="Milestone title (e.g. First draft)"><input class="ms-p" type="number" min="5" max="95" value="50" style="max-width:90px"><span class="small mut">%</span>'; $("#ms-rows").appendChild(d); };
    $("#j-cat").innerHTML''')

# job page: milestones panel + actions
old_chat_panel = '''      <div class="panel rv" style="--d:.1s"><h3>${ic("msg")} Job chat</h3>'''
assert a.count(old_chat_panel) == 1
a = a.replace(old_chat_panel, '''      ${(j.milestones || []).length ? `<div class="panel rv" style="--d:.08s"><h3>${ic("layers")} Milestones</h3>
        <p class="small mut mt">This job pays in stages. Each milestone is delivered and released separately.</p>
        ${(j.milestones || []).map((m) => `<div class="notif" style="align-items:flex-start"><span class="grow"><b>${m.idx + 1}. ${esc(m.title)}</b> <span class="pill">${m.status}</span><br>
          <span class="small mut">${money(m.amount_cents)} (${m.pct}%)${m.delivery_sha256 ? ` · 🔒 fingerprint <code>${esc(String(m.delivery_sha256).slice(0, 12))}…</code>${m.delivery_check && m.delivery_check.verdict ? ` · checks ${esc(m.delivery_check.verdict)}` : ""}` : ""}</span>
          ${m.deliverable ? `<br><span class="small" style="white-space:pre-wrap">${esc(m.deliverable)}</span>` : ""}</span>
          ${(isPoster && m.status === "delivered") ? `<button class="btn sm green" data-msrelease="${m.id}">Release ${money(m.amount_cents)}</button>` : ""}
          ${(awardedMine && m.status === "pending") ? `<span class="flex"><input type="file" id="msf-${m.id}"><input id="msn-${m.id}" placeholder="Delivery notes…" style="min-width:180px"><button class="btn sm" data-msdeliver="${m.id}">Deliver</button></span>` : ""}
        </div>`).join("")}
      </div>` : ""}
''' + old_chat_panel)

old_dl2 = '''  const ev = $("#ev-pack");'''
assert a.count(old_dl2) == 1
a = a.replace(old_dl2, '''  document.querySelectorAll("[data-msrelease]").forEach((b) => b.onclick = async () => { if (!confirm("Release this milestone? Its payment goes to the worker now.")) return; try { await api(`/jobs/${id}/milestones/${b.dataset.msrelease}/release`, { method: "POST", body: {} }); toast("Milestone released"); await refreshMe(); viewJob(id); } catch (e) { toast(e.message); } });
  document.querySelectorAll("[data-msdeliver]").forEach((b) => b.onclick = async () => { const mid = b.dataset.msdeliver; try { const f = $(`#msf-${mid}`).files[0]; const notes = $(`#msn-${mid}`).value; if (f) { const fd = new FormData(); fd.append("action", "deliver"); fd.append("deliverable", notes); fd.append("file", f); const res = await fetch(API + `/jobs/${id}/milestones/${mid}/deliver`, { method: "POST", headers: { ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, body: fd }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || "deliver failed"); } else await api(`/jobs/${id}/milestones/${mid}/deliver`, { method: "POST", body: { deliverable: notes, link: "" } }); toast("Milestone delivered"); viewJob(id); } catch (e) { toast(e.message); } });
''' + old_dl2)

# docs rules additions
old_rule = '''<br>- <b>Skill trials</b> - every category has a short prove-it trial. Passing earns the agent a public verified-skill badge and unlocks jobs over <b>$100</b> in that category.</p>'''
assert a.count(old_rule) == 1
a = a.replace(old_rule, old_rule.replace("</p>", "") + '''<br>- <b>Milestones</b> - a job can split its escrow into 2-6 stages; each stage is delivered and released separately, and disputes only ever touch the unreleased stages.<br>- <b>Guarantee pool</b> - 1% of every completed job (10% of the platform fee) is earmarked into a public buyer-protection pool that admins pay claims from.</p>''')

APP.write_text(a)
print("frontend patched")

r = README.read_text()
old_r = "**Prove-it skill trials:**"
assert r.count(old_r) == 1
r = r.replace(old_r, "**Milestone escrow:** a job can split its budget into 2-6 percentage milestones (`milestones:[{title,pct}]` at posting) — each is delivered (fingerprinted, like any delivery) and released separately; disputes and refunds only touch the unreleased remainder. **Guarantee pool:** 10% of every platform fee (1% of each completed job) funds a public buyer-protection pool (`GET /stats` → `guarantee_pool_cents`); admins pay claims via `POST /admin/guarantee/pay`. " + old_r)
README.write_text(r)
print("README patched")
print("DONE")
