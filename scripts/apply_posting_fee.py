#!/usr/bin/env python3
"""Job posting rules (owner's own design, approved verbatim 2026-10-26):
at most 3 job posts per ACCOUNT per UTC day (the owner's agents and human
profile all post as the same account, so the count inside postJob covers
the web path and the agent path), and a $2.00 posting fee charged from the
poster's wallet to the platform on top of the escrow hold - the fee is
KEPT even if the job is later cancelled (cancel refunds only the escrow).

postJob changes: (1) cap count before any money moves (429 at 3/day);
(2) a balance pre-check requiring budget + fee, with an error that names
both amounts; (3) the fee debit via ex_move_balance (type "posting_fee")
right after the job row exists - inside the existing try, so a failure
still refunds the escrow hold via the established catch. Also states the
rule in /agent/help platform_rules, the docs rules panel, the post-a-job
page subtitle, and the README rules section.
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


def insert_after(idx, block):
    global lines
    lines = lines[: idx + 1] + block.strip("\n").split("\n") + lines[idx + 1 :]


def insert_before(idx, block):
    global lines
    lines = lines[:idx] + block.strip("\n").split("\n") + lines[idx:]


# 1) constants beside the rate limit constant
i = find("const RATE_LIMIT_PER_MIN = 120;")
insert_after(i, """
const MAX_JOB_POSTS_PER_DAY = 3;
const POSTING_FEE_CENTS = 200;
""")

# 2) cap + balance pre-check inside postJob, right after mode/t are set
i = find('const mode = b.mode === "fixed" ? "fixed" : "bidding";')
assert "const t = now();" in lines[i + 1], lines[i + 1]
insert_after(i + 1, """
    // JOB POSTING RULES (owner's design, 2026-10-26): at most 3 job posts
    // per ACCOUNT per UTC day - every path posts as this account, so one
    // count covers the owner, their agents and their human profile. And
    // every post costs a $2.00 posting fee on top of the escrow hold (see
    // the debit after the job row is created); the fee is kept even if the
    // job is later cancelled.
    const dayStart = Math.floor(t / 86400) * 86400;
    const todaysPosts = await pg(`ex_jobs?poster_user_id=eq.${posterUserId}&created_at=gte.${dayStart}&select=id&limit=${MAX_JOB_POSTS_PER_DAY + 1}`);
    if (todaysPosts.length >= MAX_JOB_POSTS_PER_DAY) throw Object.assign(new Error(`daily job limit reached: an account can post at most ${MAX_JOB_POSTS_PER_DAY} jobs per day (UTC). The limit resets at 00:00 UTC.`), { status: 429 });
    const walletPre = await walletOf(posterUserId).catch(() => null);
    if (!walletPre || (walletPre.balance_cents || 0) < budget + POSTING_FEE_CENTS) throw Object.assign(new Error(`insufficient balance - posting this job needs $${((budget + POSTING_FEE_CENTS) / 100).toFixed(2)} in your wallet: the $${(budget / 100).toFixed(2)} budget (held in escrow) plus the $2.00 posting fee (current balance $${(((walletPre?.balance_cents) || 0) / 100).toFixed(2)}). Add funds first (POST /agent/deposit, or the owner tops up from the dashboard), then post the job again.`), { status: 400 });
""")

# 3) the fee debit, right after the escrow ledger ref is fixed to the job id
i = find("type=eq.escrow_hold&ref=eq.job:new")
insert_after(i, """
      // The $2.00 posting fee: charged to the platform, kept even if the
      // job is later cancelled (owner's rule, 2026-10-26). The pre-check
      // above guaranteed balance >= budget + fee and the hold only moved
      // the budget, so this debit cannot fail on funds.
      await rpc("ex_move_balance", { p_user: posterUserId, p_amount: -POSTING_FEE_CENTS, p_type: "posting_fee", p_ref: `job:${job.id}`, p_note: `Posting fee for job: ${title}`, p_now: t });
""")

# 4) platform_rules in /agent/help gains the posting rule
i = find('agents_per_account: "At most 3 agents per owner account; suspended agents do not count.",')
insert_after(i, """
          posting: "At most 3 job posts per account per day (UTC), and every post charges a $2.00 posting fee from the owner's wallet on top of the budget held in escrow. The fee is the platform's and is kept even if the job is cancelled.",
""")

IDX.write_text("\n".join(lines))

# 5) docs rules panel: add the posting bullet before the Delivery bullet
app = APP.read_text()
old = "- <b>Delivery</b> - a delivery must contain the actual work"
assert app.count(old) == 1, f"docs delivery bullet: {app.count(old)} hits"
app = app.replace(old, "- <b>Posting jobs</b> - at most <b>3 job posts per account per day</b> (UTC), and every post charges a <b>$2.00 posting fee</b> from the wallet on top of the budget held in escrow. The fee is kept even if the job is cancelled.<br>" + old)

# 6) post-a-job page subtitle states the fee + limit before anyone posts
old2 = "you release payment only when the delivery lands."
assert app.count(old2) == 1, f"post subtitle: {app.count(old2)} hits"
app = app.replace(old2, old2 + " Posting costs a $2.00 fee (the platform's, kept even if you cancel a job), and each account can post at most 3 jobs a day.")
APP.write_text(app)

# 7) cache bump
html = HTML.read_text()
assert "20261026-5" in html
HTML.write_text(html.replace("20261026-5", "20261026-6"))

# 8) README rules section gains the posting rule
readme = README.read_text()
old3 = "- **Job chat:** at most 30 messages per person per job per rolling hour."
assert readme.count(old3) == 1
readme = readme.replace(old3, old3 + "\n- **Posting jobs:** at most 3 job posts per account per day (UTC); every post charges a $2.00 posting fee from the poster's wallet on top of the escrow hold — the fee is kept even if the job is cancelled.")
README.write_text(readme)
print("posting fee + cap patched OK")
