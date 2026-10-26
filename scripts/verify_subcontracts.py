#!/usr/bin/env python3
"""Live E2E for #1 AGENTS HIRING AGENTS (owner pick 2026-10-26).
Seeds an awarded parent job (founder -> throwaway hirer agent owned by
user 4, agreed $20) and proves through the REAL agent API: offer with
cap enforcement, worker accept holds exactly $1.00 from the hirer
owner's wallet, wrong-party deliver/complete are refused, delivery is
fingerprinted, completion pays the worker owner exactly $0.90 net and
funds the pool $0.01, and a second subcontract's dispute resolves for
the hirer with an exact escrow refund. Everything is reversed/deleted;
wallets, pool and outbox proven back at baseline. Mailer PAUSEd."""
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
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation", "-d", json.dumps(body)]
    return curl(a)


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
    return int(json.loads(rest("ex_settings?key=eq.guarantee_pool_cents&select=value"))[0]["value"])


def sql(stmt):
    f = Path("/tmp/sub_e2e.sql")
    f.write_text(stmt)
    out = subprocess.run(["python3", str(ROOT / "scripts/apply_sql.py"), str(f)], capture_output=True, text=True)
    assert "APPLIED" in out.stdout, out.stdout + out.stderr


def seed_agent(owner_id, name, key, ts):
    return json.loads(rest("ex_agents", method="POST", body={
        "owner_id": owner_id, "name": name, "category": "development", "skills": "testing",
        "tagline": "", "description": "", "rate_cents": 5000, "status": "active",
        "api_key_hash": hashlib.sha256(key.encode()).hexdigest(),
        "jobs_completed": 5, "created_at": ts}))[0]


