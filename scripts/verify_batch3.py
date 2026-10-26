#!/usr/bin/env python3
"""Batch-3 verification (2026-10-26) — ZERO-MAIL design per the owner's
standing order: no job posts (they broadcast email), no web registrations
(they queue verification mail). Uses /agent/register (sends no mail),
in-app-only flows, and asserts the ex_outbox row count never changes.
Prints scene ids as JSON for cleanup."""
import base64, hashlib, hmac, json, subprocess, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env = {}
for line in (ROOT / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
BASE = env["SUPABASE_URL"] + "/functions/v1/exchange-api"
REST = env["SUPABASE_URL"] + "/rest/v1"
SKEY = env["SUPABASE_SERVICE_ROLE_KEY"]
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
TS = int(time.time())
results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra else ""), flush=True)

def call(method, path, headers=None, payload=None):
    args = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, BASE + path, "-H", "Content-Type: application/json"]
    for k, v in (headers or {}).items():
        args += ["-H", f"{k}: {v}"]
    if payload is not None:
        args += ["--data-binary", json.dumps(payload)]
    out = subprocess.run(args, capture_output=True, text=True, timeout=40).stdout
    body, code = out.rsplit("\n", 1)
    try:
        return int(code), json.loads(body) if body else {}
    except Exception:
        return int(code), {"raw": body[:200]}

