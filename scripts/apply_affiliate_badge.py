#!/usr/bin/env python3
"""Nova affiliate badge + Nova Inc admin identity (owner's order, 2026-10-26).

Backend: ex_users.nova_affiliate flows to owner_affiliate / poster_affiliate
on every public surface that already carries the verification badge; the
admin user PUT can grant/revoke it; /auth/me carries it for the dashboard.
Frontend: novaAff() renders the Nova logo (/nova-icon.png) as a round badge
beside the blue tick; poster avatars are actually rendered on job cards and
job pages (they were fetched but unused), so the Nova Inc poster's logo
shows; docs rules panel + README state the rule.
All replacements assert their exact occurrence count before writing.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
CSS = ROOT / "public/style.css"
HTML = ROOT / "public/index.html"
README = ROOT / "README.md"


def rep(path: Path, old: str, new: str, count: int):
    t = path.read_text()
    n = t.count(old)
    assert n == count, f"{path.name}: expected {count} of {old[:70]!r}, found {n}"
    path.write_text(t.replace(old, new))
    print(f"OK {path.name}: {old[:60]!r} x{count}")


# ---------------- backend ----------------
# authUser selects (JWT + API-key paths) carry the flag for /auth/me
rep(IDX, "country,country_code,verified_badge`",
    "country,country_code,verified_badge,nova_affiliate`", 2)
# agents list + leaderboard owner joins
rep(IDX, "ex_agents_owner_id_fkey(name,country,verified_badge)",
    "ex_agents_owner_id_fkey(name,country,verified_badge,nova_affiliate)", 2)
rep(IDX, "owner_verified: !!a.owner?.verified_badge })) });",
    "owner_verified: !!a.owner?.verified_badge, owner_affiliate: !!a.owner?.nova_affiliate })) });", 2)
# agent detail owner join + map
rep(IDX, "ex_agents_owner_id_fkey(name,avatar,created_at,country,verified_badge)",
    "ex_agents_owner_id_fkey(name,avatar,created_at,country,verified_badge,nova_affiliate)", 1)
rep(IDX, "owner_verified: !!a.owner?.verified_badge }, reviews",
    "owner_verified: !!a.owner?.verified_badge, owner_affiliate: !!a.owner?.nova_affiliate }, reviews", 1)
# jobs floor poster join + map
rep(IDX, "ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge),bids:ex_bids(count)",
    "ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),bids:ex_bids(count)", 1)
rep(IDX, "poster_verified: !!j.poster?.verified_badge, bid_count",
    "poster_verified: !!j.poster?.verified_badge, poster_affiliate: !!j.poster?.nova_affiliate, bid_count", 1)
# job detail (web + agent routes share the identical map string)
rep(IDX, "ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge),agent:ex_agents!ex_jobs_awarded_agent_id_fkey",
    "ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),agent:ex_agents!ex_jobs_awarded_agent_id_fkey", 1)
rep(IDX, "poster_verified: !!j.poster?.verified_badge, awarded_agent_name",
    "poster_verified: !!j.poster?.verified_badge, poster_affiliate: !!j.poster?.nova_affiliate, awarded_agent_name", 2)
# agent job detail: its poster join never selected the badge fields at all
rep(IDX, "ex_jobs_poster_user_id_fkey(name,avatar,country),agent:ex_agents!ex_jobs_awarded_agent_id_fkey",
    "ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),agent:ex_agents!ex_jobs_awarded_agent_id_fkey", 1)
# admin grant/revoke
rep(IDX,
    'if (b.verified_badge) await notify(id, "security", "Your account now carries the Exchange verification badge (the blue tick). It shows beside your name across the Exchange.", "#/dashboard"); }',
    'if (b.verified_badge) await notify(id, "security", "Your account now carries the Exchange verification badge (the blue tick). It shows beside your name across the Exchange.", "#/dashboard"); }\n'
    '      if (b.nova_affiliate !== undefined) { patch.nova_affiliate = !!b.nova_affiliate; if (b.nova_affiliate) await notify(id, "security", "Your account is now marked as a Nova affiliate. The Nova logo badge shows beside your name across the Exchange.", "#/dashboard"); }',
    1)
# /agent/help platform rules
rep(IDX,
    'badge: "The blue verification badge is granted by an admin only. It cannot be bought or earned automatically, and not everyone gets one.",',
    'badge: "The blue verification badge is granted by an admin only. It cannot be bought or earned automatically, and not everyone gets one.",\n'
    '          affiliate_badge: "The Nova logo badge marks a Nova affiliate - an account affiliated with Nova Inc. Granted by an admin only; it shows beside the verification badge.",',
    1)

# ---------------- frontend ----------------
rep(APP,
    'const NOTIF_ICONS =',
    'const novaAff = (on) => on ? \'<span class="afftick" title="Nova affiliate — affiliated with Nova Inc"><img src="/nova-icon.png" alt="Nova affiliate"></span>\' : "";\nconst NOTIF_ICONS =',
    1)
# owner lines: leaderboard card + agent page
rep(APP, 'by ${esc(a.owner_name || "")}${vTick(a.owner_verified)}',
    'by ${esc(a.owner_name || "")}${vTick(a.owner_verified)}${novaAff(a.owner_affiliate)}', 2)
# dashboard header (own account)
rep(APP, '${esc(state.user.name)}${vTick(state.user.verified_badge)}',
    '${esc(state.user.name)}${vTick(state.user.verified_badge)}${novaAff(state.user.nova_affiliate)}', 1)
# profile panel copy
rep(APP, 'cannot be bought or requested in the app."}</p>',
    'cannot be bought or requested in the app."}${state.user.nova_affiliate ? " Your account also carries the Nova affiliate badge — the Nova logo beside your name marks you as affiliated with Nova Inc." : ""}</p>', 1)
# job page poster line
rep(APP, '${vTick(j.poster_verified)}',
    '${vTick(j.poster_verified)}${novaAff(j.poster_affiliate)}', 1)
# poster avatars were fetched but never rendered: floor card + job page
rep(APP, 'ident(j.poster_name || "?", 20)',
    'ident(j.poster_name || "?", 20, false, j.poster_avatar)', 2)
# admin users table: avatar, affiliate state, toggle button + handler
rep(APP, 'ident(u.name || "?", 26)',
    'ident(u.name || "?", 26, false, u.avatar)', 1)
rep(APP, '${u.verified_badge ? " · verified" : ""}',
    '${u.verified_badge ? " · verified" : ""}${u.nova_affiliate ? " · Nova affiliate" : ""}', 1)
rep(APP, ' <button class="btn ghost sm" data-credit="${u.id}">Credit $</button>',
    ' <button class="btn ghost sm" data-aff="${u.id}" data-on="${u.nova_affiliate ? 0 : 1}">${u.nova_affiliate ? "Remove affiliate" : "Make affiliate"}</button> <button class="btn ghost sm" data-credit="${u.id}">Credit $</button>', 1)
rep(APP, 'document.querySelectorAll("[data-badge]")',
    'document.querySelectorAll("[data-aff]").forEach((b) => b.onclick = async () => { await api(`/admin/users/${b.dataset.aff}`, { method: "PUT", body: { nova_affiliate: b.dataset.on === "1" } }); toast("Affiliate badge updated"); viewAdmin(); });\n    document.querySelectorAll("[data-badge]")', 1)
# docs rules panel
rep(APP, 'and not everyone gets one.<br>',
    'and not everyone gets one.<br>- <b>Nova affiliate badge</b> - the Nova logo beside a name marks an account affiliated with Nova Inc. Granted by an admin only; it shows beside the verification badge.<br>', 1)

# ---------------- styles + cache + readme ----------------
rep(CSS, '.vtick svg{width:16px;height:16px;flex:none}',
    '.vtick svg{width:16px;height:16px;flex:none}.afftick{display:inline-flex;vertical-align:-3px;margin-left:4px}.afftick img{width:16px;height:16px;flex:none;border-radius:50%;object-fit:cover}', 1)
rep(HTML, '20261026-8', '20261026-9', 2)
rep(README, '- **Verification badge:** the blue tick is granted by an admin only — never bought, never automatic, and not everyone gets one.',
    '- **Verification badge:** the blue tick is granted by an admin only — never bought, never automatic, and not everyone gets one.\n- **Nova affiliate badge:** the Nova logo beside a name marks an account affiliated with Nova Inc — granted by an admin only, shown beside the verification badge.', 1)

print("ALL EDITS APPLIED")
