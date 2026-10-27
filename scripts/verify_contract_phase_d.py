#!/usr/bin/env python3
"""Agent Exchange - CONTRACT AGENTS PHASE D live E2E (zero-mail discipline).

Proves, against the LIVE function + REST:
 - Email Test: fail pack (<70, stays unverified) and pass pack (100 ->
   verified, 90-day expiry); agents-only at email attest/test on BOTH the
   agent-key routes and the owner mirror; a human still refused at an email
   bid with a directly-seeded verified email_send row.
 - Capability separation: Call-Verified-only refused on an email contract,
   Email-Verified-only refused on a call contract (gate names the other test).
 - per_minute refused for email_send at posting (400).
 - Single email contract: recipient/subject masked on floor/anon/other
   views, revealed to the winner at award, email proof header checks run at
   delivery, completion pays exact (2000 due / 200 fee / +1800).
 - Sealed schedule file: scheduled postings create per-entry task shells;
   bids refuse before the file lands; upload pins the local SHA-256; the
   marker string + hash appear in NO public/other view; pre-award download
   refused for a non-awarded agent, allowed for the poster; post-award the
   winner downloads the exact bytes; every download writes an audit row.
 - Scheduled 3-entry call contract settles PER ENTRY exactly: agreed 3000,
   shares 1000/1000/1000 at 100%/50%/0% -> due 1500, fee 150, worker +1350,
   poster refund 1500, per-entry breakdown stored.
 - Match routing for an email contract: the top 5 EMAIL-verified agents are
   invited (a higher-ranked call-only agent is not), invited bid OK inside
   the window, the 6th email agent refused by the priority window.
 - Sweeper: a scheduled contract is EXEMPT from the single-window +24h
   auto-cancel; at schedule_end + 48h it auto-settles (proved entry pays,
   untouched entry fails + refunds, auto_settled=schedule_expired).

No real email is ever sent: Email Test and contract proofs are submitted
packs (headers + body text), exactly as the design specifies.

Discipline: PAUSE asserted absent at start, written before any API call;
snapshot baselines; seed labelled rows; verify; DELETE every seeded row;
restore the guarantee-pool setting; assert baselines byte-identical;
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
    # Retried: a transient PostgREST/proxy error dict (or a dropped reply)
    # must not kill a seed/cleanup step mid-run (seen live 2026-10-26).
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


def api(path, key=None, body=None, method="POST", raw_headers=None):
    args = [f"{FUNC}{path}"]
    hdr = []
    if key:
        # account routes read X-API-Key; the /agent/* guard reads X-Agent-Key.
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


def api_upload(path, key, fields, file_bytes, filename, ctype, agent_key=True):
    fpath = f"/tmp/_capd_{int(time.time()*1000)}_{filename}"
    Path(fpath).write_bytes(file_bytes)
    hdr = "X-Agent-Key" if agent_key else "X-API-Key"
    args = [f"{FUNC}{path}", "-H", f"{hdr}: {key}"]
    for k, v in fields.items():
        args += ["-F", f"{k}={v}"]
    args += ["-F", f"file=@{fpath};filename={filename};type={ctype}"]
    out = curl(args)
    Path(fpath).unlink(missing_ok=True)
    try:
        return json.loads(out)
    except Exception:
        return {"_raw": out}


def fetch_url(url):
    return subprocess.run(["curl", "-s", "--max-time", "60", url],
                          capture_output=True).stdout


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
    key = "capd-" + hashlib.sha256(email.encode()).hexdigest()[:28]
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
        OWNER_KEYS[uid] = key
    return uid


def seed_agent(owner, name, key, jobs_completed=5, rate_cents=2000, is_human=False):
    rows = rest("ex_agents", "POST", {
        "owner_id": owner, "name": name, "category": "personal", "status": "active",
        "is_human": is_human, "api_key_hash": hashlib.sha256(key.encode()).hexdigest(),
        "description": "Phase D verify probe", "rate_cents": rate_cents,
        "jobs_completed": jobs_completed, "created_at": T0,
    }, "return=representation")
    aid = rows[0]["id"]
    seeded_agents.append(aid)
    AGENT_KEYS[aid] = key
    return aid


DISCLOSURE = ("Hello, I am an AI assistant calling on behalf of my principal, and this call is being recorded. "
              "I have two questions to answer for this capability check.")


def verify_call_agent(aid, phone):
    key = AGENT_KEYS[aid]
    r = api("/agent/capabilities/phone_call/attest", key, {"phone": phone})
    assert (r.get("capability") or {}).get("status") in ("unverified", "verified"), r
    r = api("/agent/capabilities/phone_call/test", key, {})
    phrase = r.get("challenge_phrase"); tid = r.get("test_id")
    assert phrase and tid, r
    transcript = (f"{DISCLOSURE} {phrase}. The purpose of this call is to confirm the appointment. "
                  "Yes, the office is open tomorrow at 9 AM.")
    r = api_upload(f"/agent/capabilities/tests/{tid}/submit", key,
                   {"transcript": transcript, "answer_1": "Confirm the appointment",
                    "answer_2": "Yes, open at 9 AM"}, WAV, "call.wav", "audio/wav")
    assert r.get("passed") is True and r.get("score", 0) >= 70, r
    return r


def email_headers(frm, subject, mid_domain=None, dkim=True):
    mid_domain = mid_domain or frm.split("@")[1]
    lines = [f"From: {frm}", "To: probe@example.invalid", f"Subject: {subject}",
             f"Message-ID: <capd-{int(time.time()*1000)}@{mid_domain}>",
             "Date: Mon, 26 Oct 2026 10:00:00 -0700", "MIME-Version: 1.0",
             "Content-Type: text/plain; charset=utf-8"]
    if dkim:
        lines.append(f"DKIM-Signature: v=1; a=rsa-sha256; d={mid_domain}; s=ex1; bh=abc=; b=def=")
    return "\r\n".join(lines)


EMAIL_BODY = ("Hello, I am an AI assistant acting on behalf of my owner. "
              "My agent name is listed on the Exchange, and a contract email job is work an agent "
              "does by sending a real email with its own mail stack and proving the send.")


def verify_email_agent(aid, email):
    key = AGENT_KEYS[aid]
    r = api("/agent/capabilities/email_send/attest", key, {"email": email})
    assert (r.get("capability") or {}).get("status") in ("unverified", "verified"), r
    r = api("/agent/capabilities/email_send/test", key, {})
    token = r.get("challenge_token"); tid = r.get("test_id")
    assert token and tid, r
    r = api(f"/agent/capabilities/tests/{tid}/submit", key, {
        "headers": email_headers(email, f"Re: verification {token}"),
        "body": EMAIL_BODY,
        "answers": ["My listed agent name", "A contract email job is agent email work with proof"],
    })
    assert r.get("passed") is True and r.get("score", 0) >= 70, r
    return r


OUTCOME_CALL = {"answered_completed": 100, "answered_partial": 50, "voicemail_left": 50,
                "no_answer": 0, "busy": 0, "wrong_number": 0, "refused_recording": 0}
OUTCOME_EMAIL = {"sent_completed": 100, "sent_partial": 50, "failed_bounced": 0, "failed_other": 0}
ATTEST = "I am authorised to have this outreach made about this matter and the purpose is lawful."


def post_contract(poster_uid, title, contract, budget=20, window=None):
    now = int(time.time())
    ws, we = window or (now - 600, now + 3600)
    body = {"capability": "phone_call", "questions": ["What is the appointment for?", "Is the office open tomorrow?"],
            "window_start": ws, "window_end": we, "window_tz": "UTC", "max_attempts": 3,
            "pay_rule": OUTCOME_CALL, "poster_attestation": ATTEST}
    body.update(contract)
    return api("/jobs", PERSONAL_KEYS[poster_uid], {
        "title": title, "description": "Contract job — see the brief.", "category": "personal",
        "budget": budget, "mode": "bidding", "deadline_hours": 48, "job_kind": "contract",
        "contract": body})


def cj_of(job_id):
    rows = rest(f"ex_contract_jobs?job_id=eq.{job_id}&select=*")
    return rows[0] if isinstance(rows, list) and rows else {}


def tasks_of(job_id):
    return rest(f"ex_contract_tasks?job_id=eq.{job_id}&select=*&order=entry_index.asc") or []


def access_of(job_id):
    return rest(f"ex_schedule_file_access?job_id=eq.{job_id}&select=*&order=id.asc") or []


def cap_of(aid, slug):
    rows = rest(f"ex_agent_capabilities?agent_id=eq.{aid}&capability=eq.{slug}&select=*")
    return rows[0] if isinstance(rows, list) and rows else {}


def wallet(uid):
    rows = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def open_priority(job_id):
    rest(f"ex_contract_jobs?job_id=eq.{job_id}", "PATCH", {"match_open_at": 0, "match_priority": False})


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
    assert not PAUSE.exists(), "PAUSE already present - a verification window is open elsewhere"
    base = snapshot()
    print("BASELINE:", json.dumps(base))
    # The stable fields must match the recorded platform state. Founder
    # wallet / job counts are snapshot-relative: a genuine founder job
    # (id 236, posted by user 1 during the first Phase D window) moved
    # them legitimately - the cleanup check below still demands the
    # end state equal THIS start state byte-for-byte.
    check("baseline stable fields match the recorded platform state",
          base["outbox_max"] == 231 and base["outbox_count"] == 200
          and base["user4"] == (200, 3290) and base["users"] == 8 and base["agents"] == 4
          and base["stats"]["fee_pct"] == 10 and base["stats"]["guarantee_pool_cents"] == 0,
          json.dumps(base["stats"]))
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    PAUSE.write_text("verify_contract_phase_d window\n")
    try:
        run(base)
    finally:
        cleanup(base)


def run(base):
    now = int(time.time())

    # ---------- 1. Email Test: fail pack, then pass pack
    owner_e = seed_user("capd-oe@example.invalid", "CapD Email Owner")
    agent_e = seed_agent(owner_e, "CapD Email Agent", "capd-agent-e", jobs_completed=6)
    EMAIL_E = "sender-d1@example.invalid"
    r = api("/agent/capabilities/email_send/attest", AGENT_KEYS[agent_e], {"email": EMAIL_E})
    check("email test: attest stores the address unverified",
          (r.get("capability") or {}).get("status") == "unverified"
          and (r.get("capability") or {}).get("attested_email") == EMAIL_E, json.dumps(r)[:200])
    r = api("/agent/capabilities/email_send/test", AGENT_KEYS[agent_e], {})
    tid = r.get("test_id")
    check("email test: challenge issued (token + 2 questions)",
          bool(tid) and bool(r.get("challenge_token")) and len(r.get("questions") or []) == 2, json.dumps(r)[:200])
    bad_headers = email_headers("impostor@other.invalid", "Re: verification without the token")
    r = api(f"/agent/capabilities/tests/{tid}/submit", AGENT_KEYS[agent_e], {
        "headers": bad_headers, "body": EMAIL_BODY,
        "answers": ["My listed agent name", "A contract email job is agent email work"]})
    check("email test: pack without the token and with a wrong From FAILS (<70)",
          r.get("passed") is False and 0 <= r.get("score", 99) < 70, f"score={r.get('score')}")
    check("email test: still unverified after the fail",
          cap_of(agent_e, "email_send").get("status") == "unverified")
    r = verify_email_agent(agent_e, EMAIL_E)
    check("email test: honest pack scores 100 and passes", r.get("score") == 100 and r.get("passed") is True,
          f"score={r.get('score')}")
    cap = cap_of(agent_e, "email_send")
    check("email test: capability verified with a ~90-day expiry",
          cap.get("status") == "verified" and abs(int(cap.get("expires_at") or 0) - (now + 90 * 86400)) < 7200,
          f"expires_at={cap.get('expires_at')}")

    # ---------- 2. Agents-only on email (human profile)
    human_owner = seed_user("capd-hum@example.invalid", "CapD Human Owner")
    human = seed_agent(human_owner, "CapD Human Profile", "capd-human", jobs_completed=5, is_human=True)
    r = api("/agent/capabilities/email_send/attest", AGENT_KEYS[human], {"email": "h@example.invalid"})
    check("agents-only: human email attest refused (agent key)", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    r = api("/agent/capabilities/email_send/test", AGENT_KEYS[human], {})
    check("agents-only: human Email Test start refused (agent key)", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    r = api(f"/my/agents/{human}/capabilities/email_send/attest", PERSONAL_KEYS[human_owner],
            {"email": "h@example.invalid"}, method="PUT")
    check("agents-only: human email attest refused (owner mirror)", "human" in json.dumps(r).lower(), json.dumps(r)[:160])
    r = api(f"/my/agents/{human}/capabilities/email_send/test", PERSONAL_KEYS[human_owner], {})
    check("agents-only: human Email Test start refused (owner mirror)", "human" in json.dumps(r).lower(), json.dumps(r)[:160])

    # ---------- 3. Single email contract: posting, masking, per-minute refusal
    poster_m = seed_user("capd-pm@example.invalid", "CapD Mail Poster")
    RECIP = "target-person@sealedmail.invalid"
    SUBJ = "Quote request ZXQ-4417"
    r = post_contract(poster_m, "CapD single email job", {
        "capability": "email_send", "recipient_email": RECIP, "email_subject": SUBJ,
        "email_instructions": "Ask for a written quote and a delivery date.",
        "questions": [], "pay_rule": OUTCOME_EMAIL}, budget=20)
    jid_m = r.get("id")
    check("email job: single email contract posts", bool(jid_m), json.dumps(r)[:220])
    seeded_jobs.append(jid_m)
    cj = cj_of(jid_m)
    check("email job: structured fields stored", cj.get("recipient_email") == RECIP and cj.get("email_subject") == SUBJ)
    r = post_contract(poster_m, "CapD per-minute email job", {
        "capability": "email_send", "recipient_email": RECIP, "email_subject": SUBJ,
        "email_instructions": "Ask for a written quote.", "questions": [],
        "pay_rule": {"mode": "per_minute", "rate_cents_per_min": 100, "max_paid_minutes": 10}}, budget=20)
    check("email job: per_minute pay REFUSED for email_send with a clear 400",
          "per-minute" in json.dumps(r), json.dumps(r)[:220])
    floor_raw = json.dumps(api("/jobs?kind=contract", method="GET"))
    check("masking: floor list carries neither recipient nor subject",
          RECIP not in floor_raw and "ZXQ-4417" not in floor_raw)
    r = api(f"/jobs/{jid_m}", method="GET")
    cpub = (r.get("job") or {}).get("contract") or {}
    check("masking: anonymous view hides recipient + subject",
          cpub.get("recipient_email") is None and not cpub.get("email_subject"), json.dumps(cpub)[:200])
    other = seed_user("capd-other@example.invalid", "CapD Other User")
    r = api(f"/jobs/{jid_m}", PERSONAL_KEYS[other], method="GET")
    cother = (r.get("job") or {}).get("contract") or {}
    check("masking: another signed-in user sees them hidden too",
          cother.get("recipient_email") is None and not cother.get("email_subject"))
    r = api(f"/jobs/{jid_m}", PERSONAL_KEYS[poster_m], method="GET")
    cposter = (r.get("job") or {}).get("contract") or {}
    check("brief privacy (owner ruling): even the POSTER's detail view is sealed on an open job",
          cposter.get("recipient_email") is None and not cposter.get("email_subject")
          and not cposter.get("email_instructions") and cposter.get("contact_visible") is False,
          json.dumps(cposter)[:200])
    admin_key = (ROOT / ".admin-api-key").read_text().strip()
    r = api(f"/jobs/{jid_m}", admin_key, method="GET")
    cadmin = (r.get("job") or {}).get("contract") or {}
    check("brief privacy (owner ruling): the ADMIN detail view is sealed on an open job too",
          cadmin.get("recipient_email") is None and not cadmin.get("email_subject")
          and not cadmin.get("email_instructions") and cadmin.get("contact_visible") is False,
          json.dumps(cadmin)[:200])
    # human bid despite a seeded verified email row
    rest("ex_agent_capabilities", "POST", {
        "agent_id": human, "capability": "email_send", "status": "verified",
        "attested_email": "human-d@example.invalid", "verified_at": T0, "expires_at": T0 + 90 * 86400,
        "created_at": T0, "updated_at": T0})
    open_priority(jid_m)
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[human], {"amount": 18, "eta_hours": 2, "pitch": "I can email."})
    check("agents-only: human bid on an email contract refused despite a seeded verified row",
          "human profiles cannot take contracts of any type" in json.dumps(r), json.dumps(r)[:220])

    # ---------- 4. Capability separation, both directions
    owner_c = seed_user("capd-oc@example.invalid", "CapD Call Owner")
    agent_c = seed_agent(owner_c, "CapD Call Agent", "capd-agent-c", jobs_completed=6)
    verify_call_agent(agent_c, "+15557650201")
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[agent_c], {"amount": 18, "eta_hours": 2, "pitch": "Call agent bidding on email."})
    check("separation: Call-Verified-only agent refused on the email contract (Email Test named)",
          "Email Test" in json.dumps(r), json.dumps(r)[:220])
    poster_c = seed_user("capd-pc@example.invalid", "CapD Call Poster")
    r = post_contract(poster_c, "CapD single call job", {
        "contact_name": "Front Desk", "contact_phone": "+15559870202"}, budget=20)
    jid_c = r.get("id")
    seeded_jobs.append(jid_c)
    open_priority(jid_c)
    r = api(f"/agent/jobs/{jid_c}/bid", AGENT_KEYS[agent_e], {"amount": 18, "eta_hours": 2, "pitch": "Email agent bidding on a call."})
    check("separation: Email-Verified-only agent refused on the call contract (Call Test named)",
          "Call Test" in json.dumps(r), json.dumps(r)[:220])

    # ---------- 4b. Brief privacy (owner ruling): sealed for ALL until award, then winner-only
    for label, key in (("anonymous", None), ("poster", PERSONAL_KEYS[poster_c]), ("admin", admin_key)):
        r = api(f"/jobs/{jid_c}", key, method="GET") if key else api(f"/jobs/{jid_c}", method="GET")
        cv = (r.get("job") or {}).get("contract") or {}
        check(f"brief privacy: {label} view of the OPEN call job has no phone and no questions",
              cv.get("contact_phone") is None and (cv.get("questions") or []) == [] and cv.get("contact_visible") is False,
              json.dumps(cv)[:200])
    r = api(f"/agent/jobs/{jid_c}/bid", AGENT_KEYS[agent_c], {"amount": 18, "eta_hours": 2, "pitch": "Call verified and ready."})
    bid_c = r.get("id")
    r = api(f"/jobs/{jid_c}/award", PERSONAL_KEYS[poster_c], {"bid_id": bid_c})
    check("brief privacy: call job award lands for the reveal checks",
          (r.get("job") or {}).get("status") == "awarded", json.dumps(r)[:160])
    r = api(f"/agent/jobs/{jid_c}", AGENT_KEYS[agent_c], method="GET")
    cv = (r.get("job") or {}).get("contract") or {}
    check("brief privacy: the AWARDED agent sees the phone + the questions",
          cv.get("contact_phone") == "+15559870202" and len(cv.get("questions") or []) == 2
          and cv.get("contact_visible") is True, json.dumps(cv)[:240])
    r = api(f"/jobs/{jid_c}", PERSONAL_KEYS[owner_c], method="GET")
    cv = (r.get("job") or {}).get("contract") or {}
    check("brief privacy: the awarded agent's OWNER sees the brief on the web detail",
          cv.get("contact_phone") == "+15559870202" and len(cv.get("questions") or []) == 2, json.dumps(cv)[:200])
    for label, key in (("poster", PERSONAL_KEYS[poster_c]), ("admin", admin_key)):
        r = api(f"/jobs/{jid_c}", key, method="GET")
        cv = (r.get("job") or {}).get("contract") or {}
        check(f"brief privacy: the {label} STAYS sealed even after award",
              cv.get("contact_phone") is None and (cv.get("questions") or []) == [] and cv.get("contact_visible") is False)

    # ---------- 5. Single email contract end-to-end
    r = api(f"/agent/jobs/{jid_m}/bid", AGENT_KEYS[agent_e], {"amount": 20, "eta_hours": 2, "pitch": "Email verified and ready."})
    bid_m = r.get("id")
    check("email e2e: Email Verified agent bids", bool(bid_m), json.dumps(r)[:200])
    r = api(f"/jobs/{jid_m}/award", PERSONAL_KEYS[poster_m], {"bid_id": bid_m})
    check("email e2e: award lands", (r.get("job") or {}).get("status") == "awarded", json.dumps(r)[:160])
    r = api(f"/agent/jobs/{jid_m}", AGENT_KEYS[agent_e], method="GET")
    cwin = (r.get("job") or {}).get("contract") or {}
    check("email e2e: winner sees recipient + subject + instructions after award",
          cwin.get("recipient_email") == RECIP and cwin.get("email_subject") == SUBJ
          and "written quote" in (cwin.get("email_instructions") or ""), json.dumps(cwin)[:240])
    r = api(f"/jobs/{jid_m}", PERSONAL_KEYS[owner_e], method="GET")
    cwin2 = (r.get("job") or {}).get("contract") or {}
    check("brief privacy: the awarded owner's WEB detail reveals recipient + subject",
          cwin2.get("recipient_email") == RECIP and cwin2.get("email_subject") == SUBJ, json.dumps(cwin2)[:200])
    r = api(f"/agent/jobs/{jid_m}/contract/attempts", AGENT_KEYS[agent_e], {})
    att_m = (r.get("attempt") or {}).get("id")
    r = api(f"/agent/jobs/{jid_m}/contract/attempts/{att_m}/close", AGENT_KEYS[agent_e],
            {"outcome": "sent_completed"})
    check("email e2e: attempt closes sent_completed", (r.get("attempt") or {}).get("outcome") == "sent_completed",
          json.dumps(r)[:200])
    good_headers = email_headers(EMAIL_E, SUBJ)
    r = api(f"/agent/jobs/{jid_m}/deliver", AGENT_KEYS[agent_e], {
        "deliverable": "Email sent from my own stack; headers + body attached as proof.",
        "headers": good_headers, "body": EMAIL_BODY})
    check("email e2e: delivery accepted", (r.get("job") or {}).get("status") == "delivered", json.dumps(r)[:220])
    dchecks = ((r.get("job") or {}).get("delivery_check") or {}).get("checks") or []
    check("email e2e: delivery checks ran (From == attested, subject == declared)",
          any((c.get("name") or "").startswith("from is the attested") and c.get("ok") for c in dchecks)
          and any("subject matches" in (c.get("name") or "") and c.get("ok") for c in dchecks), json.dumps(dchecks)[:300])
    w_before = wallet(owner_e)
    r = api(f"/jobs/{jid_m}/action", PERSONAL_KEYS[poster_m], {"action": "complete"})
    check("email e2e: poster completes", (r.get("job") or {}).get("status") == "completed", json.dumps(r)[:160])
    gain = wallet(owner_e)[0] - w_before[0]
    bd = cj_of(jid_m).get("pay_breakdown") or {}
    check("email e2e: exact money — due 2000, fee 200, worker owner +1800",
          gain == 1800 and bd.get("worker_due_cents") == 2000 and bd.get("fee_cents") == 200
          and bd.get("refunded_cents") == 0, f"gain={gain} bd={json.dumps(bd)}")
    check("email e2e: proof headers stored on the contract row",
          SUBJ in (cj_of(jid_m).get("proof_headers") or ""))


    # ---------- 6. Sealed schedule file + scheduled 3-entry settlement
    poster_s = seed_user("capd-ps@example.invalid", "CapD Sched Poster")
    MARKER = "SEALEDMARKER-9917"
    sched_bytes = (f"ENTRY 1: call +1 555 010 2233 — {MARKER} — ask about the renewal quote.\n"
                   "ENTRY 2: call +1 555 010 2244 — ask about stock.\n"
                   "ENTRY 3: call +1 555 010 2255 — ask about opening hours.\n").encode()
    sched_sha = hashlib.sha256(sched_bytes).hexdigest()
    now = int(time.time())
    r = post_contract(poster_s, "CapD scheduled call run", {
        "schedule": {"task_count": 3, "cadence": "daily", "est_minutes": 15},
        "questions": ["What did they say?", "Any follow-up needed?"],
        "pay_rule": OUTCOME_CALL}, budget=30, window=(now - 600, now + 3 * 86400))
    jid_s = r.get("id")
    check("sealed: scheduled contract posts (no private fields in the posting)", bool(jid_s), json.dumps(r)[:220])
    seeded_jobs.append(jid_s)
    cj = cj_of(jid_s)
    check("sealed: shell stored (task_count 3, cadence daily, est 15)",
          cj.get("task_count") == 3 and cj.get("schedule_cadence") == "daily" and cj.get("est_minutes") == 15,
          json.dumps({k: cj.get(k) for k in ("task_count", "schedule_cadence", "est_minutes")}))
    check("sealed: 3 task shells created at posting",
          [t.get("entry_index") for t in tasks_of(jid_s)] == [1, 2, 3]
          and all(t.get("status") == "pending" for t in tasks_of(jid_s)))
    open_priority(jid_s)
    r = api(f"/agent/jobs/{jid_s}/bid", AGENT_KEYS[agent_c], {"amount": 30, "eta_hours": 24, "pitch": "Ready when the file lands."})
    check("sealed: bid REFUSED before the schedule file is attached",
          "sealed schedule file" in json.dumps(r), json.dumps(r)[:220])
    r = api_upload(f"/jobs/{jid_s}/contract/schedule-file", PERSONAL_KEYS[poster_s], {},
                   sched_bytes, "schedule.txt", "text/plain", agent_key=False)
    sf = r.get("schedule_file") or {}
    check("sealed: upload pins the exact local SHA-256",
          sf.get("sha256") == sched_sha and sf.get("file_name") == "schedule.txt", json.dumps(r)[:240])
    for label, rr in (("floor list", api("/jobs?kind=contract", method="GET")),
                      ("anonymous view", api(f"/jobs/{jid_s}", method="GET")),
                      ("other-user view", api(f"/jobs/{jid_s}", PERSONAL_KEYS[other], method="GET")),
                      ("other-agent view", api(f"/agent/jobs/{jid_s}", AGENT_KEYS[agent_e], method="GET"))):
        raw = json.dumps(rr)
        check(f"sealed: marker + hash absent from the {label}",
              MARKER not in raw and sched_sha not in raw and "555 010 2233" not in raw)
    r = api(f"/agent/jobs/{jid_s}/contract/schedule-file", AGENT_KEYS[agent_c], method="GET")
    check("sealed: pre-award download refused for a non-awarded agent",
          "awarded" in json.dumps(r), json.dumps(r)[:200])
    r = api(f"/jobs/{jid_s}/contract/schedule-file", PERSONAL_KEYS[poster_s], method="GET")
    dl = r.get("download") or {}
    got = fetch_url(dl.get("url") or "")
    check("sealed: poster downloads pre-award; bytes identical",
          got == sched_bytes and dl.get("sha256") == sched_sha, f"len={len(got)}")
    check("sealed: access log has exactly the poster's download so far",
          len(access_of(jid_s)) == 1 and access_of(jid_s)[0].get("actor_role") == "poster")
    r = api(f"/agent/jobs/{jid_s}/bid", AGENT_KEYS[agent_c], {"amount": 30, "eta_hours": 24, "pitch": "Ready."})
    bid_s = r.get("id")
    check("sealed: verified agent bids once the file is in", bool(bid_s), json.dumps(r)[:200])
    r = api(f"/jobs/{jid_s}/award", PERSONAL_KEYS[poster_s], {"bid_id": bid_s})
    check("sealed: award lands", (r.get("job") or {}).get("status") == "awarded", json.dumps(r)[:160])
    r = api(f"/agent/jobs/{jid_s}/contract/schedule-file", AGENT_KEYS[agent_c], method="GET")
    got = fetch_url((r.get("download") or {}).get("url") or "")
    check("sealed: winner downloads post-award; bytes identical", got == sched_bytes)
    r = api(f"/jobs/{jid_s}/contract/schedule-file", PERSONAL_KEYS[owner_c], method="GET")
    got = fetch_url((r.get("download") or {}).get("url") or "")
    check("sealed: winner's owner downloads via the web route too", got == sched_bytes)
    check("sealed: access log grows by one row per download (3 total)",
          len(access_of(jid_s)) == 3, f"rows={len(access_of(jid_s))}")
    # work the entries: 1 -> completed + proof, 2 -> partial + proof, 3 -> 3x no_answer
    TR = ("Hello, I am an AI assistant calling on behalf of the poster and this call is recorded. "
          "They answered both questions for this entry.")
    ANS = json.dumps(["Renewal quote confirmed", "No follow-up needed"])
    for idx, outcome in ((1, "answered_completed"), (2, "answered_partial")):
        r = api(f"/agent/jobs/{jid_s}/contract/attempts", AGENT_KEYS[agent_c], {"entry_index": idx})
        att = (r.get("attempt") or {}).get("id")
        assert att, r
        time.sleep(1)
        r = api(f"/agent/jobs/{jid_s}/contract/attempts/{att}/close", AGENT_KEYS[agent_c],
                {"outcome": outcome, "duration_sec": 60})
        assert (r.get("attempt") or {}).get("outcome") == outcome, r
        r = api_upload(f"/agent/jobs/{jid_s}/contract/tasks/{idx}/proof", AGENT_KEYS[agent_c],
                       {"transcript": TR, "answers": ANS}, WAV, f"entry{idx}.wav", "audio/wav")
        assert (r.get("task") or {}).get("status") == "proved", r
    check("sealed: entries 1+2 proved with per-entry proof",
          [t.get("status") for t in tasks_of(jid_s)][:2] == ["proved", "proved"])
    for n in range(3):
        r = api(f"/agent/jobs/{jid_s}/contract/attempts", AGENT_KEYS[agent_c], {"entry_index": 3})
        att = (r.get("attempt") or {}).get("id")
        assert att, r
        r = api(f"/agent/jobs/{jid_s}/contract/attempts/{att}/close", AGENT_KEYS[agent_c], {"outcome": "no_answer"})
    t3 = tasks_of(jid_s)[2]
    check("sealed: entry 3 terminally failed after its 3-attempt budget",
          t3.get("status") == "failed" and t3.get("outcome") == "no_answer", json.dumps(t3)[:200])
    r = api(f"/agent/jobs/{jid_s}/deliver", AGENT_KEYS[agent_c],
            {"deliverable": "Run complete: 2 entries proved, 1 terminally failed. Per-entry proof attached."})
    check("sealed: scheduled delivery accepted with every entry resolved",
          (r.get("job") or {}).get("status") == "delivered", json.dumps(r)[:220])
    w_worker = wallet(owner_c); w_poster = wallet(poster_s)
    r = api(f"/jobs/{jid_s}/action", PERSONAL_KEYS[poster_s], {"action": "complete"})
    check("sealed: poster completes the scheduled contract",
          (r.get("job") or {}).get("status") == "completed", json.dumps(r)[:160])
    gain = wallet(owner_c)[0] - w_worker[0]
    p_after = wallet(poster_s)
    bd = cj_of(jid_s).get("pay_breakdown") or {}
    entries = bd.get("entries") or []
    check("sealed: EXACT per-entry settlement — shares 1000/1000/1000 at 100/50/0, due 1500, fee 150, worker +1350",
          gain == 1350 and bd.get("worker_due_cents") == 1500 and bd.get("fee_cents") == 150
          and bd.get("refunded_cents") == 1500 and len(entries) == 3
          and [e.get("share_cents") for e in entries] == [1000, 1000, 1000]
          and [e.get("due_cents") for e in entries] == [1000, 500, 0],
          f"gain={gain} bd={json.dumps(bd)}")
    check("sealed: poster refunded exactly 1500 and escrow fully released",
          p_after[0] - w_poster[0] == 1500 and p_after[1] == 0, f"poster={w_poster} -> {p_after}")
    r = api(f"/jobs/{jid_s}/evidence", PERSONAL_KEYS[poster_s], method="GET")
    evc = ((r.get("evidence") or {}).get("contract") or {})
    check("sealed: evidence pack carries the file fingerprint + the access log",
          (evc.get("schedule_file") or {}).get("sha256") == sched_sha
          and len(evc.get("schedule_access") or []) == 3, json.dumps(evc.get("schedule_file")))

    # ---------- 7. Match routing for an email contract
    poster_x = seed_user("capd-px@example.invalid", "CapD Match Poster")
    match_agents = {}
    for i, jc in enumerate([30, 25, 20, 15, 10, 5], start=1):
        o = seed_user(f"capd-mo{i}@example.invalid", f"CapD Match Owner {i}")
        aid = seed_agent(o, f"CapD Match Agent {i}", f"capd-match-{i}", jobs_completed=jc, rate_cents=2000)
        verify_email_agent(aid, f"match{i}@example.invalid")
        match_agents[i] = aid
        api("/agent/presence", AGENT_KEYS[aid], {})
    api("/agent/presence", AGENT_KEYS[agent_c], {})  # call-only, jobs_completed 6 — must never be invited to email
    r = post_contract(poster_x, "CapD match email job", {
        "capability": "email_send", "recipient_email": "match-target@example.invalid",
        "email_subject": "Match routing probe", "email_instructions": "Send the probe message.",
        "questions": [], "pay_rule": OUTCOME_EMAIL}, budget=25)
    jid_x = r.get("id")
    seeded_jobs.append(jid_x)
    cj = cj_of(jid_x)
    invited = [e.get("agent_id") for e in (cj.get("match_invited") or [])]
    expect = [match_agents[i] for i in (1, 2, 3, 4, 5)]
    check("match(email): exactly the top 5 EMAIL-verified agents invited, in rank order",
          invited == expect, f"invited={invited} expect={expect}")
    check("match(email): the 6th email agent and the call-only agent are NOT invited",
          match_agents[6] not in invited and agent_c not in invited)
    r = api(f"/agent/jobs/{jid_x}/bid", AGENT_KEYS[match_agents[6]], {"amount": 20, "eta_hours": 2, "pitch": "Sixth."})
    check("match(email): non-invited email agent refused inside the priority window",
          "priority window" in json.dumps(r), json.dumps(r)[:220])
    r = api(f"/agent/jobs/{jid_x}/bid", AGENT_KEYS[match_agents[1]], {"amount": 20, "eta_hours": 2, "pitch": "Invited."})
    check("match(email): invited agent bids inside the window", bool(r.get("id")), json.dumps(r)[:160])
    r = api(f"/agent/jobs/{jid_x}/bid", AGENT_KEYS[agent_c], {"amount": 20, "eta_hours": 2, "pitch": "Call only."})
    check("match(email): call-only agent refused by the capability gate, not invited",
          "Email Test" in json.dumps(r), json.dumps(r)[:220])

    # ---------- 8. Sweeper: scheduled exemption + schedule_end+48h settle
    poster_w = seed_user("capd-pw@example.invalid", "CapD Sweep Poster")
    owner_w = seed_user("capd-ow@example.invalid", "CapD Sweep Owner")
    agent_w = seed_agent(owner_w, "CapD Sweep Agent", "capd-agent-w", jobs_completed=6)
    verify_call_agent(agent_w, "+15557650301")
    now = int(time.time())
    r = post_contract(poster_w, "CapD sweeper scheduled run", {
        "schedule": {"task_count": 2, "cadence": "once", "est_minutes": 10},
        "questions": ["What did they say?", "Any follow-up needed?"],
        "pay_rule": OUTCOME_CALL}, budget=20, window=(now - 600, now + 3600))
    jid_w = r.get("id")
    seeded_jobs.append(jid_w)
    open_priority(jid_w)
    r = api_upload(f"/jobs/{jid_w}/contract/schedule-file", PERSONAL_KEYS[poster_w], {},
                   b"ENTRY 1: call +1 555 010 3311.\nENTRY 2: call +1 555 010 3322.\n",
                   "sched2.txt", "text/plain", agent_key=False)
    assert (r.get("schedule_file") or {}).get("sha256"), r
    r = api(f"/agent/jobs/{jid_w}/bid", AGENT_KEYS[agent_w], {"amount": 20, "eta_hours": 24, "pitch": "Sweep run."})
    bid_w = r.get("id")
    r = api(f"/jobs/{jid_w}/award", PERSONAL_KEYS[poster_w], {"bid_id": bid_w})
    assert (r.get("job") or {}).get("status") == "awarded", r
    r = api(f"/agent/jobs/{jid_w}/contract/attempts", AGENT_KEYS[agent_w], {"entry_index": 1})
    att = (r.get("attempt") or {}).get("id")
    time.sleep(1)
    api(f"/agent/jobs/{jid_w}/contract/attempts/{att}/close", AGENT_KEYS[agent_w],
        {"outcome": "answered_completed", "duration_sec": 45})
    r = api_upload(f"/agent/jobs/{jid_w}/contract/tasks/1/proof", AGENT_KEYS[agent_w],
                   {"transcript": TR, "answers": ANS}, WAV, "sweep1.wav", "audio/wav")
    assert (r.get("task") or {}).get("status") == "proved", r
    # window ended 25h ago: the single-window +24h cancel must NOT touch a scheduled contract
    rest(f"ex_contract_jobs?job_id=eq.{jid_w}", "PATCH", {"window_end": int(time.time()) - 25 * 3600})
    print("sweeper: waiting ~75s to prove the +24h exemption…")
    time.sleep(75)
    st = (rest(f"ex_jobs?id=eq.{jid_w}&select=status") or [{}])[0].get("status")
    check("sweeper: scheduled contract EXEMPT from the +24h window auto-cancel (still awarded at end+25h)",
          st == "awarded", f"status={st}")
    # now push past schedule_end + 48h: auto-settle (proved pays, untouched refunds)
    w_before = wallet(owner_w)
    rest(f"ex_contract_jobs?job_id=eq.{jid_w}", "PATCH", {"window_end": int(time.time()) - 49 * 3600})
    settled = None
    for _ in range(36):
        time.sleep(5)
        row = (rest(f"ex_jobs?id=eq.{jid_w}&select=status") or [{}])[0]
        if row.get("status") in ("completed", "cancelled"):
            settled = row.get("status")
            break
    check("sweeper: schedule_end + 48h auto-settles the contract", settled == "completed", f"status={settled}")
    # The sweeper claim-flips the job to completed BEFORE its settlement
    # writes land (task resolutions, escrow RPCs, pay_breakdown patch take
    # a few more seconds through the proxy) — poll for the breakdown so
    # the money assertions read the settled state, not the flip gap.
    bd = {}
    for _ in range(12):
        bd = cj_of(jid_w).get("pay_breakdown") or {}
        if bd:
            break
        time.sleep(5)
    gain = wallet(owner_w)[0] - w_before[0]
    t2 = tasks_of(jid_w)[1]
    check("sweeper: EXACT auto-settlement — entry share 1000 at 100%, due 1000, fee 100, worker +900, refund 1000",
          gain == 900 and bd.get("worker_due_cents") == 1000 and bd.get("fee_cents") == 100
          and bd.get("refunded_cents") == 1000 and bd.get("auto_settled") == "schedule_expired"
          and t2.get("status") == "failed",
          f"gain={gain} bd={json.dumps(bd)} task2={t2.get('status')}")



def store_list(prefix):
    try:
        out = curl(["https://xjpfyqzqqjeejrxzafth.supabase.co/storage/v1/object/list/deliverables",
                    "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}", "-H", "content-type: application/json"],
                   json.dumps({"prefix": prefix, "limit": 100}))
        return [o["name"] for o in json.loads(out)]
    except Exception:
        return []


def store_delete(paths):
    if not paths:
        return
    curl(["https://xjpfyqzqqjeejrxzafth.supabase.co/storage/v1/object/deliverables",
          "-X", "DELETE", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}",
          "-H", "content-type: application/json"], json.dumps({"prefixes": paths}))


def cleanup(base):
    for jid in seeded_jobs:
        rest(f"ex_contract_attempts?job_id=eq.{jid}", "DELETE")
        rest(f"ex_contract_tasks?job_id=eq.{jid}", "DELETE")
        rest(f"ex_schedule_file_access?job_id=eq.{jid}", "DELETE")
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


BASE_FALLBACK = {
    "outbox_max": 231, "outbox_count": 200, "founder": (262000, 237900), "user4": (200, 3290),
    "users": 8, "agents": 4, "jobs": 34,
    "stats": {"users": 8, "agents": 4, "open_jobs": 31, "jobs_completed": 2,
              "volume_cents": 5600, "guarantee_pool_cents": 0, "fee_pct": 10}, "pool": "0"}


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("ERROR:", e)
        # never leave the mailer paused or rows behind on a crash path
        try:
            cleanup(BASE_FALLBACK)
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
