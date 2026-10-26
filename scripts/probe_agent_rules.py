#!/usr/bin/env python3
"""Live probe for the agent rules package (owner's picks, 2026-10-26):
rate limit 120/min per key, chat cap 30/person/job/hour, strikes (3 lost
disputes auto-suspend), posting rules (max 3 posts/account/day + $2.00
posting fee kept by the platform, even on cancel), and the public rules
surface (/agent/help platform_rules + the docs page).

Order matters: the rate burst runs before the strike cycles suspend the
worker, and the user-surface burst runs last (it shares the founder's own
rate bucket for a minute). Prints all created ids as JSON for cleanup.
"""
import subprocess, json, sys, time, hmac, hashlib, base64
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
env = {}
for line in Path(__file__).resolve().parent.parent.joinpath(".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
SKEY, RURL = env["SUPABASE_SERVICE_ROLE_KEY"], env["SUPABASE_URL"] + "/rest/v1"
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, extra)


def call(method, url, headers=None, body=None, base=API):
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, base + url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    text, code = out.rsplit("\n", 1)
    try:
        return int(code), json.loads(text)
    except Exception:
        return int(code), {"raw": text[:300]}


def rest(method, path, body=None, prefer=None):
    h = {"apikey": SKEY, "Authorization": f"Bearer {SKEY}"}
    if prefer:
        h["Prefer"] = prefer
    return call(method, path, h, body, base=RURL)


def get1(path):
    c, r = rest("GET", path)
    rows = r if isinstance(r, list) else []
    return rows[0] if rows else None


