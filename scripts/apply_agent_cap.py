#!/usr/bin/env python3
"""Agent cap (owner's pick, 2026-10-26): at most 3 agents per account.

Enforced by assertAgentSlot() on both creation paths (POST /my/agents and
POST /agent/owner/agents). Suspended agents (deleted listings) do not count,
so suspending one frees its slot. POST /agent/register always creates a
brand-new account (0 agents), and the single human worker profile
(createHumanProfile - one per user, updated in place) is not an agent and
never counts. Also states the cap in GET /agent/help.
Line-based, asserted, write-at-end.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / "supabase/functions/exchange-api/index.ts"
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


# 1) helper, right after queueLifecycleMail's closing brace
i = find('console.error("lifecycle mail queue failed"')
assert lines[i + 1].strip() == "}", lines[i + 1]
insert_after(i + 1, """
// AGENT CAP (owner's pick, 2026-10-26): one account can have at most 3
// agents. Suspended agents (deleted listings) do not count - suspending one
// frees its slot. The owner's single human worker profile is separate and
// never counts toward the cap.
const MAX_AGENTS_PER_ACCOUNT = 3;
async function assertAgentSlot(ownerId: number) {
  const rows = await pg(`ex_agents?owner_id=eq.${ownerId}&status=neq.suspended&select=id,is_human`);
  const count = rows.filter((r: any) => !r.is_human).length;
  if (count >= MAX_AGENTS_PER_ACCOUNT) throw Object.assign(new Error(`agent limit reached: one account can have at most ${MAX_AGENTS_PER_ACCOUNT} agents. Suspend an existing agent before creating another.`), { status: 400 });
}
""")

# 2) POST /my/agents - check before minting the key/inserting
route = find('if (path === "/my/agents" && method === "POST") {')
k = find_from("const apiKey = randomToken(20);", route)
insert_before(k, """
    await assertAgentSlot(u.id);
""")

# 3) POST /agent/owner/agents - same check for the owning account
route = find('if (path === "/agent/owner/agents" && method === "POST") {')
k = find_from("const apiKey = randomToken(20);", route)
insert_before(k, """
      await assertAgentSlot(agent.owner_id);
""")

# 4) help text states the cap
i = find('"POST /agent/owner/agents": "create another agent — returns its api_key"')
lines[i] = lines[i].replace(
    "create another agent — returns its api_key",
    "create another agent — returns its api_key (max 3 agents per account; suspended agents do not count)",
)

IDX.write_text("\n".join(lines))
print("agent cap patched OK")
