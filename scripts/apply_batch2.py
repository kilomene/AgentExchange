#!/usr/bin/env python3
"""Batch-2 agent rules (owner's picks, 2026-10-26):
- NEW-AGENT RAMP: agents with < 3 completed jobs can only bid on / claim
  jobs budgeted at $100 or less (placeBid + both claim routes).
- DISPUTE WINDOW: delivered work disputable for 14 days from delivered_at
  (deliverJob now stamps delivered_at; disputeJob enforces).
- JOB CONTENT RULES: a narrow unambiguous-illegality screen in postJob,
  plus POST /admin/jobs/:id/remove (escrow refunded, posting fee kept).
- NO ESCAPING PUNISHMENT: sign-ups record the client IP and its country
  (GeoIP via ip-api, cached in ex_ip_geo); sign-ups are refused from
  banned IPs and from VPN/proxy exits; banning an account bans its IPs;
  logins keep last_ip fresh. Country rides the user object (register /
  login / /auth/me) and shows beside poster names on job pages and owner
  names on agent pages.
- platform_rules + docs panel + README state all of it.
Deadline auto-refund + dead-listing pause + the ban-evasion alt scan live
in the exchange-sweeper host service (sweeper/), not in this function.
Line-based, asserted, write-at-end.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
HTML = ROOT / "public/index.html"
README = ROOT / "README.md"
lines = IDX.read_text().split("\n")


def find(substr, start=0):
    hits = [i for i in range(start, len(lines)) if substr in lines[i]]
    assert len(hits) == 1, f"anchor {substr!r}: {len(hits)} hits"
    return hits[0]


def find_from(substr, start):
    for i in range(start, len(lines)):
        if substr in lines[i]:
            return i
    raise AssertionError(f"anchor {substr!r} not found after line {start}")


def insert_after(idx, block):
    global lines
    lines = lines[: idx + 1] + block.strip("\n").split("\n") + lines[idx + 1 :]


def insert_before(idx, block):
    global lines
    lines = lines[:idx] + block.strip("\n").split("\n") + lines[idx:]


def replace_in_line(idx, old, new):
    assert old in lines[idx], f"line {idx}: {old!r} not in {lines[idx][:120]!r}"
    lines[idx] = lines[idx].replace(old, new)


# 1) IP/geo helpers after rateLimit's closing brace
i = find("async function rateLimit")
j = i
while lines[j].strip() != "}":
    j += 1
insert_after(j, """
// ----- IP identity: no escaping punishment (owner's rule, 2026-10-26) ---
// Every account is created from a real connection: the sign-up IP and its
// country (from the IP itself, never self-declared) go on the account.
// Sign-ups are refused from banned IPs and from VPN/proxy exits. Banning
// an account bans its IPs with it, and the sweeper suspends replacement
// accounts that share a banned address. A wallet balance never protects
// a banned account - suspension locks every route.
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || (req.headers.get("cf-connecting-ip") || "").trim();
}
function isPrivateIp(ip: string): boolean {
  return !ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(ip);
}
async function geoForIp(ip: string): Promise<{ country: string; country_code: string; is_proxy: boolean } | null> {
  if (isPrivateIp(ip)) return null;
  try {
    const cached = await one(`ex_ip_geo?ip=eq.${q(ip)}&select=country,country_code,is_proxy`);
    if (cached) return { country: cached.country || "", country_code: cached.country_code || "", is_proxy: !!cached.is_proxy };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,proxy,hosting`, { signal: ctl.signal }).catch(() => null);
    clearTimeout(timer);
    if (!r || !r.ok) return null;
    const gj: any = await r.json().catch(() => null);
    if (!gj || gj.status !== "success") return null;
    const geo = { country: String(gj.country || ""), country_code: String(gj.countryCode || ""), is_proxy: !!(gj.proxy || gj.hosting) };
    await pg("ex_ip_geo", { method: "POST", body: JSON.stringify({ ip, country: geo.country, country_code: geo.country_code, is_proxy: geo.is_proxy, checked_at: now() }) }).catch(() => null);
    return geo;
  } catch { return null; }
}
async function assertSignupIpAllowed(req: Request): Promise<{ ip: string; country: string; country_code: string }> {
  const ip = clientIp(req);
  if (!ip || isPrivateIp(ip)) return { ip, country: "", country_code: "" };
  const banned = await one(`ex_banned_ips?ip=eq.${q(ip)}&select=ip`);
  if (banned) throw Object.assign(new Error("this network address is banned on the Exchange - an account was previously banned from it. If you believe this is a mistake, contact support."), { status: 403 });
  const geo = await geoForIp(ip);
  if (geo?.is_proxy) throw Object.assign(new Error("sign-ups are not allowed through a VPN or proxy. Please switch it off and register from your real connection."), { status: 403 });
  return { ip, country: geo?.country || "", country_code: geo?.country_code || "" };
}
async function recordLoginIp(userId: number, req: Request) {
  try {
    const ip = clientIp(req);
    if (!ip) return;
    const patch: Record<string, unknown> = { last_ip: ip };
    const u = await one(`ex_users?id=eq.${userId}&select=country`);
    if (!u?.country) {
      const geo = await geoForIp(ip);
      if (geo?.country) { patch.country = geo.country; patch.country_code = geo.country_code; }
    }
    await pg(`ex_users?id=eq.${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  } catch (e) { console.error("login ip record failed", userId, e); }
}
""")

# 2) user fetches carry country (so /auth/me and every user object shows it)
hits = [i for i, l in enumerate(lines) if "select=id,email,name,role,avatar,bio,suspended,created_at,email_verified,password_changed_at" in l]
assert len(hits) >= 1, "user select anchor missing"
for i in hits:
    replace_in_line(i, "password_changed_at`)", "password_changed_at,country,country_code`)")

# 3) web register: gate + record IP/country
i = find('if (exists) return err("email already registered", 409);')
insert_after(i, """
    const signup = await assertSignupIpAllowed(req);
""")
i = find('const rows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(password), name, avatar: b.avatar || avatarDataUri("user:" + email, name), created_at: now() }) });')
replace_in_line(i, "created_at: now() }) });", "created_at: now(), signup_ip: signup.ip, last_ip: signup.ip, country: signup.country, country_code: signup.country_code }) });")
i = find("user: { id: user.id, email, name, role: user.role, avatar: user.avatar, email_verified: false, has_api_key: true }")
replace_in_line(i, "email_verified: false, has_api_key: true }", "email_verified: false, has_api_key: true, country: signup.country, country_code: signup.country_code }")

# 4) login: record IP, return country
i = find('if (user.suspended) return err("account suspended", 403);')
insert_after(i, """
    await recordLoginIp(user.id, req);
""")
i = find("user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, bio: user.bio, email_verified: !!user.email_verified, has_api_key: true }")
replace_in_line(i, "has_api_key: true }", "has_api_key: true, country: user.country || \"\", country_code: user.country_code || \"\" }")

# 5) agent register: gate + record IP/country on the created owner
i = find('const urows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(ownerPassword), name: ownerName, avatar: avatarDataUri("user:" + email, ownerName), created_at: now() }) });')
insert_before(i, """
    const signup = await assertSignupIpAllowed(req);
""")
i = find('const urows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(ownerPassword), name: ownerName, avatar: avatarDataUri("user:" + email, ownerName), created_at: now() }) });')
replace_in_line(i, "created_at: now() }) });", "created_at: now(), signup_ip: signup.ip, last_ip: signup.ip, country: signup.country, country_code: signup.country_code }) });")

# 6) ramp in placeBid, after the own-job check
i = find('if (job.poster_user_id === agent.owner_id) throw Object.assign(new Error("you cannot bid on your own job"), { status: 400 });')
insert_after(i, """
    // NEW-AGENT RAMP (owner's rule, 2026-10-26): until an agent has
    // completed 3 jobs, it can only take jobs budgeted at $100 or less.
    if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) throw Object.assign(new Error("new-agent limit: agents with fewer than 3 completed jobs can only bid on jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets."), { status: 400 });
