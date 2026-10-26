#!/usr/bin/env python3
"""Agent Exchange - CONTRACT AGENTS PHASE C live E2E (zero-mail discipline).

Proves, against the LIVE function + REST:
 - per-minute pay: happy path (240s billable -> 4 min -> exact money + exact
   pay_breakdown), cap path (paid_minutes capped), agreed-price bound,
   zero-billable full refund; per-minute posting validation (rate/cap bounds).
 - match routing: top-5 invites with online-first ranking, 15-minute
   priority window gate (non-invited refused, invited OK, open after the
   window), no-eligible case opens immediately, public payloads carry only
   match_priority/match_open_at (never the phone, never invitee ids),
   invited flag + sort-first on the agent listing, invite notification.
 - AGENTS-ONLY ruling: a human profile cannot attest / take the Call Test
   (agent-key AND owner mirror), cannot bid even with a directly-seeded
   verified capability row, and is never match-invited (even with fresh
   presence + seeded capability).
 - outcome-mode regression: a Phase A shape job pays exactly as before and
   stores the outcome pay_breakdown.

Attempts for the per-minute settlement maths are seeded directly via REST
with controlled started_at/ended_at/duration_sec so billable seconds are
deterministic (back-to-back API open/close would measure real elapsed time,
not the reported durations). The attempt open/close API itself is Phase
A-proven; Phase C tests the settlement arithmetic on top of it.

Discipline: PAUSE file asserted absent at start, written before any API
call; snapshot baselines; seed labelled rows; verify; DELETE every seeded
row; restore the guarantee-pool setting; assert baselines byte-identical;
remove PAUSE last (after a drain sleep).
"""
import hashlib
import io
import json
import struct
import subprocess
import sys
import time
import wave
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
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
T0 = int(time.time())
PHONE = "+15559870101"
PHONE_DIGITS = "5559870101"

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def curl(args, data=None):
    cmd = ["curl", "-s", "--max-time", "90"] + args
    if data is not None:
        cmd += ["--data-binary", data]
    return subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", "replace")


def rest(path, method="GET", body=None, prefer=None):
    args = [f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if method != "GET":
        args += ["-X", method]
    if body is not None:
        args += ["-H", "content-type: application/json"]
    if prefer:
        args += ["-H", f"Prefer: {prefer}"]
    out = curl(args, json.dumps(body) if body is not None else None)
    return json.loads(out) if out.strip() else None


def api(path, key=None, body=None, method="POST", raw_headers=None):
    args = [f"{FUNC}{path}"]
    hdr = []
    if key:
        # account routes read X-API-Key; the /agent/* guard reads X-Agent-Key.
        # Sending both lets one helper drive both surfaces (each side ignores
        # the header it does not read, and a key only ever matches its own kind).
        hdr += ["-H", f"X-API-Key: {key}", "-H", f"X-Agent-Key: {key}"]
    if raw_headers:
        hdr += raw_headers
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


def api_form(path, key, fields, wav_bytes, filename="call.wav"):
    fpath = f"/tmp/_capc_{int(time.time()*1000)}.wav"
    Path(fpath).write_bytes(wav_bytes)
    args = [f"{FUNC}{path}", "-H", f"X-Agent-Key: {key}"]
    for k, v in fields.items():
        args += ["-F", f"{k}={v}"]
    args += ["-F", f"file=@{fpath};filename={filename};type=audio/wav"]
    out = curl(args)
    Path(fpath).unlink(missing_ok=True)
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out}


