#!/usr/bin/env python3
"""Round 2 of lifecycle emails (owner's order, 2026-10-26): review received,
dispute opened (worker + admins), dispute resolved (both parties, with
money figures), job cancelled (to active bidders), bid not selected (to
losing bidders at award). Same rules as round 1: hooks live in the shared
helpers / beside the existing in-app notifies, queueing is best-effort and
can never break the job or the money. Line-based, asserted, write-at-end.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / "supabase/functions/exchange-api/index.ts"
lines = IDX.read_text().split("\n")


def find(substr):
    hits = [i for i in range(len(lines)) if substr in lines[i]]
    assert len(hits) == 1, f"anchor {substr!r}: {len(hits)} hits"
    return hits[0]


def insert_after(idx, block):
    global lines
    lines = lines[: idx + 1] + block.strip("\n").split("\n") + lines[idx + 1 :]


def insert_before(idx, block):
    global lines
    lines = lines[:idx] + block.strip("\n").split("\n") + lines[idx:]


# 1) reviewJob: email the reviewed agent's owner (stars + text + new average)
i = find('await notify(agent.owner_id, "review",')
insert_after(i, """
      await queueLifecycleMail("review_received", agent.owner_id, { agent_name: agent.name, stars, review: String(b.body || "").slice(0, 600), rating_avg: avg, title: job.title, link: `${SITE_URL}/#/agent/${job.awarded_agent_id}` });
""")

# 2) disputeJob: email the worker's owner, and every admin
i = find('await notify(awardedOwner, "dispute",')
insert_after(i, """
    if (awardedOwner) await queueLifecycleMail("dispute_opened", awardedOwner, { title: job.title, reason: String(reason || "").slice(0, 300), link: `${SITE_URL}/#/job/${job.id}` });
""")
i = find('for (const a of admins) await notify(a.id, "dispute",')
insert_after(i, """
    for (const a of admins) await queueLifecycleMail("dispute_opened", a.id, { title: job.title, reason: String(reason || "").slice(0, 300), admin: true, link: `${SITE_URL}/#/admin` });
""")

# 3) cancelJob: capture active bids before rejecting them, email their owners
i = find("await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active`, { method: \"PATCH\", body: JSON.stringify({ status: \"rejected\" }) });")
insert_before(i, """
    const openBids = await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active&select=agent_id,bidder_user_id`);
""")
i = find("await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active`, { method: \"PATCH\", body: JSON.stringify({ status: \"rejected\" }) });")
insert_after(i, """
    // EMAIL every bidder whose bid just died with the job (2026-10-26).
    try {
      const seenOwners = new Set<number>();
      for (const ob of openBids) {
        if (seenOwners.has(ob.bidder_user_id)) continue;
        seenOwners.add(ob.bidder_user_id);
        const bAgent = await one(`ex_agents?id=eq.${ob.agent_id}&select=name`);
        await queueLifecycleMail("job_cancelled", ob.bidder_user_id, { agent_name: bAgent?.name || "Your agent", title: job.title, link: `${SITE_URL}/#/jobs` });
      }
    } catch (e) { console.error("job_cancelled mail failed", e); }
""")

# 4) awardJob: capture losing bids before they are rejected; email their
# owners after the winner mail (winner agent row is in scope there)
i = find("await pg(`ex_bids?job_id=eq.${job.id}&id=neq.${bid.id}&status=eq.active`, { method: \"PATCH\", body: JSON.stringify({ status: \"rejected\" }) });")
insert_before(i, """
    const loserBids = await pg(`ex_bids?job_id=eq.${job.id}&id=neq.${bid.id}&status=eq.active&select=agent_id,bidder_user_id`);
""")
i = find('await queueLifecycleMail("job_awarded",')
insert_after(i, """
    // EMAIL the bidders who were not picked (owner's order, 2026-10-26).
    try {
      const seenLosers = new Set<number>();
      for (const lb of loserBids) {
        if (seenLosers.has(lb.bidder_user_id)) continue;
        seenLosers.add(lb.bidder_user_id);
        const lAgent = await one(`ex_agents?id=eq.${lb.agent_id}&select=name`);
        await queueLifecycleMail("bid_not_selected", lb.bidder_user_id, { agent_name: lAgent?.name || "Your agent", title: job.title, winner_name: agent?.name || "another agent", link: `${SITE_URL}/#/jobs` });
      }
    } catch (e) { console.error("bid_not_selected mail failed", e); }
""")

# 5) admin dispute resolution: email both parties for either outcome
i = find("resolved in your favor — escrow refunded")
insert_after(i, """
        const posterWalletRes = await walletOf(job.poster_user_id).catch(() => null);
        await queueLifecycleMail("dispute_resolved", job.poster_user_id, { title: job.title, summary: "The dispute was resolved in your favor — the escrow has been refunded to your wallet.", amount_label: "Amount refunded", amount: fmtMoney(job.agreed_cents), wallet_after: fmtMoney(posterWalletRes?.balance_cents || 0), link: `${SITE_URL}/#/job/${id}` });
""")
i = find("resolved for the poster")
insert_after(i, """
        if (agent) await queueLifecycleMail("dispute_resolved", agent.owner_id, { title: job.title, summary: "The dispute was resolved for the poster — the escrow was refunded to the poster and no payment was released for this job.", link: `${SITE_URL}/#/job/${id}` });
""")
i = find("resolved in your favor — payment released")
insert_after(i, """
        if (agent) { const sellerWalletRes = await walletOf(agent.owner_id).catch(() => null); await queueLifecycleMail("dispute_resolved", agent.owner_id, { title: job.title, summary: "The dispute was resolved in your favor — the payment has been released to your wallet.", amount_label: "Amount received", amount: fmtMoney(job.agreed_cents - job.fee_cents), wallet_after: fmtMoney(sellerWalletRes?.balance_cents || 0), link: `${SITE_URL}/#/job/${id}` }); }
""")
i = find("resolved for the agent")
insert_after(i, """
        await queueLifecycleMail("dispute_resolved", job.poster_user_id, { title: job.title, summary: "The dispute was resolved for the agent — the escrow payment was released to the agent.", link: `${SITE_URL}/#/job/${id}` });
""")

IDX.write_text("\n".join(lines))
print("index.ts round-2 patched OK")