def main():
    assert not PAUSE.exists(), "mailer already PAUSEd - aborting"
    PAUSE.parent.mkdir(parents=True, exist_ok=True)
    PAUSE.write_text("verify_subcontracts")
    ts = int(time.time())
    fw0, uw0 = wallet(1), wallet(4)
    ob0 = outbox_state()
    notif0 = json.loads(rest("ex_notifications?select=id&order=id.desc&limit=1"))[0]["id"]
    feed0 = json.loads(rest("ex_feed?select=id&order=id.desc&limit=1"))[0]["id"]
    print(f"baseline founder={fw0} user4={uw0} outbox={ob0} pool={pool()}")
    assert pool() == 0

    hirer_key, worker_key = f"hirer-{ts}", f"worker-{ts}"
    hirer = seed_agent(4, "SubHirerProbe", hirer_key, ts)
    wowner = json.loads(rest("ex_users", method="POST", body={
        "email": f"subworker{ts}@example.org", "password_hash": "probe-only",
        "name": "Sub Worker Owner", "avatar": "", "created_at": ts}))[0]
    rest("ex_wallets", method="POST", body={"user_id": wowner["id"], "balance_cents": 0, "held_cents": 0})
    worker = seed_agent(wowner["id"], "SubWorkerProbe", worker_key, ts)
    HK, WK = f"X-Agent-Key: {hirer_key}", f"X-Agent-Key: {worker_key}"
    print(f"hirer agent {hirer['id']} (owner 4), worker agent {worker['id']} (owner {wowner['id']})")

    job = json.loads(rest("ex_jobs", method="POST", body={
        "poster_user_id": 1, "poster_agent_id": None, "title": "SUB Probe — parent build",
        "description": "throwaway subcontract probe", "category": "development", "budget_cents": 2000,
        "mode": "bidding", "status": "awarded", "awarded_agent_id": hirer["id"], "agreed_cents": 2000,
        "fee_cents": 200, "created_at": ts, "updated_at": ts}))[0]
    jid = job["id"]
    sql(f"select ex_hold_escrow(1, 2000, 'job:{jid}', 'subcontract probe escrow', {ts});")
    rest("ex_bids", method="POST", body={
        "job_id": jid, "agent_id": hirer["id"], "bidder_user_id": 4, "amount_cents": 2000,
        "eta_hours": 24, "pitch": "probe", "status": "accepted", "created_at": ts})

    # Offer $1.00 to the worker
    r = json.loads(api(f"/agent/jobs/{jid}/subcontracts", "POST",
                       {"worker_agent_id": worker["id"], "amount_cents": 100, "brief": "Build the settings page"}, HK))
    sub = r.get("subcontract", {})
    assert sub.get("status") == "offered", f"offer failed: {r}"
    sid = sub["id"]
    # Cap: another $19.50 would exceed the $20 agreed price
    r = json.loads(api(f"/agent/jobs/{jid}/subcontracts", "POST",
                       {"worker_agent_id": worker["id"], "amount_cents": 1950, "brief": "Too much work"}, HK))
    assert "exceed" in r.get("error", ""), f"cap failed: {r}"
    print("offer created; over-cap offer refused")

    # Worker accepts -> $1.00 held from user 4 (hirer owner)
    r = json.loads(api(f"/agent/subcontracts/{sid}/accept", "POST", {}, WK))
    assert r.get("subcontract", {}).get("status") == "accepted", f"accept failed: {r}"
    assert wallet(4) == (uw0[0] - 100, uw0[1] + 100), f"hold wrong: {wallet(4)} vs {(uw0[0]-100, uw0[1]+100)}"
    print("accept held exactly $1.00 from the hirer owner's wallet")

    # Wrong-party deliver (hirer) refused; worker delivers a file
    fpath = Path("/tmp/sub_part.txt")
    fpath.write_text("settings page code - buyer: wire your own routes")
    out = curl(["-X", "POST", f"{API}/agent/subcontracts/{sid}/deliver", "-H", HK,
                "-F", "deliverable=hirer should not deliver", "-F", f"file=@{fpath}"])
    assert "only the subcontract worker" in out, f"hirer deliver not refused: {out}"
    out = curl(["-X", "POST", f"{API}/agent/subcontracts/{sid}/deliver", "-H", WK,
                "-F", "deliverable=Settings page attached. Edit: wire your own routes.",
                "-F", f"file=@{fpath}"])
    r = json.loads(out)
    assert r.get("subcontract", {}).get("status") == "delivered", f"deliver failed: {r}"
    want = hashlib.sha256(fpath.read_bytes()).hexdigest()
    assert r["subcontract"]["delivery_sha256"] == want, "fingerprint mismatch"
    print("worker delivery fingerprinted; hirer deliver refused")

    # Wrong-party complete (worker) refused; hirer completes -> +$0.90
    r = json.loads(api(f"/agent/subcontracts/{sid}/complete", "POST", {}, WK))
    assert "only the hiring agent" in r.get("error", ""), f"worker complete not refused: {r}"
    r = json.loads(api(f"/agent/subcontracts/{sid}/complete", "POST", {}, HK))
    assert r.get("subcontract", {}).get("status") == "completed", f"complete failed: {r}"
    assert wallet(wowner["id"]) == (90, 0), f"worker owner wallet: {wallet(wowner['id'])}"
    # The hirer PAID the $1.00 from his own wallet (his pay for the
    # parent job comes from the founder when the parent completes).
    assert wallet(4) == (uw0[0] - 100, uw0[1]), f"hirer owner after completion: {wallet(4)} vs {(uw0[0]-100, uw0[1])}"
    assert pool() == 1, f"pool should hold 1 cent, holds {pool()}"
    wst = json.loads(rest(f"ex_agents?id=eq.{worker['id']}&select=jobs_completed,earnings_cents"))[0]
    assert wst == {"jobs_completed": 6, "earnings_cents": 90}, wst
    print("completion paid exactly $0.90 net; pool +$0.01; worker stats updated")

    # Second subcontract: dispute resolves for the hirer, escrow refunds
    r = json.loads(api(f"/agent/jobs/{jid}/subcontracts", "POST",
                       {"worker_agent_id": worker["id"], "amount_cents": 100, "brief": "Build the billing page"}, HK))
    sid2 = r["subcontract"]["id"]
    json.loads(api(f"/agent/subcontracts/{sid2}/accept", "POST", {}, WK))
    assert wallet(4) == (uw0[0] - 200, uw0[1] + 100), wallet(4)
    r = json.loads(api(f"/agent/subcontracts/{sid2}/deliver", "POST",
                       {"deliverable": "Billing page in the shared folder.", "link": "https://example.com/billing"}, WK))
    assert r.get("subcontract", {}).get("status") == "delivered", r
    r = json.loads(api(f"/agent/subcontracts/{sid2}/dispute", "POST", {"reason": "Wrong pages delivered"}, WK))
    assert r.get("subcontract", {}).get("status") == "disputed", r
    r = json.loads(api(f"/admin/subcontracts/{sid2}/resolve", "POST", {"resolution": "hirer"}, f"X-API-Key: {ADMIN_KEY}"))
    assert r.get("ok"), f"resolve failed: {r}"
    assert wallet(4) == (uw0[0] - 100, uw0[1]), f"after dispute refund: {wallet(4)} vs {(uw0[0]-100, uw0[1])}"
    print("dispute resolved for hirer; escrow refunded exactly")

    # Chain shows on the public job view
    jv = json.loads(curl([f"{API}/jobs/{jid}"]))
    subs = jv.get("job", {}).get("subcontracts", [])
    assert len(subs) == 2 and subs[0]["worker_name"] == "SubWorkerProbe", f"chain missing: {[s.get('status') for s in subs]}"
    print("work chain visible on the job page data")

    # ---- cleanup ----
    sql(f"select ex_move_balance({wowner['id']}, -90, 'reversal', 'sub:{sid}', 'subcontract e2e cleanup', {int(time.time())});")
    sql(f"select ex_move_balance(4, 100, 'reversal', 'sub:{sid}', 'subcontract e2e cleanup - hirer spend restored', {int(time.time())});")
    sql(f"select ex_refund_escrow(1, 2000, 'job:{jid}', 'subcontract e2e cleanup', {int(time.time())});")
    rest("ex_settings?key=eq.guarantee_pool_cents", method="PATCH", body={"value": "0"})
    rest(f"ex_subcontracts?job_id=eq.{jid}", method="DELETE")
    rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
    rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
    rest(f"ex_agents?id=eq.{hirer['id']}", method="DELETE")
    rest(f"ex_agents?id=eq.{worker['id']}", method="DELETE")
    rest(f"ex_wallets?user_id=eq.{wowner['id']}", method="DELETE")
    rest(f"ex_users?id=eq.{wowner['id']}", method="DELETE")
    rest(f"ex_notifications?id=gt.{notif0}", method="DELETE")
    rest(f"ex_feed?id=gt.{feed0}", method="DELETE")
    rest(f"ex_outbox?id=gt.{ob0[0]}", method="DELETE")
    PAUSE.unlink()
    assert wallet(1) == fw0 and wallet(4) == uw0 and pool() == 0 and outbox_state() == ob0, (wallet(1), wallet(4), pool(), outbox_state())
    print("CLEANUP VERIFIED: wallets, pool, outbox all at baseline")
    print("SUBCONTRACTS E2E: ALL PASS")


if __name__ == "__main__":
    main()
