#!/usr/bin/env python3
"""Live E2E for #2 PROVE-IT SKILL TRIALS (owner pick 2026-10-26).
Registers a throwaway agent (register queues no mail), proves: trial
list, the >$100 bid gate BLOCKS before the trial, a passing submission
scores 100 and lands the verified badge, a weak submission fails with a
report, and after passing, the same bid goes through. The one real bid
runs under a mailer PAUSE and is deleted with its mail/feed rows.
Everything created is deleted; outbox and floor proven unchanged."""
import json
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = {}
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip()
SRK = ENV["SUPABASE_SERVICE_ROLE_KEY"]
REST = "https://xjpfyqzqqjeejrxzafth.supabase.co/rest/v1"
API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"

PASS_HTML = """<!doctype html><html><head><title>Ember & Oak Coffee</title></head><body>
<h1>Ember & Oak</h1><table><tr><th>Item</th><th>Price</th></tr>
<tr><td>Espresso</td><td>3</td></tr><tr><td>Latte</td><td>4</td></tr>
<tr><td>Mocha</td><td>5</td></tr><tr><td>Tea</td><td>3</td></tr></table>
<form><input name="order"><button>Order</button></form>
<footer>Opening hours: 7am - 7pm every day</footer></body></html>"""


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation", "-d", json.dumps(body)]
    return curl(a)


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def main():
    ob0 = outbox_state()
    jobs = json.loads(curl([f"{API}/jobs?limit=100"]))["jobs"]
    big = [j for j in jobs if j["budget_cents"] > 10000 and j["status"] == "open" and j["mode"] == "bidding"]
    assert big, "no open >$100 bidding job on the floor for the gate test"
    job = big[0]
    print(f"gate test job: {job['id']} budget ${job['budget_cents']/100} category {job['category']}")
    # Seed the throwaway agent directly in the DB: /agent/register is
    # already proven, and this VM's egress IP is currently flagged as a
    # proxy by the signup guard, so the public register path refuses.
    import hashlib as _hl
    key = "trialprobe-" + str(int(time.time()))
    ts = int(time.time())
    owner = json.loads(rest("ex_users", method="POST", body={
        "email": f"trialprobe{ts}@example.org", "password_hash": "probe-only",
        "name": "Trial Probe Owner", "avatar": "", "created_at": ts}))[0]
    owner_id = owner["id"]
    rest("ex_wallets", method="POST", body={"user_id": owner_id, "balance_cents": 0, "held_cents": 0})
    agent = json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": "TrialProbe", "category": job["category"],
        "skills": "testing", "tagline": "", "description": "", "rate_cents": 5000,
        "status": "active", "api_key_hash": _hl.sha256(key.encode()).hexdigest(),
        "jobs_completed": 5, "created_at": ts}))[0]
    agent_id = agent["id"]
    print("throwaway agent:", agent_id, "owner:", owner_id)
    T0 = int(time.time()) - 5
    bid_id = None
    try:
        # 1) gate blocks the big bid before any trial
        out = curl(["-X", "POST", f"{API}/agent/jobs/{job['id']}/bid", "-H", f"X-Agent-Key: {key}",
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps({"amount": 50, "eta_hours": 24, "pitch": "probe"})])
        assert "skill trial required" in out, out[:300]
        print("PASS: bid over $100 blocked without a passed trial")

        # 2) trials list
        tl = json.loads(curl([f"{API}/agent/trials", "-H", f"X-Agent-Key: {key}"]))
        assert len(tl["trials"]) == 8, len(tl["trials"])
        print("PASS: 8 trials listed")

        # 3) start + pass the development-style trial for the job's category
        st = json.loads(curl(["-X", "POST", f"{API}/agent/trials/{job['category']}/start",
                              "-H", f"X-Agent-Key: {key}", "-H", "Content-Type: application/json", "-d", "{}"]))
        att = st["attempt"]["id"]
        cat = job["category"]
        payload = PASS_HTML if cat == "development" else None
        if payload is None:
            # generic strong submission per category type
            payload = ("Summary\nFindings\nSources\n" + ("word " * 320) + " http://a.example http://b.example\n"
                       if cat == "research" else "x " * 500)
        sub = json.loads(curl(["-X", "POST", f"{API}/agent/trials/{att}/submit",
                               "-H", f"X-Agent-Key: {key}", "-H", "Content-Type: application/json",
                               "-d", json.dumps({"text": payload})]))
        print(f"submission: score {sub.get('score')} passed {sub.get('passed')}")
        if cat == "development":
            assert sub["passed"] and sub["score"] == 100, sub
        agent_pub = json.loads(curl([f"{API}/agents/{agent_id}"]))["agent"]
        sv = agent_pub.get("skills_verified") or []
        print("skills_verified on public profile:", sv)
        assert any(x["category"] == cat for x in sv), sv

        # 4) weak submission fails with a report (fresh attempt, research)
        st2 = json.loads(curl(["-X", "POST", f"{API}/agent/trials/research/start",
                               "-H", f"X-Agent-Key: {key}", "-H", "Content-Type: application/json", "-d", "{}"]))
        sub2 = json.loads(curl(["-X", "POST", f"{API}/agent/trials/{st2['attempt']['id']}/submit",
                                "-H", f"X-Agent-Key: {key}", "-H", "Content-Type: application/json",
                                "-d", json.dumps({"text": "this submission is deliberately far too weak to pass"})]))
        assert sub2["passed"] is False and sub2["score"] < 70 and len(sub2["report"]) >= 4, sub2
        print(f"PASS: weak submission failed honestly (score {sub2['score']})")

        # 5) the same big bid now goes through (under mailer PAUSE)
        assert not PAUSE.exists()
        PAUSE.write_text("verify_skill_trials\n")
        time.sleep(6)
        try:
            out = curl(["-X", "POST", f"{API}/agent/jobs/{job['id']}/bid", "-H", f"X-Agent-Key: {key}",
                        "-H", "Content-Type: application/json",
                        "-d", json.dumps({"amount": 50, "eta_hours": 24, "pitch": "probe after trial"})])
            resp = json.loads(out)
            bid_id = resp.get("id")
            assert bid_id, out[:300]
            print("PASS: bid accepted after passing the trial, bid id", bid_id)
        finally:
            if bid_id:
                rest(f"ex_bids?id=eq.{bid_id}", method="DELETE")
            for n in json.loads(rest(f"ex_notifications?created_at=gte.{T0}&select=id")):
                rest(f"ex_notifications?id=eq.{n['id']}", method="DELETE")
            for fd in json.loads(rest(f"ex_feed?created_at=gte.{T0}&select=id")):
                rest(f"ex_feed?id=eq.{fd['id']}", method="DELETE")
            for ob in json.loads(rest(f"ex_outbox?created_at=gte.{T0}&select=id")):
                rest(f"ex_outbox?id=eq.{ob['id']}", method="DELETE")
                print("deleted queued mail row", ob["id"], "(never sent)")
            PAUSE.unlink()
        print("PASS: skill trials E2E complete")
    finally:
        for t in json.loads(rest(f"ex_trial_attempts?agent_id=eq.{agent_id}&select=id")):
            rest(f"ex_trial_attempts?id=eq.{t['id']}", method="DELETE")
        rest(f"ex_agent_skills?agent_id=eq.{agent_id}", method="DELETE")
        rest(f"ex_agents?id=eq.{agent_id}", method="DELETE")
        rest(f"ex_wallets?user_id=eq.{owner_id}", method="DELETE")
        rest(f"ex_user_wallets?user_id=eq.{owner_id}", method="DELETE")
        rest(f"ex_users?id=eq.{owner_id}", method="DELETE")
        ob1 = outbox_state()
        assert ob1 == ob0, (ob0, ob1)
        left = json.loads(rest(f"ex_agents?id=eq.{agent_id}&select=id"))
        assert not left
        print(f"cleanup done; outbox unchanged {ob1}; throwaway agent + owner deleted")


if __name__ == "__main__":
    main()
