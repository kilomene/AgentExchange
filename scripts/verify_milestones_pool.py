#!/usr/bin/env python3
"""Live E2E for #6 MILESTONES + GUARANTEE POOL (owner pick 2026-10-26).
Seeds an awarded milestone job (founder -> agent 13, $20, 50/50), then
proves through the REAL API: whole-job deliver/complete are refused,
milestone 1 delivers with a matching SHA-256 fingerprint, release 1
pays exactly $9.00 net, milestone 2 (link) completes the set, release 2
finalizes the job (agent stats +$18.00 earnings, +1 job) and funds the
guarantee pool with exactly 10% of the $2.00 fee = $0.20. Then an admin
guarantee payout of $0.15 lands exactly and the pool drops to $0.05;
an over-pool payout is refused. Everything is reversed/deleted and the
floor, wallets and outbox are proven back at baseline. Mailer PAUSEd
throughout; queued rows deleted unsent before unpausing."""
import base64
import hashlib
import hmac
import io
import json
import subprocess
import time
import zipfile
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


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation", "-d", json.dumps(body)]
    return curl(a)


def jwt_for(uid):
    def b64(x):
        return base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    now = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    pay = b64(json.dumps({"sub": uid, "iat": now, "exp": now + 3600}).encode())
    sig = b64(hmac.new(ENV["EXCHANGE_JWT_SECRET"].encode(), f"{head}.{pay}".encode(), hashlib.sha256).digest())
    return f"{head}.{pay}.{sig}"


def api(path, method="GET", body=None, auth=None):
    a = ["-X", method, f"{API}{path}"]
    if auth:
        a += ["-H", auth]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    return curl(a)


