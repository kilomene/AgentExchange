#!/usr/bin/env python3
"""Agent Exchange - NOVA INC POSTING EXEMPTION live E2E (zero-mail discipline).

Owner's order (2026-10-26): "Nova Inc doesn't have limit to job posting."
The Nova Inc company account (ex_users id 1) is EXEMPT from the job
posting limits: no 3-posts/day cap, no $2.00 posting fee, wallet
pre-check = budget only. Every other account keeps both rules.

Proves, against the LIVE function + REST:
 - the founder posts FOUR standard jobs in one UTC day - all succeed
   (the old code 429s the 4th);
 - NO posting_fee ledger row exists for those four jobs, and the
   founder wallet moved by exactly the four budgets (balance -2000,
   held +2000) and nothing more;
 - a NON-Nova seeded account still posts 3 fine and is refused with a
   429 daily-limit error on the 4th;
 - after cancelling all test jobs and deleting every seeded row, the
   snapshot equals the start snapshot byte-for-byte (founder wallet,
   outbox, counts, stats, pool).

Baselines are snapshot-relative (taken at start): job 236, a genuine
founder posting, legitimately moved the recorded constants during the
Phase D window, so this script asserts start == end instead.

Discipline: PAUSE asserted absent at start, written before any API
call; removed last after cleanup + a drain sleep.
"""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path.home() / "workspace" / "agent-exchange"
ENV = {}
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip()

FUNC = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
REST = "https://xjpfyqzqqjeejrxzafth.supabase.co/rest/v1"
SRK = ENV["SUPABASE_SERVICE_ROLE_KEY"]
FOUNDER_KEY = (ROOT / ".admin-api-key").read_text().strip()
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
T0 = int(time.time())

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def curl(args, data=None):
    cmd = ["curl", "-s", "--max-time", "120"] + args
    if data is not None:
        cmd += ["--data-binary", data]
    return subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")


def rest(path, method="GET", body=None, prefer=None):
    last = None
    for attempt in range(4):
        args = [f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
        if method != "GET":
            args += ["-X", method]
        if body is not None:
            args += ["-H", "content-type: application/json"]
        if prefer:
            args += ["-H", f"Prefer: {prefer}"]
        out = curl(args, json.dumps(body) if body is not None else None)
        try:
            last = json.loads(out) if out.strip() else None
        except Exception:
            last = None
            time.sleep(2)
            continue
        if isinstance(last, dict) and last.get("code") and attempt < 3:
            time.sleep(2)
            continue
        return last
    return last


def api(path, key=None, body=None, method="POST"):
    args = [f"{FUNC}{path}"]
    hdr = []
    if key:
        hdr += ["-H", f"X-API-Key: {key}", "-H", f"X-Agent-Key: {key}"]
    if body is not None:
        hdr += ["-H", "content-type: application/json"]
        args += hdr + ["-X", method]
        out = curl(args, json.dumps(body))
    else:
        args += hdr + ["-X", method]
        out = curl(args)
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out}


def wallet(uid):
    rows = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def snapshot():
    s = api("/stats", method="GET")
    return {
        "outbox_max": (rest("ex_outbox?select=id&order=id.desc&limit=1") or [{}])[0].get("id"),
        "outbox_count": len(rest("ex_outbox?select=id") or []),
        "founder": wallet(1), "user4": wallet(4),
        "users": len(rest("ex_users?select=id") or []),
        "agents": len(rest("ex_agents?select=id") or []),
        "jobs": len(rest("ex_jobs?select=id") or []),
        "stats": {k: s.get(k) for k in ("users", "agents", "open_jobs", "jobs_completed", "volume_cents", "guarantee_pool_cents", "fee_pct")},
        "pool": [r for r in rest("ex_settings?select=*") if r.get("key") == "guarantee_pool_cents"][0]["value"],
    }


seeded_users, seeded_jobs, founder_jobs = [], [], []


def post_job(key, title, budget=5):
    return api("/jobs", key, {
        "title": title, "description": "Posting-exemption verification probe.",
        "category": "personal", "budget": budget, "mode": "bidding", "deadline_hours": 48})


def main():
    assert not PAUSE.exists(), "PAUSE already present - a verification window is open elsewhere"
    base = snapshot()
    print("BASELINE:", json.dumps(base))
    check("baseline outbox matches the recorded platform state",
          base["outbox_max"] == 231 and base["outbox_count"] == 200, json.dumps(base)[:200])
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    PAUSE.write_text("verify_posting_exemption window\n")
    try:
        run(base)
    finally:
        cleanup(base)


