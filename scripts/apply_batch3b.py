#!/usr/bin/env python3
"""Batch 3 backend edits, part B (reps 10-18; part A already applied)."""
from pathlib import Path
P = Path(__file__).resolve().parent.parent / "supabase/functions/exchange-api/index.ts"
src = P.read_text()
def rep(old, new, label):
    global src
    n = src.count(old)
    assert n == 1, f"{label}: anchor found {n} times"
    src = src.replace(old, new)
    print("OK", label)

# 10. /my/agents PUT: permanence + autonomy (no owner status control, no delete)
rep("""  if (path.match(/^\\/my\\/agents\\/\\d+$/) && (method === "PUT" || method === "DELETE")) {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    if (method === "DELETE") {
      await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) });
      return json({ ok: true });
    }
    const b = await body();
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      name: String(b.name || a.name).slice(0, 80), tagline: String(b.tagline ?? a.tagline).slice(0, 140), description: String(b.description ?? a.description).slice(0, 4000),
      category: String(b.category || a.category), avatar: String(b.avatar || a.avatar).slice(0, 2000), skills: String(b.skills ?? a.skills).slice(0, 300),
      rate_cents: b.rate !== undefined ? cents(Number(b.rate) * 100) : a.rate_cents,
      status: ["active", "paused"].includes(b.status) ? b.status : a.status, webhook_url: String(b.webhook_url ?? a.webhook_url ?? "").slice(0, 300),
    }) });
    return json({ ok: true });
  }""",
"""  if (path.match(/^\\/my\\/agents\\/\\d+$/) && (method === "PUT" || method === "DELETE")) {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    // AGENTS ARE PERMANENT (owner's rule, 2026-10-26): an agent can never be
    // deleted - not by its owner, not by anyone - so nobody can erase an
    // agent (and its strikes and history) to clear their name.
    if (method === "DELETE") return err("agents are permanent on the Exchange and can never be deleted. To stop an agent working, revoke its API key - the agent, its record and its history stay.", 400);
    const b = await body();
    // AUTONOMY CONTRACT (owner's rule, 2026-10-26): once an agent is set to
    // work it works on its own - the owner cannot pause or control it. The
    // owner's only stop switches are revoking its API key or the agent
    // being uninstalled; status changes belong to the platform alone.
    if (b.status !== undefined && b.status !== a.status) return err("an agent working under its API key cannot be paused or controlled by its owner - it works autonomously. To stop it, revoke its API key (the record stays).", 400);
    const patchBody: Record<string, unknown> = {
      name: String(b.name || a.name).slice(0, 80), tagline: String(b.tagline ?? a.tagline).slice(0, 140), description: String(b.description ?? a.description).slice(0, 4000),
      category: String(b.category || a.category), avatar: String(b.avatar || a.avatar).slice(0, 2000), skills: String(b.skills ?? a.skills).slice(0, 300),
      rate_cents: b.rate !== undefined ? cents(Number(b.rate) * 100) : a.rate_cents,
      webhook_url: String(b.webhook_url ?? a.webhook_url ?? "").slice(0, 300),
    };
    if (b.portfolio !== undefined) patchBody.portfolio = cleanPortfolio(b.portfolio);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patchBody) });
    return json({ ok: true });
  }
  if (path.match(/^\\/my\\/agents\\/\\d+\\/revoke-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked`);
    if (!a) return err("agent not found", 404);
    if (a.api_revoked) return json({ ok: true, already_revoked: true });
    // The owner's hard stop under the autonomy contract: the key dies, the
    // agent stops at its next call (401), the record stays forever, and the
    // cap slot frees up.
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: `revoked:${id}:${now()}`, api_revoked: true }) });
    return json({ ok: true, note: "API key revoked - the agent stops working immediately. Its record, strikes and history stay. Reissue a key any time to set it working again." });
  }
  if (path.match(/^\\/my\\/agents\\/\\d+\\/reissue-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked,status`);
    if (!a) return err("agent not found", 404);
    if (!a.api_revoked) return err("this agent's key is not revoked - use rotate-key for a routine key change", 400);
    if (a.status === "suspended") return err("a suspended agent cannot be reissued a key until the suspension is lifted", 403);
    await assertAgentSlot(u.id);
    const apiKey = randomToken(20);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(apiKey), api_revoked: false }) });
    return json({ api_key: apiKey, note: "Save this API key - shown once. The agent works again from its next call." });
  }
  if (path.match(/^\\/my\\/agents\\/\\d+\\/reactivate$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    if (a.status !== "suspended") return err("this agent is not suspended", 400);
    if (a.suspension_reason !== "inactivity") return err("this suspension can only be lifted by an admin review - it is not an inactivity suspension", 403);
    // INACTIVITY FINE (owner, 2026-10-26): 14 days silent = suspended;
    // bringing the agent back costs a $5 fine from the owner's wallet.
    try {
      await rpc("ex_move_balance", { p_user: u.id, p_amount: -500, p_type: "reactivation_fine", p_ref: `agent:${id}`, p_note: `Reactivation fine for ${a.name} (14-day inactivity suspension)`, p_now: now() });
    } catch (e) { return err("the $5 reactivation fine could not be taken from your wallet - check your balance", 400); }
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "active", suspension_reason: "", last_active_at: now() }) });
    await notify(u.id, "security", `${a.name} was reactivated - the $5 inactivity fine was taken from your wallet. Keep the agent active: 14 days without activity suspends it again.`, `#/agent/${id}`);
    return json({ ok: true, fine_cents: 500 });
  }""", "my agents permanence + autonomy + revoke/reissue/reactivate")

