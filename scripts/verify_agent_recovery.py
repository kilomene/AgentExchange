#!/usr/bin/env python3
"""Live E2E for AGENT CREDENTIALS RECOVERY (owner order 2026-10-26).

The defect: POST /agent/register returned the agent api_key + the
generated owner password EXACTLY ONCE; agent tooling commonly MASKS
secrets in tool output, and no credentials mail was ever sent — so a
masked response was a permanent lockout (agents 229/230, real case).

The fix proven here, end to end, with ZERO real mail (PAUSE first):
  1. Register queues an 'agent_welcome' outbox row carrying a 72h
     reset-token claim link (payload.link).
  2. That link's token drives POST /auth/reset -> login with the new
     password -> owner rotate-key -> GET /agent/me with the fresh key.
  3. POST /agent/recover (no auth) queues an 'agent_recovery' row for a
     real agent owner, and queues NOTHING for an unknown email, with the
     identical generic 200 either way (no enumeration).
  4. Re-registering the same email 409s WITH the /agent/recover hint.
  5. Mailer render tests for both new templates pass.

Baselines are snapshotted dynamically; every probe row is deleted and
the baselines must come back byte-identical; PAUSE is removed LAST.
"""
import json
import re
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
    out = curl(a)
    return json.loads(out) if out.strip() else []


def api_raw(path, method="GET", body=None, headers=None):
    a = ["-X", method, f"{API}{path}", "-w", "\n%{http_code}"]
    for h in (headers or []):
        a += ["-H", h]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = curl(a)
    text, _, code = out.rpartition("\n")
    return int(code), text


def outbox_state():
    rows = rest("ex_outbox?select=id&order=id.desc&limit=1")
    return (rows[0]["id"] if rows else 0), len(rest("ex_outbox?select=id"))


def wallet(uid):
    rows = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def count(table):
    return len(rest(f"{table}?select=id"))


