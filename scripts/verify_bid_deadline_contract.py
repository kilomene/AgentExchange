#!/usr/bin/env python3
"""Live E2E for the BID-DEADLINE vs CONTRACT-WINDOW fix (owner report
2026-10-27: job 236's API refused bids with "bidding has closed for this
job" because its stored bid_deadline - set from deadline_hours at
posting - passed ~3.4h earlier, while the job itself was still open and
its contract work window ran for another day).

Rule proven here: for CONTRACT jobs the effective bidding deadline is
never earlier than the contract window's end.
  * At posting, the stored bid_deadline is raised to the window end.
  * At bid/claim time the deadline is computed live as
    max(stored bid_deadline, contract window_end), so a later window
    extension can never strand bidding again (simulated by PATCHing a
    probe job's stored deadline back into the past).
  * Floor / web detail / agent list / agent detail all expose the
    effective bid_deadline, so the UI countdown matches enforcement.
  * A contract whose window has ended AND whose stored deadline is also
    past still refuses bids (a later poster deadline still governs, as
    before - the fix only lifts deadlines that fall before the window).
  * A STANDARD job with a past deadline still refuses bids (unchanged).
  * Job 236 (owner's real job) is READ-ONLY here: stored + exposed
    bid_deadline == its window end 1793144520.

Zero-mail discipline: mailer PAUSE on first, dynamic baselines, every
seeded row deleted afterwards, baselines must return byte-identical.
"""
import hashlib
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
ATTESTED = "+15557650199"
TEST_NUMBER = "+19565537205"
PAY_RULE = {"answered_completed": 100, "answered_partial": 50, "voicemail_left": 50,
            "no_answer": 0, "busy": 0, "wrong_number": 0, "refused_recording": 0}
QUESTIONS = ["What are your opening hours this week?", "Can an appointment be confirmed for Thursday morning?"]
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS: " if cond else "FAIL: ") + name + (f"  [{detail}]" if detail else ""))
    if not cond:
        raise AssertionError(name + " " + str(detail))


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation", "-d", json.dumps(body)]
    return curl(a)


def api(path, key=None, agent_key=None, method="GET", body=None, raw=False):
    a = ["-X", method, f"{API}{path}"]
    if key:
        a += ["-H", f"X-API-Key: {key}"]
    if agent_key:
        a += ["-H", f"X-Agent-Key: {agent_key}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = curl(a)
    return out if raw else json.loads(out)


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def wallet(uid):
    rows = json.loads(rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents"))
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def count(table):
    return len(json.loads(rest(f"{table}?select=id")))


def seed_user(name):
    ts = int(time.time())
    key = f"probe-{name.lower().replace(' ', '-')}-{ts}-{int(time.time() * 1000) % 9973}"
    body = {"email": f"deadlineprobe{ts}{abs(hash(name)) % 99999}@example.org", "password_hash": "probe-only",
            "name": name, "avatar": "", "created_at": ts, "email_verified": True,
            "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "api_key_created_at": ts}
    user = json.loads(rest("ex_users", method="POST", body=body))[0]
    rest("ex_wallets", method="POST", body={"user_id": user["id"], "balance_cents": 100000, "held_cents": 0})
    return user, key


def seed_agent(owner_id, name, key):
    ts = int(time.time())
    return json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": name, "category": "personal", "skills": "calling, appointments",
        "tagline": "I make calls", "description": "probe", "rate_cents": 2000, "status": "active",
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "jobs_completed": 5,
        "created_at": ts}))[0]


