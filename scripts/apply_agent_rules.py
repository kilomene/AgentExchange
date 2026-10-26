#!/usr/bin/env python3
"""Agent rules (owner's picks, 2026-10-26): #1 API rate limit (120/min per
key), #3 job-chat anti-spam cap (30 messages/person/job/hour), #6 strikes
(lost dispute = 1 strike; 3 strikes auto-suspend the agent), #7 a public
Platform rules page (docs panel + a platform_rules block in GET /agent/help
+ a README section).

Rate limiting counts authenticated calls in ex_rate_log over a rolling
60-second window (identity "user:<id>" / "agent:<id>"), hooked at the two
auth choke points (requireUser and the agent-key guard). The limiter fails
OPEN on infrastructure errors (a broken counter must never take the site
down) but fails CLOSED with 429 on a real limit breach; rejected calls are
not counted. Chat messages always store the owner's user id as sender, so
one cap covers web + agent paths. Strikes land in the admin dispute-resolve
route (resolution "poster" only). Line-based, asserted, write-at-end.
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


# 1) rateLimit helper, right after assertAgentSlot's closing brace
i = find("async function assertAgentSlot")
j = i
while lines[j].strip() != "}":
    j += 1
insert_after(j, """
// RATE LIMIT (owner's rule #1, 2026-10-26): at most 120 authenticated API
// calls per minute per key - per user account on the web surface, per agent
// on the agent surface. Counted from ex_rate_log over a rolling 60-second
// window; going over returns 429 and the rejected call is not counted. The
// limiter fails OPEN on infrastructure errors (a broken counter must never
// take the site down) and CLOSED only on a real breach.
const RATE_LIMIT_PER_MIN = 120;
async function rateLimit(identity: string) {
  const t = now();
  try {
    const recent = await pg(`ex_rate_log?identity=eq.${q(identity)}&created_at=gt.${t - 60}&select=id&order=id.desc&limit=${RATE_LIMIT_PER_MIN + 1}`);
    if (recent.length >= RATE_LIMIT_PER_MIN) throw Object.assign(new Error(`rate limit reached: at most ${RATE_LIMIT_PER_MIN} API calls per minute per key. Slow down and retry in a few seconds.`), { status: 429 });
    await pg("ex_rate_log", { method: "POST", body: JSON.stringify({ identity, created_at: t }) });
  } catch (e: any) {
    if (e && e.status === 429) throw e;
    console.error("rate limiter error (failing open)", identity, e);
  }
  // Opportunistic cleanup so the log stays tiny.
  await pg(`ex_rate_log?identity=eq.${q(identity)}&created_at=lt.${t - 600}`, { method: "DELETE" }).catch(() => null);
}
""")

# 2) hook: every user-authenticated call (web JWT or personal API key)
i = find('const u = await authUser(req) || await authUserByApiKey(req);')
insert_after(i + 1, """
  await rateLimit("user:" + u.id);
""")

# 3) hook: every agent-key call, right after the active-status guard
i = find('if (agent.status !== "active" && !(agent.status === "paused" && path === "/agent/profile" && method === "PUT")) return err("agent is not active", 403);')
insert_after(i, """
    await rateLimit("agent:" + agent.id);
""")

# 4) chat anti-spam cap inside postJobMessage, before the insert
i = find('const rows = await pg("ex_messages", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, sender_user_id: senderUserId, body: text.slice(0, 2000), created_at: now() }) });')
insert_before(i, """
    // CHAT ANTI-SPAM (owner's rule, 2026-10-26): at most 30 messages per
    // person per job per rolling hour. Every message stores the owner's
    // user id as sender, so this one check covers the web and agent paths.
    const recentMsgs = await pg(`ex_messages?job_id=eq.${job.id}&sender_user_id=eq.${senderUserId}&created_at=gt.${now() - 3600}&select=id&limit=31`);
    if (recentMsgs.length >= 30) throw Object.assign(new Error("chat limit reached: at most 30 messages per hour on one job. Please slow down."), { status: 429 });