def wallet(uid):
    r = json.loads(rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents"))[0]
    return r["balance_cents"], r["held_cents"]


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def pool():
    r = json.loads(rest("ex_settings?key=eq.guarantee_pool_cents&select=value"))
    return int(r[0]["value"]) if r else 0


def sql(stmt):
    f = Path("/tmp/ms_e2e.sql")
    f.write_text(stmt)
    out = subprocess.run(["python3", str(ROOT / "scripts/apply_sql.py"), str(f)], capture_output=True, text=True)
    assert "APPLIED" in out.stdout, out.stdout + out.stderr


def main():
    assert not PAUSE.exists(), "mailer already PAUSEd - aborting"
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    PAUSE.write_text("verify_milestones_pool")
    ts = int(time.time())
    fw0, uw0 = wallet(1), wallet(4)
    ob0 = outbox_state()
    pool0 = pool()
    a13 = json.loads(rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents"))[0]
    notif0 = json.loads(rest("ex_notifications?select=id&order=id.desc&limit=1"))[0]["id"]
    feed0 = json.loads(rest("ex_feed?select=id&order=id.desc&limit=1"))[0]["id"]
    print(f"baseline founder={fw0} user4={uw0} pool={pool0} agent13={a13} outbox={ob0}")
    assert pool0 == 0, "pool not empty at baseline - investigate before running"

    job = json.loads(rest("ex_jobs", method="POST", body={
        "poster_user_id": 1, "poster_agent_id": None, "title": "MS Probe — two stage site build",
        "description": "throwaway milestone probe", "category": "development", "budget_cents": 2000,
        "mode": "bidding", "status": "awarded", "awarded_agent_id": 13, "agreed_cents": 2000,
        "fee_cents": 200, "created_at": ts, "updated_at": ts}))[0]
    jid = job["id"]
    sql(f"select ex_hold_escrow(1, 2000, 'job:{jid}', 'milestone probe escrow', {ts});")
    bid = json.loads(rest("ex_bids", method="POST", body={
        "job_id": jid, "agent_id": 13, "bidder_user_id": 4, "amount_cents": 2000, "eta_hours": 24,
        "pitch": "probe", "status": "accepted", "created_at": ts}))[0]
    ms = []
    for i, (title, pct) in enumerate([("Stage one — draft", 50), ("Stage two — final", 50)]):
        ms.append(json.loads(rest("ex_milestones", method="POST", body={
            "job_id": jid, "idx": i, "title": title, "pct": pct, "amount_cents": 1000, "created_at": ts}))[0])
    m1, m2 = ms[0]["id"], ms[1]["id"]
    print(f"seeded job {jid} milestones {m1},{m2}")

    jwt4 = f"Authorization: Bearer {jwt_for(4)}"
    adm = f"X-API-Key: {ADMIN_KEY}"

    # Guards: whole-job deliver + complete refused on milestone jobs
    r = json.loads(api(f"/jobs/{jid}/action", "POST", {"action": "deliver", "deliverable": "whole job attempt"}, jwt4))
    assert "milestone" in r.get("error", ""), f"deliver guard failed: {r}"
    print("guard OK: whole-job deliver refused")

    # Milestone 1: real ZIP delivery as user 4 (agent 13 owner)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("index.html", "<!doctype html><html><head><title>MS Probe</title></head><body>stage one</body></html>")
        z.writestr("README.md", "Stage one draft. Buyer: replace the title text.")
    zbytes = buf.getvalue()
    zpath = Path("/tmp/ms_stage1.zip")
    zpath.write_bytes(zbytes)
    out = curl(["-X", "POST", f"{API}/jobs/{jid}/milestones/{m1}/deliver", "-H", jwt4,
                "-F", "action=deliver", "-F", "deliverable=Stage one draft attached. Edit: title text.",
                "-F", f"file=@{zpath};type=application/zip"])
    r = json.loads(out)
    m = r.get("milestone", {})
    assert m.get("status") == "delivered", f"m1 deliver failed: {r}"
    want_sha = hashlib.sha256(zbytes).hexdigest()
    assert m.get("delivery_sha256") == want_sha, "fingerprint mismatch"
    assert m.get("delivery_check", {}).get("verdict") == "passed", m.get("delivery_check")
    print("milestone 1 delivered, fingerprint matches, checks passed")

    # Release 1 as founder: user 4 +900 exactly
    r = json.loads(api(f"/jobs/{jid}/milestones/{m1}/release", "POST", {}, adm))
    assert r.get("milestone", {}).get("status") == "released", f"m1 release failed: {r}"
    assert wallet(4) == (uw0[0] + 900, uw0[1]), f"after release1 user4={wallet(4)} want {(uw0[0]+900, uw0[1])}"
    assert pool() == 0, "pool must not fund before finalize"
    print("release 1 paid exactly $9.00 net")

    # Milestone 2: link delivery, job flips to delivered
    r = json.loads(api(f"/jobs/{jid}/milestones/{m2}/deliver", "POST",
                       {"deliverable": "Final files in the shared folder. Edit: swap in your domain.", "link": "https://example.com/ms-final"}, jwt4))
    assert r.get("milestone", {}).get("status") == "delivered", f"m2 deliver failed: {r}"
    jj = json.loads(rest(f"ex_jobs?id=eq.{jid}&select=status"))[0]
    assert jj["status"] == "delivered", f"job should flip delivered: {jj}"
    # Now that the job is delivered, a whole-job complete must hit the
    # milestone guard inside completeJob (not the status dispatcher).
    r = json.loads(api(f"/jobs/{jid}/action", "POST", {"action": "complete"}, adm))
    assert "milestone" in r.get("error", ""), f"complete guard failed: {r}"
    print("guard OK: whole-job complete refused on delivered milestone job")

    # Release 2: finalize
    r = json.loads(api(f"/jobs/{jid}/milestones/{m2}/release", "POST", {}, adm))
    assert r.get("milestone", {}).get("status") == "released", f"m2 release failed: {r}"
    assert wallet(4) == (uw0[0] + 1800, uw0[1]), f"after release2 user4={wallet(4)}"
    # The poster PAID the $20: balance drops by the agreed price, the
    # held escrow is fully consumed (baseline held restored).
    assert wallet(1) == (fw0[0] - 2000, fw0[1]), f"founder after paying: {wallet(1)} vs {(fw0[0]-2000, fw0[1])}"
    jj = json.loads(rest(f"ex_jobs?id=eq.{jid}&select=status"))[0]
    assert jj["status"] == "completed", jj
    a13n = json.loads(rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents"))[0]
    assert a13n["jobs_completed"] == a13["jobs_completed"] + 1 and a13n["earnings_cents"] == a13["earnings_cents"] + 1800, a13n
    assert pool() == 20, f"pool should hold 20 cents, holds {pool()}"
    print("release 2 finalized: job completed, stats +$18.00/+1 job, pool = $0.20")

    # Guarantee pool: admin pays $0.15 to user 4
    r = json.loads(api("/admin/guarantee/pay", "POST", {"user_id": 4, "amount": 0.15, "reason": "e2e pool check", "job_id": jid}, adm))
    assert r.get("claim", {}).get("amount_cents") == 15, f"guarantee pay failed: {r}"
    assert pool() == 5 and wallet(4) == (uw0[0] + 1815, uw0[1]), (pool(), wallet(4))
    r = json.loads(api("/admin/guarantee/pay", "POST", {"user_id": 4, "amount": 0.10, "reason": "over pool"}, adm))
    assert "pool" in r.get("error", ""), f"over-pool must refuse: {r}"
    g = json.loads(api("/admin/guarantee", "GET", None, adm))
    assert g["pool_cents"] == 5 and len(g["claims"]) >= 1, g
    print("guarantee payout exact; over-pool refused; admin view OK")

    # ---- cleanup: reverse every cent, delete every row ----
    sql(f"select ex_move_balance(4, -1815, 'reversal', 'job:{jid}', 'milestone e2e cleanup', {int(time.time())});")
    sql(f"select ex_move_balance(1, 2000, 'reversal', 'job:{jid}', 'milestone e2e cleanup - poster spend restored', {int(time.time())});")
    rest("ex_settings?key=eq.guarantee_pool_cents", method="PATCH", body={"value": "0"})
    rest("ex_agents?id=eq.13", method="PATCH", body={"jobs_completed": a13["jobs_completed"], "earnings_cents": a13["earnings_cents"]})
    rest(f"ex_guarantee_claims?job_id=eq.{jid}", method="DELETE")
    rest(f"ex_milestones?job_id=eq.{jid}", method="DELETE")
    rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
    rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
    rest(f"ex_notifications?id=gt.{notif0}", method="DELETE")
    rest(f"ex_feed?id=gt.{feed0}", method="DELETE")
    rest(f"ex_outbox?id=gt.{ob0[0]}", method="DELETE")
    PAUSE.unlink()
    assert wallet(1) == fw0 and wallet(4) == uw0 and pool() == 0 and outbox_state() == ob0, (wallet(1), wallet(4), pool(), outbox_state())
    a13f = json.loads(rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents"))[0]
    assert a13f == a13, a13f
    print("CLEANUP VERIFIED: wallets, pool, outbox, agent stats all at baseline")
    print("MILESTONES + GUARANTEE POOL E2E: ALL PASS")


if __name__ == "__main__":
    main()
