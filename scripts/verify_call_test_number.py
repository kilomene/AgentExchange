#!/usr/bin/env python3
"""Live E2E for the NOVA CALL TEST NUMBER + RING TEST (owner orders
2026-10-26 18:37 + 18:41 PDT). Zero-mail discipline: the mailer PAUSE
goes on FIRST, baselines are snapshotted, every seeded row is deleted
afterwards, and the baselines must come back byte-identical.

Proves, against the live API:
  * GET /agent/capabilities exposes the Nova test number +19565537205.
  * Call Test start returns the test number and RING-TEST instructions
    (dial the Nova test number from the attested number; if it rings,
    cut the call yourself; submit the call report).
  * A call report {dialed +19565537205, from = attested, outcome rang}
    PASSES and marks the agent Call Verified (90 days).
  * Negative reports FAIL: wrong dialed number; caller other than the
    attested number; outcome other than "rang".
  * A human profile is still refused from starting the Call Test.
NO real call is placed and NO real email is sent - the reports are
synthetic, exactly as in prior phases; probe users use reserved-domain
emails and the mailer is paused throughout.
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
TEST_NUMBER = "+19565537205"
TEST_NUMBER_DISPLAY = "+1 (956) 553-7205"
ATTESTED = "+15557650101"
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


def stats():
    return api("/stats")


def seed_user(name):
    ts = int(time.time())
    body = {"email": f"calltestprobe{ts}{abs(hash(name)) % 99999}@example.org", "password_hash": "probe-only",
            "name": name, "avatar": "", "created_at": ts, "email_verified": True}
    user = json.loads(rest("ex_users", method="POST", body=body))[0]
    rest("ex_wallets", method="POST", body={"user_id": user["id"], "balance_cents": 100000, "held_cents": 0})
    return user


def seed_agent(owner_id, name, key, is_human=False):
    ts = int(time.time())
    agent = json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": name, "category": "personal", "skills": "calling",
        "tagline": "I make calls", "description": "probe", "rate_cents": 2000, "status": "active",
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "jobs_completed": 5,
        "is_human": is_human, "created_at": ts}))[0]
    return agent


def start_test(akey):
    return api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})


def report(akey, test_id, dialed=TEST_NUMBER, frm=ATTESTED, outcome="rang", dur=5):
    return api(f"/agent/capabilities/tests/{test_id}/submit", agent_key=akey, method="POST",
               body={"dialed_number": dialed, "from_number": frm, "outcome": outcome,
                     "rang_at": int(time.time()), "duration_sec": dur})


def mine_status(akey):
    mine = api("/agent/capabilities", agent_key=akey)
    rows = mine.get("mine") or []
    return (rows[0].get("status") if rows else None), mine


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_call_test_number\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = stats()
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0}")
    check("baseline outbox is 440/203 (moved by the owner's own live Folk registration + bids at 18:43 PDT)", ob0 == (440, 203), str(ob0))
    check("baseline founder wallet is 254200/245700", f0 == (254200, 245700), str(f0))
    check("baseline user-4 wallet is 200/3290", u40 == (200, 3290), str(u40))
    check("baseline stats match", st0 == {"users": 9, "agents": 5, "open_jobs": 32, "jobs_completed": 2,
                                          "volume_cents": 5600, "guarantee_pool_cents": 0, "fee_pct": 10}, json.dumps(st0))

    ts = int(time.time())
    T0 = ts - 5
    owner = seed_user("CallTest Probe Owner")
    howner = seed_user("CallTest Probe Human Owner")
    akey = f"calltest-key-{ts}"
    agent = seed_agent(owner["id"], "CallTestProbeCaller", akey)
    hkey = f"calltest-human-{ts}"
    human = seed_agent(howner["id"], "CallTestProbeHuman", hkey, is_human=True)
    print(f"seeded: owner {owner['id']}, agent {agent['id']}, human owner {howner['id']}, human {human['id']}")
    try:
        # ---------- discovery: capabilities exposes the number ----------
        caps = api("/agent/capabilities", agent_key=akey)
        check("GET /agent/capabilities exposes call_test_number",
              caps.get("call_test_number") == TEST_NUMBER, json.dumps({k: caps.get(k) for k in ("call_test_number", "call_test_number_display")}))
        check("capabilities note names the Nova test number",
              "553-7205" in str(caps.get("note", "")), str(caps.get("note", ""))[:200])

        # ---------- attest + start ----------
        r = api("/agent/capabilities/phone_call/attest", agent_key=akey, method="POST", body={"phone": ATTESTED})
        check("attest accepts the caller number", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:200])
        t1 = start_test(akey)
        check("test start returns the Nova test number",
              t1.get("test_number") == TEST_NUMBER and t1.get("call_test_number") == TEST_NUMBER, json.dumps(t1)[:240])
        ins = str(t1.get("instructions", ""))
        check("instructions name the Nova test number as the destination",
              TEST_NUMBER_DISPLAY in ins and TEST_NUMBER in ins, ins[:240])
        check("instructions describe the RING TEST (ring -> cut it yourself, submit the call report)",
              "ring" in ins.lower() and ("cut" in ins.lower() or "hang up" in ins.lower()) and "call report" in ins.lower(), ins[:300])
        check("instructions carry NO spoken-proof requirements for the test",
              "challenge phrase" not in ins.lower() and "transcript" not in ins.lower().split("call report")[0], ins[:300])

        # ---------- negative: wrong dialed number ----------
        bad1 = report(akey, t1["test_id"], dialed="+15550001111")
        check("report with the WRONG dialed number fails", bad1.get("passed") is False, json.dumps(bad1)[:240])
        st, _ = mine_status(akey)
        check("capability still unverified after wrong-dialed report", st == "unverified", str(st))

        # ---------- negative: caller is not the attested number ----------
        t2 = start_test(akey)
        bad2 = report(akey, t2["test_id"], frm="+15559998888")
        check("report from a NON-attested number fails", bad2.get("passed") is False, json.dumps(bad2)[:240])

        # ---------- negative: outcome is not rang ----------
        t3 = start_test(akey)
        bad3 = report(akey, t3["test_id"], outcome="no_ring")
        check("report with outcome != rang fails", bad3.get("passed") is False, json.dumps(bad3)[:240])
        st, _ = mine_status(akey)
        check("capability still unverified after no-ring report", st == "unverified", str(st))

        # ---------- positive: the ring report passes ----------
        t4 = start_test(akey)
        ok = report(akey, t4["test_id"])
        check("valid ring report PASSES (score 100)", ok.get("passed") is True and ok.get("score") == 100, json.dumps(ok)[:300])
        st, mine = mine_status(akey)
        m0 = (mine.get("mine") or [{}])[0]
        check("agent is Call Verified after the ring report",
              st == "verified" and m0.get("attested_last4") == "0101" and m0.get("expires_at", 0) > int(time.time()) + 80 * 86400,
              json.dumps(m0)[:220])

        # ---------- the call report is recorded on the test row ----------
        rows = json.loads(rest(f"ex_capability_tests?id=eq.{t4['test_id']}&select=status,score,report"))
        rep = (rows[0].get("report") or {}).get("call_report") or {}
        check("test row records the call report (dialed/from/outcome)",
              rows[0].get("status") == "passed" and rep.get("dialed_number") == TEST_NUMBER
              and rep.get("from_number") == ATTESTED and rep.get("outcome") == "rang", json.dumps(rows)[:300])

        # ---------- human profile refused ----------
        raw = api("/agent/capabilities/phone_call/test", agent_key=hkey, method="POST", body={}, raw=True)
        check("human profile refused from starting the Call Test", "human" in raw.lower(), raw[:240])
        raw = api("/agent/capabilities/phone_call/attest", agent_key=hkey, method="POST", body={"phone": ATTESTED}, raw=True)
        check("human profile refused from attesting a caller number", "human" in raw.lower(), raw[:240])

        print(f"\nALL {len(RESULTS)} CHECKS PASSED")
    finally:
        # ---------- cleanup: every seeded row goes ----------
        for aid in (agent["id"], human["id"]):
            rest(f"ex_capability_tests?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agent_capabilities?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agents?id=eq.{aid}", method="DELETE")
        for u in (owner, howner):
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
        st1 = stats()
        check("cleanup: outbox byte-identical", ob1 == ob0, f"{ob0} -> {ob1}")
        check("cleanup: founder wallet byte-identical", f1 == f0, f"{f0} -> {f1}")
        check("cleanup: user-4 wallet byte-identical", u41 == u40, f"{u40} -> {u41}")
        check("cleanup: stats byte-identical", st1 == st0, f"{st0} -> {st1}")
        PAUSE.unlink()
        print("PAUSE removed last; cleanup complete")


if __name__ == "__main__":
    main()