""")

# 7a) ramp in the agent claim route
i = find('if (job.poster_user_id === agent.owner_id) return err("you cannot claim your own job");')
insert_after(i, """
      if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) return err("new-agent limit: agents with fewer than 3 completed jobs can only claim jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets.");
""")

# 7b) ramp in the web claim route
route = find('if (path.match(/^\\/jobs\\/\\d+\\/claim$/) && method === "POST") {')
k = find_from("const agent = await one(`ex_agents?id=eq.${parseInt(b.agent_id)}", route)
k2 = find_from('if (!agent) return err("agent not found or not yours", 404);', k)
insert_after(k2, """
    if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) return err("new-agent limit: agents with fewer than 3 completed jobs can only claim jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets.");
""")

# 8) deliverJob stamps delivered_at
i = find('const patch: Record<string, unknown> = { status: "delivered", deliverable: notes.slice(0, 8000), delivery_link: link.slice(0, 1000), updated_at: now() };')
replace_in_line(i, "updated_at: now() };", "updated_at: now(), delivered_at: now() };")

# 9) dispute window at the top of disputeJob
i = find("async function disputeJob(job: any, reason: unknown) {")
insert_after(i, """
    // DISPUTE WINDOW (owner's rule, 2026-10-26): delivered work can only
    // be disputed within 14 days of delivery. Work that was never
    // delivered can be disputed at any time.
    if (job.status === "delivered" && job.delivered_at && now() > Number(job.delivered_at) + 14 * 86400) throw Object.assign(new Error("the dispute window has closed: delivered work can be disputed within 14 days of delivery."), { status: 400 });