def post_contract(poster_key, title, window_start, window_end, deadline_hours=1):
    contract = {"capability": "phone_call", "contact_name": "Probe Contact", "contact_phone": ATTESTED,
                "brief_extra": "Probe context.", "questions": QUESTIONS,
                "window_tz": "UTC", "window_start": window_start, "window_end": window_end,
                "max_attempts": 3, "pay_rule": PAY_RULE,
                "poster_attestation": "I am authorised to have this person called about this matter and the purpose is lawful."}
    body = {"title": title, "description": "Bid deadline probe contract job.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": deadline_hours,
            "job_kind": "contract", "contract": contract}
    return api("/jobs", key=poster_key, method="POST", body=body)


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_bid_deadline_contract\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = api("/stats")
    n0 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0} counts {n0}")

    ts = int(time.time())
    T0 = ts - 5
    poster, poster_key = seed_user("Deadline Probe Poster")
    worker_owner, _ = seed_user("Deadline Probe Worker Owner")
    akey = f"deadline-key-{ts}"
    agent = seed_agent(worker_owner["id"], "DeadlineProbeCaller", akey)
    print(f"seeded: poster {poster['id']}, worker owner {worker_owner['id']}, agent {agent['id']}")
    job_ids = []
    try:
        # ---- make the agent Call Verified via the ring test ----
        r = api("/agent/capabilities/phone_call/attest", agent_key=akey, method="POST", body={"phone": ATTESTED})
        check("attest accepts the caller number", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:160])
        t1 = api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})
        ok = api(f"/agent/capabilities/tests/{t1['test_id']}/submit", agent_key=akey, method="POST",
                 body={"dialed_number": TEST_NUMBER, "from_number": ATTESTED, "outcome": "rang",
                       "rang_at": int(time.time()), "duration_sec": 5})
        check("ring report passes -> Call Verified", ok.get("passed") is True, json.dumps(ok)[:200])

        now = int(time.time())

        # ---- Job D: deadline_hours=1 but window ends in ~26h ----
        D_START, D_END = now + 3600, now + 26 * 3600
        jD = post_contract(poster_key, "Deadline Probe D: short deadline, long window", D_START, D_END, deadline_hours=1)
        jobD = jD.get("id") or (jD.get("job") or {}).get("id")
        job_ids.append(jobD)
        check("job D posted", bool(jobD), json.dumps(jD)[:200])
        rows = json.loads(rest(f"ex_jobs?id=eq.{jobD}&select=bid_deadline"))
        check("job D stored bid_deadline raised to window end at posting",
              rows and rows[0]["bid_deadline"] == D_END, json.dumps(rows))
        # isolate the deadline logic from the match priority window
        rest(f"ex_contract_jobs?job_id=eq.{jobD}", method="PATCH", body={"match_open_at": 0, "match_invited": []})

        # ---- simulate the job-236 divergence: stored deadline in the past,
        #      window still running -> bidding must stay open ----
        rest(f"ex_jobs?id=eq.{jobD}", method="PATCH", body={"bid_deadline": now - 3600})
        rows = json.loads(rest(f"ex_jobs?id=eq.{jobD}&select=bid_deadline"))
        check("job D stored deadline forced into the past (divergence simulated)",
              rows and rows[0]["bid_deadline"] == now - 3600, json.dumps(rows))

        det = api(f"/jobs/{jobD}", key=poster_key)
        check("web detail exposes effective bid_deadline == window end",
              det["job"].get("bid_deadline") == D_END, str(det["job"].get("bid_deadline")))
        floor = api("/jobs?kind=contract&capability=phone_call")
        frow = next((x for x in floor.get("jobs", []) if x["id"] == jobD), None)
        check("floor exposes effective bid_deadline == window end",
              frow is not None and frow.get("bid_deadline") == D_END, str(frow and frow.get("bid_deadline")))
        alist = api("/agent/jobs?all=1", agent_key=akey)
        arow = next((x for x in alist.get("jobs", []) if x["id"] == jobD), None)
        check("agent list exposes effective bid_deadline == window end",
              arow is not None and arow.get("bid_deadline") == D_END, str(arow and arow.get("bid_deadline")))
        adet = api(f"/agent/jobs/{jobD}", agent_key=akey)
        check("agent detail exposes effective bid_deadline == window end",
              adet["job"].get("bid_deadline") == D_END, str(adet["job"].get("bid_deadline")))

        bid = api(f"/agent/jobs/{jobD}/bid", agent_key=akey, method="POST",
                  body={"amount": 18, "eta_hours": 24, "pitch": "verified caller, bidding inside the window"})
        check("bid ACCEPTED despite past stored deadline (contract window still open)",
              bool(bid.get("id")), json.dumps(bid)[:240])

        # ---- Job E: window ended AND stored deadline past -> really closed ----
        # (The rule is max(stored, window_end): a poster deadline LATER than
        # the window end still governs, as before - see job C in
        # verify_window_tz.py. Refusal requires BOTH to be in the past.)
        E_START, E_END = now - 3600, now - 1800
        jE = post_contract(poster_key, "Deadline Probe E: window ended", E_START, E_END, deadline_hours=48)
        jobE = jE.get("id") or (jE.get("job") or {}).get("id")
        job_ids.append(jobE)
        check("job E posted", bool(jobE), json.dumps(jE)[:200])
        rest(f"ex_contract_jobs?job_id=eq.{jobE}", method="PATCH", body={"match_open_at": 0, "match_invited": []})
        rest(f"ex_jobs?id=eq.{jobE}", method="PATCH", body={"bid_deadline": now - 7200})
        detE = api(f"/jobs/{jobE}", key=poster_key)
        check("web detail E exposes effective bid_deadline == past window end",
              detE["job"].get("bid_deadline") == E_END, str(detE["job"].get("bid_deadline")))
        raw = api(f"/agent/jobs/{jobE}/bid", agent_key=akey, method="POST",
                  body={"amount": 18, "eta_hours": 24, "pitch": "too late"}, raw=True)
        check("bid REFUSED once window end and stored deadline are both past",
              "bidding has closed for this job" in raw, raw[:240])

        # ---- Job F: standard job, past deadline -> still refused (unchanged) ----
        jF = api("/jobs", key=poster_key, method="POST", body={
            "title": "Deadline Probe F: standard job", "description": "Standard bidding probe.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": 1})
        jobF = jF.get("id") or (jF.get("job") or {}).get("id")
        job_ids.append(jobF)
        check("job F (standard) posted", bool(jobF), json.dumps(jF)[:200])
        rest(f"ex_jobs?id=eq.{jobF}", method="PATCH", body={"bid_deadline": now - 3600})
        raw = api(f"/agent/jobs/{jobF}/bid", agent_key=akey, method="POST",
                  body={"amount": 18, "eta_hours": 24, "pitch": "too late"}, raw=True)
        check("standard job bid still REFUSED after its deadline",
              "bidding has closed for this job" in raw, raw[:240])

        # ---- Job 236: owner's real job, READ-ONLY ----
        det236 = api("/jobs/236")
        j236 = det236["job"]
        check("job 236 stored+exposed bid_deadline == window end 1793144520",
              j236.get("bid_deadline") == 1793144520, str(j236.get("bid_deadline")))
        check("job 236 contract window unchanged",
              j236["contract"].get("window_start") == 1793058120 and j236["contract"].get("window_end") == 1793144520,
              json.dumps({k: j236["contract"].get(k) for k in ("window_start", "window_end")}))
        check("job 236 still open", j236.get("status") == "open", str(j236.get("status")))
        alist236 = api("/agent/jobs?all=1", agent_key=akey)
        arow236 = next((x for x in alist236.get("jobs", []) if x["id"] == 236), None)
        check("agent list: job 236 bid_deadline == window end",
              arow236 is not None and arow236.get("bid_deadline") == 1793144520,
              str(arow236 and arow236.get("bid_deadline")))

        print(f"\nALL {len(RESULTS)} CHECKS PASSED")
    finally:
        for jid in job_ids:
            if not jid:
                continue
            rest(f"ex_contract_attempts?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_contract_tasks?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_schedule_file_access?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_contract_jobs?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_messages?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
        rest(f"ex_capability_tests?agent_id=eq.{agent['id']}", method="DELETE")
        rest(f"ex_agent_capabilities?agent_id=eq.{agent['id']}", method="DELETE")
        rest(f"ex_agents?id=eq.{agent['id']}", method="DELETE")
        for u in (poster, worker_owner):
            rest(f"ex_notifications?user_id=eq.{u['id']}", method="DELETE")
            rest(f"ex_ledger?user_id=eq.{u['id']}", method="DELETE")
            rest(f"ex_wallets?user_id=eq.{u['id']}", method="DELETE")
            rest(f"ex_user_wallets?user_id=eq.{u['id']}", method="DELETE")
            rest(f"ex_users?id=eq.{u['id']}", method="DELETE")
        for fd in json.loads(rest(f"ex_feed?created_at=gte.{T0}&select=id")):
            rest(f"ex_feed?id=eq.{fd['id']}", method="DELETE")
        for ob in json.loads(rest(f"ex_outbox?created_at=gte.{T0}&select=id")):
            rest(f"ex_outbox?id=eq.{ob['id']}", method="DELETE")
            print("deleted queued mail row", ob["id"], "(never sent - mailer paused)")
        ob1 = outbox_state()
        f1, u41 = wallet(1), wallet(4)
        st1 = api("/stats")
        n1 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
        check("cleanup: outbox byte-identical", ob1 == ob0, f"{ob0} -> {ob1}")
        check("cleanup: founder wallet byte-identical", f1 == f0, f"{f0} -> {f1}")
        check("cleanup: user-4 wallet byte-identical", u41 == u40, f"{u40} -> {u41}")
        check("cleanup: stats byte-identical", st1 == st0, f"{st0} -> {st1}")
        check("cleanup: users/agents/jobs counts restored", n1 == n0, f"{n0} -> {n1}")
        PAUSE.unlink()
        print("PAUSE removed last; cleanup complete")


if __name__ == "__main__":
    main()
