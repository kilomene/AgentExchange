#!/usr/bin/env python3
"""Live E2E for the CONTRACT WINDOW TIMEZONE CLARITY FIX (owner order
2026-10-26 ~19:05 PDT). Zero-mail discipline: the mailer PAUSE goes
on FIRST, baselines are snapshotted dynamically, every seeded row is
deleted afterwards, and the baselines must come back byte-identical.

Proves, against the live API:
  * Every contract payload (web job detail, floor list, agent list,
    agent job detail) carries the unambiguous window forms computed
    server-side from the stored epochs + window_tz:
    window_start_utc / window_end_utc (ISO 8601 UTC, exactly the
    stored epoch), window_start_local / window_end_local (the job's
    timezone with the UTC offset spelled out - EST (UTC-5) for a
    November America/New_York window, computed via zoneinfo),
    window_phase and window_opens_in_sec (before a future window).
  * An early attempt-open is refused with a message carrying the UTC
    ISO instant, the job-tz form with offset, and a countdown.
  * A past-window job reports window_phase "closed" with NO
    countdown fields, and its attempt-open refusal names the ended
    instant in both forms.
  * A scheduled contract carries the same clarity fields.
  * Job 236 (the owner's real job, read-only here) shows
    window_start_utc 2026-10-27T10:00:00Z / end 10:40:00Z for its
    stored epochs 1793095200-1793097600 - stored data untouched.
Baselines are DYNAMIC (snapshotted at start): the founder wallet and
counts have legitimately moved since the older suites' hardcoded
snapshots (owner's own $5,000 admin credit, job 236, Folk signup).
"""
import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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
NY = ZoneInfo("America/New_York")
ATTESTED = "+15557650101"
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


