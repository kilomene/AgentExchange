#!/usr/bin/env python3
"""Apply job-lifecycle email notifications to exchange-api/index.ts (2026-10-26).

Adds a queueLifecycleMail helper and hooks real emails (via ex_outbox ->
exchange-mailerd) into the shared lifecycle helpers so BOTH the web routes
and the agent-key routes send them:
- postJob      -> 'job_posted' email to every other user
- placeBid     -> 'bid_received' email to the poster (NEW bids only; the hook
                  sits in the new-bid branch, edits stay silent per bid rules)
- awardJob     -> 'job_awarded' email to the winner's owner, with deadline
- deliverJob   -> 'job_delivered' email to the poster
- completeJob  -> 'payment_received' to the worker (wallet before -> after)
                  and 'payment_sent' to the poster (balance / held / total)
All mail queueing is best-effort try/catch: mail can never break money.
Line-based insertion with assertions; safe to fail, never half-applies
(writes only at the end).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDX = ROOT / "supabase/functions/exchange-api/index.ts"
lines = IDX.read_text().split("\n")


def find(substr, start=0):
    hits = [i for i in range(start, len(lines)) if substr in lines[i]]
    assert len(hits) == 1, f"anchor {substr!r}: {len(hits)} hits"
    return hits[0]


def insert_after(idx, block):
    global lines
    lines = lines[: idx + 1] + block.strip("\n").split("\n") + lines[idx + 1 :]


# 1) helpers after queuePasswordChangedMail (ends with `return mailed;` + `}`)
i = find("  return mailed;")
assert lines[i + 1].strip() == "}", f"unexpected line after return mailed: {lines[i+1]!r}"
insert_after(i + 1, """
// ---------- job-lifecycle emails (owner's order, 2026-10-26) ----------
// Every lifecycle step also sends a real email via ex_outbox ->
// exchange-mailerd (no-reply@novamail.store, Nova Inc). Queueing is
// best-effort: a mail failure must never break the job or the money.
async function userContact(userId: number) {
  return await one(`ex_users?id=eq.${userId}&select=email,name`);
}
const fmtMoney = (c: number) => "$" + (Number(c || 0) / 100).toFixed(2);
function fmtDeadline(ts: number) {
  try { return new Date(ts * 1000).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }) + " UTC"; } catch { return new Date(ts * 1000).toISOString(); }
}
async function queueLifecycleMail(kind: string, userId: number, payload: Record<string, unknown>) {
  try {
    const c = await userContact(userId);
    if (c?.email) await queueMail(kind, c.email, c.name || "", { name: c.name || "", ...payload });
  } catch (e) { console.error("lifecycle mail queue failed", kind, "for user", userId, e); }
}
""")

# 2) postJob: broadcast 'job_posted' to every other user, after the feed line
i = find('await feed("job_posted",')
insert_after(i, """
      // EMAIL every other user about the new job (owner's order, 2026-10-26).
      try {
        const poster = await userContact(posterUserId);
        const others = await pg(`ex_users?id=neq.${posterUserId}&select=id,email,name`);
        for (const o of others) {
          if (!o.email) continue;
          try { await queueMail("job_posted", o.email, o.name || "", { name: o.name || "", poster_name: poster?.name || "A member", title: job.title, category: job.category, budget: fmtMoney(budget), mode, link: `${SITE_URL}/#/job/${job.id}` }); }
          catch (e) { console.error("job_posted mail failed for user", o.id, e); }
        }
      } catch (e) { console.error("job_posted mail broadcast failed", e); }
""")

# 3) placeBid: email the poster on a NEW bid (this line exists only in the
# new-bid branch - bid edits return earlier and stay silent)
i = find('await notify(job.poster_user_id, "bid",')
insert_after(i, """
    await queueLifecycleMail("bid_received", job.poster_user_id, { bidder_name: agent.name, amount: fmtMoney(amount), title: job.title, link: `${SITE_URL}/#/job/${job.id}` });
""")

# 4) awardJob: email the winner's owner with the delivery deadline
i = find('await notify(bid.bidder_user_id, "award",')
insert_after(i, """
    await queueLifecycleMail("job_awarded", bid.bidder_user_id, { agent_name: agent?.name || "Your agent", title: job.title, amount: fmtMoney(bid.amount_cents), deadline: fmtDeadline(updated[0].work_deadline), link: `${SITE_URL}/#/job/${job.id}` });
""")

# 5) deliverJob: email the poster that the work arrived
i = find('await notify(job.poster_user_id, "delivery",')
insert_after(i, """
    const dAgentName = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name`))?.name : null;
    await queueLifecycleMail("job_delivered", job.poster_user_id, { agent_name: dAgentName || "The worker", title: job.title, notes: notes.slice(0, 300), link: `${SITE_URL}/#/job/${job.id}` });
""")

# 6a) completeJob: capture the seller's wallet BEFORE the escrow release
i = find("p_seller: awardedOwner")
insert_after(i - 1, """
    const sellerWalletBefore = await walletOf(awardedOwner).catch(() => null);
""")

# 6b) completeJob: both payment emails after the in-app payment notify
i = find('await notify(awardedOwner, "payment",')
insert_after(i, """
    const sellerWalletAfter = await walletOf(awardedOwner).catch(() => null);
    const posterWalletAfter = await walletOf(job.poster_user_id).catch(() => null);
    await queueLifecycleMail("payment_received", awardedOwner, { title: job.title, amount: fmtMoney(job.agreed_cents - job.fee_cents), wallet_before: fmtMoney(sellerWalletBefore?.balance_cents || 0), wallet_after: fmtMoney(sellerWalletAfter?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` });
    await queueLifecycleMail("payment_sent", job.poster_user_id, { title: job.title, agent_name: agent?.name || "The worker", amount: fmtMoney(job.agreed_cents), wallet_balance: fmtMoney(posterWalletAfter?.balance_cents || 0), escrow_held: fmtMoney(posterWalletAfter?.held_cents || 0), wallet_total: fmtMoney((posterWalletAfter?.balance_cents || 0) + (posterWalletAfter?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` });
""")

IDX.write_text("\n".join(lines))
print("index.ts patched OK")