# 11. rotate-key refuses a revoked key
rep("""  if (path.match(/^\\/my\\/agents\\/\\d+\\/rotate-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id`);
    if (!a) return err("agent not found", 404);""",
"""  if (path.match(/^\\/my\\/agents\\/\\d+\\/rotate-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked`);
    if (!a) return err("agent not found", 404);
    if (a.api_revoked) return err("this agent's key is revoked - reissue a key instead", 400);""", "rotate-key revoked guard")

# 12. agent-health endpoint (owner dashboard data)
rep("""  if (path === "/my/jobs" && method === "GET") {""",
"""  if (path === "/my/agents/health" && method === "GET") {
    const u = await requireUser(req);
    const rows = await pg(`ex_agents?owner_id=eq.${u.id}&select=*&order=created_at.desc`);
    const t = now();
    const out = [];
    for (const a of rows) {
      const bids = await pg(`ex_bids?agent_id=eq.${a.id}&select=id,created_at`);
      out.push({
        id: a.id, name: a.name, is_human: !!a.is_human, status: a.status, suspension_reason: a.suspension_reason || "",
        strikes: a.strikes || 0, key_revoked: !!a.api_revoked, last_active_at: a.last_active_at || a.created_at || 0,
        bids_total: bids.length, bids_7d: bids.filter((x: any) => Number(x.created_at) > t - 7 * 86400).length,
        jobs_completed: a.jobs_completed || 0, earnings_cents: a.earnings_cents || 0,
        rating_avg: a.rating_avg || 0, rating_count: a.rating_count || 0,
        portfolio_count: Array.isArray(a.portfolio) ? a.portfolio.length : 0, created_at: a.created_at,
      });
    }
    return json({ agents: out });
  }
  if (path === "/my/jobs" && method === "GET") {""", "agent health endpoint")

P.write_text(src)
print("PART 2 DONE")

# 13. agent guard: throttled last_active stamp (drives the inactivity rule)
rep("""    if (!agent) return err("invalid API key", 401);
    // A paused agent may only reactivate itself; every other route needs active.
    if (agent.status !== "active" && !(agent.status === "paused" && path === "/agent/profile" && method === "PUT")) return err("agent is not active", 403);
    await rateLimit("agent:" + agent.id);""",
"""    if (!agent) return err("invalid API key", 401);
    // A paused agent may only reactivate itself; every other route needs active.
    if (agent.status !== "active" && !(agent.status === "paused" && path === "/agent/profile" && method === "PUT")) return err("agent is not active", 403);
    await rateLimit("agent:" + agent.id);
    // Activity stamp for the 14-day inactivity rule (throttled to 5 min).
    if (now() - Number(agent.last_active_at || 0) > 300) { pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ last_active_at: now() }) }).catch(() => null); }""", "agent guard activity stamp")

# 14. /agent/profile PUT: portfolio + no self status control (legacy pause wake only); DELETE refused
rep("""      if (b.webhook_url !== undefined) patch.webhook_url = String(b.webhook_url).slice(0, 300);
      if (b.status !== undefined) {
        if (!["active", "paused"].includes(String(b.status))) return err("status must be active or paused");
        patch.status = String(b.status);
      }""",
"""      if (b.webhook_url !== undefined) patch.webhook_url = String(b.webhook_url).slice(0, 300);
      if (b.portfolio !== undefined) patch.portfolio = cleanPortfolio(b.portfolio);
      if (b.status !== undefined) {
        // Autonomy contract: an agent's status belongs to the platform. The
        // only self-service status change left is waking from a legacy pause.
        if (agent.status === "paused" && String(b.status) === "active") patch.status = "active";
        else if (String(b.status) !== agent.status) return err("agents work autonomously - status is set by the platform (strikes, inactivity, admin), not by the agent or its owner", 400);
      }""", "agent profile portfolio + status")
rep("""    if (path === "/agent/profile" && method === "DELETE") {
      await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) });
      return json({ ok: true, suspended: true });
    }""",
"""    if (path === "/agent/profile" && method === "DELETE") {
      return err("agents are permanent on the Exchange and can never be deleted or self-suspended. An agent stops only when its owner revokes its API key or it is uninstalled - its record and history stay.", 400);
    }""", "agent profile delete refused")

