#!/usr/bin/env python3
"""Live E2E for the SIGNUP IP RULE SPLIT (owner decision 2026-10-26
~19:27 PDT). Zero-mail discipline: the mailer PAUSE goes on FIRST,
baselines are snapshotted dynamically, every seeded row is deleted
afterwards, and the baselines must come back byte-identical.

The split: geoForIp now stores is_proxy (ip-api `proxy` ONLY) and
is_hosting (ip-api `hosting` ONLY) as separate verdicts.
  * POST /agent/register may come from a hosting/server IP - agents
    live on servers. A true VPN/proxy is still refused.
  * POST /auth/register (normal web signup) stays strict: proxy OR
    hosting refused, with a hosting-specific message.

KEY DIFFERENTIAL: requests from THIS VM are judged by the function on
the VM's real egress IP, whose ip-api verdict is proxy=false /
hosting=true - exactly the shape of the owner's report (a third party
on a Latitude.sh server IP, 67.213.112.233, was refused as "VPN or
proxy" under the old combined flag).

Leg (d) - a proxy=true verdict still blocks /agent/register - is
CODE-VERIFIED, honestly: there is no safe live harness from this VM
to make the function judge a proxy-flagged source IP (clientIp only
trusts the proxy-secret header or the unforgeable right-hand side of
the forwarded chain). The script asserts the deployed source's logic
order and seeds a split cache row to prove the fields store
independently; it does NOT fake a live proxy source.
"""
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
SRC = (ROOT / "supabase/functions/exchange-api/index.ts").read_text()
TESTNET_IP = "198.51.100.99"  # TEST-NET-2, documentation range
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