""")

# 10) content screen in postJob, before the posting-rules block
i = find("// JOB POSTING RULES (owner's design, 2026-10-26): at most 3 job posts")
insert_before(i, """
    // JOB CONTENT RULES (owner's rule, 2026-10-26): jobs asking for
    // illegal goods or services are refused at posting. The list is
    // deliberately narrow - only unambiguous illegality. An admin can
    // also remove a posted job later (escrow refunded, posting fee kept).
    const haystack = (title + " " + String(b.description || "")).toLowerCase();
    const bannedTerms = ["malware", "ransomware", "keylogger", "stealer logs", "credit card dump", "carding", "fullz", "counterfeit money", "fake passport", "fake id", "hitman", "murder for hire", "child porn", "csam", "methamphetamine", "cocaine trafficking", "heroin trafficking", "ddos for hire", "booter service"];
    if (bannedTerms.some((w) => haystack.includes(w))) throw Object.assign(new Error("this job appears to ask for something illegal or harmful, which the Exchange does not allow. Jobs that violate the content rules are refused, and posted jobs can be removed by an admin (the posting fee is not refunded on removals)."), { status: 400 });
""")

# 11) banning a user bans their IPs (admin users PUT)
i = find("if (b.suspended !== undefined) patch.suspended = !!b.suspended;")
k = find_from("if (Object.keys(patch).length) await pg(`ex_users?id=eq.${id}`", i)
insert_after(k, """
      // NO ESCAPING PUNISHMENT (owner's rule, 2026-10-26): banning an
      // account also bans its sign-up and last-seen IP addresses, so a
      // fresh account from the same address is refused at registration.
      if (b.suspended) {
        const bannedUser = await one(`ex_users?id=eq.${id}&select=signup_ip,last_ip`);
        for (const ip of [bannedUser?.signup_ip, bannedUser?.last_ip]) {
          if (ip && !isPrivateIp(ip)) await pg("ex_banned_ips", { method: "POST", prefer: "resolution=ignore-duplicates", body: JSON.stringify({ ip, reason: `account ${id} banned`, source_user_id: id, created_at: now() }) }).catch(() => null);
        }
      }
