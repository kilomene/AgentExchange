#!/usr/bin/env python3
"""Live E2E for the WINNER-BRIEF report (owner report 2026-10-27 ~02:06 PDT:
"api and the ui masks her number (+132****8017) even for the winner - fix
that with full functionality; also if the email too was like that fix it").

Job 236's contact ("Beulah", +13234878017 in the DB, full) was awarded to
agent 230. This probe proves, for BOTH contract types, exactly what every
surface returns after award:
  * the WINNER (agent key detail, agent contracts list, web detail as the
    winner's owner, evidence pack) must carry the FULL phone / FULL email
    - the raw payload must contain the full string and no "****" mask;
  * everyone else (anonymous, the poster, the floor lists) stays sealed
    exactly as the owner's 2026-10-26 brief-privacy ruling requires.

Zero-mail discipline: mailer PAUSE first, dynamic baselines, every seeded
row deleted afterwards, baselines must return byte-identical.
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

CALLER = "+15557650199"            # the probe agent's attested caller number
TEST_NUMBER = "+19565537205"
CONTACT_PHONE = "+13235550199"     # fictional 555 contact number (the "her number" stand-in)
CONTACT_NAME = "Probe Beulah"
RECIPIENT = "probe-recipient@example.org"
SENDER = "probe-sender@example.org"
SUBJECT = "Your appointment confirmation"
INSTRUCTIONS = "Confirm the appointment for Thursday morning and ask whether parking is available on site."
QUESTIONS = ["What are your opening hours this week?", "Can an appointment be confirmed for Thursday morning?"]
PAY_CALL = {"answered_completed": 100, "answered_partial": 50, "voicemail_left": 50,
            "no_answer": 0, "busy": 0, "wrong_number": 0, "refused_recording": 0}
PAY_EMAIL = {"sent_completed": 100, "sent_partial": 50, "failed_bounced": 0, "failed_other": 0}
ATTEST = "I am authorised to have this outreach made about this matter and the purpose is lawful."
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
    key = f"probe-winnerbrief-{name.lower().replace(' ', '-')}-{ts}-{int(time.time() * 1000) % 9973}"
    body = {"email": f"winnerbrief{ts}{abs(hash(name)) % 99999}@example.org", "password_hash": "probe-only",
            "name": name, "avatar": "", "created_at": ts, "email_verified": True,
            "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "api_key_created_at": ts}
    user = json.loads(rest("ex_users", method="POST", body=body))[0]
    rest("ex_wallets", method="POST", body={"user_id": user["id"], "balance_cents": 100000, "held_cents": 0})
    return user, key


def seed_agent(owner_id, name, key):
    ts = int(time.time())
    return json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": name, "category": "personal", "skills": "calling, emailing",
        "tagline": "I work contracts", "description": "probe", "rate_cents": 2000, "status": "active",
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "jobs_completed": 5,
        "created_at": ts}))[0]


def email_headers(frm, subject):
    dom = frm.split("@")[1]
    lines = [f"From: {frm}", "To: probe@example.invalid", f"Subject: {subject}",
             f"Message-ID: <wb-{int(time.time() * 1000)}@{dom}>",
             "Date: Mon, 26 Oct 2026 10:00:00 -0700", "MIME-Version: 1.0",
             "Content-Type: text/plain; charset=utf-8",
             f"DKIM-Signature: v=1; a=rsa-sha256; d={dom}; s=ex1; bh=abc=; b=def="]
    return "\r\n".join(lines)


EMAIL_BODY = ("Hello, I am an AI assistant acting on behalf of my owner. "
              "My agent name is listed on the Exchange, and a contract email job is work an agent "
              "does by sending a real email with its own mail stack and proving the send.")


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_winner_brief\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = api("/stats")
    n0 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0} counts {n0}")

    ts = int(time.time())
    T0 = ts - 5
    poster, poster_key = seed_user("WinnerBrief Probe Poster")
    worker_owner, owner_key = seed_user("WinnerBrief Probe Worker Owner")
    akey = f"winnerbrief-key-{ts}"
    agent = seed_agent(worker_owner["id"], "WinnerBriefProbe", akey)
    print(f"seeded: poster {poster['id']}, worker owner {worker_owner['id']}, agent {agent['id']}")
    job_ids = []
    try:
        # ---- verify the agent for BOTH capabilities ----
        r = api("/agent/capabilities/phone_call/attest", agent_key=akey, method="POST", body={"phone": CALLER})
        check("call attest ok", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:160])
        t1 = api("/agent/capabilities/phone_call/test", agent_key=akey, method="POST", body={})
        ok = api(f"/agent/capabilities/tests/{t1['test_id']}/submit", agent_key=akey, method="POST",
                 body={"dialed_number": TEST_NUMBER, "from_number": CALLER, "outcome": "rang",
                       "rang_at": int(time.time()), "duration_sec": 5})
        check("ring test passes -> Call Verified", ok.get("passed") is True, json.dumps(ok)[:200])

        r = api("/agent/capabilities/email_send/attest", agent_key=akey, method="POST", body={"email": SENDER})
        check("email attest ok", r.get("capability", {}).get("status") == "unverified", json.dumps(r)[:160])
        t2 = api("/agent/capabilities/email_send/test", agent_key=akey, method="POST", body={})
        token = t2.get("challenge_token"); tid2 = t2.get("test_id")
        check("email test issued", bool(token and tid2), json.dumps(t2)[:160])
        ok2 = api(f"/agent/capabilities/tests/{tid2}/submit", agent_key=akey, method="POST",
                  body={"headers": email_headers(SENDER, f"Re: verification {token}"),
                        "body": EMAIL_BODY,
                        "answers": ["My listed agent name", "A contract email job is agent email work with proof"]})
        check("email test passes -> Email Verified", ok2.get("passed") is True, json.dumps(ok2)[:200])

        now = int(time.time())
        WS, WE = now - 600, now + 3600

        # ---- post the CALL contract ----
        call_contract = {"capability": "phone_call", "contact_name": CONTACT_NAME, "contact_phone": CONTACT_PHONE,
                         "brief_extra": "Probe context.", "questions": QUESTIONS,
                         "window_tz": "UTC", "window_start": WS, "window_end": WE,
                         "max_attempts": 3, "pay_rule": PAY_CALL, "poster_attestation": ATTEST}
        jC = api("/jobs", key=poster_key, method="POST", body={
            "title": "WinnerBrief Probe: call contract", "description": "Probe contract job.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": 48,
            "job_kind": "contract", "contract": call_contract})
        jobC = jC.get("id") or (jC.get("job") or {}).get("id")
        job_ids.append(jobC)
        check("call contract posted", bool(jobC), json.dumps(jC)[:200])

        # ---- post the EMAIL contract ----
        email_contract = {"capability": "email_send", "recipient_email": RECIPIENT,
                          "email_subject": SUBJECT, "email_instructions": INSTRUCTIONS,
                          "brief_extra": "Probe context.", "questions": QUESTIONS,
                          "window_tz": "UTC", "window_start": WS, "window_end": WE,
                          "max_attempts": 3, "pay_rule": PAY_EMAIL, "poster_attestation": ATTEST}
        jE = api("/jobs", key=poster_key, method="POST", body={
            "title": "WinnerBrief Probe: email contract", "description": "Probe contract job.",
            "category": "personal", "budget": 20, "mode": "bidding", "deadline_hours": 48,
            "job_kind": "contract", "contract": email_contract})
        jobE = jE.get("id") or (jE.get("job") or {}).get("id")
        job_ids.append(jobE)
        check("email contract posted", bool(jobE), json.dumps(jE)[:200])

        for jid in (jobC, jobE):
            rest(f"ex_contract_jobs?job_id=eq.{jid}", method="PATCH", body={"match_open_at": 0, "match_invited": []})

        # ---- pre-award: the (future) winner must NOT see the brief yet ----
        pre = api(f"/agent/jobs/{jobC}", agent_key=akey)
        check("pre-award agent detail: phone sealed", pre["job"]["contract"].get("contact_phone") in (None, ""),
              str(pre["job"]["contract"].get("contact_phone")))
        preE = api(f"/agent/jobs/{jobE}", agent_key=akey)
        check("pre-award agent detail: recipient sealed", preE["job"]["contract"].get("recipient_email") in (None, ""),
              str(preE["job"]["contract"].get("recipient_email")))

        # ---- bid + award both jobs to the probe agent ----
        bidC = api(f"/agent/jobs/{jobC}/bid", agent_key=akey, method="POST",
                   body={"amount": 18, "eta_hours": 24, "pitch": "verified for calls"})
        check("call bid placed", bool(bidC.get("id")), json.dumps(bidC)[:200])
        bidE = api(f"/agent/jobs/{jobE}/bid", agent_key=akey, method="POST",
                   body={"amount": 18, "eta_hours": 24, "pitch": "verified for email"})
        check("email bid placed", bool(bidE.get("id")), json.dumps(bidE)[:200])
        awC = api(f"/jobs/{jobC}/award", key=poster_key, method="POST", body={"bid_id": bidC["id"]})
        check("call job awarded to probe agent", (awC.get("job") or awC).get("status") == "awarded", json.dumps(awC)[:200])
        awE = api(f"/jobs/{jobE}/award", key=poster_key, method="POST", body={"bid_id": bidE["id"]})
        check("email job awarded to probe agent", (awE.get("job") or awE).get("status") == "awarded", json.dumps(awE)[:200])

        # ============ WINNER surfaces: FULL phone ============
        raw = api(f"/agent/jobs/{jobC}", agent_key=akey, raw=True)
        det = json.loads(raw)
        c = det["job"]["contract"]
        check("WINNER agent detail: contact_visible true", c.get("contact_visible") is True, str(c.get("contact_visible")))
        check("WINNER agent detail: FULL phone", c.get("contact_phone") == CONTACT_PHONE, str(c.get("contact_phone")))
        check("WINNER agent detail: full contact name", c.get("contact_name") == CONTACT_NAME, str(c.get("contact_name")))
        check("WINNER agent detail raw: full phone present, no mask", CONTACT_PHONE in raw and "****" not in raw,
              "phone in raw" if CONTACT_PHONE in raw else "PHONE MISSING FROM RAW")

        lst = api("/agent/contracts", agent_key=akey)
        row = next((x for x in lst.get("contracts", []) if x["id"] == jobC), None)
        check("WINNER /agent/contracts: FULL phone", row is not None and row["contract"].get("contact_phone") == CONTACT_PHONE,
              str(row and row["contract"].get("contact_phone")))

        web = api(f"/jobs/{jobC}", key=owner_key)
        wc = web["job"]["contract"]
        check("WINNER web detail (owner key): contact_visible true", wc.get("contact_visible") is True, str(wc.get("contact_visible")))
        check("WINNER web detail (owner key): FULL phone", wc.get("contact_phone") == CONTACT_PHONE, str(wc.get("contact_phone")))

        ev = api(f"/agent/jobs/{jobC}/evidence", agent_key=akey)
        evc = (ev.get("evidence") or {}).get("contract") or {}
        check("WINNER evidence pack: FULL phone", evc.get("contact_phone") == CONTACT_PHONE, str(evc.get("contact_phone")))

        mine = api("/my/jobs", key=owner_key)
        wrow = next((x for x in mine.get("working", []) if x["id"] == jobC), None)
        check("WINNER /my/jobs working row: contract block present with FULL phone",
              wrow is not None and (wrow.get("contract") or {}).get("contact_phone") == CONTACT_PHONE,
              str(wrow and (wrow.get("contract") or {}).get("contact_phone")))
        wrowE = next((x for x in mine.get("working", []) if x["id"] == jobE), None)
        check("WINNER /my/jobs working row: FULL recipient email",
              wrowE is not None and (wrowE.get("contract") or {}).get("recipient_email") == RECIPIENT,
              str(wrowE and (wrowE.get("contract") or {}).get("recipient_email")))
        pmine = api("/my/jobs", key=poster_key)
        prow = next((x for x in pmine.get("posted", []) if x["id"] == jobC), None)
        check("POSTER /my/jobs posted row: contract shell present, phone sealed",
              prow is not None and prow.get("contract") is not None
              and (prow.get("contract") or {}).get("contact_phone") in (None, "")
              and (prow.get("contract") or {}).get("contact_visible") is False,
              str(prow and (prow.get("contract") or {}).get("contact_phone")))

        # ---- self-view capabilities: own identifiers IN FULL ----
        acaps = api("/agent/capabilities", agent_key=akey)
        minecaps = {c["capability"]: c for c in acaps.get("mine", [])}
        check("SELF /agent/capabilities: own caller number FULL",
              minecaps.get("phone_call", {}).get("attested_phone") == CALLER,
              str(minecaps.get("phone_call", {}).get("attested_phone")))
        check("SELF /agent/capabilities: own sending email FULL",
              minecaps.get("email_send", {}).get("attested_email") == SENDER,
              str(minecaps.get("email_send", {}).get("attested_email")))
        ocaps = api("/my/capabilities", key=owner_key)
        orow = next((a for a in ocaps.get("agents", []) if a["id"] == agent["id"]), None)
        ocmap = {c["capability"]: c for c in (orow or {}).get("capabilities", [])}
        check("OWNER /my/capabilities: agent's caller number FULL",
              ocmap.get("phone_call", {}).get("attested_phone") == CALLER,
              str(ocmap.get("phone_call", {}).get("attested_phone")))
        check("OWNER /my/capabilities: agent's sending email FULL",
              ocmap.get("email_send", {}).get("attested_email") == SENDER,
              str(ocmap.get("email_send", {}).get("attested_email")))
        pub = api(f"/agents/{agent['id']}")
        pubmap = {c["capability"]: c for c in (pub.get("agent") or {}).get("capabilities", [])}
        check("PUBLIC agent profile: caller number stays masked (last4 only)",
              not pubmap.get("phone_call", {}).get("attested_phone")
              and pubmap.get("phone_call", {}).get("attested_last4") == CALLER[-4:],
              json.dumps(pubmap.get("phone_call", {}))[:160])
        check("PUBLIC agent profile: sending email stays masked",
              not pubmap.get("email_send", {}).get("attested_email")
              and pubmap.get("email_send", {}).get("attested_email_masked", "").startswith("p***"),
              json.dumps(pubmap.get("email_send", {}))[:160])

        # ============ WINNER surfaces: FULL email ============
        rawE = api(f"/agent/jobs/{jobE}", agent_key=akey, raw=True)
        detE = json.loads(rawE)
        ce = detE["job"]["contract"]
        check("WINNER agent detail: recipient_visible (contact_visible true)", ce.get("contact_visible") is True, str(ce.get("contact_visible")))
        check("WINNER agent detail: FULL recipient email", ce.get("recipient_email") == RECIPIENT, str(ce.get("recipient_email")))
        check("WINNER agent detail: full subject", ce.get("email_subject") == SUBJECT, str(ce.get("email_subject")))
        check("WINNER agent detail: full instructions", ce.get("email_instructions") == INSTRUCTIONS, str(ce.get("email_instructions"))[:80])
        check("WINNER agent detail raw: full email present, no mask", RECIPIENT in rawE and "****" not in rawE,
              "email in raw" if RECIPIENT in rawE else "EMAIL MISSING FROM RAW")

        lstE = api("/agent/contracts", agent_key=akey)
        rowE = next((x for x in lstE.get("contracts", []) if x["id"] == jobE), None)
        check("WINNER /agent/contracts: FULL recipient email", rowE is not None and rowE["contract"].get("recipient_email") == RECIPIENT,
              str(rowE and rowE["contract"].get("recipient_email")))

        webE = api(f"/jobs/{jobE}", key=owner_key)
        wec = webE["job"]["contract"]
        check("WINNER web detail (owner key): FULL recipient email", wec.get("recipient_email") == RECIPIENT, str(wec.get("recipient_email")))
        check("WINNER web detail (owner key): full subject", wec.get("email_subject") == SUBJECT, str(wec.get("email_subject")))

        evE = api(f"/agent/jobs/{jobE}/evidence", agent_key=akey)
        evcE = (evE.get("evidence") or {}).get("contract") or {}
        check("WINNER evidence pack: FULL recipient email", evcE.get("recipient_email") == RECIPIENT, str(evcE.get("recipient_email")))

        # ============ everyone else stays sealed ============
        anon = api(f"/jobs/{jobC}")
        ac = anon["job"]["contract"]
        check("anon web detail: phone sealed", ac.get("contact_phone") in (None, "") and ac.get("contact_visible") is False,
              str(ac.get("contact_phone")))
        anonE = api(f"/jobs/{jobE}")
        ace = anonE["job"]["contract"]
        check("anon web detail: recipient sealed", ace.get("recipient_email") in (None, "") and ace.get("contact_visible") is False,
              str(ace.get("recipient_email")))
        post = api(f"/jobs/{jobC}", key=poster_key)
        pc = post["job"]["contract"]
        check("poster web detail: phone sealed (brief-privacy ruling)", pc.get("contact_phone") in (None, ""),
              str(pc.get("contact_phone")))
        postE = api(f"/jobs/{jobE}", key=poster_key)
        pce = postE["job"]["contract"]
        check("poster web detail: recipient sealed (brief-privacy ruling)", pce.get("recipient_email") in (None, ""),
              str(pce.get("recipient_email")))
        floor = api("/jobs?kind=contract&capability=phone_call", raw=True)
        check("web floor raw: contact phone never present", CONTACT_PHONE not in floor, "")
        raws = json.dumps(lst)
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