def api_raw(path, method="GET", body=None):
    a = ["-X", method, f"{API}{path}", "-w", "\n%{http_code}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = curl(a)
    text, _, code = out.rpartition("\n")
    return int(code), text


def api(path):
    code, text = api_raw(path)
    return json.loads(text)


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    return (rows[0]["id"] if rows else 0), len(json.loads(rest("ex_outbox?select=id")))


def wallet(uid):
    rows = json.loads(rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents"))
    return (rows[0]["balance_cents"], rows[0]["held_cents"]) if rows else None


def count(table):
    return len(json.loads(rest(f"{table}?select=id")))


def main():
    assert not PAUSE.exists(), "PAUSE already present - another verification window is open; aborting"
    PAUSE.write_text("verify_ip_hosting_split\n")
    time.sleep(6)
    ob0 = outbox_state()
    f0 = wallet(1)
    u40 = wallet(4)
    st0 = api("/stats")
    n0 = (count("ex_users"), count("ex_agents"), count("ex_jobs"))
    print(f"baselines: outbox {ob0} founder {f0} user4 {u40} stats {st0} counts {n0}")

    ts = int(time.time())
    T0 = ts - 5
    created_user = None
    created_agent = None
    try:
        # ---------- (b) web signup from the same hosting IP: STILL refused ----------
        web_email = f"ipsplitweb{ts}@example.org"
        code, text = api_raw("/auth/register", method="POST",
                             body={"email": web_email, "name": "IP Split Web Probe", "password": "probe-pass-123"})
        check("(b) POST /auth/register from a hosting IP is refused 403", code == 403, f"{code} {text[:200]}")
        check("(b) refusal is the hosting-specific message", "hosting or server" in text, text[:200])
        check("(b) refusal is NOT the VPN/proxy message", "VPN or proxy. Please" not in text, text[:200])
        rows = json.loads(rest(f"ex_users?email=eq.{web_email}&select=id"))
        check("(b) no account was created", rows == [], json.dumps(rows))

        # ---------- (a) agent registration from the same IP: now SUCCEEDS ----------
        agent_email = f"ipsplitagent{ts}@example.org"
        code, text = api_raw("/agent/register", method="POST", body={
            "name": "IP Split Probe Agent", "category": "research",
            "skills": "web research, reports", "email": agent_email,
            "rate": 25, "tagline": "Split-rule probe - deleted in cleanup"})
        check("(a) POST /agent/register from a hosting IP succeeds 201", code == 201, f"{code} {text[:240]}")
        reg = json.loads(text)
        created_agent = reg["agent"]["id"]
        created_user = reg["owner"]["id"]
        check("(a) registration returns agent + owner + one-time keys",
              bool(reg.get("api_key")) and reg["owner"].get("email") == agent_email,
              json.dumps({k: reg.get(k) for k in ("api_key",)})[:60])

        # ---------- (c) the judged IP's cache row stores the verdict SPLIT ----------
        urows = json.loads(rest(f"ex_users?id=eq.{created_user}&select=signup_ip,country,country_code"))
        signup_ip = urows[0]["signup_ip"]
        check("(c) signup IP recorded on the account", bool(signup_ip), json.dumps(urows))
        grows = json.loads(rest(f"ex_ip_geo?ip=eq.{signup_ip}&select=ip,country,country_code,is_proxy,is_hosting"))
        check("(c) geo cache row exists for the judged IP", len(grows) == 1, json.dumps(grows))
        g = grows[0]
        check("(c) is_proxy stored separately and FALSE (not a VPN/proxy)", g["is_proxy"] is False, json.dumps(g))
        check("(c) is_hosting stored separately and TRUE (a server IP)", g["is_hosting"] is True, json.dumps(g))
        check("(c) account country matches the geo verdict",
              urows[0]["country"] == g["country"] and bool(g["country"]), json.dumps(urows) + " vs " + json.dumps(g))

        # ---------- (e) the reported real-world IP resolves split, read-only ----------
        raw = curl([f"http://ip-api.com/json/67.213.112.233?fields=status,country,countryCode,proxy,hosting"])
        verdict = json.loads(raw)
        check("(e) 67.213.112.233 (the reported server IP): proxy=false", verdict.get("proxy") is False, raw)
        check("(e) 67.213.112.233: hosting=true - allowed for agent registration under the split",
              verdict.get("hosting") is True, raw)

        # ---------- (d) proxy=true still blocks agent registration: CODE-VERIFIED ----------
        # No safe live harness exists from this VM to present a
        # proxy-flagged source IP to the function (clientIp trusts only
        # the proxy-secret header or the unforgeable right-hand side of
        # the forwarded chain), so this leg is proven on the deployed
        # source + an independently-stored split cache row. Honest
        # label: code-verified, NOT live-fired.
        rest("ex_ip_geo", method="POST", body={"ip": TESTNET_IP, "country": "Testland",
             "country_code": "XX", "is_proxy": True, "is_hosting": False, "checked_at": ts})
        srows = json.loads(rest(f"ex_ip_geo?ip=eq.{TESTNET_IP}&select=is_proxy,is_hosting"))
        check("(d) [code-verified] split cache row stores is_proxy=true independently of is_hosting",
              srows and srows[0]["is_proxy"] is True and srows[0]["is_hosting"] is False, json.dumps(srows))
        check("(d) [code-verified] verdict is split at the source (no combined proxy||hosting)",
              "is_proxy: !!gj.proxy" in SRC and "is_hosting: !!gj.hosting" in SRC and "gj.proxy || gj.hosting" not in SRC)
        guard = SRC[SRC.index("async function assertSignupIpAllowed"):SRC.index("async function recordLoginIp")]
        check("(d) [code-verified] proxy refusal precedes the hosting branch in the guard",
              guard.index("geo.is_proxy") < guard.index("geo.is_hosting"), guard[:80])
        check("(d) [code-verified] hosting refusal is gated to strict mode only",
              'mode === "strict" && geo.is_hosting' in guard)
        check("(d) [code-verified] /agent/register passes agent mode; /auth/register stays strict",
              'assertSignupIpAllowed(req, "agent")' in SRC and "const signup = await assertSignupIpAllowed(req);" in SRC)

        print(f"\nALL {len(RESULTS)} CHECKS PASSED")
    finally:
        # ---------- cleanup: every seeded row goes ----------
        if created_agent:
            rest(f"ex_agents?id=eq.{created_agent}", method="DELETE")
        if created_user:
            rest(f"ex_notifications?user_id=eq.{created_user}", method="DELETE")
            rest(f"ex_ledger?user_id=eq.{created_user}", method="DELETE")
            rest(f"ex_wallets?user_id=eq.{created_user}", method="DELETE")
            rest(f"ex_user_wallets?user_id=eq.{created_user}", method="DELETE")
            rest(f"ex_users?id=eq.{created_user}", method="DELETE")
        rest(f"ex_ip_geo?ip=eq.{TESTNET_IP}", method="DELETE")
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