""")

# 12) admin job removal, before the dispute-resolve route
i = find('if (path.match(/^\\/admin\\/jobs\\/\\d+\\/resolve$/) && method === "POST") {')
insert_before(i, """
    if (path.match(/^\\/admin\\/jobs\\/\\d+\\/remove$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const job = await one(`ex_jobs?id=eq.${id}&select=*`);
      if (!job) return err("job not found", 404);
      if (["completed", "refunded", "cancelled", "removed"].includes(job.status)) return err("job is already closed", 400);
      const t = now();
      const reason = String(b.reason || "violates the platform's job content rules").slice(0, 300);
      if (job.status === "open") {
        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${id}`, p_note: "Job removed by admin - escrow refunded (posting fee kept)", p_now: t });
        await pg(`ex_bids?job_id=eq.${id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
      } else {
        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${id}`, p_note: "Job removed by admin - escrow refunded (posting fee kept)", p_now: t });
      }
      await pg(`ex_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "removed", dispute_reason: reason, updated_at: t }) });
      await notify(job.poster_user_id, "security", `Your job "${job.title}" was removed by an admin: ${reason}. The escrow was refunded to your wallet; the $2.00 posting fee is kept.`, `#/job/${id}`);
      if (job.awarded_agent_id) {
        const w = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`);
        if (w) await notify(w.owner_id, "security", `The job "${job.title}" you were working on was removed by an admin (${reason}). Its escrow was refunded to the poster.`, `#/job/${id}`);
      }
      return json({ ok: true });
    }
""")

# 13) platform_rules: the batch-2 rules, after the posting entry
i = find('posting: "At most 3 job posts per account per day (UTC), and every post charges a $2.00 posting fee')
insert_after(i, """
          deadline: "If the delivery deadline passes with no delivery, the job is cancelled automatically and the escrow refunds to the poster - no action needed.",
          new_agent_ramp: "Agents with fewer than 3 completed jobs can only bid on or claim jobs budgeted at $100 or less.",
          dispute_window: "Delivered work can be disputed within 14 days of delivery; after that the job is closed for good. Undelivered work can be disputed at any time.",
          content_rules: "Jobs asking for anything illegal or harmful are refused at posting and can be removed by an admin (escrow refunded, posting fee kept).",
          no_evasion: "Every account records its sign-up IP address and the country that IP comes from. Sign-ups are refused from banned IP addresses and through VPNs or proxies. Banning an account bans its IP addresses with it, and replacement accounts from a banned address are refused or suspended - a wallet balance does not protect a banned account.",
          dead_listings: "Agents with no activity for 30 days are paused automatically; a profile update or any work wakes them.",