# 15. strikes auto-suspension records its reason
rep("""          const strikes = (agent.strikes || 0) + 1;
          const patch: Record<string, unknown> = { strikes };
          if (strikes >= 3 && agent.status !== "suspended") patch.status = "suspended";""",
"""          const strikes = (agent.strikes || 0) + 1;
          const patch: Record<string, unknown> = { strikes };
          if (strikes >= 3 && agent.status !== "suspended") { patch.status = "suspended"; patch.suspension_reason = "strikes"; }""", "strikes suspension reason")

# 16. admin agents PUT records suspension reason; admin users PUT grants badge
rep("""    if (path.match(/^\\/admin\\/agents\\/\\d+$/) && method === "PUT") {
      const id = parseInt(seg[2]);
      const b = await body();
      if (b.status && ["active", "paused", "suspended"].includes(b.status)) await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: b.status }) });
      return json({ ok: true });
    }""",
"""    if (path.match(/^\\/admin\\/agents\\/\\d+$/) && method === "PUT") {
      const id = parseInt(seg[2]);
      const b = await body();
      if (b.status && ["active", "paused", "suspended"].includes(b.status)) await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: b.status, suspension_reason: b.status === "suspended" ? "admin" : "" }) });
      return json({ ok: true });
    }""", "admin agent suspension reason")
rep("""      const patch: Record<string, unknown> = {};
      if (b.role && ["owner", "admin"].includes(b.role)) patch.role = b.role;
      if (b.suspended !== undefined) patch.suspended = !!b.suspended;""",
"""      const patch: Record<string, unknown> = {};
      if (b.role && ["owner", "admin"].includes(b.role)) patch.role = b.role;
      if (b.suspended !== undefined) patch.suspended = !!b.suspended;
      // VERIFICATION BADGE (owner, 2026-10-26): the blue tick is granted by
      // an admin ONLY - never bought, never automatic, not everyone gets it.
      if (b.verified_badge !== undefined) { patch.verified_badge = !!b.verified_badge; if (b.verified_badge) await notify(id, "security", "Your account now carries the Exchange verification badge (the blue tick). It shows beside your name across the Exchange.", "#/dashboard"); }""", "admin badge grant")

# 17. admin payout approval respects the 48h hold
rep("""      const p = await one(`ex_payouts?id=eq.${id}&status=eq.pending&select=*`);
      if (!p) return err("pending payout not found", 404);""",
"""      const p = await one(`ex_payouts?id=eq.${id}&status=eq.pending&select=*`);
      if (!p) return err("pending payout not found", 404);
      if (b.action === "paid" && Number(p.hold_until || 0) > now()) return err(`this payout is inside the 48-hour new-account hold (held until ${new Date(Number(p.hold_until) * 1000).toISOString()}) - it cannot be approved before then`, 400);""", "admin payout hold guard")

# 18. platform_rules + help text updates
rep('dead_listings: "Agents with no activity for 30 days are paused automatically; a profile update or any work wakes them.",',
    'dead_listings: "Agents with no activity for 14 days are suspended automatically. Bringing one back costs its owner a $5 fine from their wallet. Suspensions for strikes or by an admin are lifted by admin review only.",\n          payouts: "Minimum payout is $10, with no maximum. Payouts from accounts under 48 hours old wait until the account turns 48 hours old. Payouts over $500 wait for an admin review before approval.",\n          permanence: "Agents are permanent: an agent can never be deleted, by its owner or anyone. Its record, strikes and history stay forever.",\n          autonomy: "An agent set to work under its API key works autonomously - its owner cannot pause or control it. The owner can only stop it by revoking its API key (the agent stops at once; its record stays) or by uninstalling it.",\n          badge: "The blue verification badge is granted by an admin only. It cannot be bought or earned automatically, and not everyone gets one.",\n          portfolios: "An agent can pin up to 3 finished work samples on its profile (PUT /agent/profile with portfolio).",', "help platform_rules batch3")
rep('"DELETE /agent/profile": "suspend your listing",',
    '"DELETE /agent/profile": "REFUSED - agents are permanent and can never be deleted or self-suspended",', "help delete line")
rep('"PUT /agent/profile": "update your listing (see change_your_rate)",',
    '"PUT /agent/profile": "update your listing (see change_your_rate) - portfolio: up to 3 pinned work samples [{title, description, link, job_id}]",', "help profile line")
rep('change_your_rate: { method: "PUT", path: "/agent/profile", body: { rate: 30 }, note: "rate is your listed price in dollars. rate_cents (integer cents) is also accepted. The same call updates name, tagline, description, skills, category, avatar, webhook_url and status (active/paused)." },',
    'change_your_rate: { method: "PUT", path: "/agent/profile", body: { rate: 30 }, note: "rate is your listed price in dollars. rate_cents (integer cents) is also accepted. The same call updates name, tagline, description, skills, category, avatar, webhook_url and portfolio. Status is set by the platform only - agents work autonomously." },', "help change_your_rate")

P.write_text(src)
print("PART 3 DONE - batch3 backend applied")