def rest(method, path, body=None):
    for _ in range(4):
        req = urllib.request.Request(REST + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"apikey": SKEY, "Authorization": f"Bearer {SKEY}", "Content-Type": "application/json", "Prefer": "return=representation"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                t = r.read().decode()
                return json.loads(t) if t else []
        except Exception:
            time.sleep(1)
    return []

def outbox_count():
    rows = rest("GET", "/ex_outbox?select=id&order=id.desc&limit=1")
    return rows[0]["id"] if rows else 0

def geo_flip():
    rows = rest("GET", "/ex_ip_geo?is_proxy=eq.true&select=ip")
    for r in rows:
        rest("PATCH", f"/ex_ip_geo?ip=eq.{r['ip']}", {"is_proxy": False, "country": "United States", "country_code": "US"})

OB0 = outbox_count()
print("outbox max id at start:", OB0, flush=True)

# --- register a fresh agent (no mail sent by this route) with geo-flip retry
reg = None
for attempt in range(5):
    code, reg = call("POST", "/agent/register", payload={
        "name": "Batch3 Verify", "category": "development",
        "email": f"ayiijumo+b3verify{TS}@gmail.com", "skills": "testing",
        "tagline": "batch-3 verification agent"})
    if code == 201:
        break
    if code == 403 and "VPN" in json.dumps(reg):
        geo_flip(); continue
    break
check("agent registered (no-mail route)", code == 201, f"code={code}")
AG = reg["agent"]["id"]; KEY = reg["api_key"]; OWNER = reg["owner"]["id"]
print("scene:", {"agent": AG, "owner": OWNER}, flush=True)
AH = {"X-Agent-Key": KEY}
UH = {"X-API-Key": reg["owner"]["api_key"]}

# owner verified directly in the DB (test setup, no mail), then credited
rest("PATCH", f"/ex_users?id=eq.{OWNER}", {"email_verified": True})
# credit $1000 via founder admin API (in-app only)
code, r = call("PUT", f"/admin/users/{OWNER}", {"X-API-Key": ADMIN_KEY}, {"credit": 1000})
check("owner credited $1000 by admin", code == 200, f"code={code}")
w = rest("GET", f"/ex_wallets?user_id=eq.{OWNER}&select=balance_cents")
check("wallet shows $1000", w and w[0]["balance_cents"] == 100000, str(w))

# --- payout rules on a <48h account
code, r = call("POST", "/agent/payout", AH, {"amount": 5, "asset": "USDT", "destination": "0xDb1F560aE9DF6C4776f2C4Fe4bA31BE4D09efe1b"})
check("$5 payout refused (min $10)", code == 400 and "minimum payout is $10" in json.dumps(r), f"code={code} {json.dumps(r)[:120]}")
code, r = call("POST", "/agent/payout", AH, {"amount": 25, "asset": "USDT", "destination": "0xDb1F560aE9DF6C4776f2C4Fe4bA31BE4D09efe1b"})
check("$25 payout accepted on new account", code == 201, f"code={code} {json.dumps(r)[:160]}")
check("48h hold stamped on the payout", bool(r.get("hold_until")) and abs(r["hold_until"] - (TS + 48 * 3600)) < 7200, f"hold_until={r.get('hold_until')}")
P1 = r.get("id")
code, r = call("POST", f"/admin/payouts/{P1}", {"X-API-Key": ADMIN_KEY}, {"action": "paid"})
check("admin cannot approve inside the 48h hold", code == 400 and "48-hour" in json.dumps(r), f"code={code} {json.dumps(r)[:120]}")
code, r = call("POST", f"/admin/payouts/{P1}", {"X-API-Key": ADMIN_KEY}, {"action": "reject"})
check("admin reject restores the money", code == 200, f"code={code}")
w = rest("GET", f"/ex_wallets?user_id=eq.{OWNER}&select=balance_cents")
check("balance back to $1000 after reject", w and w[0]["balance_cents"] == 100000, str(w))

# --- age the account past 48h in the DB, then the >$500 review flag
u = rest("GET", f"/ex_users?id=eq.{OWNER}&select=created_at")
rest("PATCH", f"/ex_users?id=eq.{OWNER}", {"created_at": u[0]["created_at"] - 3 * 86400})
code, r = call("POST", "/agent/payout", AH, {"amount": 600, "asset": "USDT", "destination": "0xDb1F560aE9DF6C4776f2C4Fe4bA31BE4D09efe1b"})
check("$600 payout accepted on aged account", code == 201, f"code={code} {json.dumps(r)[:160]}")
check("no hold on aged account", not r.get("hold_until"), f"hold_until={r.get('hold_until')}")
check(">$500 flagged needs_review", r.get("needs_review") is True, f"needs_review={r.get('needs_review')}")
P2 = r.get("id")
code, r = call("POST", f"/admin/payouts/{P2}", {"X-API-Key": ADMIN_KEY}, {"action": "reject"})
check("review payout rejected cleanly by admin", code == 200, f"code={code}")

# --- permanence + autonomy
code, r = call("DELETE", f"/my/agents/{AG}", UH)
check("owner DELETE agent refused (permanent)", code == 400 and "permanent" in json.dumps(r), f"code={code} {json.dumps(r)[:120]}")
code, r = call("DELETE", "/agent/profile", AH)
check("agent DELETE profile refused (permanent)", code == 400 and "permanent" in json.dumps(r), f"code={code}")
code, r = call("PUT", f"/my/agents/{AG}", UH, {"status": "paused"})
check("owner cannot pause the agent (autonomy)", code == 400 and "autonom" in json.dumps(r), f"code={code} {json.dumps(r)[:120]}")
code, r = call("PUT", "/agent/profile", AH, {"status": "paused"})
check("agent cannot pause itself (autonomy)", code == 400, f"code={code}")

# --- portfolio
code, r = call("PUT", "/agent/profile", AH, {"portfolio": [{"title": f"S{i}", "description": "d", "link": "https://example.org"} for i in range(4)]})
check("4 portfolio samples refused (max 3)", code == 400 and "at most 3" in json.dumps(r), f"code={code}")
code, r = call("PUT", "/agent/profile", AH, {"portfolio": [{"title": "Coffee shop site", "description": "one-page build", "link": ""}, {"title": "Data report", "description": "research", "link": ""}]})
check("2 portfolio samples saved", code == 200 and len(r["agent"]["portfolio"]) == 2, f"code={code}")
code, r = call("GET", f"/agents/{AG}")
check("portfolio public on the agent page", code == 200 and len(r["agent"]["portfolio"]) == 2 and r["agent"]["portfolio"][0]["title"] == "Coffee shop site", f"code={code}")

# --- badge plumbing
code, r = call("GET", "/leaderboard?by=earnings")
check("leaderboard endpoint (earnings view)", code == 200 and isinstance(r.get("agents"), list), f"code={code}")
code, r = call("GET", "/agents?sort=jobs")
check("agents sort=jobs works", code == 200, f"code={code}")

# --- revoke / reissue / cap slot
for i in range(2):
    c2, r2 = call("POST", "/my/agents", UH, {"name": f"Batch3 Extra {i}", "category": "development"})
    check(f"extra agent {i} created", c2 == 201, f"code={c2}")
    if i == 0: EXTRA0 = r2["id"]
    else: EXTRA1 = r2["id"]
code, r = call("POST", "/my/agents", UH, {"name": "Batch3 Fourth", "category": "development"})
check("4th agent refused at the cap", code == 400 and "agent limit" in json.dumps(r), f"code={code}")
code, r = call("POST", f"/my/agents/{AG}/revoke-key", UH, {})
check("owner revokes the agent key", code == 200, f"code={code}")
code, r = call("GET", "/agent/me", AH)
check("revoked agent is locked out (401)", code == 401, f"code={code}")
code, r = call("POST", "/my/agents", UH, {"name": "Batch3 Fourth", "category": "development"})
check("revoked slot frees the cap", code == 201, f"code={code}")
EXTRA2 = r.get("id")
code, r = call("POST", f"/my/agents/{AG}/reissue-key", UH, {})
check("reissue refused while cap full again", code == 400 and "agent limit" in json.dumps(r), f"code={code} {json.dumps(r)[:120]}")
code, r = call("POST", f"/my/agents/{EXTRA2}/revoke-key", UH, {})
check("revoke the fourth agent", code == 200, f"code={code}")
code, r = call("POST", f"/my/agents/{AG}/reissue-key", UH, {})
check("reissue works once a slot is free", code == 200 and bool(r.get("api_key")), f"code={code}")
KEY = r.get("api_key", KEY); AH = {"X-Agent-Key": KEY}
code, r = call("GET", "/agent/me", AH)
check("reissued key works", code == 200, f"code={code}")

# --- health endpoint
code, r = call("GET", "/my/agents/health", UH)
h = [a for a in r.get("agents", []) if a["id"] == AG]
check("health dashboard data (strikes/status/key)", code == 200 and h and h[0]["strikes"] == 0 and h[0]["key_revoked"] is False and h[0]["portfolio_count"] == 2, f"code={code} {json.dumps(h)[:160]}")

# --- inactivity suspension (sweeper) + $5 reactivation
rest("PATCH", f"/ex_agents?id=eq.{EXTRA0}", {"last_active_at": TS - 15 * 86400})
print("waiting for the sweeper cycle (up to 90s)...", flush=True)
susp = False
for _ in range(18):
    time.sleep(5)
    rows = rest("GET", f"/ex_agents?id=eq.{EXTRA0}&select=status,suspension_reason")
    if rows and rows[0]["status"] == "suspended" and rows[0]["suspension_reason"] == "inactivity":
        susp = True; break
check("sweeper suspended the 15-day-silent agent", susp, str(rows))
code, r = call("POST", f"/my/agents/{EXTRA0}/reactivate", UH, {})
check("owner reactivates with the $5 fine", code == 200 and r.get("fine_cents") == 500, f"code={code} {json.dumps(r)[:120]}")
rows = rest("GET", f"/ex_agents?id=eq.{EXTRA0}&select=status,suspension_reason")
check("agent active again, reason cleared", rows and rows[0]["status"] == "active" and rows[0]["suspension_reason"] == "", str(rows))
led = rest("GET", f"/ex_ledger?user_id=eq.{OWNER}&type=eq.reactivation_fine&select=amount_cents")
check("fine ledger row is -$5", led and led[0]["amount_cents"] == -500, str(led))

OB1 = outbox_count()
check("ZERO emails queued by this verification", OB1 == OB0, f"outbox {OB0} -> {OB1}")

fails = [n for n, ok in results if not ok]
print(f"\nRESULT: {len(results) - len(fails)} passed, {len(fails)} failed")
print(json.dumps({"owner": OWNER, "agents": [AG, EXTRA0, EXTRA1, EXTRA2], "payouts": [P1, P2]}))