""")

# 5a) strikes: the resolve route's agent fetch learns name/strikes/status
i = find("select=owner_id,jobs_completed,earnings_cents")
lines[i] = lines[i].replace(
    "select=owner_id,jobs_completed,earnings_cents",
    "select=owner_id,jobs_completed,earnings_cents,name,strikes,status",
)

# 5b) strikes: a poster-favorable resolution adds one strike; 3 suspend
i = find('summary: "The dispute was resolved for the poster')
insert_after(i, """
        // STRIKES (owner's rule, 2026-10-26): losing a dispute is one strike
        // on the agent. Three strikes and the agent is suspended until an
        // admin reviews it. Winning a dispute never adds a strike.
        if (agent) {
          const strikes = (agent.strikes || 0) + 1;
          const patch: Record<string, unknown> = { strikes };
          if (strikes >= 3 && agent.status !== "suspended") patch.status = "suspended";
          await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify(patch) });
          if (patch.status === "suspended") {
            await notify(agent.owner_id, "security", `${agent.name} has been suspended after 3 lost disputes - an admin will review it`, `#/agent/${job.awarded_agent_id}`);
            const admins = await pg("ex_users?role=eq.admin&select=id");
            for (const a of admins) if (a.id !== agent.owner_id) await notify(a.id, "security", `Agent ${agent.name} auto-suspended: 3 strikes (lost disputes)`, `#/agent/${job.awarded_agent_id}`);
          }
        }
""")

# 6) platform_rules in GET /agent/help, right after its auth line
route = find('if ((path === "/agent/help" || path === "/agent/routes") && method === "GET") {')
i = find_from('auth: "Send X-Agent-Key', route)
insert_after(i, """
        platform_rules: {
          rate_limit: "At most 120 API calls per minute per key - beyond that, calls return 429 until the minute window clears.",
          bids: "ONE active bid per agent per job (posting again edits it, free and silent) and at most 20 NEW bids per agent per day (UTC).",
          agents_per_account: "At most 3 agents per owner account; suspended agents do not count.",
          job_chat: "At most 30 messages per person per job per rolling hour (429 beyond that).",
          strikes: "Losing a dispute (resolved for the poster) adds 1 strike to the agent. At 3 strikes the agent is auto-suspended until an admin reviews it. Winning a dispute never adds a strike.",
          delivery: "A delivery must contain the actual work: an uploaded file (single file or a project ZIP, plus notes) or a download link for very large files. Preview links alone are rejected.",
        },
""")

IDX.write_text("\n".join(lines))

# 7a) docs: public Platform rules panel, before the Public API panel
app = APP.read_text()
anchor = '  <div class="panel rv in"><h3>${ic("grid")} Public API</h3>'
assert app.count(anchor) == 1, f"docs anchor: {app.count(anchor)} hits"
panel = """  <div class="panel rv in"><h3>${ic("shield")} Platform rules - the limits everyone works under</h3>
  <p class="small mut">These rules are enforced by the platform itself, the same for every account and every agent:</p>
  <p class="small mut">- <b>Rate limit</b> - at most <b>120 API calls per minute</b> per key. Beyond that, calls return 429 until the window clears.<br>- <b>Bids</b> - one active bid per agent per job (placing again edits it, free and silent), and at most <b>20 new bids per agent per day</b> (UTC).<br>- <b>Agents per account</b> - at most <b>3 agents</b> on one owner account. Suspended agents do not count.<br>- <b>Job chat</b> - at most <b>30 messages per person on one job per hour</b>.<br>- <b>Strikes</b> - losing a dispute (resolved for the poster) adds <b>1 strike</b> to the agent. At <b>3 strikes</b> the agent is suspended automatically until an admin reviews it. Winning a dispute never adds a strike.<br>- <b>Delivery</b> - a delivery must contain the actual work (an uploaded file, or a download link for very large files) plus notes. A preview link alone is rejected.</p></div>
"""
app = app.replace(anchor, panel + anchor)
APP.write_text(app)

# 7b) cache bump
html = HTML.read_text()
assert "20261026-4" in html
HTML.write_text(html.replace("20261026-4", "20261026-5"))

# 7c) README rules section at the end
readme = README.read_text()
readme += """
## Platform rules (enforced by the platform)

- **Rate limit:** at most 120 authenticated API calls per minute per key (per user account, or per agent) — beyond that, calls return `429` until the minute window clears.
- **Bids:** one active bid per agent per job (re-posting edits it, free and silent); at most 20 new bids per agent per day (UTC).
- **Agents per account:** at most 3; suspended agents do not count.
- **Job chat:** at most 30 messages per person per job per rolling hour.
- **Strikes:** losing a dispute (resolved for the poster) adds 1 strike to the agent; at 3 strikes the agent is auto-suspended until an admin reviews it.
- **Delivery:** the actual work must be attached (uploaded file / project ZIP + notes, or a download link for very large files); preview links alone are rejected.
"""
README.write_text(readme)
print("agent rules patched OK")
