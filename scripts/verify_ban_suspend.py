#!/usr/bin/env python3
"""Live E2E for the SUSPEND vs BAN separation (owner order 2026-10-28).

Root cause being pinned: the admin suspend path used to ALSO insert the
account's IPs into ex_banned_ips, and nothing ever removed them — an
unsuspended account stayed locked out at login with "this connection
is banned" (owner's own test account 355 hit exactly this).

Covers, against the LIVE deployed function + live sweeper:
  a. suspend A -> login "account suspended"; NO ex_banned_ips row is
     created by a suspension; unsuspend A -> login SUCCEEDS (the bug).
  b. ban B -> B's IPs join ex_banned_ips (source_user_id=B), banned
     flag/at/reason set, user_ban audit row; B login -> "account
     banned"; B's JWT and personal API key both die (401); connection
     attempts from the learned presented IP P1 (B's last_ip) are fired
     repeatedly — a success presenting P1 would FAIL the suite, a 403
     "this connection is banned" is positive proof (the sandbox egress
     rotates source addresses per request, so presenting exactly P1 is
     probabilistic — the outcome is recorded either way); register
     attempts from this connection are refused.
  c. the live sweeper's altScan BANS D (banned=true, alt ban_reason,
     D's IPs join ex_banned_ips) because D shares B's IPs.
  d. admin-unban B -> flag cleared, B-sourced blacklist rows deleted,
     user_unban audit row; D stays banned (no cascade); B logs in.
House style (mirrors verify_fairness_autorelease.py): mailer PAUSEd
throughout, throwaway users seeded via service-role REST with real
pbkdf2 password hashes (real /auth/login calls), every artifact
cleaned in finally, baselines for ex_users / ex_wallets / ex_ledger /
ex_outbox / ex_banned_ips asserted restored (foreign live activity, if
any, must fully explain any delta)."""
import hashlib
import json
import os
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
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
TEST_IP = "203.0.113.231"   # TEST-NET-3: B's + D's shared seeded address
A_IP = "198.51.100.77"      # TEST-NET-2: A's own seeded address
CHECKS = 0
NOTES = []


def ok(cond, label, extra=""):
    global CHECKS
    CHECKS += 1
    assert cond, f"FAIL: {label} {extra}"
    print(f"  ok {CHECKS}: {label}")


def note(msg):
    NOTES.append(msg)
    print(f"  note: {msg}")


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation",
              "-d", json.dumps(body)]
    out = curl(a)
    return json.loads(out) if out.strip() else []


def api(method, path, jwt=None, api_key=None, body=None):
    a = ["-X", method, f"{API}{path}", "-w", "\n%{http_code}"]
    if jwt:
        a += ["-H", f"Authorization: Bearer {jwt}"]
    if api_key:
        a += ["-H", f"X-API-Key: {api_key}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    raw = curl(a)
    text, _, code = raw.rpartition("\n")
    try:
        parsed = json.loads(text) if text.strip() else {}
    except Exception:
        parsed = {"raw": text}
    return int(code), parsed


def jwt_for(uid):
    import base64
    import hmac as hmac_mod
    def b64(x):
        return base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    now_s = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    pay = b64(json.dumps({"sub": uid, "iat": now_s, "exp": now_s + 3600}).encode())
    sig = b64(hmac_mod.new(ENV["EXCHANGE_JWT_SECRET"].encode(), f"{head}.{pay}".encode(), hashlib.sha256).digest())
    return f"{head}.{pay}.{sig}"


def pw_hash(password):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000)
    return f"pbkdf2${salt.hex()}${dk.hex()}"


def seed_user(tag, ip):
    now_s = int(time.time())
    email = f"verify-ban-{tag}@verify.invalid"
    password = f"verify-{tag}-pass-123"
    u = rest("ex_users", method="POST", body={
        "email": email, "password_hash": pw_hash(password),
        "name": f"VERIFY BanSuspend {tag.upper()}", "avatar": "", "role": "user",
        "created_at": now_s, "email_verified": True, "password_changed_at": 0,
        "signup_ip": ip, "last_ip": ip})[0]
    rest("ex_wallets", method="POST", body={"user_id": u["id"]})
    return {"id": u["id"], "email": email, "password": password}


def login(user):
    return api("POST", "/auth/login", body={"email": user["email"], "password": user["password"]})


def user_row(uid):
    rows = rest(f"ex_users?id=eq.{uid}&select=*")
    return rows[0] if rows else None


