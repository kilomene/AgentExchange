#!/usr/bin/env python3
"""Continuation of probe_lifecycle_mail.py for job 52 (round 1).
The first run proved job_posted / bid_received / job_awarded, then used two
web routes that do not exist (/jobs/:id/deliver, /jobs/:id/complete). The
real web contract is POST /jobs/:id/action {action: deliver|complete}
(multipart with action=deliver + deliverable + file for delivery), exactly
what public/app.js sends. This script finishes the cycle from the awarded
state and checks the remaining three emails + final wallet figures.
"""
import subprocess, json, sys, time

API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
env = {}
for line in open("/home/hatch/workspace/agent-exchange/.env"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
BASE, KEY = env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]
ADMIN = open("/home/hatch/workspace/agent-exchange/.admin-api-key").read().strip()
reg = json.load(open("/tmp/mail_probe_state.json"))
JOB_ID = 52
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, extra)


def call(method, url, headers=None, body=None, raw_base=None):
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, (raw_base or API) + url]
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


def rest(path):
    return call("GET", path, {"apikey": KEY, "Authorization": "Bearer " + KEY}, raw_base=BASE + "/rest/v1")


_, ob = rest("/ex_outbox?select=id&order=id.desc&limit=1")
since = ob[0]["id"]
print("outbox watermark:", since)

# login as probe owner
code, login = call("POST", "/auth/login", body={"email": "zad112911@gmail.com", "password": reg["owner"]["password"]})
check("probe owner login 200", code == 200, str(login)[:150])
token = login.get("token") or login.get("access_token") or (login.get("session") or {}).get("token")

# deliver via the real web contract: POST /jobs/:id/action multipart
cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", "POST", API + f"/jobs/{JOB_ID}/action",
       "-H", f"Authorization: Bearer {token}",
       "-F", "action=deliver",
       "-F", "deliverable=The welcome guide, as a text file. It covers what the marketplace is, escrow, placing a first bid, and how delivery and payment work.",
       "-F", "link=",
       "-F", "file=@/tmp/welcome-guide.txt"]
out = subprocess.run(cmd, capture_output=True, text=True).stdout
text, dcode = out.rsplit("\n", 1)
check("deliver with file via /action 200", dcode == "200", text[:250])


def wait_outbox(kind, to_email, tries=14):
    for _ in range(tries):
        _, rows = rest(f"/ex_outbox?kind=eq.{kind}&to_email=eq.{to_email}&id=gt.{since}&select=*&order=id.desc&limit=1")
        if rows:
            if rows[0]["status"] == "sent":
                return rows[0]
            if rows[0]["status"] in ("failed", "skipped_invalid_domain"):
                return rows[0]
        time.sleep(3)
    _, rows = rest(f"/ex_outbox?kind=eq.{kind}&to_email=eq.{to_email}&id=gt.{since}&select=*&order=id.desc&limit=1")
    return rows[0] if rows else None


row = wait_outbox("job_delivered", "fleet@novamail.store")
check("job_delivered email to poster sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("delivered email names the agent", bool(row) and row["payload"].get("agent_name") == "Mail Probe", str(row and row["payload"])[:200])

# complete via the action route as the founder
code, comp = call("POST", f"/jobs/{JOB_ID}/action", {"X-API-Key": ADMIN}, {"action": "complete"})
check("complete via /action 200", code == 200, str(comp)[:200])

row = wait_outbox("payment_received", "zad112911@gmail.com")
check("payment_received email sent", bool(row) and row["status"] == "sent", str(row)[:200])
p = (row or {}).get("payload", {})
check("worker email: $8.10 in, wallet $0.00 -> $8.10",
      p.get("amount") == "$8.10" and p.get("wallet_before") == "$0.00" and p.get("wallet_after") == "$8.10", str(p)[:250])

row2 = wait_outbox("payment_sent", "fleet@novamail.store")
check("payment_sent email to poster sent", bool(row2) and row2["status"] == "sent", str(row2)[:200])
p2 = (row2 or {}).get("payload", {})
_, w = rest("/ex_wallets?user_id=eq.1&select=balance_cents,held_cents")
fw = w[0]
exp_bal = "$" + f"{fw['balance_cents']/100:,.2f}"
exp_held = "$" + f"{fw['held_cents']/100:,.2f}"
exp_tot = "$" + f"{(fw['balance_cents']+fw['held_cents'])/100:,.2f}"
check("poster email totals match his real wallet",
      p2.get("amount") == "$9.00" and p2.get("wallet_balance") == exp_bal and p2.get("escrow_held") == exp_held and p2.get("wallet_total") == exp_tot,
      f"payload={str(p2)[:250]} expected bal={exp_bal} held={exp_held} tot={exp_tot}")
check("founder final: balance $2,611.00, held back to $2,379.00",
      fw["balance_cents"] == 261100 and fw["held_cents"] == 237900, str(fw))

print(f"\nRESULT: {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
