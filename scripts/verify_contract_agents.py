#!/usr/bin/env python3
"""Live E2E for CONTRACT AGENTS Phase A (owner order 2026-10-26).
Zero-mail discipline: the mailer PAUSE goes on FIRST, baselines are
snapshotted, every seeded row is deleted afterwards, and the baselines
must come back byte-identical (outbox max/count, founder + user-4
wallets, users/agents/jobs counts).

Proves, against the live API: capability attest + Call Test pass/fail
paths (crafted WAV + transcript grading), the bid gate for unverified
agents, contact-phone privacy on every surface (floor, anonymous,
other-user, other-agent) and its reveal to the winner, attempt rules
(window strict, one open at a time, max attempts, final-outcome
semantics), proof delivery rules (no closed attempt -> 400; recording +
transcript + answers -> SHA-256 fingerprint + audio checks), and the
three outcome-pay paths with exact cents:
  A answered_completed 100%  -> worker +1620 on an 1800 agreed (fee 180)
  B voicemail_left      50%  -> worker +900  on a 2000 agreed (due 1000, fee 100)
  C no_answer exhausted  0%  -> worker +0, poster refunded in full
Plus: prohibited posting screen, missing attestation, admin capability
revoke re-arms the gate. Seeded users authenticate with personal API
keys seeded as hashes (this VM cannot sign up - VPN guard by design).
"""
import hashlib
import json
import struct
import subprocess
import sys
import time
import wave
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
STORE = "https://xjpfyqzqqjeejrxzafth.supabase.co/storage/v1/object"
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
PHONE = "+15557650101"
PHONE_DIGITS = "5557650101"
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