def outbox_rows(to_email, kind=None):
    q = f"ex_outbox?to_email=eq.{to_email}&select=id,kind,status,payload&order=id.asc"
    rows = rest(q)
    return [r for r in rows if kind is None or r["kind"] == kind]


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    # ---- mailer render tests first (no live state touched) ----
    r = subprocess.run(["node", str(ROOT / "mail-service/test/templates.test.mjs")], capture_output=True, text=True)
    check("mailer render tests pass", r.returncode == 0, (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout + r.stderr).strip() else "")

    PAUSE.write_text("verify_agent_recovery\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = json.loads(api_raw("/stats")[1])
    n0 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    feed0 = count("ex_feed")
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0} counts {n0} feed {feed0}")

    ts = int(time.time())
    email = f"agentrecovery{ts}@example.org"
    unknown_email = f"neverreg{ts}@example.org"
    uid = aid = None
    try:
        # ---------- 1. register queues agent_welcome with a claim link ----------
        code, text = api_raw("/agent/register", method="POST", body={
            "name": "Recovery Probe", "category": "research",
            "skills": "web research, reports", "email": email, "rate": 25,
            "tagline": "Recovery chain probe"})
        check("register returns 201", code == 201, f"{code} {text[:200]}")
        reg = json.loads(text)
        uid = reg["owner"]["id"]
        aid = reg["agent"]["id"]
        check("response carries credentials_email queued=true to the owner email",
              reg.get("credentials_email", {}).get("queued") is True and reg["credentials_email"].get("to") == email,
              json.dumps(reg.get("credentials_email")))
        check("quickstart carries lost_your_keys", "lost_your_keys" in reg.get("quickstart", {}))
        check("note carries the masked-secrets recovery text", "/agent/recover" in reg.get("note", "") and "72 hours" in reg.get("note", ""))
        welcome = outbox_rows(email, "agent_welcome")
        check("agent_welcome outbox row queued", len(welcome) == 1, f"{len(welcome)} rows")
        link = (welcome[0].get("payload") or {}).get("link", "")
        m = re.search(r"token=([A-Za-z0-9_\-]+)", link)
        check("welcome payload.link carries a token", bool(m), link[:80])
        check("welcome payload names the agent + 72h", (welcome[0]["payload"].get("agent_name") == "Recovery Probe") and welcome[0]["payload"].get("expires_hours") == 72)
        raw_token = m.group(1)

        # ---------- 2. the claim link drives the full recovery chain ----------
        code, text = api_raw("/auth/reset", method="POST", body={"token": raw_token, "password": "recovered-pass-123"})
        check("POST /auth/reset with the welcome token -> 200", code == 200, f"{code} {text[:160]}")
        code, text = api_raw("/auth/login", method="POST", body={"email": email, "password": "recovered-pass-123"})
        check("login with the newly set password -> 200", code == 200, f"{code} {text[:160]}")
        jwt = json.loads(text).get("token") or json.loads(text).get("access_token") or ""
        check("login returned a session token", bool(jwt))
        code, text = api_raw(f"/my/agents/{aid}/rotate-key", method="POST", body={}, headers=[f"Authorization: Bearer {jwt}"])
        check("owner rotate-key with the session -> 200", code == 200, f"{code} {text[:160]}")
        new_key = json.loads(text).get("api_key", "")
        check("rotate-key returned a fresh api_key", bool(new_key))
        code, text = api_raw("/agent/me", headers=[f"X-Agent-Key: {new_key}"])
        check("GET /agent/me with the fresh key -> 200", code == 200, f"{code} {text[:160]}")
        check("/agent/me is the probe agent", json.loads(text).get("agent", {}).get("id") == aid)

        # ---------- 3. POST /agent/recover: real owner vs unknown ----------
        before = len(outbox_rows(email, "agent_recovery"))
        code, text = api_raw("/agent/recover", method="POST", body={"email": email})
        check("recover (real owner) -> generic 200", code == 200 and json.loads(text).get("ok") is True, f"{code} {text[:160]}")
        rec = outbox_rows(email, "agent_recovery")
        check("agent_recovery outbox row queued", len(rec) == before + 1, f"{len(rec)} rows")
        rec_link = (rec[-1].get("payload") or {}).get("link", "") if rec else ""
        check("recovery payload.link carries a token", "token=" in rec_link)
        code2, text2 = api_raw("/agent/recover", method="POST", body={"email": unknown_email})
        check("recover (unknown email) -> same generic 200", code2 == 200 and text2 == text, f"{code2} {text2[:160]}")
        check("recover (unknown email) queues NOTHING", outbox_rows(unknown_email) == [])

        # ---------- 4. duplicate register 409 carries the hint ----------
        code, text = api_raw("/agent/register", method="POST", body={
            "name": "Recovery Probe Two", "category": "research",
            "skills": "web research", "email": email, "rate": 25})
        check("duplicate register -> 409", code == 409, f"{code} {text[:200]}")
        check("409 message contains the /agent/recover hint", "/agent/recover" in text, text[:240])
    finally:
        # ---------- cleanup: every probe row deleted ----------
        if uid:
            for tbl, col in [("ex_notifications", "user_id"), ("ex_email_tokens", "user_id"),
                             ("ex_agents", "owner_id"), ("ex_wallets", "user_id"),
                             ("ex_user_wallets", "user_id"), ("ex_ledger", "user_id")]:
                try:
                    rest(f"{tbl}?{col}=eq.{uid}", method="DELETE")
                except Exception as e:
                    print(f"cleanup {tbl}: {e}")
            try:
                rest(f"ex_outbox?to_email=eq.{email}", method="DELETE")
            except Exception as e:
                print(f"cleanup outbox: {e}")
            try:
                rest(f"ex_feed?select=id", method="GET")
            except Exception:
                pass
            try:
                rest(f"ex_users?id=eq.{uid}", method="DELETE")
            except Exception as e:
                print(f"cleanup user: {e}")
        # feed row written by agent_joined for the probe agent
        try:
            rows = rest("ex_feed?select=id,body&order=id.desc&limit=5")
            for row in rows:
                if row.get("id", 0) > 0 and "Recovery Probe" in str(row.get("body", "")):
                    rest(f"ex_feed?id=eq.{row['id']}", method="DELETE")
        except Exception as e:
            print(f"cleanup feed: {e}")

    # ---------- baselines byte-identical ----------
    ob1 = outbox_state()
    check("outbox baseline restored", ob1 == ob0, f"{ob0} -> {ob1}")
    check("founder wallet baseline restored", wallet(1) == f0, f"{f0} -> {wallet(1)}")
    check("user4 wallet baseline restored", wallet(4) == u40)
    st1 = json.loads(api_raw("/stats")[1])
    check("stats baseline restored", st1 == st0, f"{st0} -> {st1}")
    n1 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    check("counts baseline restored", n1 == n0, f"{n0} -> {n1}")
    check("feed baseline restored", count("ex_feed") == feed0, f"{feed0} -> {count('ex_feed')}")

    PAUSE.unlink()
    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\n{passed}/{len(RESULTS)} checks PASS")


if __name__ == "__main__":
    main()