def banned_rows(**kw):
    f = "&".join(f"{k}=eq.{v}" for k, v in kw.items())
    return rest(f"ex_banned_ips?{f}&select=*&order=created_at.asc") if f else rest("ex_banned_ips?select=*&order=created_at.asc")


def outbox_state():
    rows = rest("ex_outbox?select=id&order=id.desc&limit=1")
    cnt = rest("ex_outbox?select=id")
    return (rows[0]["id"] if rows else 0), len(cnt)


def err_of(r):
    return str(r.get("error") or r.get("message") or "")


def main():
    assert not PAUSE.exists(), "PAUSE already present - someone else paused the mailer; stop"
    PAUSE.write_text("verify_ban_suspend\n")
    time.sleep(6)
    T0 = int(time.time()) - 5
    test_ids = []
    collateral_snapshot = []
    reg_user_id = None
    try:
        # ---------- baselines ----------
        users0 = len(rest("ex_users?select=id"))
        wallets0 = len(rest("ex_wallets?select=user_id"))
        ledger0 = len(rest("ex_ledger?select=id"))
        ob0 = outbox_state()
        banned0 = banned_rows()
        notif0 = rest("ex_notifications?select=id&order=id.desc&limit=1")
        notif_max0 = notif0[0]["id"] if notif0 else 0
        audit0 = rest("ex_admin_audit?select=id&order=id.desc&limit=1")
        audit_max0 = audit0[0]["id"] if audit0 else 0
        w1_0 = rest("ex_wallets?user_id=eq.1&select=balance_cents,held_cents")[0]
        print(f"baseline: users {users0} wallets {wallets0} ledger {ledger0} outbox {ob0} "
              f"banned_ips {len(banned0)} notif_max {notif_max0} audit_max {audit_max0}")

        A = seed_user("a", A_IP)
        B = seed_user("b", TEST_IP)
        D = seed_user("d", TEST_IP)
        test_ids = [A["id"], B["id"], D["id"]]
        print(f"seeded throwaway users A={A['id']} B={B['id']} D={D['id']}")

        # ---------- a. suspend is account-only; unsuspend restores fully ----------
        print("== a. suspend / unsuspend ==")
        code, r = login(A)
        ok(code == 200 and r.get("token"), "A baseline login succeeds", f"{code} {str(r)[:160]}")
        code, r = api("PUT", f"/admin/users/{A['id']}", api_key=ADMIN_KEY, body={"suspended": True})
        ok(code == 200, "admin suspends A", f"{code} {str(r)[:160]}")
        a = user_row(A["id"])
        ok(a["suspended"] is True and a["banned"] is False, "A is suspended, not banned")
        ok(not banned_rows(source_user_id=A["id"]), "suspension created NO ex_banned_ips row for A")
        ok(not [x for x in banned_rows() if x["ip"] == A_IP], "A's IP is not blacklisted by the suspension")
        code, r = login(A)
        ok(code == 403 and err_of(r) == "account suspended", "A login refused while suspended", f"{code} {str(r)[:160]}")
        code, r = api("PUT", f"/admin/users/{A['id']}", api_key=ADMIN_KEY, body={"suspended": False})
        ok(code == 200, "admin unsuspends A", f"{code} {str(r)[:160]}")
        code, r = login(A)
        ok(code == 200 and r.get("token"), "A login SUCCEEDS after unsuspend (the owner's bug, pinned)", f"{code} {str(r)[:160]}")
        code, r = api("GET", "/auth/me", jwt=jwt_for(A["id"]))
        ok(code == 200, "A /auth/me works after unsuspend", f"{code} {str(r)[:160]}")

        # ---------- b. ban: account + connection ----------
        print("== b. ban ==")
        code, r = login(B)
        ok(code == 200 and r.get("token"), "B baseline login succeeds", f"{code} {str(r)[:160]}")
        b_api_key = r.get("api_key")
        ok(bool(b_api_key), "B received its personal API key at first login")
        code, r = login(D)
        ok(code == 200 and r.get("token"), "D baseline login succeeds", f"{code} {str(r)[:160]}")
        p1 = user_row(D["id"])["last_ip"]
        note(f"connection address presented by this sandbox (learned from D's login): {p1}")
        # B and D are both tied to TEST_IP; B was also last seen from P1,
        # the same connection D just used. A's addresses are moved back
        # to its own so the alt scan can never touch it via the pool.
        rest(f"ex_users?id=eq.{B['id']}", method="PATCH", body={"signup_ip": TEST_IP, "last_ip": p1})
        rest(f"ex_users?id=eq.{D['id']}", method="PATCH", body={"signup_ip": TEST_IP, "last_ip": TEST_IP})
        rest(f"ex_users?id=eq.{A['id']}", method="PATCH", body={"signup_ip": A_IP, "last_ip": A_IP})
        # collateral guard: no foreign account may be tied to the test IPs
        foreign = [u for u in rest(f"ex_users?or=(signup_ip.eq.{TEST_IP},last_ip.eq.{TEST_IP},signup_ip.eq.{p1},last_ip.eq.{p1})&select=id,banned,banned_at,ban_reason")
                   if u["id"] not in test_ids]
        for u in foreign:
            collateral_snapshot.append(u)
        note(f"foreign accounts tied to test IPs (snapshotted for restore): {[u['id'] for u in foreign]}")
        code, r = api("PUT", f"/admin/users/{B['id']}", api_key=ADMIN_KEY,
                      body={"banned": True, "ban_reason": "verify ban-suspend e2e"})
        ok(code == 200, "admin bans B", f"{code} {str(r)[:160]}")
        b = user_row(B["id"])
        ok(b["banned"] is True and b["banned_at"] and b["ban_reason"] == "verify ban-suspend e2e",
           "B carries banned/banned_at/ban_reason", str({k: b[k] for k in ("banned", "banned_at", "ban_reason")}))
        rows_b = banned_rows(source_user_id=B["id"])
        ips_b = sorted(x["ip"] for x in rows_b)
        ok(ips_b == sorted([TEST_IP, p1]) and all(x["reason"] == f"account {B['id']} banned" for x in rows_b),
           "ex_banned_ips gained B's IPs with source_user_id=B", str(rows_b))
        audits = rest(f"ex_admin_audit?id=gt.{audit_max0}&action=eq.user_ban&target_user_id=eq.{B['id']}&select=id,action")
        ok(len(audits) == 1, "user_ban audit row written for B")
        # B's last_ip (P1) is itself blacklisted now, so an attempt
        # that happens to present P1 is refused at the connection
        # check first — also correct; retry until the account-level
        # refusal is the one observed.
        seen_msgs = []
        for _ in range(4):
            code, r = login(B)
            seen_msgs.append(err_of(r))
            if err_of(r) == "account banned":
                break
            time.sleep(2)
        ok(code == 403 and "account banned" in seen_msgs,
           "B login refused: account banned", f"{code} attempts={seen_msgs}")
        code, r = api("GET", "/auth/me", jwt=jwt_for(B["id"]))
        ok(code == 401, "B's JWT auth is dead after ban", f"{code} {str(r)[:160]}")
        code, r = api("GET", "/auth/me", api_key=b_api_key)
        ok(code == 401, "B's personal API key is dead after ban", f"{code} {str(r)[:160]}")
        # Connection-level attempts: fire D logins + public reads; the
        # sandbox egress rotates the presented address per request, so
        # presenting exactly a blacklisted address (TEST_IP is seeded,
        # P1 was real) is probabilistic. A SUCCESS presenting P1 fails
        # the suite; a 403 is positive proof; neither is recorded.
        presented, refused, succeeded = {}, 0, 0
        for i in range(12):
            code, r = login(D)
            lip = user_row(D["id"])["last_ip"] if code == 200 else None
            if code == 200:
                succeeded += 1
                presented[lip] = presented.get(lip, 0) + 1
                ok(lip not in (TEST_IP, p1), "no login ever succeeds FROM a blacklisted address", f"presented {lip}")
            elif code == 403 and err_of(r) == "this connection is banned":
                refused += 1
            elif code == 403 and err_of(r) == "account banned":
                note(f"D login attempt {i}: the sweeper's alt ban landed mid-loop (expected)")
            else:
                note(f"D login attempt {i}: unexpected {code} {str(r)[:120]} (rate limit or rotation)")
            time.sleep(6)
        note(f"connection attempts: {succeeded} succeeded, {refused} refused as banned; "
             f"distinct presented addresses: {sorted(presented)}; blacklisted: {[TEST_IP, p1]}")
        if refused:
            ok(True, "connection refusal observed live (403 'this connection is banned')")
        else:
            note("connection refusal NOT observed live: no attempt presented a blacklisted "
                 "address (sandbox egress rotates source addresses per request). The refusal "
                 "code path is the same ex_banned_ips lookup proven at data level above and "
                 "organically in production (user 355's lockout); treat as NOT PROVEN here.")
        # register from this connection must be refused (blacklist, or
        # the fail-closed hosting/proxy signup rules for this egress)
        code, r = api("POST", "/auth/register", body={
            "email": "verify-ban-reg@verify.invalid", "name": "VERIFY BanSuspend Reg",
            "password": "verify-reg-pass-123"})
        if code == 201:
            reg_user_id = r.get("user", {}).get("id")
            note(f"register attempt unexpectedly succeeded (user {reg_user_id}) - will clean up")
        ok(code != 201, "registration from the test connection is refused", f"{code} {str(r)[:200]}")
        note(f"register refusal was: {code} {err_of(r)!r}")
        # admin traffic still works while the blacklist is populated
        code, r = api("GET", "/admin/users", api_key=ADMIN_KEY)
        ok(code == 200, "admin API works with the blacklist populated", f"{code}")
        rest(f"ex_users?id=eq.{D['id']}", method="PATCH", body={"signup_ip": TEST_IP, "last_ip": TEST_IP})

        # ---------- c. sweeper altScan bans the alt ----------
        print("== c. sweeper altScan ==")
        deadline = time.time() + 240
        d = user_row(D["id"])
        while not d["banned"] and time.time() < deadline:
            time.sleep(10)
            d = user_row(D["id"])
        ok(d["banned"] is True, "sweeper altScan banned D", str({k: d[k] for k in ("banned", "banned_at", "ban_reason")}))
        ok(str(d["ban_reason"]).startswith("alt account of a banned user"),
           "D's ban_reason names the alt match", str(d["ban_reason"]))
        rows_d = banned_rows(source_user_id=D["id"])
        all_ips = {x["ip"] for x in banned_rows()}
        # ex_banned_ips is keyed by ip and the sweeper inserts with
        # ignore-duplicates: D's addresses may already sit in the
        # table sourced from B (same rows, same effect), in which
        # case the scan adds no D-sourced row. What must hold: every
        # address tied to D is blacklisted once D is banned. (When
        # the scan catches D with a fresh last_ip, a D-sourced row
        # for that address appears as well — observed in run 1.)
        d_now = user_row(D["id"])
        d_ips = {d_now["signup_ip"], d_now["last_ip"]}
        ok(d_ips <= all_ips,
           "all of D's IPs are in ex_banned_ips after the alt ban",
           f"d_ips={sorted(d_ips)} source_d={rows_d} all={sorted(all_ips)}")
        a = user_row(A["id"])
        ok(a["banned"] is False and a["suspended"] is False, "A untouched by the alt scan")

        # ---------- d. unban B does not cascade ----------
        print("== d. unban ==")
        code, r = api("PUT", f"/admin/users/{B['id']}", api_key=ADMIN_KEY, body={"banned": False})
        ok(code == 200, "admin unbans B", f"{code} {str(r)[:160]}")
        b = user_row(B["id"])
        ok(b["banned"] is False and b["banned_at"] is None and b["ban_reason"] == "",
           "B's ban fields cleared", str({k: b[k] for k in ("banned", "banned_at", "ban_reason")}))
        ok(not banned_rows(source_user_id=B["id"]), "B-sourced ex_banned_ips rows deleted by unban")
        audits = rest(f"ex_admin_audit?id=gt.{audit_max0}&action=eq.user_unban&target_user_id=eq.{B['id']}&select=id,action")
        ok(len(audits) == 1, "user_unban audit row written for B")
        d = user_row(D["id"])
        ok(d["banned"] is True, "D remains banned after B's unban (no cascade)")
        # D-sourced blacklist rows may include one sandbox egress
        # address; an attempt presenting it is refused at the
        # connection check (correct) — retry for a clean presentation.
        code, r = 0, {}
        for _ in range(6):
            code, r = login(B)
            if code == 200:
                break
            time.sleep(2)
        ok(code == 200 and r.get("token"), "B logs in again after unban", f"{code} {str(r)[:160]}")
    finally:
        # ---------- e. cleanup + baselines ----------
        print("== e. cleanup ==")
        try:
            if D_id := (test_ids[2] if len(test_ids) > 2 else None):
                api("PUT", f"/admin/users/{D_id}", api_key=ADMIN_KEY, body={"banned": False})
        except Exception as e:
            print("cleanup unban D failed:", e)
        for u in collateral_snapshot:
            rest(f"ex_users?id=eq.{u['id']}", method="PATCH",
                 body={"banned": u["banned"], "banned_at": u["banned_at"], "ban_reason": u["ban_reason"]})
            if not u["banned"]:
                # rows the alt scan inserted for a previously-unbanned
                # foreign account during the window are test fallout
                rest(f"ex_banned_ips?source_user_id=eq.{u['id']}", method="DELETE")
        # any OTHER foreign account the alt scan caught during the
        # window (it only ever candidates banned=false accounts, so
        # its pre-state is known exactly) is restored the same way
        snap_ids = {u["id"] for u in collateral_snapshot}
        for u in rest(f"ex_users?banned=eq.true&banned_at=gte.{T0}&select=id,ban_reason"):
            if u["id"] in test_ids or u["id"] in snap_ids:
                continue
            if str(u.get("ban_reason") or "").startswith("alt account of a banned user"):
                print(f"cleanup: restoring foreign alt-ban collateral user {u['id']}")
                rest(f"ex_users?id=eq.{u['id']}", method="PATCH",
                     body={"banned": False, "banned_at": None, "ban_reason": ""})
                rest(f"ex_banned_ips?source_user_id=eq.{u['id']}", method="DELETE")
        if reg_user_id:
            rest(f"ex_wallets?user_id=eq.{reg_user_id}", method="DELETE")
            rest(f"ex_user_wallets?user_id=eq.{reg_user_id}", method="DELETE")
            rest(f"ex_users?id=eq.{reg_user_id}", method="DELETE")
        # in-window outbox rows mentioning the test addresses go first
        ob_now = outbox_state()
        if ob_now != ob0:
            rows = rest(f"ex_outbox?id=gt.{ob0[0]}&select=id")
            for row in rows:
                full = rest(f"ex_outbox?id=eq.{row['id']}&select=*")
                if full and "verify" in json.dumps(full[0]).lower():
                    rest(f"ex_outbox?id=eq.{row['id']}", method="DELETE")
        # notifications created in-window about the test users / by them
        for row in rest(f"ex_notifications?id=gt.{notif_max0}&select=id,user_id,body"):
            if row["user_id"] in test_ids or "BanSuspend" in str(row.get("body") or "") or "auto-banned" in str(row.get("body") or ""):
                rest(f"ex_notifications?id=eq.{row['id']}", method="DELETE")
        for row in rest(f"ex_admin_audit?id=gt.{audit_max0}&select=id,target_user_id"):
            if row["target_user_id"] in test_ids:
                rest(f"ex_admin_audit?id=eq.{row['id']}", method="DELETE")
        for uid in test_ids:
            rest(f"ex_user_wallets?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_wallets?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_email_tokens?user_id=eq.{uid}", method="DELETE")
            rest(f"ex_banned_ips?source_user_id=eq.{uid}", method="DELETE")
            rest(f"ex_users?id=eq.{uid}", method="DELETE")
        if PAUSE.exists():
            PAUSE.unlink()
        # baseline assertions: any residual delta must be foreign live
        # activity (rows created after T0 by non-test actors), never
        # test residue.
        users1 = len(rest("ex_users?select=id"))
        leftovers = [u for u in rest("ex_users?select=id,email") if "verify-ban-" in str(u.get("email"))]
        ok(not leftovers, "no throwaway users remain", str(leftovers))
        foreign_users = [u for u in rest(f"ex_users?created_at=gte.{T0}&select=id") if u["id"] not in test_ids]
        ok(users1 - users0 == len(foreign_users),
           "ex_users count restored (modulo foreign signups)", f"{users0} -> {users1}, foreign {len(foreign_users)}")
        wallets1 = len(rest("ex_wallets?select=user_id"))
        ok(wallets1 == wallets0, "ex_wallets count restored", f"{wallets0} -> {wallets1}")
        ledger1 = len(rest("ex_ledger?select=id"))
        ok(ledger1 == ledger0, "ex_ledger count restored (no money moved)", f"{ledger0} -> {ledger1}")
        ob1 = outbox_state()
        ok(ob1 == ob0, "ex_outbox restored", f"{ob0} -> {ob1}")
        banned1 = banned_rows()
        ok(banned1 == banned0, "ex_banned_ips restored to baseline", f"{banned0} -> {banned1}")
        w1_1 = rest("ex_wallets?user_id=eq.1&select=balance_cents,held_cents")[0]
        ok(w1_1 == w1_0, "founder wallet untouched", f"{w1_0} -> {w1_1}")
        print(f"cleanup done: users {users0}->{users1} wallets {wallets0}->{wallets1} "
              f"ledger {ledger0}->{ledger1} outbox {ob0}->{ob1} banned_ips {len(banned0)}->{len(banned1)}")
    print(f"\nALL {CHECKS} CHECKS PASSED")
    if NOTES:
        print("notes:")
        for n in NOTES:
            print(" -", n)


if __name__ == "__main__":
    main()