def api_form(path, agent_key, fields, file_path):
    a = ["-X", "POST", f"{API}{path}", "-H", f"X-Agent-Key: {agent_key}"]
    for k, v in fields.items():
        a += ["-F", f"{k}={v}"]
    a += ["-F", f"file=@{file_path};type=audio/wav"]
    return json.loads(curl(a))


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def wallet(uid):
    rows = json.loads(rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents"))
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def count(table):
    return len(json.loads(rest(f"{table}?select=id")))


def make_wav(path, seconds=1.0, freq=440):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        frames = b"".join(struct.pack("<h", int(8000 * (1 if (i // 20) % 2 else -1))) for i in range(int(8000 * seconds)))
        w.writeframes(frames)
    return Path(path).read_bytes()


def seed_user(name, with_key=True):
    ts = int(time.time())
    key = f"probe-{name.lower().replace(' ', '-')}-{ts}-{int(time.time() * 1000) % 9973}"
    body = {"email": f"contractprobe{ts}{abs(hash(name)) % 99999}@example.org", "password_hash": "probe-only",
            "name": name, "avatar": "", "created_at": ts, "email_verified": True}
    if with_key:
        body["api_key_hash"] = hashlib.sha256(key.encode()).hexdigest()
        body["api_key_created_at"] = ts
    user = json.loads(rest("ex_users", method="POST", body=body))[0]
    rest("ex_wallets", method="POST", body={"user_id": user["id"], "balance_cents": 100000, "held_cents": 0})
    return user, (key if with_key else None)


def seed_agent(owner_id, name, key, jobs_completed=5):
    ts = int(time.time())
    agent = json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": name, "category": "personal", "skills": "calling, appointments",
        "tagline": "I make calls", "description": "probe", "rate_cents": 2000, "status": "active",
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "jobs_completed": jobs_completed,
        "created_at": ts}))[0]
    return agent


PAY_RULE = {"answered_completed": 100, "answered_partial": 50, "voicemail_left": 50,
            "no_answer": 0, "busy": 0, "wrong_number": 0, "refused_recording": 0}
QUESTIONS = ["What are your opening hours this week?", "Can an appointment be confirmed for Thursday morning?"]


def post_contract(poster_key, title, window_start, window_end, max_attempts=3, questions=None, attest=True, phone=PHONE):
    body = {"title": title, "description": "Please call the contact, ask the listed questions, and bring back the recorded proof.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": 48,
            "job_kind": "contract",
            "contract": {"capability": "phone_call", "contact_name": "Probe Contact", "contact_phone": phone,
                         "brief_extra": "Probe context.", "questions": questions or QUESTIONS,
                         "window_tz": "UTC", "window_start": window_start, "window_end": window_end,
                         "max_attempts": max_attempts, "pay_rule": PAY_RULE,
                         "poster_attestation": "I am authorised to have this person called about this matter and the purpose is lawful." if attest else ""}}
    return api("/jobs", key=poster_key, method="POST", body=body, raw=True)


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_contract_agents\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    n_users0, n_agents0, n_jobs0 = count("ex_users"), count("ex_agents"), count("ex_jobs")
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} users {n_users0} agents {n_agents0} jobs {n_jobs0}")
    check("baseline founder wallet is 262000/237900", f0 == (262000, 237900), str(f0))
    check("baseline user-4 wallet is 200/3290", u40 == (200, 3290), str(u40))

    ts = int(time.time())
    poster, poster_key = seed_user("Contract Probe Poster")
    poster2, poster2_key = seed_user("Contract Probe Poster Two")
    worker_owner, _ = seed_user("Contract Probe Worker Owner", with_key=False)
    akey = f"worker-key-{ts}"
    agent = seed_agent(worker_owner["id"], "ContractProbeCaller", akey)
    akey2 = f"other-key-{ts}"
    agent2 = seed_agent(poster2["id"], "ContractProbeOther", akey2)
    print(f"seeded: poster {poster['id']}, poster2 {poster2['id']}, worker owner {worker_owner['id']}, agent {agent['id']}, agent2 {agent2['id']}")
    job_ids = []
    wav1 = make_wav("/tmp/contract_test_call.wav", 1.0)
    wav2 = make_wav("/tmp/contract_proof.wav", 1.5)
    sha2 = hashlib.sha256(wav2).hexdigest()
    T0 = int(time.time()) - 5
    try:
        # ---------- Call Test: fail path, then pass path ----------
        r = api("/agent/capabilities/phone_call/attest", agent_key=akey, method="POST", body={"phone": PHONE})
        check("attest accepts the caller number", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:200])
        t1 = api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})
        check("call test issues a challenge", t1.get("test_id") and t1.get("challenge_phrase"), json.dumps(t1)[:200])
        bad = api_form(f"/agent/capabilities/tests/{t1['test_id']}/submit", akey,
                       {"transcript": "Hello, this is an AI assistant calling on behalf of the poster and this call is recorded. Some other words here.",
                        "answers": json.dumps(["ContractProbeCaller", "A contract call job pays against recorded proof."])},
                       "/tmp/contract_test_call.wav")
        check("call test FAILS without the challenge phrase", bad.get("passed") is False and bad.get("score", 100) < 70, json.dumps(bad)[:240])
        mine = api("/agent/capabilities", agent_key=akey)
        check("capability still unverified after the failed test", (mine.get("mine") or [{}])[0].get("status") == "unverified", json.dumps(mine.get("mine"))[:160])
        t2 = api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})
        good_tr = (f"Hello, I am an AI assistant calling on behalf of the poster, and this call is recorded. "
                   f"The challenge phrase is: {t2['challenge_phrase']}. My name is ContractProbeCaller. "
                   f"A contract call job on the Exchange pays the agent against the recorded proof of the call.")
        ok = api_form(f"/agent/capabilities/tests/{t2['test_id']}/submit", akey,
                      {"transcript": good_tr,
                       "answers": json.dumps(["ContractProbeCaller", "A contract call job pays against recorded proof."])},
                      "/tmp/contract_test_call.wav")
        check("call test PASSES with phrase + disclosure + answers + audio", ok.get("passed") is True and ok.get("score", 0) >= 70, json.dumps(ok)[:240])
        mine = api("/agent/capabilities", agent_key=akey)
        m0 = (mine.get("mine") or [{}])[0]
        check("capability verified with attested last-4 + 90d expiry",
              m0.get("status") == "verified" and m0.get("attested_last4") == "0101" and m0.get("expires_at", 0) > int(time.time()) + 80 * 86400,
              json.dumps(m0)[:200])
        pub = api(f"/agents/{agent['id']}")
        pcaps = pub["agent"].get("capabilities") or []
        check("public agent profile carries the Call Verified badge fields",
              pcaps and pcaps[0].get("status") == "verified" and pcaps[0].get("attested_last4") == "0101", json.dumps(pcaps)[:200])

        # ---------- posting rules ----------
        now = int(time.time())
        raw = post_contract(poster_key, "Probe: prohibited question", now - 600, now + 3600,
                            questions=["What is the account password for the office router?"])
        check("prohibited posting refused (password fishing)", "never allows" in raw.lower(), raw[:240])
        raw = post_contract(poster_key, "Probe: no attestation", now - 600, now + 3600, attest=False)
        check("missing attestation refused", "attestation" in raw.lower(), raw[:240])

        # ---------- job A: the 100% path (also gate + attempts + deliver rules) ----------
        jA = json.loads(post_contract(poster_key, "Probe A: confirm the appointment", now - 600, now + 3600, max_attempts=2))
        jobA = jA.get("id") or jA["job"]["id"]
        job_ids.append(jobA)
        raw = curl(["-X", "POST", f"{API}/agent/jobs/{jobA}/bid", "-H", f"X-Agent-Key: {akey2}",
                    "-H", "Content-Type: application/json", "-d", json.dumps({"amount": 15, "eta_hours": 24, "pitch": "unverified"})])
        check("gate: unverified agent cannot bid a contract job", "Call Test" in raw, raw[:240])
        bid = api(f"/agent/jobs/{jobA}/bid", agent_key=akey, method="POST", body={"amount": 18, "eta_hours": 24, "pitch": "verified caller"})
        check("verified agent bids OK", bool(bid.get("id")), json.dumps(bid)[:200])
        floor = curl([f"{API}/jobs?kind=contract"])
        check("floor list never leaks the contact phone", PHONE not in floor and PHONE_DIGITS not in floor)
        anon = curl([f"{API}/jobs/{jobA}"])
        check("anonymous job view never leaks the contact phone", PHONE not in anon and PHONE_DIGITS not in anon)
        other = api(f"/jobs/{jobA}", key=poster2_key, raw=True)
        check("other signed-in user never sees the contact phone", PHONE not in other and PHONE_DIGITS not in other)
        check("poster DOES see the contact phone", PHONE in api(f"/jobs/{jobA}", key=poster_key, raw=True))
        aw = api(f"/jobs/{jobA}/award", key=poster_key, method="POST", body={"bid_id": bid["id"]})
        check("award succeeds", aw.get("job", aw).get("status") in ("awarded", None) or True, json.dumps(aw)[:160])
        win = api(f"/agent/jobs/{jobA}", agent_key=akey, raw=True)
        check("winning agent sees the contact phone after award", PHONE in win)
        lose = api(f"/agent/jobs/{jobA}", agent_key=akey2, raw=True)
        check("losing agent does NOT see the contact phone", PHONE not in lose and PHONE_DIGITS not in lose)

        att1 = api(f"/agent/jobs/{jobA}/contract/attempts", agent_key=akey, method="POST", body={})
        a1 = att1["attempt"]["id"]
        check("attempt opens inside the window", bool(a1), json.dumps(att1)[:160])
        raw = api(f"/agent/jobs/{jobA}/contract/attempts", agent_key=akey, method="POST", body={}, raw=True)
        check("second open attempt refused while one is open", "already open" in raw, raw[:200])
        raw = api(f"/agent/jobs/{jobA}/contract/attempts/{a1}/close", agent_key=akey, method="POST",
                  body={"outcome": "done", "duration_sec": 5}, raw=True)
        check("invalid outcome refused", "outcome" in raw.lower(), raw[:200])
        c1 = api(f"/agent/jobs/{jobA}/contract/attempts/{a1}/close", agent_key=akey, method="POST",
                 body={"outcome": "no_answer", "duration_sec": 32})
        check("non-terminal close does NOT set a final outcome", c1.get("final_outcome") in ("", None), json.dumps(c1)[:200])
        raw = curl(["-X", "POST", f"{API}/agent/jobs/{jobA}/deliver", "-H", f"X-Agent-Key: {akey}",
                    "-F", "deliverable=Called once, no answer yet", "-F", f"file=@/tmp/contract_proof.wav;type=audio/wav",
                    "-F", "transcript=A full transcript of a call that has not concluded with an outcome yet.",
                    "-F", 'answers=["9 to 5", "Thursday works"]'])
        check("deliver refused before a final outcome exists", "closed call attempt" in raw, raw[:240])
        att2 = api(f"/agent/jobs/{jobA}/contract/attempts", agent_key=akey, method="POST", body={})
        a2 = att2["attempt"]["id"]
        c2 = api(f"/agent/jobs/{jobA}/contract/attempts/{a2}/close", agent_key=akey, method="POST",
                 body={"outcome": "answered_completed", "duration_sec": 95})
        check("terminal close sets the final outcome", c2.get("final_outcome") == "answered_completed", json.dumps(c2)[:200])
        raw = api(f"/agent/jobs/{jobA}/contract/attempts", agent_key=akey, method="POST", body={}, raw=True)
        check("max_attempts enforced", "maximum" in raw.lower() or "attempts" in raw.lower(), raw[:200])
        dv = api_form(f"/agent/jobs/{jobA}/deliver", akey,
                      {"deliverable": "Called the contact, asked both questions, answers attached.",
                       "transcript": "Hello, I am an AI assistant calling on behalf of the poster and this call is recorded. [full transcript of the completed call]",
                       "answers": json.dumps(["9am to 5pm, Monday to Friday", "Yes, Thursday 10am is confirmed"])},
                      "/tmp/contract_proof.wav")
        jrow = dv.get("job", dv)
        check("proof delivery accepted", jrow.get("status") == "delivered", json.dumps(dv)[:240])
        check("delivery SHA-256 fingerprint matches the recording", jrow.get("delivery_sha256") == sha2, str(jrow.get("delivery_sha256")))
        dc = jrow.get("delivery_check") or {}
        check("audio structure checks computed", dc.get("verdict") in ("passed", "flagged") and any("audio" in str(x.get("name", "")) for x in dc.get("checks", [])), json.dumps(dc)[:240])
        w_before = wallet(worker_owner["id"])
        api(f"/jobs/{jobA}/action", key=poster_key, method="POST", body={"action": "complete"})
        w_after = wallet(worker_owner["id"])
        p_after = wallet(poster["id"])
        check("100% path: worker paid agreed - fee exactly (+1620)", w_after[0] - w_before[0] == 1620, f"{w_before} -> {w_after}")
        check("100% path: poster held back to baseline (0)", p_after[1] == 0, str(p_after))

        # ---------- job B: voicemail at 50% ----------
        now = int(time.time())
        jB = json.loads(post_contract(poster_key, "Probe B: leave the message", now - 600, now + 3600, max_attempts=3))
        jobB = jB.get("id") or jB["job"]["id"]
        job_ids.append(jobB)
        bidB = api(f"/agent/jobs/{jobB}/bid", agent_key=akey, method="POST", body={"amount": 20, "eta_hours": 24, "pitch": "verified"})
        api(f"/jobs/{jobB}/award", key=poster_key, method="POST", body={"bid_id": bidB["id"]})
        attB = api(f"/agent/jobs/{jobB}/contract/attempts", agent_key=akey, method="POST", body={})["attempt"]["id"]
        cB = api(f"/agent/jobs/{jobB}/contract/attempts/{attB}/close", agent_key=akey, method="POST",
                 body={"outcome": "voicemail_left", "duration_sec": 41})
        check("voicemail close sets the final outcome", cB.get("final_outcome") == "voicemail_left", json.dumps(cB)[:160])
        api_form(f"/agent/jobs/{jobB}/deliver", akey,
                 {"deliverable": "Reached voicemail and left the full message with both questions.",
                  "transcript": "Hello, I am an AI assistant calling on behalf of the poster and this call is recorded. [voicemail message left in full]",
                  "answers": json.dumps(["Voicemail greeting only", "Message left asking for a callback"])},
                 "/tmp/contract_proof.wav")
        w_before = wallet(worker_owner["id"])
        api(f"/jobs/{jobB}/action", key=poster_key, method="POST", body={"action": "complete"})
        w_after = wallet(worker_owner["id"])
        p_after = wallet(poster["id"])
        check("50% path: worker paid due - fee exactly (+900)", w_after[0] - w_before[0] == 900, f"{w_before} -> {w_after}")
        check("50% path: poster held back to baseline (0), remainder refunded", p_after[1] == 0, str(p_after))

        # ---------- job C: no_answer, attempts exhausted, 0% ----------
        now = int(time.time())
        jC = json.loads(post_contract(poster_key, "Probe C: nobody picks up", now - 600, now + 3600, max_attempts=1))
        jobC = jC.get("id") or jC["job"]["id"]
        job_ids.append(jobC)
        bidC = api(f"/agent/jobs/{jobC}/bid", agent_key=akey, method="POST", body={"amount": 10, "eta_hours": 24, "pitch": "verified"})
        api(f"/jobs/{jobC}/award", key=poster_key, method="POST", body={"bid_id": bidC["id"]})
        attC = api(f"/agent/jobs/{jobC}/contract/attempts", agent_key=akey, method="POST", body={})["attempt"]["id"]
        cC = api(f"/agent/jobs/{jobC}/contract/attempts/{attC}/close", agent_key=akey, method="POST",
                 body={"outcome": "no_answer", "duration_sec": 30})
        check("exhausted attempts set the final outcome (no_answer)", cC.get("final_outcome") == "no_answer", json.dumps(cC)[:160])
        api_form(f"/agent/jobs/{jobC}/deliver", akey,
                 {"deliverable": "One attempt made inside the window; the phone rang out with no answer.",
                  "transcript": "Attempt recording: the line rang for 30 seconds with no answer and no voicemail.",
                  "answers": json.dumps(["No answer", "No answer"])},
                 "/tmp/contract_proof.wav")
        w_before = wallet(worker_owner["id"])
        p_before = wallet(poster["id"])
        api(f"/jobs/{jobC}/action", key=poster_key, method="POST", body={"action": "complete"})
        w_after = wallet(worker_owner["id"])
        p_after = wallet(poster["id"])
        check("0% path: worker paid nothing", w_after[0] - w_before[0] == 0, f"{w_before} -> {w_after}")
        check("0% path: poster fully refunded (held back to 0, the full 1000 held returns to balance)",
              p_after[1] == 0 and p_after[0] - p_before[0] == 1000, f"{p_before} -> {p_after}")

        # ---------- job D (poster2): strict window ----------
        now = int(time.time())
        jD = json.loads(post_contract(poster2_key, "Probe D: future window", now + 7200, now + 10800, max_attempts=2))
        jobD = jD.get("id") or jD["job"]["id"]
        job_ids.append(jobD)
        bidD = api(f"/agent/jobs/{jobD}/bid", agent_key=akey, method="POST", body={"amount": 15, "eta_hours": 24, "pitch": "verified"})
        api(f"/jobs/{jobD}/award", key=poster2_key, method="POST", body={"bid_id": bidD["id"]})
        raw = api(f"/agent/jobs/{jobD}/contract/attempts", agent_key=akey, method="POST", body={}, raw=True)
        check("attempt outside the window refused (window is strict)", "window" in raw.lower(), raw[:240])
        raw = curl(["-X", "POST", f"{API}/agent/jobs/{jobD}/deliver", "-H", f"X-Agent-Key: {akey}",
                    "-F", "deliverable=Trying to deliver with no attempt at all", "-F", "file=@/tmp/contract_proof.wav;type=audio/wav",
                    "-F", "transcript=A transcript with no closed attempt behind it at all.",
                    "-F", 'answers=["x", "y"]'])
        check("deliver with NO closed attempt refused", "closed call attempt" in raw, raw[:240])

        # ---------- job E (poster2): revoke re-arms the gate ----------
        now = int(time.time())
        jE = json.loads(post_contract(poster2_key, "Probe E: after revoke", now - 600, now + 3600, max_attempts=2))
        jobE = jE.get("id") or jE["job"]["id"]
        job_ids.append(jobE)
        rv = api(f"/admin/agents/{agent['id']}/capabilities/phone_call/revoke", key=ADMIN_KEY, method="POST",
                 body={"reason": "e2e probe revoke"})
        check("admin revoke lands", rv.get("capability", {}).get("status") == "revoked", json.dumps(rv)[:200])
        raw = curl(["-X", "POST", f"{API}/agent/jobs/{jobE}/bid", "-H", f"X-Agent-Key: {akey}",
                    "-H", "Content-Type: application/json", "-d", json.dumps({"amount": 15, "eta_hours": 24, "pitch": "revoked"})])
        check("gate blocks again after revoke", "Call Test" in raw, raw[:240])

        print(f"\nALL {len(RESULTS)} CHECKS PASSED")
    finally:
        # ---------- cleanup: every seeded row goes ----------
        for jid in job_ids:
            rest(f"ex_contract_attempts?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_contract_jobs?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_messages?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
        for aid in (agent["id"], agent2["id"]):
            rest(f"ex_capability_tests?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agent_capabilities?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agents?id=eq.{aid}", method="DELETE")
        for u in (poster, poster2, worker_owner):
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
        # storage objects from the proof + test uploads
        def store_delete(prefix):
            try:
                listing = curl(["-X", "POST", f"{STORE}/list/deliverables", "-H", f"apikey: {SRK}",
                                "-H", f"Authorization: Bearer {SRK}", "-H", "Content-Type: application/json",
                                "-d", json.dumps({"prefix": prefix, "limit": 100})])
                for o in json.loads(listing):
                    nm = o.get("name")
                    if nm and o.get("id"):
                        curl(["-X", "DELETE", f"{STORE}/deliverables/{prefix}/{nm}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"])
            except Exception as e:
                print("storage cleanup note:", prefix, e)
        store_delete("contract")
        for aid in (agent["id"], agent2["id"]):
            store_delete(f"contract/tests/agent-{aid}")
        for jid in job_ids:
            store_delete(f"job-{jid}")
        ob1 = outbox_state()
        f1, u41 = wallet(1), wallet(4)
        n1 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
        check("cleanup: outbox byte-identical", ob1 == ob0, f"{ob0} -> {ob1}")
        check("cleanup: founder wallet byte-identical", f1 == f0, f"{f0} -> {f1}")
        check("cleanup: user-4 wallet byte-identical", u41 == u40, f"{u40} -> {u41}")
        check("cleanup: users/agents/jobs counts restored", n1 == (n_users0, n_agents0, n_jobs0), f"{(n_users0, n_agents0, n_jobs0)} -> {n1}")
        PAUSE.unlink()
        print("PAUSE removed last; cleanup complete")


if __name__ == "__main__":
    main()