def run(base):
    # ---------- 1. Founder (user 1, Nova Inc) posts FOUR jobs in one day
    ids = []
    for i in range(1, 5):
        r = post_job(FOUNDER_KEY, f"NovaExempt probe {i}")
        jid = r.get("id")
        check(f"exemption: founder post {i}/4 succeeds (no daily cap)", bool(jid), json.dumps(r)[:160])
        if jid:
            ids.append(jid)
            seeded_jobs.append(jid)
            founder_jobs.append(jid)
    fees = rest(f"ex_ledger?user_id=eq.1&type=eq.posting_fee&created_at=gte.{T0}&select=id,ref") or []
    check("exemption: NO posting_fee ledger rows for the founder's four posts",
          len(fees) == 0, f"fee rows={len(fees)}")
    w = wallet(1)
    check("exemption: founder wallet moved by exactly the four budgets (balance -2000, held +2000)",
          w[0] == base["founder"][0] - 2000 and w[1] == base["founder"][1] + 2000,
          f"base={base['founder']} now={w}")

    # ---------- 2. A non-Nova account still hits the cap on its 4th post
    email = "novaexempt-plain@example.invalid"
    key = "nxp-" + hashlib.sha256(email.encode()).hexdigest()[:28]
    rows = rest("ex_users", "POST", {
        "email": email, "name": "NX Plain Poster", "password_hash": "x", "role": "user",
        "email_verified": True, "api_key_hash": hashlib.sha256(key.encode()).hexdigest(),
        "api_key_created_at": T0, "created_at": T0}, "return=representation")
    uid = rows[0]["id"]
    seeded_users.append(uid)
    rest("ex_wallets", "POST", {"user_id": uid, "balance_cents": 100000, "held_cents": 0})
    ok = 0
    for i in range(1, 4):
        r = post_job(key, f"NX plain probe {i}")
        if r.get("id"):
            ok += 1
            seeded_jobs.append(r["id"])
    check("control: non-Nova account posts its first 3 jobs fine", ok == 3, f"ok={ok}")
    r = post_job(key, "NX plain probe 4")
    check("control: non-Nova 4th post in a day is refused 429 (daily limit)",
          "daily job limit" in json.dumps(r), json.dumps(r)[:220])
    fees = rest(f"ex_ledger?user_id=eq.{uid}&type=eq.posting_fee&select=id") or []
    check("control: the non-Nova account WAS charged the $2 fee on each post (3 rows)",
          len(fees) == 3, f"fee rows={len(fees)}")


def cleanup(base):
    # The founder's jobs are cancelled properly first: the cancel
    # refunds the escrow hold back to the founder wallet (there was no
    # posting fee to keep). Seeded-user jobs are deleted at REST level
    # below, wallet and all, like every other verify script.
    for jid in founder_jobs:
        api(f"/jobs/{jid}/action", FOUNDER_KEY, {"action": "cancel"})
    for jid in list(seeded_jobs):
        rest(f"ex_bids?job_id=eq.{jid}", "DELETE")
        rest(f"ex_messages?job_id=eq.{jid}", "DELETE")
        rest(f"ex_jobs?id=eq.{jid}", "DELETE")
    for uid in seeded_users:
        rest(f"ex_notifications?user_id=eq.{uid}", "DELETE")
        rest(f"ex_ledger?user_id=eq.{uid}", "DELETE")
        rest(f"ex_wallets?user_id=eq.{uid}", "DELETE")
        rest(f"ex_user_wallets?user_id=eq.{uid}", "DELETE")
        rest(f"ex_users?id=eq.{uid}", "DELETE")
    rest(f"ex_feed?created_at=gte.{T0}", "DELETE")
    rest(f"ex_outbox?created_at=gte.{T0}", "DELETE")
    rest("ex_settings?key=eq.guarantee_pool_cents", "PATCH", {"value": base["pool"]})
    time.sleep(6)
    after = snapshot()
    check("cleanup: baselines byte-identical (founder wallet, outbox, counts, stats, pool)",
          after == base, f"\n  base={json.dumps(base)}\n  after={json.dumps(after)}")
    PAUSE.unlink(missing_ok=True)
    check("cleanup: PAUSE removed last, mailer unpaused", not PAUSE.exists())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("ERROR:", e)
        try:
            cleanup({"outbox_max": 231, "outbox_count": 200, "founder": None, "user4": (200, 3290),
                     "users": 8, "agents": 4, "jobs": 34,
                     "stats": {}, "pool": "0"})
        except Exception as e2:
            print("CLEANUP ERROR:", e2)
            PAUSE.unlink(missing_ok=True)
        sys.exit(2)
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n==== {len(RESULTS) - len(fails)}/{len(RESULTS)} checks PASS ====")
    if fails:
        for n, _, d in fails:
            print("FAILED:", n, d)
        sys.exit(1)
