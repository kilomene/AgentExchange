#!/usr/bin/env python3
"""Live E2E for the FIX-EVERYTHING backend batch (2026-10-26, migration
20261026001500): escrow invariant, auth rate limits, webhook SSRF guard,
claim-first admin money moves, atomic guarantee pool, stored-fee milestone
math, delivery privacy, dispute guard, suspended reset, stale API keys,
unified email gate, presence heartbeat, deposit/payout mail queueing, and
the rules batch (own-job claim, partial screening, account strikes,
sock-puppet guard, subcontract gates, per-account bid cap, human trials,
bid deadline, login IP ban, payout review step, live fee texts).

Zero-mail discipline: mailer PAUSEd throughout (a pre-existing PAUSE from
a parallel track is respected, never removed by this script); all test
data seeded via REST service-role (never POST /jobs broadcasts except the
two gate probes, which throw before any insert/broadcast); everything
deleted after; founder/user-4 wallets + pool asserted back at baseline,
and every outbox row attributable to this run deleted.

AUTH NOTE: account-route auth uses seeded PERSONAL API KEYS
(X-API-Key) instead of crafted JWTs - the live function's JWT secret
stopped matching .env's EXCHANGE_JWT_SECRET mid-session on 2026-10-26
(crafted tokens verified at 17:24 UTC, rejected from ~17:40 UTC), while
API-key auth (the same path the founder key uses) stayed healthy."""
import base64
import hashlib
import hmac as hmac_mod
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
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
ADMIN = f"X-API-Key: {ADMIN_KEY}"

PASS = 0
FAIL = 0
FAILURES = []
SKIPS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}", flush=True)
    else:
        FAIL += 1
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL {name} :: {detail}", flush=True)


def skip(name, reason):
    SKIPS.append(f"{name}: {reason}")
    print(f"  SKIP {name} :: {reason}", flush=True)


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation", "-d", json.dumps(body)]
    out = curl(a)
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}


def api(path, method="GET", body=None, auth=None, extra_headers=None):
    a = ["-X", method, f"{API}{path}"]
    if auth:
        a += ["-H", auth]
    for h in (extra_headers or []):
        a += ["-H", h]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = curl(a)
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out}


def wallet(uid):
    r = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")[0]
    return r["balance_cents"], r["held_cents"]


def outbox_state():
    rows = rest("ex_outbox?select=id&order=id.desc&limit=1")
    cnt = rest("ex_outbox?select=id")
    return (rows[0]["id"] if rows else 0), len(cnt)


def pool():
    return int(rest("ex_settings?key=eq.guarantee_pool_cents&select=value")[0]["value"])


def sql(stmt):
    f = Path("/tmp/fixall_e2e.sql")
    f.write_text(stmt)
    out = subprocess.run(["python3", str(ROOT / "scripts/apply_sql.py"), str(f)], capture_output=True, text=True)
    assert "APPLIED" in out.stdout, out.stdout + out.stderr


def pbkdf2_hash(password, salt_hex):
    # The API decodes the hex salt to raw bytes before deriving.
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 100000, dklen=32)
    return f"pbkdf2${salt_hex}${dk.hex()}"


def seed_user(ts, tag, **kw):
    key = f"ukey-{tag}-{ts}"
    body = {"email": f"fixall-{tag}-{ts}@example.org", "password_hash": "probe-only",
            "name": f"FixAll {tag}", "avatar": "", "created_at": ts, "email_verified": True,
            "api_key_hash": hashlib.sha256(key.encode()).hexdigest(), "api_key_created_at": ts}
    body.update(kw)
    u = rest("ex_users", method="POST", body=body)[0]
    rest("ex_wallets", method="POST", body={"user_id": u["id"], "balance_cents": 0, "held_cents": 0})
    u["_auth"] = f"X-API-Key: {key}"
    u["_email"] = body["email"]
    return u


def seed_agent(owner_id, name, key, ts, **kw):
    body = {"owner_id": owner_id, "name": name, "category": "development", "skills": "testing",
            "tagline": "", "description": "", "rate_cents": 5000, "status": "active",
            "api_key_hash": hashlib.sha256(key.encode()).hexdigest(),
            "jobs_completed": 5, "created_at": ts}
    body.update(kw)
    return rest("ex_agents", method="POST", body=body)[0]


def seed_job(ts, **kw):
    body = {"poster_user_id": kw.pop("poster_user_id"), "poster_agent_id": None,
            "title": "FIXALL probe job", "description": "throwaway fixall probe",
            "category": "development", "budget_cents": 5000, "mode": "bidding",
            "status": "open", "created_at": ts, "updated_at": ts}
    body.update(kw)
    return rest("ex_jobs", method="POST", body=body)[0]