def iso_z(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def off_label(dt_local):
    off = dt_local.utcoffset()
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    h, rem = divmod(total, 3600)
    m = rem // 60
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def seed_user(name):
    ts = int(time.time())
    key = f"probe-{name.lower().replace(' ', '-')}-{ts}-{int(time.time() * 1000) % 9973}"
    body = {"email": f"wintzprobe{ts}{abs(hash(name)) % 99999}@example.org", "password_hash": "probe-only",
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


def post_contract(poster_key, title, window_start, window_end, window_tz="America/New_York", scheduled=False):
    contract = {"capability": "phone_call", "brief_extra": "Probe context.", "questions": QUESTIONS,
                "window_tz": window_tz, "window_start": window_start, "window_end": window_end,
                "max_attempts": 3, "pay_rule": PAY_RULE,
                "poster_attestation": "I am authorised to have this outreach made about this matter and the purpose is lawful."}
    if scheduled:
        contract["schedule"] = {"task_count": 2, "cadence": "once", "est_minutes": 30}
    else:
        contract["contact_name"] = "Probe Contact"
        contract["contact_phone"] = ATTESTED
    body = {"title": title, "description": "Window timezone clarity probe job.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": 48,
            "job_kind": "contract", "contract": contract}
    return api("/jobs", key=poster_key, method="POST", body=body)


def assert_window_block(tag, c, start, end, tzname, expect_phase):
    """The shared clarity assertions for one contract block."""
    check(f"{tag}: raw epochs + tz unchanged", c.get("window_start") == start and c.get("window_end") == end
          and c.get("window_tz") == tzname, json.dumps({k: c.get(k) for k in ("window_start", "window_end", "window_tz")}))
    check(f"{tag}: window_start_utc is the exact stored epoch in ISO UTC",
          c.get("window_start_utc") == iso_z(start), f"{c.get('window_start_utc')} vs {iso_z(start)}")
    check(f"{tag}: window_end_utc is the exact stored epoch in ISO UTC",
          c.get("window_end_utc") == iso_z(end), f"{c.get('window_end_utc')} vs {iso_z(end)}")
    loc = datetime.fromtimestamp(start, NY)
    lab = off_label(loc)
    abbr = loc.tzname()
    check(f"{tag}: window_start_local is the job-tz form with offset ({abbr} {lab})",
          c.get("window_start_local", "").startswith(loc.strftime("%b ") + str(loc.day) + loc.strftime(", %Y"))
          and abbr in c.get("window_start_local", "") and f"({lab})" in c.get("window_start_local", ""),
          str(c.get("window_start_local")))
    check(f"{tag}: window_phase is {expect_phase}", c.get("window_phase") == expect_phase, str(c.get("window_phase")))
    if expect_phase == "before":
        ois = c.get("window_opens_in_sec")
        check(f"{tag}: window_opens_in_sec tracks the countdown",
              isinstance(ois, int) and abs((start - int(time.time())) - ois) < 300, str(ois))
        check(f"{tag}: no closes_in while before", "window_closes_in_sec" not in c)
    if expect_phase == "closed":
        check(f"{tag}: no countdown fields once closed",
              "window_opens_in_sec" not in c and "window_closes_in_sec" not in c, json.dumps(c)[:200])


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_window_tz\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = api("/stats")
    n0 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0} counts {n0}")

    ts = int(time.time())
    T0 = ts - 5
    poster, poster_key = seed_user("WinTz Probe Poster")
    worker_owner, _ = seed_user("WinTz Probe Worker Owner")
    akey = f"wintz-key-{ts}"
    agent = seed_agent(worker_owner["id"], "WinTzProbeCaller", akey)
    print(f"seeded: poster {poster['id']}, worker owner {worker_owner['id']}, agent {agent['id']}")
    job_ids = []
    try:
        # ---------- make the agent Call Verified via the ring test ----------
        r = api("/agent/capabilities/phone_call/attest", agent_key=akey, method="POST", body={"phone": ATTESTED})
        check("attest accepts the caller number", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:160])
        t1 = api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})
        ok = api(f"/agent/capabilities/tests/{t1['test_id']}/submit", agent_key=akey, method="POST",
                 body={"dialed_number": TEST_NUMBER, "from_number": ATTESTED, "outcome": "rang",
                       "rang_at": int(time.time()), "duration_sec": 5})
        check("ring report passes -> Call Verified", ok.get("passed") is True, json.dumps(ok)[:200])

        # ---------- job A: future window, America/New_York, EST (UTC-5) ----------
        a_start_local = datetime(2026, 11, 5, 10, 0, tzinfo=NY)
        a_end_local = datetime(2026, 11, 5, 12, 0, tzinfo=NY)
        A_START, A_END = int(a_start_local.timestamp()), int(a_end_local.timestamp())
        assert off_label(a_start_local) == "UTC-5" and a_start_local.tzname() == "EST", "test premise: Nov 5 NY is EST UTC-5"
        jA = post_contract(poster_key, "WinTz Probe A: future NY window", A_START, A_END)
        jobA = jA.get("id") or (jA.get("job") or {})["id"]
        job_ids.append(jobA)
        check("job A posted", bool(jobA), json.dumps(jA)[:200])

        det = api(f"/jobs/{jobA}", key=poster_key)
        assert_window_block("web detail A", det["job"]["contract"], A_START, A_END, "America/New_York", "before")

        floor = api("/jobs?kind=contract&capability=phone_call")
        frow = next((x for x in floor.get("jobs", []) if x["id"] == jobA), None)
        check("floor carries job A", frow is not None)
        assert_window_block("floor A", frow["contract"], A_START, A_END, "America/New_York", "before")

        alist = api("/agent/jobs", agent_key=akey)
        arow = next((x for x in alist.get("jobs", []) if x["id"] == jobA), None)
        check("agent list carries job A", arow is not None, json.dumps(alist)[:160])
        assert_window_block("agent list A", arow["contract"], A_START, A_END, "America/New_York", "before")

        bid = api(f"/agent/jobs/{jobA}/bid", agent_key=akey, method="POST",
                  body={"amount": 18, "eta_hours": 24, "pitch": "verified caller"})
        check("verified agent bids job A", bool(bid.get("id")), json.dumps(bid)[:200])
        api(f"/jobs/{jobA}/award", key=poster_key, method="POST", body={"bid_id": bid["id"]})
        rows = json.loads(rest(f"ex_jobs?id=eq.{jobA}&select=status"))
        check("job A awarded", rows and rows[0]["status"] == "awarded", json.dumps(rows))

        adet = api(f"/agent/jobs/{jobA}", agent_key=akey)
        assert_window_block("agent detail A", adet["job"]["contract"], A_START, A_END, "America/New_York", "before")

        raw = api(f"/agent/jobs/{jobA}/contract/attempts", agent_key=akey, method="POST", body={}, raw=True)
        check("early attempt refused: not opened yet", "has not opened yet" in raw, raw[:300])
        check("early attempt refusal carries the UTC ISO instant", iso_z(A_START) in raw, raw[:300])
        check("early attempt refusal carries the job-tz form with offset",
              "EST" in raw and "(UTC-5)" in raw.replace("EST, ", "EST (") or ("EST" in raw and "UTC-5" in raw), raw[:300])
        check("early attempt refusal carries a countdown", re.search(r"in \d+d \d+h", raw) is not None, raw[:300])
        check("early attempt refusal says act on UTC", "Act on the UTC instant" in raw, raw[:300])

        # ---------- job B: scheduled contract, same clarity fields ----------
        b_start_local = datetime(2026, 11, 6, 9, 0, tzinfo=NY)
        b_end_local = datetime(2026, 11, 6, 17, 0, tzinfo=NY)
        B_START, B_END = int(b_start_local.timestamp()), int(b_end_local.timestamp())
        jB = post_contract(poster_key, "WinTz Probe B: scheduled NY window", B_START, B_END, scheduled=True)
        jobB = jB.get("id") or (jB.get("job") or {})["id"]
        job_ids.append(jobB)
        check("job B (scheduled) posted", bool(jobB), json.dumps(jB)[:200])
        detB = api(f"/jobs/{jobB}", key=poster_key)
        assert_window_block("web detail B (scheduled)", detB["job"]["contract"], B_START, B_END, "America/New_York", "before")
        check("job B is flagged scheduled with 2 tasks",
              detB["job"]["contract"].get("scheduled") is True and detB["job"]["contract"].get("task_count") == 2,
              json.dumps(detB["job"]["contract"])[:200])

        # ---------- job C: past window -> phase closed, refusal names the end ----------
        now = int(time.time())
        C_START, C_END = now - 3600, now - 1800
        jC = post_contract(poster_key, "WinTz Probe C: past NY window", C_START, C_END)
        jobC = jC.get("id") or (jC.get("job") or {})["id"]
        job_ids.append(jobC)
        check("job C posted", bool(jobC), json.dumps(jC)[:200])
        bidC = api(f"/agent/jobs/{jobC}/bid", agent_key=akey, method="POST",
                   body={"amount": 18, "eta_hours": 24, "pitch": "verified caller"})
        api(f"/jobs/{jobC}/award", key=poster_key, method="POST", body={"bid_id": bidC["id"]})
        detC = api(f"/jobs/{jobC}", key=poster_key)
        assert_window_block("web detail C", detC["job"]["contract"], C_START, C_END, "America/New_York", "closed")
        raw = api(f"/agent/jobs/{jobC}/contract/attempts", agent_key=akey, method="POST", body={}, raw=True)
        c_lab = off_label(datetime.fromtimestamp(C_END, NY))
        check("late attempt refused: window has closed", "has closed" in raw, raw[:300])
        check("late attempt refusal carries the ended UTC ISO instant", iso_z(C_END) in raw, raw[:300])
        check("late attempt refusal carries the job-tz offset form", c_lab in raw, raw[:300])

        # ---------- job 236: the owner's real job, READ-ONLY ----------
        det236 = api("/jobs/236")
        c236 = det236["job"]["contract"]
        check("job 236 stored epochs untouched", c236.get("window_start") == 1793095200 and c236.get("window_end") == 1793097600,
              json.dumps({k: c236.get(k) for k in ("window_start", "window_end", "window_tz")}))
        check("job 236 window_start_utc", c236.get("window_start_utc") == "2026-10-27T10:00:00Z", str(c236.get("window_start_utc")))
        check("job 236 window_end_utc", c236.get("window_end_utc") == "2026-10-27T10:40:00Z", str(c236.get("window_end_utc")))
        loc236 = str(c236.get("window_start_local")).replace("\u202f", " ").replace("\xa0", " ")
        check("job 236 window_start_local is the UTC form with offset",
              "10:00 AM" in loc236 and "(UTC+0)" in loc236,
              str(c236.get("window_start_local")))
        exp_phase = "before" if int(time.time()) < 1793095200 else ("open" if int(time.time()) <= 1793097600 else "closed")
        check("job 236 window_phase consistent", c236.get("window_phase") == exp_phase,
              f"{c236.get('window_phase')} vs {exp_phase}")

        print(f"\nALL {len(RESULTS)} CHECKS PASSED")
    finally:
        # ---------- cleanup: every seeded row goes ----------
        for jid in job_ids:
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