def make_wav(seconds=1.0, rate=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        frames = b"".join(struct.pack("<h", 1200 if (i // 40) % 2 else -1200) for i in range(int(rate * seconds)))
        w.writeframes(frames)
    return buf.getvalue()


WAV = make_wav()

seeded_users, seeded_agents, seeded_jobs = [], [], []
OWNER_KEYS, PERSONAL_KEYS, AGENT_KEYS = {}, {}, {}


def seed_user(email, name, with_key=True):
    key = "capc-" + hashlib.sha256(email.encode()).hexdigest()[:28]
    rows = rest("ex_users", "POST", {
        "email": email, "name": name, "password_hash": "x", "role": "user", "email_verified": True,
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest() if with_key else None,
        "api_key_created_at": T0, "created_at": T0,
    }, "return=representation")
    uid = rows[0]["id"]
    rest("ex_wallets", "POST", {"user_id": uid, "balance_cents": 100000, "held_cents": 0})
    seeded_users.append(uid)
    if with_key:
        PERSONAL_KEYS[uid] = key
    return uid


def seed_agent(owner, name, key, jobs_completed=5, rate_cents=2000, is_human=False):
    rows = rest("ex_agents", "POST", {
        "owner_id": owner, "name": name, "category": "personal", "status": "active",
        "is_human": is_human, "api_key_hash": hashlib.sha256(key.encode()).hexdigest(),
        "description": "Phase C verify probe", "rate_cents": rate_cents,
        "jobs_completed": jobs_completed, "created_at": T0,
    }, "return=representation")
    aid = rows[0]["id"]
    seeded_agents.append(aid)
    AGENT_KEYS[aid] = key
    return aid


DISCLOSURE = ("Hello, I am an AI assistant calling on behalf of my principal, and this call is being recorded. "
              "I have two questions to answer for this capability check.")


def verify_agent(aid, phone):
    """Full Call Test flow (attest -> challenge -> proof submit) -> verified."""
    key = AGENT_KEYS[aid]
    r = api(f"/agent/capabilities/phone_call/attest", key, {"phone": phone})
    assert (r.get("capability") or {}).get("status") in ("unverified", "verified"), r
    r = api("/agent/capabilities/phone_call/test", key, {})
    phrase = r.get("challenge_phrase"); tid = r.get("test_id")
    assert phrase and tid, r
    transcript = (f"{DISCLOSURE} {phrase}. The purpose of this call is to confirm the appointment. "
                  "Yes, the office is open tomorrow at 9 AM.")
    r = api_form(f"/agent/capabilities/tests/{tid}/submit", key,
                 {"transcript": transcript, "answer_1": "Confirm the appointment", "answer_2": "Yes, open at 9 AM"}, WAV)
    assert r.get("passed") is True and r.get("score", 0) >= 70, r
    return r


def post_contract(poster_uid, title, pay_rule, budget=20, window=None):
    now = int(time.time())
    ws, we = window or (now - 600, now + 3600)
    return api("/jobs", PERSONAL_KEYS[poster_uid], {
        "title": title, "description": "Please call the contact and ask the questions.",
        "category": "personal", "budget": budget, "mode": "bidding", "deadline_hours": 48,
        "job_kind": "contract",
        "contract": {
            "capability": "phone_call",
            "contact_name": "Front Desk", "contact_phone": PHONE,
            "brief_extra": "Phase C verify context.",
            "questions": ["What is the appointment for?", "Is the office open tomorrow?"],
            "window_start": ws, "window_end": we, "window_tz": "UTC",
            "max_attempts": 3, "pay_rule": pay_rule,
            "poster_attestation": "I am authorised to have this person called about this matter and the purpose is lawful.",
        },
    })


def cj_of(job_id):
    rows = rest(f"ex_contract_jobs?job_id=eq.{job_id}&select=*")
    return rows[0] if isinstance(rows, list) and rows else {}


def wallet(uid):
    rows = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def seed_attempt(job_id, agent_id, outcome, started, ended, dur):
    rows = rest("ex_contract_attempts", "POST", {
        "job_id": job_id, "agent_id": agent_id, "started_at": started,
        "ended_at": ended, "outcome": outcome, "duration_sec": dur, "created_at": T0,
    }, "return=representation")
    return rows[0]["id"]


def deliver_and_complete(job_id, poster_uid):
    r = api_form(f"/agent/jobs/{job_id}/deliver", AGENT_KEYS[CUR_WORKER],
                 {"deliverable": "Call completed; recording attached.", "transcript":
                  "Hello, I am an AI assistant calling on behalf of the poster and this call is recorded. "
                  "The appointment is for a checkup. Yes, the office is open tomorrow at 9 AM.",
                  "answers": json.dumps(["A checkup", "Yes, open at 9 AM"])}, WAV)
    assert r.get("job", {}).get("status") == "delivered", r
    return api(f"/jobs/{job_id}/action", PERSONAL_KEYS[poster_uid], {"action": "complete"})


CUR_WORKER = None

# ---------------------------------------------------------------- snapshot
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


def main():
    global CUR_WORKER
    assert not PAUSE.exists(), "PAUSE already present - a verification window is open elsewhere"
    base = snapshot()
    print("BASELINE:", json.dumps(base))
    check("baseline matches the recorded platform state",
          base["outbox_max"] == 231 and base["outbox_count"] == 200 and base["founder"] == (262000, 237900)
          and base["user4"] == (200, 3290) and base["users"] == 8 and base["agents"] == 4 and base["jobs"] == 34
          and base["stats"] == {"users": 8, "agents": 4, "open_jobs": 31, "jobs_completed": 2,
                                "volume_cents": 5600, "guarantee_pool_cents": 0, "fee_pct": 10},
          json.dumps(base["stats"]))
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    PAUSE.write_text("verify_contract_phase_c window\n")
    try:
        run(base)
    finally:
        cleanup(base)


def run(base):
    global CUR_WORKER
    # ---------- 1. No-eligible case (only the poster's own verified agent exists)
    poster_ne = seed_user("capc-pne@example.invalid", "CapC Poster NE")
    agent_ne = seed_agent(poster_ne, "CapC Own Agent", "capc-agent-ne", jobs_completed=0, rate_cents=99900)
    verify_agent(agent_ne, "+15557650101")
    r = post_contract(poster_ne, "CapC no-eligible call job", {"answered_completed": 100, "voicemail_left": 50})
    jid_ne = r.get("id")
    check("no-eligible: contract job posts", bool(jid_ne), json.dumps(r)[:200])
    seeded_jobs.append(jid_ne)
    cj = cj_of(jid_ne)
    check("no-eligible: match_invited empty + match_open_at 0 (never traps the job)",
          (cj.get("match_invited") or []) == [] and int(cj.get("match_open_at") or 0) == 0,
          f"invited={cj.get('match_invited')} open_at={cj.get('match_open_at')}")

    # ---------- 2. Agents-only: human profile
    human_owner = seed_user("capc-hum@example.invalid", "CapC Human Owner")
    human = seed_agent(human_owner, "CapC Human Profile", "capc-human", jobs_completed=5, is_human=True)
    r = api("/agent/capabilities/phone_call/attest", AGENT_KEYS[human], {"phone": "+15557650199"})
    check("agents-only: human attest refused", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    r = api("/agent/capabilities/phone_call/test", AGENT_KEYS[human], {})
    check("agents-only: human Call Test start refused", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    r = api(f"/my/agents/{human}/capabilities/phone_call/attest", PERSONAL_KEYS[human_owner],
            {"phone": "+15557650199"}, method="PUT")
    check("agents-only: human attest refused on the owner mirror too", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    # directly-seeded verified capability row must NOT rescue a human profile
    rest("ex_agent_capabilities", "POST", {
        "agent_id": human, "capability": "phone_call", "status": "verified",
        "attested_phone": "+15557650199", "verified_at": T0, "expires_at": T0 + 90 * 86400,
        "created_at": T0, "updated_at": T0})
    r = api(f"/agent/jobs/{jid_ne}/bid", AGENT_KEYS[human], {"amount": 18, "eta_hours": 2, "pitch": "I can call."})
    check("agents-only: human bid refused even with a seeded verified capability",
          "human profiles cannot take call contracts" in json.dumps(r), json.dumps(r)[:200])

    # ---------- 3. Match routing
    poster_m = seed_user("capc-pm@example.invalid", "CapC Poster Match")
    match_agents = {}
    for i, jc in enumerate([5, 4, 3, 2, 1, 0], start=1):
        owner = seed_user(f"capc-mo{i}@example.invalid", f"CapC Match Owner {i}")
        aid = seed_agent(owner, f"CapC Match Agent {i}", f"capc-match-{i}", jobs_completed=jc, rate_cents=2000)
        verify_agent(aid, f"+1555765011{i}")
        match_agents[i] = aid
    # fresh presence: match agent 1 (top jobs_completed) + the human profile
    api("/agent/presence", AGENT_KEYS[match_agents[1]], {})
    api("/agent/presence", AGENT_KEYS[human], {})
    r = post_contract(poster_m, "CapC match call job", {"answered_completed": 100, "voicemail_left": 50})
    jid_m = r.get("id")
    check("match: contract job posts", bool(jid_m), json.dumps(r)[:200])
    seeded_jobs.append(jid_m)
    cj = cj_of(jid_m)
    invited = [e.get("agent_id") for e in (cj.get("match_invited") or [])]
    expect = [match_agents[i] for i in (1, 2, 3, 4, 5)]
    check("match: exactly the top 5 invited, online agent first",
          invited == expect, f"invited={invited} expect={expect}")
    check("match: 6th eligible agent NOT invited", match_agents[6] not in invited)
    check("match: human profile never invited (fresh presence + seeded capability)",
          human not in invited)
    now = int(time.time())
    check("match: match_open_at is ~now+900", abs(int(cj.get("match_open_at") or 0) - (now + 900)) <= 120,
          f"open_at={cj.get('match_open_at')} now={now}")
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[match_agents[6]], {"amount": 18, "eta_hours": 2, "pitch": "Me too."})
    check("match: non-invited verified agent refused during the priority window",
          "priority window" in json.dumps(r), json.dumps(r)[:220])
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[match_agents[1]], {"amount": 18, "eta_hours": 2, "pitch": "Invited and ready."})
    check("match: invited agent bids inside the window", bool(r.get("id")), json.dumps(r)[:160])
    r = api(f"/jobs/{jid_m}", method="GET")
    raw = json.dumps(r)
    cpub = (r.get("job") or {}).get("contract") or {}
    check("match: public view exposes match_priority + match_open_at only",
          cpub.get("match_priority") is True and int(cpub.get("match_open_at") or 0) == int(cj["match_open_at"])
          and "match_invited" not in raw and PHONE_DIGITS not in raw,
          f"priority={cpub.get('match_priority')}")
    r = api("/jobs?kind=contract", method="GET")
    check("match: floor payload never contains the phone", PHONE_DIGITS not in json.dumps(r))
    r = api(f"/agent/jobs/{jid_m}", AGENT_KEYS[match_agents[1]], method="GET")
    check("match: invited agent sees invited:true on its own view",
          ((r.get("job") or {}).get("contract") or {}).get("invited") is True, json.dumps(r)[:200])
    r = api(f"/agent/jobs/{jid_m}", AGENT_KEYS[match_agents[6]], method="GET")
    check("match: non-invited agent sees invited:false",
          ((r.get("job") or {}).get("contract") or {}).get("invited") is False, json.dumps(r)[:200])
    # sort-first: a NEWER contract job (posted after, window backdated) must sort below the priority job for the invited agent
    r = post_contract(poster_m, "CapC late call job", {"answered_completed": 100})
    jid_late = r.get("id")
    seeded_jobs.append(jid_late)
    rest(f"ex_contract_jobs?job_id=eq.{jid_late}", "PATCH", {"match_open_at": int(time.time()) - 10})
    r = api("/agent/jobs?all=1", AGENT_KEYS[match_agents[1]], method="GET")
    rows = r.get("jobs") or []
    idx = {row["id"]: n for n, row in enumerate(rows)}
    row_m = next((row for row in rows if row["id"] == jid_m), {})
    check("match: invited priority job sorts first on the agent listing + carries invited:true",
          row_m.get("invited") is True and jid_m in idx and jid_late in idx and idx[jid_m] < idx[jid_late],
          f"idx match={idx.get(jid_m)} late={idx.get(jid_late)} invited={row_m.get('invited')}")
    owner_m1 = rest(f"ex_agents?id=eq.{match_agents[1]}&select=owner_id")[0]["owner_id"]
    notes = rest(f"ex_notifications?user_id=eq.{owner_m1}&select=body&order=id.desc&limit=5") or []
    check("match: invited agent's owner got the in-app invite, phone-free",
          any("invited" in (n.get("body") or "") for n in notes)
          and all(PHONE_DIGITS not in json.dumps(n) for n in notes),
          json.dumps(notes)[:200])
    rest(f"ex_contract_jobs?job_id=eq.{jid_m}", "PATCH", {"match_open_at": int(time.time()) - 10})
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[match_agents[6]], {"amount": 17, "eta_hours": 2, "pitch": "After the window."})
    check("match: after the window any Call Verified agent may bid", bool(r.get("id")), json.dumps(r)[:160])

    # ---------- 4. Per-minute jobs
    worker_owner = seed_user("capc-wo@example.invalid", "CapC Worker Owner")
    worker = seed_agent(worker_owner, "CapC Worker", "capc-worker", jobs_completed=5, rate_cents=2000)
    CUR_WORKER = worker
    verify_agent(worker, "+15557650150")
    poster_pm1 = seed_user("capc-ppm1@example.invalid", "CapC Poster PM1")
    poster_pm2 = seed_user("capc-ppm2@example.invalid", "CapC Poster PM2")
    PM_RULE = {"mode": "per_minute", "rate_cents_per_min": 250, "max_paid_minutes": 10}

    # posting validation
    r = post_contract(poster_pm1, "CapC bad rate job", {"mode": "per_minute", "rate_cents_per_min": 5, "max_paid_minutes": 10})
    check("per-minute: rate below 10 cents refused", "rate_cents_per_min" in json.dumps(r), json.dumps(r)[:160])
    r = post_contract(poster_pm1, "CapC bad cap job", {"mode": "per_minute", "rate_cents_per_min": 250, "max_paid_minutes": 601})
    check("per-minute: max_paid_minutes above 600 refused", "max_paid_minutes" in json.dumps(r), json.dumps(r)[:160])

    def pm_job(poster, title, rule, bid_amount, attempts, final_outcome):
        r = post_contract(poster, title, rule, budget=20)
        jid = r.get("id")
        assert jid, r
        seeded_jobs.append(jid)
        r = api(f"/agent/jobs/{jid}/bid", AGENT_KEYS[worker], {"amount": bid_amount, "eta_hours": 2, "pitch": "Calling."})
        bid = r.get("id")
        assert bid, r
        r = api(f"/jobs/{jid}/award", PERSONAL_KEYS[poster], {"bid_id": bid})
        assert (r.get("job") or {}).get("status") == "awarded", r
        ts = int(time.time())
        for (outcome, off, dur) in attempts:
            seed_attempt(jid, worker, outcome, ts + off, ts + off + dur, dur)
        rest(f"ex_contract_jobs?job_id=eq.{jid}", "PATCH", {"final_outcome": final_outcome})
        w_before = wallet(worker_owner)
        p_held_before = wallet(poster)[1]
        r = deliver_and_complete(jid, poster)
        assert (r.get("job") or {}).get("status") == "completed", r
        w_after = wallet(worker_owner)
        p_after = wallet(poster)
        return jid, w_after[0] - w_before[0], p_after, cj_of(jid)

    # happy path: 90s completed + 150s partial at 250/min cap 10, agreed 2000
    jid, gain, p_after, cj = pm_job(poster_pm1, "CapC per-minute happy job", PM_RULE, 20,
                                    [("answered_completed", -2000, 90), ("answered_partial", -1500, 150)],
                                    "answered_completed")
    bd = cj.get("pay_breakdown") or {}
    check("per-minute happy: worker +900 (due 1000 - fee 100)", gain == 900, f"gain={gain}")
    check("per-minute happy: poster held fully settled", p_after[1] == 0, f"poster={p_after}")
    check("per-minute happy: pay_breakdown exact",
          bd.get("mode") == "per_minute" and bd.get("billable_seconds") == 240 and bd.get("billable_minutes") == 4
          and bd.get("paid_minutes") == 4 and bd.get("rate_cents_per_min") == 250 and bd.get("max_paid_minutes") == 10
          and bd.get("worker_due_cents") == 1000 and bd.get("fee_cents") == 100 and bd.get("refunded_cents") == 1000
          and sorted(a.get("seconds_counted") for a in bd.get("attempts", [])) == [90, 150],
          json.dumps(bd))

    # cap path: 900s answered at cap 5 -> paid 5 min -> due 1250, fee 125
    jid, gain, p_after, cj = pm_job(poster_pm1, "CapC per-minute cap job",
                                    {"mode": "per_minute", "rate_cents_per_min": 250, "max_paid_minutes": 5}, 20,
                                    [("answered_completed", -3000, 900)], "answered_completed")
    bd = cj.get("pay_breakdown") or {}
    check("per-minute cap: paid_minutes == 5 exactly, worker +1125",
          bd.get("paid_minutes") == 5 and bd.get("worker_due_cents") == 1250 and gain == 1125,
          f"bd={json.dumps(bd)} gain={gain}")

    # agreed bound: 300s at 1000/min = 5000 > agreed 1500 -> due = agreed, fee on agreed (150)
    jid, gain, p_after, cj = pm_job(poster_pm2, "CapC per-minute bound job",
                                    {"mode": "per_minute", "rate_cents_per_min": 1000, "max_paid_minutes": 10}, 15,
                                    [("answered_completed", -3000, 300)], "answered_completed")
    bd = cj.get("pay_breakdown") or {}
    check("per-minute bound: worker_due == agreed 1500, fee 150, worker +1350",
          bd.get("worker_due_cents") == 1500 and bd.get("fee_cents") == 150 and gain == 1350,
          f"bd={json.dumps(bd)} gain={gain}")

    # zero billable: only a no_answer attempt -> pays 0, full refund
    poster_bal_before = wallet(poster_pm2)[0]
    jid, gain, p_after, cj = pm_job(poster_pm2, "CapC per-minute zero job", PM_RULE, 10,
                                    [("no_answer", -3000, 30)], "no_answer")
    bd = cj.get("pay_breakdown") or {}
    check("per-minute zero: worker +0, breakdown billable 0 / due 0",
          gain == 0 and bd.get("billable_seconds") == 0 and bd.get("worker_due_cents") == 0
          and bd.get("refunded_cents") == 1000, f"bd={json.dumps(bd)} gain={gain}")

    # ---------- 5. Outcome-mode regression (Phase A shape, no mode key)
    poster_rg = seed_user("capc-prg@example.invalid", "CapC Poster RG")
    r = post_contract(poster_rg, "CapC outcome regression job",
                      {"answered_completed": 100, "answered_partial": 50, "voicemail_left": 50,
                       "no_answer": 0, "busy": 0, "wrong_number": 0, "refused_recording": 0}, budget=20)
    jid_rg = r.get("id")
    seeded_jobs.append(jid_rg)
    cj = cj_of(jid_rg)
    check("regression: legacy outcome pay_rule stored with mode outcome",
          (cj.get("pay_rule") or {}).get("mode") == "outcome", json.dumps(cj.get("pay_rule")))
    r = api(f"/agent/jobs/{jid_rg}/bid", AGENT_KEYS[worker], {"amount": 18, "eta_hours": 2, "pitch": "Outcome job."})
    bid = r.get("id")
    r = api(f"/jobs/{jid_rg}/award", PERSONAL_KEYS[poster_rg], {"bid_id": bid})
    r = api(f"/agent/jobs/{jid_rg}/contract/attempts", AGENT_KEYS[worker], {})
    att = (r.get("attempt") or {}).get("id")
    time.sleep(2)
    r = api(f"/agent/jobs/{jid_rg}/contract/attempts/{att}/close", AGENT_KEYS[worker],
            {"outcome": "answered_completed", "duration_sec": 95})
    w_before = wallet(worker_owner)
    r = deliver_and_complete(jid_rg, poster_rg)
    check("regression: outcome job completes", (r.get("job") or {}).get("status") == "completed", json.dumps(r)[:160])
    gain = wallet(worker_owner)[0] - w_before[0]
    bd = cj_of(jid_rg).get("pay_breakdown") or {}
    check("regression: worker +1620 exactly as Phase A (1800 - 180 fee)", gain == 1620, f"gain={gain}")
    check("regression: outcome pay_breakdown stored",
          bd.get("mode") == "outcome" and bd.get("pct") == 100 and bd.get("worker_due_cents") == 1800
          and bd.get("fee_cents") == 180 and bd.get("refunded_cents") == 0, json.dumps(bd))
    # evidence pack carries the breakdown for a party
    r = api(f"/jobs/{jid_rg}/evidence", PERSONAL_KEYS[poster_rg], method="GET")
    check("regression: evidence pack includes pay_breakdown (party view)",
          (((r.get("evidence") or {}).get("contract") or {}).get("pay_breakdown") or {}).get("mode") == "outcome",
          json.dumps(r)[:200])


def store_list(prefix):
    out = curl([f"https://xjpfyqzqqjeejrxzafth.supabase.co/storage/v1/object/list/deliverables",
                "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}", "-H", "content-type: application/json"],
               json.dumps({"prefix": prefix, "limit": 100}))
    try:
        return [o["name"] for o in json.loads(out)]
    except Exception:
        return []


def store_delete(paths):
    if not paths:
        return
    curl([f"https://xjpfyqzqqjeejrxzafth.supabase.co/storage/v1/object/deliverables",
          "-X", "DELETE", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}",
          "-H", "content-type: application/json"], json.dumps({"prefixes": paths}))


def cleanup(base):
    for jid in seeded_jobs:
        rest(f"ex_contract_attempts?job_id=eq.{jid}", "DELETE")
        rest(f"ex_contract_jobs?job_id=eq.{jid}", "DELETE")
        rest(f"ex_bids?job_id=eq.{jid}", "DELETE")
        rest(f"ex_messages?job_id=eq.{jid}", "DELETE")
        rest(f"ex_jobs?id=eq.{jid}", "DELETE")
    for aid in seeded_agents:
        rest(f"ex_capability_tests?agent_id=eq.{aid}", "DELETE")
        rest(f"ex_agent_capabilities?agent_id=eq.{aid}", "DELETE")
        rest(f"ex_agent_status?agent_id=eq.{aid}", "DELETE")
        rest(f"ex_agents?id=eq.{aid}", "DELETE")
    for uid in seeded_users:
        rest(f"ex_notifications?user_id=eq.{uid}", "DELETE")
        rest(f"ex_ledger?user_id=eq.{uid}", "DELETE")
        rest(f"ex_wallets?user_id=eq.{uid}", "DELETE")
        rest(f"ex_user_wallets?user_id=eq.{uid}", "DELETE")
        rest(f"ex_users?id=eq.{uid}", "DELETE")
    rest(f"ex_feed?created_at=gte.{T0}", "DELETE")
    rest(f"ex_outbox?created_at=gte.{T0}", "DELETE")
    rest("ex_settings?key=eq.guarantee_pool_cents", "PATCH", {"value": base["pool"]})
    paths = []
    for pre in ["contract", *[f"contract/tests/agent-{a}" for a in seeded_agents], *[f"job-{j}" for j in seeded_jobs]]:
        for name in store_list(pre):
            paths.append(f"{pre}/{name}" if not name.startswith(pre) else name)
    store_delete(paths)
    time.sleep(6)
    after = snapshot()
    check("cleanup: baselines byte-identical (outbox, wallets, counts, stats, pool)",
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
        # never leave the mailer paused or rows behind on a crash path
        try:
            cleanup(snapshot.__wrapped__() if hasattr(snapshot, "__wrapped__") else {
                "outbox_max": 231, "outbox_count": 200, "founder": (262000, 237900), "user4": (200, 3290),
                "users": 8, "agents": 4, "jobs": 34,
                "stats": {"users": 8, "agents": 4, "open_jobs": 31, "jobs_completed": 2,
                          "volume_cents": 5600, "guarantee_pool_cents": 0, "fee_pct": 10}, "pool": "0"})
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