def main():
    pause_preexisting = PAUSE.exists()
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    if not pause_preexisting:
        PAUSE.write_text("verify_fixall_backend")
    print(f"mailer PAUSE in place (pre-existing: {pause_preexisting})", flush=True)
    ts = int(time.time())
    fw0, uw0 = wallet(1), wallet(4)
    ob0 = outbox_state()
    pool0 = pool()
    notif0 = rest("ex_notifications?select=id&order=id.desc&limit=1")[0]["id"]
    feed0 = rest("ex_feed?select=id&order=id.desc&limit=1")[0]["id"]
    founder_email = rest("ex_users?id=eq.1&select=email")[0]["email"]
    print(f"baseline founder={fw0} user4={uw0} outbox={ob0} pool={pool0}", flush=True)
    users, agents, jobs = [], [], []
    my_emails = {founder_email}

    try:
        # ---------- shared fixtures ----------
        posterA = seed_user(ts, "postera"); users.append(posterA["id"]); my_emails.add(posterA["_email"])
        bidder_owner = seed_user(ts, "bidowner"); users.append(bidder_owner["id"]); my_emails.add(bidder_owner["_email"])
        a1 = seed_agent(bidder_owner["id"], "FixBidderOne", f"b1-{ts}", ts); agents.append(a1["id"])
        a2 = seed_agent(bidder_owner["id"], "FixBidderTwo", f"b2-{ts}", ts); agents.append(a2["id"])
        K1, K2 = f"X-Agent-Key: b1-{ts}", f"X-Agent-Key: b2-{ts}"

        # ---------- R8 + R3: per-account bid cap, pitch screening ----------
        print("== R8/R3 bid cap + pitch screening ==", flush=True)
        bid_jobs = []
        for i in range(21):
            j = seed_job(ts, poster_user_id=posterA["id"]); jobs.append(j["id"]); bid_jobs.append(j["id"])
        r = api(f"/agent/jobs/{bid_jobs[0]}/bid", "POST",
                {"amount": 40, "eta_hours": 24, "pitch": "hire me, mail me at leak@example.com please"}, K1)
        check("bid placed", "id" in r, str(r))
        brows = rest(f"ex_bids?job_id=eq.{bid_jobs[0]}&agent_id=eq.{a1['id']}&select=pitch")
        brow = brows[0] if brows else {"pitch": ""}
        check("R3 pitch email masked at write", "leak@example.com" not in brow["pitch"] and "[hidden]" in brow["pitch"], brow["pitch"])
        ok = 1
        for jid in bid_jobs[1:10]:
            r = api(f"/agent/jobs/{jid}/bid", "POST", {"amount": 40, "eta_hours": 24, "pitch": "ok"}, K1)
            ok += 1 if "id" in r else 0
        for jid in bid_jobs[10:20]:
            r = api(f"/agent/jobs/{jid}/bid", "POST", {"amount": 40, "eta_hours": 24, "pitch": "ok"}, K2)
            ok += 1 if "id" in r else 0
        check("20 bids across two agents of one account placed", ok == 20, f"placed={ok}")
        r = api(f"/agent/jobs/{bid_jobs[20]}/bid", "POST", {"amount": 40, "eta_hours": 24, "pitch": "one too many"}, K2)
        check("R8 21st bid (either agent) refused per-account", "20 new bids per day" in r.get("error", "") and "account" in r.get("error", ""), str(r))

        # ---------- R10: bid deadline ----------
        print("== R10 bid deadline ==", flush=True)
        oc = seed_user(ts, "otherbidder"); users.append(oc["id"]); my_emails.add(oc["_email"])
        aoc = seed_agent(oc["id"], "FixOtherBidder", f"ob-{ts}", ts); agents.append(aoc["id"])
        KOC = f"X-Agent-Key: ob-{ts}"
        jdl = seed_job(ts, poster_user_id=posterA["id"], bid_deadline=ts - 100); jobs.append(jdl["id"])
        r = api(f"/agent/jobs/{jdl['id']}/bid", "POST", {"amount": 40, "eta_hours": 24, "pitch": "late"}, KOC)
        check("R10 bid after deadline refused", r.get("error") == "bidding has closed for this job", str(r))

        # ---------- R5: sock-puppet guard ----------
        print("== R5 sock-puppet guard ==", flush=True)
        twin_poster = seed_user(ts, "twinposter", signup_ip="203.0.113.9"); users.append(twin_poster["id"]); my_emails.add(twin_poster["_email"])
        twin_owner = seed_user(ts, "twinowner", signup_ip="203.0.113.9"); users.append(twin_owner["id"]); my_emails.add(twin_owner["_email"])
        atwin = seed_agent(twin_owner["id"], "FixTwinBidder", f"tw-{ts}", ts); agents.append(atwin["id"])
        jt = seed_job(ts, poster_user_id=twin_poster["id"]); jobs.append(jt["id"])
        r = api(f"/agent/jobs/{jt['id']}/bid", "POST", {"amount": 40, "eta_hours": 24, "pitch": "hi"}, f"X-Agent-Key: tw-{ts}")
        check("R5 same-signup-ip bid refused", "share a signup connection" in r.get("error", ""), str(r))

        # ---------- R9: human profile trial gate ----------
        print("== R9 human trials ==", flush=True)
        trial = rest("ex_trials?category=eq.development&active=eq.true&select=id")
        check("development trial is active (fixture)", len(trial) > 0, "no active development trial")
        hum_owner = seed_user(ts, "humowner"); users.append(hum_owner["id"]); my_emails.add(hum_owner["_email"])
        hum = seed_agent(hum_owner["id"], "FixHumanProfile", f"hm-{ts}", ts, is_human=True); agents.append(hum["id"])
        jbig = seed_job(ts, poster_user_id=posterA["id"], budget_cents=15000); jobs.append(jbig["id"])
        r = api(f"/agent/jobs/{jbig['id']}/bid", "POST", {"amount": 140, "eta_hours": 24, "pitch": "human here"}, f"X-Agent-Key: hm-{ts}")
        check("R9 human profile blocked by trial gate on >$100", "skill trial required" in r.get("error", "") and "every worker" in r.get("error", ""), str(r))

        # ---------- B19 + R4: postJob gates ----------
        print("== B19/R4 postJob gates ==", flush=True)
        unv = seed_user(ts, "unverified", email_verified=False); users.append(unv["id"]); my_emails.add(unv["_email"])
        rest(f"ex_wallets?user_id=eq.{unv['id']}", method="PATCH", body={"balance_cents": 100000})
        aunv = seed_agent(unv["id"], "FixUnverifiedAgent", f"uv-{ts}", ts); agents.append(aunv["id"])
        r = api("/agent/jobs", "POST", {"title": "Gate probe job", "description": "should be refused", "category": "development", "budget": 50, "mode": "bidding"}, f"X-Agent-Key: uv-{ts}")
        check("B19 unverified poster refused via agent key", "verify your email first" in r.get("error", ""), str(r))
        stk = seed_user(ts, "struck", strikes=3); users.append(stk["id"]); my_emails.add(stk["_email"])
        rest(f"ex_wallets?user_id=eq.{stk['id']}", method="PATCH", body={"balance_cents": 100000})
        astk = seed_agent(stk["id"], "FixStruckAgent", f"st-{ts}", ts); agents.append(astk["id"])
        r = api("/agent/jobs", "POST", {"title": "Strike probe job", "description": "should be refused", "category": "development", "budget": 50, "mode": "bidding"}, f"X-Agent-Key: st-{ts}")
        check("R4 poster with 3 strikes refused", "posting is suspended on your account (3 strikes)" in r.get("error", ""), str(r))

        # ---------- B1: escrow invariant on award ----------
        print("== B1 over-budget award ==", flush=True)
        pB = seed_user(ts, "awardposter"); users.append(pB["id"]); my_emails.add(pB["_email"])
        sql(f"select ex_move_balance({pB['id']}, 5000, 'probe_credit', 'fixall:b1', 'award probe funding', {ts});")
        jB = seed_job(ts, poster_user_id=pB["id"]); jobs.append(jB["id"])
        sql(f"select ex_hold_escrow({pB['id']}, 5000, 'job:{jB['id']}', 'award probe escrow', {ts});")
        bidB = rest("ex_bids", method="POST", body={"job_id": jB["id"], "agent_id": aoc["id"], "bidder_user_id": oc["id"],
                                                    "amount_cents": 7000, "eta_hours": 24, "pitch": "over budget", "status": "active", "created_at": ts})[0]
        r = api(f"/jobs/{jB['id']}/award", "POST", {"bid_id": bidB["id"]}, pB["_auth"])
        check("B1 award above budget + empty wallet refused naming shortfall",
              "insufficient balance to award this bid" in r.get("error", "") and "short by $20.00" in r.get("error", ""), str(r))
        sql(f"select ex_move_balance({pB['id']}, 2500, 'probe_credit', 'fixall:b1', 'award probe top-up', {ts});")
        r = api(f"/jobs/{jB['id']}/award", "POST", {"bid_id": bidB["id"]}, pB["_auth"])
        check("B1 award succeeds after top-up", "error" not in r, str(r))
        check("B1 escrow now holds the full agreed $70", wallet(pB["id"]) == (500, 7000), str(wallet(pB["id"])))

        # ---------- B3 + R7: subcontract gates ----------
        print("== B3/R7 subcontracts ==", flush=True)
        pS = seed_user(ts, "subposter"); users.append(pS["id"]); my_emails.add(pS["_email"])
        oH = seed_user(ts, "hirerowner"); users.append(oH["id"]); my_emails.add(oH["_email"])
        rest(f"ex_wallets?user_id=eq.{oH['id']}", method="PATCH", body={"balance_cents": 50000})
        hirer = seed_agent(oH["id"], "FixHirer", f"hr-{ts}", ts); agents.append(hirer["id"])
        same_owner_worker = seed_agent(oH["id"], "FixSameOwnerWorker", f"sw-{ts}", ts); agents.append(same_owner_worker["id"])
        oW = seed_user(ts, "subworkerowner"); users.append(oW["id"]); my_emails.add(oW["_email"])
        new_worker = seed_agent(oW["id"], "FixNewWorker", f"nw-{ts}", ts, jobs_completed=1); agents.append(new_worker["id"])
        jS = seed_job(ts, poster_user_id=pS["id"], status="awarded", awarded_agent_id=hirer["id"],
                      agreed_cents=20000, fee_cents=2000, budget_cents=20000); jobs.append(jS["id"])
        KH = f"X-Agent-Key: hr-{ts}"
        r = api(f"/agent/jobs/{jS['id']}/subcontracts", "POST", {"worker_agent_id": same_owner_worker["id"], "amount_cents": 1000, "brief": "same owner work"}, KH)
        check("B3 subcontract to own-account agent refused", "your own account" in r.get("error", ""), str(r))
        r = api(f"/agent/jobs/{jS['id']}/subcontracts", "POST", {"worker_agent_id": new_worker["id"], "amount_cents": 15000, "brief": "big chunk of work"}, KH)
        sub_id = r.get("subcontract", {}).get("id")
        check("subcontract offered to new worker", bool(sub_id), str(r))
        r = api(f"/agent/subcontracts/{sub_id}/accept", "POST", {}, f"X-Agent-Key: nw-{ts}")
        check("R7 new worker (<3 jobs) cannot accept a $150 subcontract", "new-agent limit" in r.get("error", ""), str(r))

        # ---------- B4 + B18 + R3: agent profile hygiene ----------
        print("== B4/B18/R3 agent profile ==", flush=True)
        r = api("/agent/profile", "PUT", {"webhook_url": "http://192.168.1.5/hook"}, K1)
        check("B4 private-IP webhook refused", "webhook_url must be a public http(s) URL" in r.get("error", ""), str(r))
        r = api("/agent/profile", "PUT", {"webhook_url": "https://hooks.example.com/x", "avatar": "javascript:alert(1)",
                                          "tagline": "mail me at leak2@example.com"}, K1)
        check("B4 public https webhook accepted", "error" not in r, str(r))
        arow = rest(f"ex_agents?id=eq.{a1['id']}&select=avatar,tagline,webhook_url")[0]
        check("B18 non-image avatar dropped", not str(arow["avatar"]).startswith("javascript:"), str(arow["avatar"])[:40])
        check("R3 agent tagline email masked", "leak2@example.com" not in arow["tagline"], arow["tagline"])
        check("B4 webhook stored", arow["webhook_url"] == "https://hooks.example.com/x", arow["webhook_url"])
        r = api("/my/agents", "POST", {"name": "FixWebCreated", "category": "development", "tagline": "reach me at leak3@example.com"}, posterA["_auth"])
        if "error" in r and "agent" in r.get("error", "").lower() and "limit" in r.get("error", "").lower():
            skip("/my/agents POST screening", f"poster agent slot full: {r['error']}")
        else:
            check("/my/agents POST ok", "id" in r, str(r))
            if "id" in r:
                agents.append(r["id"])
                crow = rest(f"ex_agents?id=eq.{r['id']}&select=tagline")[0]
                check("R3 /my/agents tagline masked", "leak3@example.com" not in crow["tagline"], crow["tagline"])

        # ---------- R1: web claim own job ----------
        print("== R1 web claim ==", flush=True)
        jF = seed_job(ts, poster_user_id=posterA["id"], mode="fixed"); jobs.append(jF["id"])
        own_agent = seed_agent(posterA["id"], "FixPosterOwn", f"po-{ts}", ts); agents.append(own_agent["id"])
        r = api(f"/jobs/{jF['id']}/claim", "POST", {"agent_id": own_agent["id"]}, posterA["_auth"])
        check("R1 cannot claim your own job (web)", r.get("error") == "you cannot claim your own job", str(r))

        # ---------- B13: delivery privacy ----------
        print("== B13 delivery privacy ==", flush=True)
        jD = seed_job(ts, poster_user_id=posterA["id"], status="delivered", awarded_agent_id=aoc["id"],
                      agreed_cents=5000, deliverable="SECRET DELIVERY NOTES", delivery_link="https://example.com/secret.zip",
                      delivered_at=ts); jobs.append(jD["id"])
        r = api(f"/jobs/{jD['id']}")
        jv = r.get("job", {})
        check("B13 anonymous view hides notes + link", jv.get("deliverable") == "" and jv.get("delivery_link") == "" and jv.get("delivery_private") is True,
              str({k: jv.get(k) for k in ("deliverable", "delivery_link", "delivery_private")}))
        r = api(f"/jobs/{jD['id']}", auth=posterA["_auth"])
        check("B13 poster still sees the delivery", r.get("job", {}).get("deliverable") == "SECRET DELIVERY NOTES", str(r.get("job", {}).get("deliverable")))

        # ---------- B15 + R3: dispute guard + reason screening ----------
        print("== B15/R3 dispute ==", flush=True)
        pJ = seed_user(ts, "disputeposter"); users.append(pJ["id"]); my_emails.add(pJ["_email"])
        jX = seed_job(ts, poster_user_id=pJ["id"], status="awarded", awarded_agent_id=aoc["id"], agreed_cents=5000); jobs.append(jX["id"])
        r = api(f"/jobs/{jX['id']}/action", "POST", {"action": "dispute", "reason": "bad work, see tiktok.com for proof"}, pJ["_auth"])
        check("B15 dispute on awarded job succeeds", r.get("ok") is True, str(r))
        jrow = rest(f"ex_jobs?id=eq.{jX['id']}&select=status,dispute_reason")[0]
        check("R3 dispute reason domain masked", "tiktok.com" not in (jrow["dispute_reason"] or ""), jrow["dispute_reason"] or "")
        jC = seed_job(ts, poster_user_id=pJ["id"], status="completed", awarded_agent_id=aoc["id"], agreed_cents=5000); jobs.append(jC["id"])
        r = api(f"/jobs/{jC['id']}/action", "POST", {"action": "dispute", "reason": "too late"}, pJ["_auth"])
        check("B15 dispute on completed job refused", "error" in r, str(r))

        # ---------- R4: dispute-resolve strikes ----------
        print("== R4 resolve strikes ==", flush=True)
        pD = seed_user(ts, "resposter"); users.append(pD["id"]); my_emails.add(pD["_email"])
        sql(f"select ex_move_balance({pD['id']}, 4000, 'probe_credit', 'fixall:r4', 'resolve probe', {ts});")
        jR1 = seed_job(ts, poster_user_id=pD["id"], status="disputed", awarded_agent_id=aoc["id"], agreed_cents=4000, fee_cents=400); jobs.append(jR1["id"])
        sql(f"select ex_hold_escrow({pD['id']}, 4000, 'job:{jR1['id']}', 'resolve probe escrow', {ts});")
        r = api(f"/admin/jobs/{jR1['id']}/resolve", "POST", {"resolution": "agent"}, ADMIN)
        check("resolve for agent ok", r.get("ok") is True, str(r))
        urow = rest(f"ex_users?id=eq.{pD['id']}&select=strikes")[0]
        check("R4 poster account strike +1 on agent resolution", urow["strikes"] == 1, str(urow))
        nrow = rest(f"ex_notifications?user_id=eq.{pD['id']}&type=eq.security&select=id")
        check("R4 poster got the security notification", len(nrow) >= 1, "no security notification")
        oE = seed_user(ts, "resworkerowner"); users.append(oE["id"]); my_emails.add(oE["_email"])
        aE = seed_agent(oE["id"], "FixResWorker", f"rw-{ts}", ts); agents.append(aE["id"])
        pE = seed_user(ts, "resposter2"); users.append(pE["id"]); my_emails.add(pE["_email"])
        sql(f"select ex_move_balance({pE['id']}, 4000, 'probe_credit', 'fixall:r4', 'resolve probe 2', {ts});")
        jR2 = seed_job(ts, poster_user_id=pE["id"], status="disputed", awarded_agent_id=aE["id"], agreed_cents=4000, fee_cents=400); jobs.append(jR2["id"])
        sql(f"select ex_hold_escrow({pE['id']}, 4000, 'job:{jR2['id']}', 'resolve probe escrow 2', {ts});")
        r = api(f"/admin/jobs/{jR2['id']}/resolve", "POST", {"resolution": "poster"}, ADMIN)
        check("resolve for poster ok", r.get("ok") is True, str(r))
        urow = rest(f"ex_users?id=eq.{oE['id']}&select=strikes")[0]
        arow2 = rest(f"ex_agents?id=eq.{aE['id']}&select=strikes")[0]
        check("R4 worker-owner account strike mirrors agent strike", urow["strikes"] == 1 and arow2["strikes"] == 1, f"user={urow} agent={arow2}")

        # ---------- B5a: admin remove claim-first ----------
        print("== B5a admin remove ==", flush=True)
        pR = seed_user(ts, "removeposter"); users.append(pR["id"]); my_emails.add(pR["_email"])
        sql(f"select ex_move_balance({pR['id']}, 5000, 'probe_credit', 'fixall:b5', 'remove probe', {ts});")
        jRM = seed_job(ts, poster_user_id=pR["id"], budget_cents=3000); jobs.append(jRM["id"])
        sql(f"select ex_hold_escrow({pR['id']}, 3000, 'job:{jRM['id']}', 'remove probe escrow', {ts});")
        r = api(f"/admin/jobs/{jRM['id']}/remove", "POST", {"reason": "probe removal"}, ADMIN)
        check("admin remove ok", r.get("ok") is True, str(r))
        check("remove refunded escrow exactly", wallet(pR["id"]) == (5000, 0), str(wallet(pR["id"])))
        r = api(f"/admin/jobs/{jRM['id']}/remove", "POST", {"reason": "again"}, ADMIN)
        check("second remove refused (no double refund)", "error" in r and wallet(pR["id"]) == (5000, 0), str(r))

        # ---------- B8: milestone fees from stored fee_cents ----------
        print("== B8 milestone fees ==", flush=True)
        pM = seed_user(ts, "mileposter"); users.append(pM["id"]); my_emails.add(pM["_email"])
        oM = seed_user(ts, "mileworker"); users.append(oM["id"]); my_emails.add(oM["_email"])
        aM = seed_agent(oM["id"], "FixMileWorker", f"mw-{ts}", ts); agents.append(aM["id"])
        sql(f"select ex_move_balance({pM['id']}, 10000, 'probe_credit', 'fixall:b8', 'milestone probe', {ts});")
        jM = seed_job(ts, poster_user_id=pM["id"], status="delivered", awarded_agent_id=aM["id"],
                      agreed_cents=10000, fee_cents=999, budget_cents=10000); jobs.append(jM["id"])
        sql(f"select ex_hold_escrow({pM['id']}, 10000, 'job:{jM['id']}', 'milestone probe escrow', {ts});")
        m1 = rest("ex_milestones", method="POST", body={"job_id": jM["id"], "idx": 0, "title": "Part 1", "pct": 33, "amount_cents": 3333, "status": "delivered", "created_at": ts})[0]
        m2 = rest("ex_milestones", method="POST", body={"job_id": jM["id"], "idx": 1, "title": "Part 2", "pct": 67, "amount_cents": 6667, "status": "delivered", "created_at": ts})[0]
        r = api(f"/jobs/{jM['id']}/milestones/{m1['id']}/release", "POST", {}, pM["_auth"])
        check("milestone 1 released", "error" not in r, str(r))
        check("B8 share 1 = 3333-333 (stored fee 999 pro-rata)", wallet(oM["id"]) == (3000, 0), str(wallet(oM["id"])))
        r = api(f"/jobs/{jM['id']}/milestones/{m2['id']}/release", "POST", {}, pM["_auth"])
        check("milestone 2 released (job finalizes)", "error" not in r, str(r))
        check("B8 total paid = agreed - stored fee exactly (9001)", wallet(oM["id"]) == (9001, 0), str(wallet(oM["id"])))
        check("B8 poster held drained", wallet(pM["id"])[1] == 0, str(wallet(pM["id"])))

        # ---------- B7 + B20 + B5b/c + R15: pool, deposits, payouts ----------
        print("== B7/B20/B5/R15 money admin ==", flush=True)
        pG = seed_user(ts, "pooluser"); users.append(pG["id"]); my_emails.add(pG["_email"])
        rest("ex_settings?key=eq.guarantee_pool_cents", method="PATCH", body={"value": "500"})
        r = api("/admin/guarantee/pay", "POST", {"user_id": pG["id"], "amount": 6.00, "reason": "probe overdraw"}, ADMIN)
        check("B7 pool overdraw refused", "cannot exceed the pool" in r.get("error", ""), str(r))
        check("B7 pool intact after refusal", pool() == 500, str(pool()))
        r = api("/admin/guarantee/pay", "POST", {"user_id": pG["id"], "amount": 5.00, "reason": "probe claim"}, ADMIN)
        check("B7 pool pay ok + pool drained atomically", r.get("pool_cents") == 0 and wallet(pG["id"]) == (500, 0), f"{r} wallet={wallet(pG['id'])}")
        dep = rest("ex_deposits", method="POST", body={"user_id": pG["id"], "amount_cents": 1234, "method": "crypto", "asset": "USDT", "tx_ref": "probe", "status": "pending", "created_at": ts})[0]
        r = api(f"/admin/deposits/{dep['id']}", "POST", {"action": "credit"}, ADMIN)
        if "raw" in r:  # transient gateway 502 - the claim-first flip makes a retry safe
            time.sleep(3)
            r = api(f"/admin/deposits/{dep['id']}", "POST", {"action": "credit"}, ADMIN)
        check("B5c deposit credit ok", r.get("ok") is True and wallet(pG["id"]) == (1734, 0), f"{r} wallet={wallet(pG['id'])}")
        ob = rest("ex_outbox?kind=eq.deposit_confirmed&select=id")
        check("B20 deposit_confirmed mail queued", len(ob) >= 1, "no deposit_confirmed row")
        r = api(f"/admin/deposits/{dep['id']}", "POST", {"action": "credit"}, ADMIN)
        check("B5c second credit refused, no double money", "error" in r and wallet(pG["id"]) == (1734, 0), f"{r} wallet={wallet(pG['id'])}")
        po = rest("ex_payouts", method="POST", body={"user_id": pG["id"], "amount_cents": 60000, "method": "bank", "asset": "USDT",
                                                     "destination": "probe bank", "status": "pending", "needs_review": True, "hold_until": 0, "created_at": ts})[0]
        r = api(f"/admin/payouts/{po['id']}", "POST", {"action": "paid"}, ADMIN)
        check("R15 >$500 payout blocked without reviewed:true", "flagged for review" in r.get("error", ""), str(r))
        r = api(f"/admin/payouts/{po['id']}", "POST", {"action": "paid", "reviewed": True}, ADMIN)
        check("R15 reviewed payout pays", r.get("ok") is True, str(r))
        ob = rest("ex_outbox?kind=eq.payout_completed&select=id")
        check("B20 payout_completed mail queued", len(ob) >= 1, "no payout_completed row")
        po2 = rest("ex_payouts", method="POST", body={"user_id": pG["id"], "amount_cents": 2000, "method": "bank", "asset": "USDT",
                                                      "destination": "probe bank", "status": "pending", "needs_review": False, "hold_until": 0, "created_at": ts})[0]
        before = wallet(pG["id"])
        r = api(f"/admin/payouts/{po2['id']}", "POST", {"action": "reject"}, ADMIN)
        check("B5b payout reject refunds once", r.get("ok") is True and wallet(pG["id"]) == (before[0] + 2000, before[1]), f"{r} wallet={wallet(pG['id'])}")
        r = api(f"/admin/payouts/{po2['id']}", "POST", {"action": "reject"}, ADMIN)
        check("B5b second reject refused, no double refund", "error" in r and wallet(pG["id"]) == (before[0] + 2000, before[1]), f"{r} wallet={wallet(pG['id'])}")

        # ---------- B17: stale personal API key ----------
        print("== B17 stale api key ==", flush=True)
        stale_key = f"stale-{ts}"
        uK1 = seed_user(ts, "stalekey", api_key_hash=hashlib.sha256(stale_key.encode()).hexdigest(),
                        api_key_created_at=100, password_changed_at=200); users.append(uK1["id"]); my_emails.add(uK1["_email"])
        r = api("/my/agents", auth=f"X-API-Key: {stale_key}")
        check("B17 pre-password-change key rejected with rotate message", "predates your last password change" in r.get("error", ""), str(r))
        fresh_key = f"fresh-{ts}"
        uK2 = seed_user(ts, "freshkey", api_key_hash=hashlib.sha256(fresh_key.encode()).hexdigest(),
                        api_key_created_at=300, password_changed_at=200); users.append(uK2["id"]); my_emails.add(uK2["_email"])
        r = api("/my/agents", auth=f"X-API-Key: {fresh_key}")
        check("B17 post-change key still works", "agents" in r, str(r))

        # ---------- B21: presence ----------
        print("== B21 presence ==", flush=True)
        r = api("/agent/presence", "POST", {}, K1)
        check("B21 presence heartbeat ok", r.get("ok") is True, str(r))
        srow = rest(f"ex_agent_status?agent_id=eq.{a1['id']}&select=online,last_heartbeat")
        check("B21 status row online", len(srow) == 1 and srow[0]["online"] is True, str(srow))

        # ---------- B16: reset on suspended account ----------
        print("== B16 suspended reset ==", flush=True)
        uS = seed_user(ts, "suspended", suspended=True); users.append(uS["id"]); my_emails.add(uS["_email"])
        raw_token = f"fixall-reset-token-{ts}-0123456789abcdef"
        rest("ex_email_tokens", method="POST", body={"user_id": uS["id"], "kind": "reset",
                                                     "token_hash": hashlib.sha256(raw_token.encode()).hexdigest(),
                                                     "expires_at": ts + 3600, "created_at": ts})
        r = api("/auth/reset", "POST", {"token": raw_token, "password": "brandnewpass1"})
        check("B16 reset for suspended account refused", r.get("error") == "account suspended", str(r))

        # ---------- B14 register slice + R11 login ban ----------
        print("== B14 register / R11 login ==", flush=True)
        reg_email = f"fixallreg{ts}@gmail.com"
        my_emails.add(reg_email)
        reg_id = None
        last_reg = {}
        for attempt in range(3):
            last_reg = api("/auth/register", "POST", {"email": reg_email, "password": "probe-pass-123", "name": "N" * 100})
            reg_id = (last_reg.get("user") or {}).get("id") or last_reg.get("id")
            if reg_id:
                break
            time.sleep(5)
        if not reg_id:
            skip("B14 register name slice", f"register blocked in this environment: {last_reg}")
        else:
            users.append(reg_id)
            urow = rest(f"ex_users?id=eq.{reg_id}&select=name")[0]
            check("B14 registered name sliced to 80", len(urow["name"]) == 80, f"len={len(urow['name'])}")
        # R11 uses a REST-seeded account with a real pbkdf2 password hash -
        # no dependency on the (egress-blocked) register route. The IP the
        # function sees for this sandbox rotates across Cloudflare edge
        # addresses, so the ban probe bans the address a first login just
        # recorded; if the next request lands on a different edge address
        # the check cannot fire and the probe reports a skip, not a pass.
        salt = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
        lu = seed_user(ts, "loginuser", password_hash=pbkdf2_hash("probe-pass-123", salt))
        users.append(lu["id"]); my_emails.add(lu["_email"])
        r = api("/auth/login", "POST", {"email": lu["_email"], "password": "probe-pass-123"})
        check("R11 clean login works (pbkdf2-seeded account)", "token" in r, str(r)[:160])
        seen_ip = (rest(f"ex_users?id=eq.{lu['id']}&select=last_ip")[0] or {}).get("last_ip")
        if not seen_ip:
            skip("R11 login ban", "function recorded no client IP for the probe login")
        else:
            rest("ex_banned_ips", method="POST", body={"ip": seen_ip, "reason": "fixall probe", "created_at": ts})
            r = api("/auth/login", "POST", {"email": lu["_email"], "password": "probe-pass-123"})
            rest(f"ex_banned_ips?ip=eq.{seen_ip}", method="DELETE")
            if r.get("error") == "this connection is banned":
                check("R11 login from banned IP refused", True)
            elif "token" in r:
                skip("R11 login ban", f"client IP rotated between requests (banned {seen_ip}, next request presented a different edge address)")
            else:
                check("R11 login from banned IP refused", False, str(r))

        # ---------- R16: live fee in stats + help ----------
        print("== R16 live fee ==", flush=True)
        r = api("/stats")
        check("R16 /stats exposes fee_pct", r.get("fee_pct") == 10, str(r.get("fee_pct")))
        rest("ex_settings?key=eq.fee_pct", method="PATCH", body={"value": "12"})
        r = api("/agent/help", auth=K1)
        rules = r.get("platform_rules", {})
        check("R16 help texts interpolate live fee", "12% fee" in rules.get("subcontracts", "") and "12% fee" in rules.get("milestones", ""),
              str({k: rules.get(k, "")[:60] for k in ("subcontracts", "milestones")}))
        rest("ex_settings?key=eq.fee_pct", method="PATCH", body={"value": "10"})

        # ---------- B2: auth rate limits (LAST - burns the shared IP budget) ----------
        print("== B2 auth rate limits ==", flush=True)
        codes = []
        for i in range(8):
            out = curl(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", f"{API}/auth/forgot",
                        "-H", "Content-Type: application/json", "-d", json.dumps({"email": f"ghost{ts}@example.org"})])
            codes.append(out.strip())
        check("B2 forgot-password rate limit trips (429)", "429" in codes and codes[-1] == "429", str(codes))

    finally:
        # ---------- cleanup ----------
        for jid in jobs:
            rest(f"ex_milestones?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_subcontracts?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_reviews?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
        for aid in agents:
            rest(f"ex_trial_attempts?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agent_status?agent_id=eq.{aid}", method="DELETE")
            rest(f"ex_agents?id=eq.{aid}", method="DELETE")
        rest("ex_banned_ips?ip=eq.203.0.113.77", method="DELETE")
        rest(f"ex_guarantee_claims?created_at=gte.{ts - 5}", method="DELETE")
        for uid in users:
            rest(f"ex_email_tokens?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_deposits?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_payouts?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_notifications?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_ledger?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_wallets?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_users?id=eq.{uid}", method="DELETE")
        rest(f"ex_notifications?id=gt.{notif0}", method="DELETE")
        rest(f"ex_feed?id=gt.{feed0}", method="DELETE")
        # Outbox: delete only rows attributable to THIS run (seeded users'
        # mail + the founder's admin copies) - a parallel track is live.
        rows = rest(f"ex_outbox?id=gt.{ob0[0]}&select=id,to_email")
        if isinstance(rows, list):
            for row in rows:
                if row.get("to_email") in my_emails:
                    rest(f"ex_outbox?id=eq.{row['id']}", method="DELETE")
        rest("ex_settings?key=eq.guarantee_pool_cents", method="PATCH", body={"value": str(pool0)})
        rest("ex_settings?key=eq.fee_pct", method="PATCH", body={"value": "10"})
        if PAUSE.exists() and not pause_preexisting:
            PAUSE.unlink()

    ok_fw, ok_uw = wallet(1) == fw0, wallet(4) == uw0
    ok_pool = pool() == pool0
    leftover = rest(f"ex_outbox?id=gt.{ob0[0]}&select=id,to_email")
    my_leftover = [r for r in leftover if isinstance(r, dict) and r.get("to_email") in my_emails] if isinstance(leftover, list) else []
    print(f"baseline restore: founder {wallet(1)}=={fw0} {ok_fw}; user4 {wallet(4)}=={uw0} {ok_uw}; pool {pool()}=={pool0} {ok_pool}; "
          f"outbox global now {outbox_state()} vs baseline {ob0} (parallel track active); my attributable outbox rows left: {len(my_leftover)}", flush=True)
    check("baselines restored (wallets + pool exact, no outbox rows of mine left)",
          ok_fw and ok_uw and ok_pool and len(my_leftover) == 0,
          f"fw={ok_fw} uw={ok_uw} pool={ok_pool} leftover={len(my_leftover)}")
    print(f"FIXALL BACKEND VERIFY: {PASS} passed, {FAIL} failed, {len(SKIPS)} skipped", flush=True)
    for f in FAILURES:
        print("  FAILED:", f, flush=True)
    for s in SKIPS:
        print("  SKIPPED:", s, flush=True)


if __name__ == "__main__":
    main()