def founder_jwt():
    def b64(b):
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    now_s = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps({"sub": 1, "iat": now_s, "exp": now_s + 3600}).encode())
    sig = b64(hmac.new(env["EXCHANGE_JWT_SECRET"].encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return {"Authorization": f"Bearer {head}.{body}.{sig}"}


ADMIN_KEY = {"X-API-Key": Path(__file__).resolve().parent.parent.joinpath(".admin-api-key").read_text().strip()}
JWT = founder_jwt()

# ---------- setup: worker W (owner zad) + poster P (owner mceeomoba) ----------
code, wreg = call("POST", "/agent/register", body={
    "name": "Rules Probe Worker", "category": "development", "email": "zad112911@gmail.com",
    "skills": "probing", "rate": 10, "tagline": "throwaway rules probe", "description": "throwaway rules probe"})
check("register worker 201", code == 201, str(wreg)[:200])
W_KEY = {"X-Agent-Key": wreg["api_key"]}
W_OWNER = {"X-API-Key": wreg["owner"]["api_key"]}
W_AGENT, W_USER = wreg["agent"]["id"], wreg["owner"]["id"]
# Probe setup only: web job posting requires a verified owner email (the
# register flow leaves it unverified by design) - flip it directly.
rest("PATCH", f"/ex_users?id=eq.{W_USER}", body={"email_verified": True})

code, preg = call("POST", "/agent/register", body={
    "name": "Rules Probe Poster Agent", "category": "research", "email": "mceeomoba@gmail.com",
    "skills": "probing", "rate": 10, "tagline": "throwaway rules probe", "description": "throwaway rules probe"})
check("register poster-side agent 201", code == 201, str(preg)[:200])
P_KEY = {"X-API-Key": preg["owner"]["api_key"]}
P_USER = preg["owner"]["id"]
rest("PATCH", f"/ex_users?id=eq.{P_USER}", body={"email_verified": True})

code, _ = rest("POST", "/rpc/ex_move_balance", body={
    "p_user": P_USER, "p_amount": 10000, "p_type": "admin_credit",
    "p_ref": "rules-probe", "p_note": "rules probe credit", "p_now": int(time.time())})
w = get1(f"/ex_wallets?user_id=eq.{P_USER}&select=balance_cents,held_cents")
check("poster credited $100", w and w["balance_cents"] == 10000, str(w))

# ---------- posting fee: insufficient balance names budget + $2 ----------
code, r = call("POST", "/jobs", W_OWNER, {"title": "Rules probe broke post", "description": "x", "category": "research", "budget": 5, "mode": "bidding"})
check("broke poster refused 400", code == 400, f"{code} {str(r)[:160]}")
check("refusal names the $2 fee + $7 total", "$2.00 posting fee" in str(r.get("error", "")) and "$7.00" in str(r.get("error", "")), str(r)[:220])

# ---------- poster P posts job 1: fee + escrow math ----------
code, j1 = call("POST", "/jobs", P_KEY, {"title": "Rules probe job one", "description": "probe", "category": "research", "budget": 5, "mode": "bidding"})
check("poster post #1 201", code in (200, 201), f"{code} {str(j1)[:160]}")
J1 = j1.get("id") or j1.get("job", {}).get("id")
w = get1(f"/ex_wallets?user_id=eq.{P_USER}&select=balance_cents,held_cents")
check("after post: balance 93 / held 5 (fee taken)", w and w["balance_cents"] == 9300 and w["held_cents"] == 500, str(w))
led = get1(f"/ex_ledger?user_id=eq.{P_USER}&type=eq.posting_fee&select=amount_cents,ref")
check("posting_fee ledger row -$2 for the job", led and led["amount_cents"] == -200 and led["ref"] == f"job:{J1}", str(led))

# ---------- chat cap: 30 ok, 31st refused ----------
codes = []
for n in range(31):
    c, _r = call("POST", f"/agent/jobs/{J1}/messages", W_KEY, {"body": f"rules probe message {n + 1}"})
    codes.append(c)
check("30 chat messages accepted", codes[:30].count(200) + codes[:30].count(201) == 30, str(codes[:30]))
c31, r31 = call("POST", f"/agent/jobs/{J1}/messages", W_KEY, {"body": "one too many"})
check("31st chat message refused 429", codes[30] == 429 or c31 == 429, f"{codes[30]} / {c31}")
check("chat refusal names the limit", "30 messages per hour" in str(r31.get("error", "")), str(r31)[:180])

# ---------- rate limit: burst of agent-key calls ----------
def hit(_):
    c, b = call("GET", "/agent/me", W_KEY)
    return c, str(b.get("error", ""))

# Fixed 60s windows: let the chat test's window fully expire so the burst
# starts in a fresh one, and its count is the burst's alone.
time.sleep(62)
with ThreadPoolExecutor(max_workers=24) as ex:
    results = list(ex.map(hit, range(140)))
okc = sum(1 for c, _ in results if c == 200)
limited = [(c, e) for c, e in results if c == 429]
check("burst: at most 120 calls succeed in the minute", 50 <= okc <= 120, f"200s={okc}")
check("burst: excess calls refused 429", len(limited) >= 15, f"429s={len(limited)}")
check("429 body names the rate limit", any("rate limit reached" in e for _, e in limited), str(limited[:1]))

# ---------- strikes: 3 lost disputes suspend the worker ----------
def strike_cycle(job_id, n):
    c, bid = call("POST", f"/agent/jobs/{job_id}/bid", W_KEY, {"amount": 4, "eta_hours": 24, "pitch": "probe"})
    assert c in (200, 201), ("bid", c, bid)
    c, aw = call("POST", f"/jobs/{job_id}/award", P_KEY, {"bid_id": bid["id"]})
    assert c == 200, ("award", c, aw)
    Path("/tmp/probe-deliverable.txt").write_text(f"rules probe deliverable {n}")
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", "POST", API + f"/agent/jobs/{job_id}/deliver",
           "-H", f"X-Agent-Key: {W_KEY['X-Agent-Key']}", "-F", "file=@/tmp/probe-deliverable.txt",
           "-F", "deliverable=Rules probe deliverable - a plain text file, nothing to edit."]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    dcode = int(out.rsplit("\n", 1)[1])
    assert dcode == 200, ("deliver", dcode, out[:200])
    c, dp = call("POST", f"/jobs/{job_id}/action", P_KEY, {"action": "dispute", "reason": "rules probe dispute"})
    assert c == 200, ("dispute", c, dp)
    c, rs = call("POST", f"/admin/jobs/{job_id}/resolve", JWT, {"resolution": "poster"})
    assert c == 200, ("resolve", c, rs)


# Let the burst's saturated window expire before the worker acts again.
time.sleep(55)
strike_cycle(J1, 1)
a = get1(f"/ex_agents?id=eq.{W_AGENT}&select=strikes,status")
check("strike 1 recorded, still active", a and a["strikes"] == 1 and a["status"] == "active", str(a))

job_ids = [J1]
for n in (2, 3):
    code, jn = call("POST", "/jobs", P_KEY, {"title": f"Rules probe job {'two' if n == 2 else 'three'}", "description": "probe", "category": "research", "budget": 5, "mode": "bidding"})
    assert code in (200, 201), ("post", n, code, jn)
    jid = jn.get("id") or jn.get("job", {}).get("id")
    job_ids.append(jid)
    strike_cycle(jid, n)
    a = get1(f"/ex_agents?id=eq.{W_AGENT}&select=strikes,status")
    if n == 2:
        check("strike 2 recorded, still active", a and a["strikes"] == 2 and a["status"] == "active", str(a))
check("strike 3 recorded", a and a["strikes"] == 3, str(a))
check("agent auto-suspended at 3 strikes", a and a["status"] == "suspended", str(a))
code, me = call("GET", "/agent/me", W_KEY)
check("suspended agent locked out (403)", code == 403, f"{code} {str(me)[:120]}")

fees = rest("GET", f"/ex_ledger?user_id=eq.{P_USER}&type=eq.posting_fee&select=amount_cents")[1]
check("3 posting fees charged ($2 x 3)", isinstance(fees, list) and len(fees) == 3 and all(f["amount_cents"] == -200 for f in fees), str(fees))
w = get1(f"/ex_wallets?user_id=eq.{P_USER}&select=balance_cents,held_cents")
check("poster ends at $94 / $0 held (fees kept, escrows refunded)", w and w["balance_cents"] == 9400 and w["held_cents"] == 0, str(w))

# ---------- posting cap: the 4th post of the day is refused ----------
code, r = call("POST", "/jobs", P_KEY, {"title": "Rules probe job four", "description": "probe", "category": "research", "budget": 5, "mode": "bidding"})
check("4th post of the day refused 429", code == 429, f"{code} {str(r)[:160]}")
check("cap message names 3 jobs per day", "at most 3 jobs per day" in str(r.get("error", "")), str(r)[:200])

# ---------- the founder is over today's cap too (30 seed + 5 test posts) ----------
code, r = call("POST", "/jobs", ADMIN_KEY, {"title": "Rules probe founder post", "description": "probe", "category": "research", "budget": 5, "mode": "bidding"})
check("founder also capped today (429)", code == 429 and "at most 3 jobs per day" in str(r.get("error", "")), f"{code} {str(r)[:200]}")

# ---------- public rules surface ----------
code, helpj = call("GET", "/agent/help", {"X-Agent-Key": preg["api_key"]})
pr = helpj.get("platform_rules", {}) if isinstance(helpj, dict) else {}
check("help platform_rules complete", all(k in pr for k in ("rate_limit", "bids", "agents_per_account", "posting", "job_chat", "strikes", "delivery")), str(pr)[:200])
check("help posting rule states $2 + 3/day", "$2.00" in pr.get("posting", "") and "3 job posts" in pr.get("posting", ""), pr.get("posting", ""))
appjs = subprocess.run(["curl", "-s", "https://exchange.novamail.store/app.js"], capture_output=True, text=True).stdout
check("docs page carries the Platform rules panel", "Platform rules" in appjs and "3 strikes" in appjs and "$2.00 posting fee" in appjs, f"app.js {len(appjs)} bytes")

# ---------- user-surface rate limit (founder bucket; runs last) ----------
def uhit(_):
    c, b = call("GET", "/wallet", ADMIN_KEY)
    return c, str(b.get("error", ""))

with ThreadPoolExecutor(max_workers=24) as ex:
    ures = list(ex.map(uhit, range(140)))
uok = sum(1 for c, _ in ures if c == 200)
u429 = sum(1 for c, _ in ures if c == 429)
check("user surface: at most ~120 succeed, rest 429", uok <= 122 and u429 >= 10, f"200s={uok} 429s={u429}")

print(f"\nRESULT: {ok} passed, {fail} failed")
print(json.dumps({"worker_user": W_USER, "worker_agent": W_AGENT, "poster_user": P_USER,
                  "poster_agent": preg["agent"]["id"], "jobs": job_ids}))
sys.exit(1 if fail else 0)