""")

# 14) country joins + mappings
src = "\n".join(lines)
n = src.count("ex_jobs_poster_user_id_fkey(name,avatar)")
assert n >= 3, f"poster fk selects: {n}"
src = src.replace("ex_jobs_poster_user_id_fkey(name,avatar)", "ex_jobs_poster_user_id_fkey(name,avatar,country)")
assert src.count("ex_agents_owner_id_fkey(name)") == 1
src = src.replace("ex_agents_owner_id_fkey(name)", "ex_agents_owner_id_fkey(name,country)")
assert src.count("ex_agents_owner_id_fkey(name,avatar,created_at)") == 1
src = src.replace("ex_agents_owner_id_fkey(name,avatar,created_at)", "ex_agents_owner_id_fkey(name,avatar,created_at,country)")
n = src.count("poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, awarded_agent_name:")
assert n == 2, f"job detail mappings: {n}"
src = src.replace("poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, awarded_agent_name:",
                  "poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, poster_country: j.poster?.country || \"\", awarded_agent_name:")
assert src.count("poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, bid_count:") == 1
src = src.replace("poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, bid_count:",
                  "poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, poster_country: j.poster?.country || \"\", bid_count:")
assert src.count("owner_name: a.owner?.name }))") == 1
src = src.replace("owner_name: a.owner?.name }))", "owner_name: a.owner?.name, owner_country: a.owner?.country || \"\" }))")
assert src.count("owner_name: a.owner?.name }, reviews, recent_jobs: recent") == 1
src = src.replace("owner_name: a.owner?.name }, reviews, recent_jobs: recent", "owner_name: a.owner?.name, owner_country: a.owner?.country || \"\" }, reviews, recent_jobs: recent")
lines = src.split("\n")

IDX.write_text("\n".join(lines))

# 15) frontend: country beside poster (job page) + owner (agent page)
app = APP.read_text()
old = '<b style="color:var(--txt)">${esc(j.poster_name)}</b>${j.poster_agent_id ? " · via their agent" : ""}'
assert app.count(old) == 1, f"job page poster: {app.count(old)}"
app = app.replace(old, '<b style="color:var(--txt)">${esc(j.poster_name)}</b>${j.poster_country ? " · " + esc(j.poster_country) : ""}${j.poster_agent_id ? " · via their agent" : ""}')
old = 'by ${esc(a.owner_name || "")} · <span class="pill">'
assert app.count(old) == 1, f"agent page owner: {app.count(old)}"
app = app.replace(old, 'by ${esc(a.owner_name || "")}${a.owner_country ? " · " + esc(a.owner_country) : ""} · <span class="pill">')

# 16) docs panel: batch-2 bullets before the Delivery bullet
old = "- <b>Delivery</b> - a delivery must contain the actual work"
assert app.count(old) == 1, f"docs delivery bullet: {app.count(old)}"
app = app.replace(old, "- <b>Delivery deadline</b> - if the deadline passes with no delivery, the job is cancelled automatically and the escrow refunds to the poster.<br>- <b>New agents</b> - until an agent completes 3 jobs, it can only bid on or claim jobs budgeted at <b>$100 or less</b>.<br>- <b>Dispute window</b> - delivered work can be disputed within <b>14 days</b> of delivery; after that the job is closed for good.<br>- <b>Content rules</b> - jobs asking for anything illegal or harmful are refused, and admins can remove posted jobs (escrow refunded, posting fee kept).<br>- <b>No escaping a ban</b> - every account records its sign-up IP address and the country it comes from. Sign-ups are refused from banned addresses and through <b>VPNs or proxies</b>. A banned account's addresses are banned with it, and replacement accounts from a banned address are refused or suspended - money in a wallet does not protect a banned account.<br>- <b>Dead listings</b> - agents with no activity for 30 days are paused automatically.<br>" + old)
APP.write_text(app)

# 17) cache bump
html = HTML.read_text()
assert "20261026-6" in html
HTML.write_text(html.replace("20261026-6", "20261026-7"))

# 18) README: batch-2 bullets after the posting rule
readme = README.read_text()
old = "- **Posting jobs:** at most 3 job posts per account per day (UTC); every post charges a $2.00 posting fee from the poster's wallet on top of the escrow hold — the fee is kept even if the job is cancelled."
assert readme.count(old) == 1
readme = readme.replace(old, old + """
- **Delivery deadline:** if the deadline passes with no delivery, the job is cancelled automatically and the escrow refunds to the poster.
- **New-agent ramp:** agents with fewer than 3 completed jobs can only bid on or claim jobs budgeted at $100 or less.
- **Dispute window:** delivered work can be disputed within 14 days of delivery.
- **Content rules:** jobs asking for anything illegal or harmful are refused at posting; admins can remove posted jobs (escrow refunded, posting fee kept).
- **No escaping a ban:** sign-ups record the client IP and its country; sign-ups are refused from banned IPs and through VPNs/proxies; banning an account bans its IPs; replacement accounts from a banned address are refused or suspended. A wallet balance does not protect a banned account.
- **Dead listings:** agents with no activity for 30 days are auto-paused.""")
README.write_text(readme)
print("batch-2 patched OK")
