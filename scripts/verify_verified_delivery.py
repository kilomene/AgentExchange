#!/usr/bin/env python3
"""Live E2E for #4 VERIFIED DELIVERY (owner pick 2026-10-26).
Runs a full synthetic cycle on a throwaway job (poster=founder 1,
worker=agent 13 / owner 4): DB-seeded award + escrow hold, REAL API
delivery of a real ZIP, fingerprint + checks asserted, evidence pack
asserted, completion asserted to the cent, then EVERYTHING reversed
(balances, agent stats, rows) and the mail queue proven untouched.
The mailer is PAUSEd for the whole run and any rows queued inside the
window are deleted before the pause is lifted - zero real email."""
import base64
import hashlib
import hmac as hmac_mod
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
JWT_SECRET = ENV["EXCHANGE_JWT_SECRET"]
REST = "https://xjpfyqzqqjeejrxzafth.supabase.co/rest/v1"
API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
AMOUNT, FEE = 1500, 150


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation",
              "-d", json.dumps(body)]
    return curl(a)


def sql(stmt):
    f = Path("/tmp/verify_vd.sql")
    f.write_text(stmt)
    r = subprocess.run(["python3", str(ROOT / "scripts/apply_sql.py"), str(f)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def jwt_for(uid):
    def b64(x):
        return base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    now_s = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    pay = b64(json.dumps({"sub": uid, "iat": now_s, "exp": now_s + 3600}).encode())
    sig = b64(hmac_mod.new(JWT_SECRET.encode(), f"{head}.{pay}".encode(), hashlib.sha256).digest())
    return f"{head}.{pay}.{sig}"


def wallet(uid):
    rows = json.loads(rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents"))
    return rows[0]["balance_cents"], rows[0]["held_cents"]


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def main():
    assert not PAUSE.exists(), "PAUSE already present - someone else paused the mailer; stop"
    PAUSE.write_text("verify_verified_delivery\n")
    time.sleep(6)
    T0 = int(time.time()) - 5
    job_id = bid_id = None
    w1_0, w4_0 = wallet(1), wallet(4)
    ob0 = outbox_state()
    ag0 = json.loads(rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents"))[0]
    print(f"baseline wallets: founder {w1_0} user4 {w4_0} outbox {ob0} agent13 {ag0}")
    try:
        now_s = int(time.time())
        job = json.loads(rest("ex_jobs", method="POST", body={
            "poster_user_id": 1, "title": "VERIFY verified delivery (throwaway)",
            "description": "Throwaway verification job. Deliverable: a zip.",
            "category": "development", "mode": "bidding", "budget_cents": AMOUNT,
            "status": "awarded", "awarded_agent_id": 13, "agreed_cents": AMOUNT,
            "fee_cents": FEE, "work_deadline": now_s + 86400,
            "created_at": now_s, "updated_at": now_s}))[0]
        job_id = job["id"]
        bid = json.loads(rest("ex_bids", method="POST", body={
            "job_id": job_id, "agent_id": 13, "bidder_user_id": 4,
            "amount_cents": AMOUNT, "eta_hours": 24, "pitch": "verify",
            "status": "accepted", "created_at": now_s}))[0]
        bid_id = bid["id"]
        rest(f"ex_jobs?id=eq.{job_id}", method="PATCH", body={"awarded_bid_id": bid_id})
        sql(f"select ex_hold_escrow(1, {AMOUNT}, 'job:{job_id}', 'verify hold', {now_s});")
        print("seeded awarded job", job_id, "escrow held")

        # real ZIP delivery through the real API as user 4 (worker owner)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("index.html", "<!doctype html><html><head><title>Verify</title></head><body>ok</body></html>")
            z.writestr("README.md", "# Verify delivery\nOpen index.html. Replace nothing.")
        zip_bytes = buf.getvalue()
        sha = hashlib.sha256(zip_bytes).hexdigest()
        Path("/tmp/verify_delivery.zip").write_bytes(zip_bytes)
        out = curl(["-X", "POST", f"{API}/jobs/{job_id}/action",
                    "-H", f"Authorization: Bearer {jwt_for(4)}",
                    "-F", "action=deliver",
                    "-F", "deliverable=ZIP with index.html and README - open index.html, replace nothing.",
                    "-F", f"file=@/tmp/verify_delivery.zip;type=application/zip"])
        resp = json.loads(out)
        gjob = resp.get("job", {})
        print("deliver resp status:", gjob.get("status"), "sha:", (gjob.get("delivery_sha256") or "")[:16])
        assert gjob.get("status") == "delivered", out[:400]
        assert gjob.get("delivery_sha256") == sha, "fingerprint mismatch"
        chk = gjob.get("delivery_check") or {}
        print("check verdict:", chk.get("verdict"), "| checks:", [c["name"] for c in chk.get("checks", [])])
        assert chk.get("verdict") == "passed", chk
        assert any("index.html" in c["detail"] for c in chk["checks"] if c["name"] == "zip contents")

        # evidence pack as the poster (founder admin key)
        ev = json.loads(curl([f"{API}/jobs/{job_id}/evidence", "-H", f"X-API-Key: {ADMIN_KEY}"]))
        evd = ev.get("evidence", {})
        assert evd.get("delivery", {}).get("sha256_fingerprint") == sha, evd.get("delivery")
        assert evd.get("job", {}).get("status") == "delivered"
        print("evidence pack OK: bids", len(evd.get("bids", [])), "| agent", evd.get("awarded_agent", {}).get("name"))

        # complete as poster; money must land to the cent
        out = curl(["-X", "POST", f"{API}/jobs/{job_id}/action",
                    "-H", f"X-API-Key: {ADMIN_KEY}", "-H", "Content-Type: application/json",
                    "-d", json.dumps({"action": "complete"})])
        assert json.loads(out).get("job", {}).get("status") == "completed", out[:300]
        w4_1 = wallet(4)
        assert w4_1[0] == w4_0[0] + (AMOUNT - FEE), (w4_0, w4_1)
        print(f"completion paid exactly: user4 {w4_0[0]} -> {w4_1[0]}")
        print("PASS: verified delivery E2E")
    finally:
        # reverse money + stats, delete every created row, prove baseline
        now_s = int(time.time())
        try:
            sql(f"select ex_move_balance(4, -{AMOUNT - FEE}, 'test_reversal', 'verify:vd', 'reverse verify payout', {now_s});")
            sql(f"select ex_move_balance(1, {AMOUNT}, 'test_reversal', 'verify:vd', 'reverse verify hold', {now_s});")
        except Exception as e:
            print("money reversal note:", e)
        if job_id:
            rest(f"ex_jobs?id=eq.{job_id}", method="DELETE")
        if bid_id:
            rest(f"ex_bids?id=eq.{bid_id}", method="DELETE")
        for n in json.loads(rest(f"ex_notifications?created_at=gte.{T0}&select=id")):
            rest(f"ex_notifications?id=eq.{n['id']}", method="DELETE")
        for fd in json.loads(rest(f"ex_feed?created_at=gte.{T0}&select=id")):
            rest(f"ex_feed?id=eq.{fd['id']}", method="DELETE")
        for ob in json.loads(rest(f"ex_outbox?created_at=gte.{T0}&select=id")):
            rest(f"ex_outbox?id=eq.{ob['id']}", method="DELETE")
            print("deleted queued mail row", ob["id"], "(never sent - mailer paused)")
        ag = json.loads(rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents"))[0]
        if ag != ag0:
            rest("ex_agents?id=eq.13", method="PATCH",
                 body={"jobs_completed": ag0["jobs_completed"], "earnings_cents": ag0["earnings_cents"]})
        # ledger reversal rows from ex_move_balance stay as honest audit; wallet totals must match baseline
        w1_1, w4_1 = wallet(1), wallet(4)
        ob1 = outbox_state()
        print(f"restored wallets: founder {w1_1} user4 {w4_1} outbox {ob1}")
        assert w1_1 == w1_0 and w4_1 == w4_0, (w1_0, w1_1, w4_0, w4_1)
        assert ob1 == ob0, (ob0, ob1)
        PAUSE.unlink()
        print("mailer unpaused; state fully restored")


if __name__ == "__main__":
    main()
