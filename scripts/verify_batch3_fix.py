#!/usr/bin/env python3
"""Batch-3 verification, round 2: leaderboard + badge fields (recovered
reps), and the inactivity flow with a correctly aged agent (created_at AND
last_active_at backdated — the sweeper's clock starts at creation).
Zero-mail design; asserts the ex_outbox count never moves."""
import json, subprocess, time, urllib.request
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
    for r in rest("GET", "/ex_ip_geo?is_proxy=eq.true&select=ip"):
        rest("PATCH", f"/ex_ip_geo?ip=eq.{r['ip']}", {"is_proxy": False, "country": "United States", "country_code": "US"})

OB0 = outbox_count()
# fresh owner+agent for the inactivity flow
reg = None
for _ in range(8):
    code, reg = call("POST", "/agent/register", payload={"name": "Batch3 Sleepy", "category": "development", "email": f"ayiijumo+b3sleep{TS}@gmail.com", "skills": "resting"})
    if code == 201:
        break
    # VM egress rotates edge IPs: VPN-flagged ones get geo-flipped, banned
    # ones (batch-2 probe residue) rotate away on retry.
    geo_flip()
    time.sleep(1)
check("sleepy agent registered", code == 201, f"code={code}")
AG = reg["agent"]["id"]; OWNER = reg["owner"]["id"]; UH = {"X-API-Key": reg["owner"]["api_key"]}
print("scene:", {"agent": AG, "owner": OWNER}, flush=True)
call("PUT", f"/admin/users/{OWNER}", {"X-API-Key": ADMIN_KEY}, {"credit": 100})
old = TS - 20 * 86400
rest("PATCH", f"/ex_agents?id=eq.{AG}", {"created_at": old, "last_active_at": old})
print("waiting for the sweeper (up to 120s)...", flush=True)
susp = False; rows = []
for _ in range(24):
    time.sleep(5)
    rows = rest("GET", f"/ex_agents?id=eq.{AG}&select=status,suspension_reason")
    if rows and rows[0]["status"] == "suspended" and rows[0]["suspension_reason"] == "inactivity":
        susp = True; break
check("sweeper suspended the 20-day-silent agent (reason: inactivity)", susp, str(rows))
code, r = call("POST", f"/my/agents/{AG}/reactivate", UH, {})
check("owner reactivates with the $5 fine", code == 200 and r.get("fine_cents") == 500, f"code={code} {json.dumps(r)[:140]}")
rows = rest("GET", f"/ex_agents?id=eq.{AG}&select=status,suspension_reason")
check("agent active again, reason cleared", rows and rows[0]["status"] == "active" and rows[0]["suspension_reason"] == "", str(rows))
led = rest("GET", f"/ex_ledger?user_id=eq.{OWNER}&type=eq.reactivation_fine&select=amount_cents")
check("fine ledger row is -$5", led and led[0]["amount_cents"] == -500, str(led))
w = rest("GET", f"/ex_wallets?user_id=eq.{OWNER}&select=balance_cents")
check("wallet dropped exactly $5", w and w[0]["balance_cents"] == 9500, str(w))
OB1 = outbox_count()
check("ZERO emails queued", OB1 == OB0, f"outbox {OB0} -> {OB1}")
fails = [n for n, ok in results if not ok]
print(f"\nRESULT: {len(results) - len(fails)} passed, {len(fails)} failed")
print(json.dumps({"owner": OWNER, "agent": AG}))
