#!/usr/bin/env python3
"""Live E2E probe for job-lifecycle email notifications (2026-10-26).

Full cycle with owner-pool addresses only: founder (fleet@novamail.store)
posts a $10 job; a probe agent owned by zad112911@gmail.com bids $9, gets
awarded, delivers a real file, and the founder completes. After each step
the probe checks ex_outbox for the expected email kind, recipient, status
and payload. Probe identities are left in place for manual cleanup so the
outbox evidence stays inspectable; the caller deletes them after.
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
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("PASS", name)
    else:
        fail += 1
        print("FAIL", name, extra)


def call(method, url, headers=None, body=None, raw_base=None, form=None):
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, (raw_base or API) + url]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if form:
        for k, v in form.items():
            cmd += ["-F", f"{k}={v}"]
    elif body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    text, code = out.rsplit("\n", 1)
    try:
        return int(code), json.loads(text)
    except Exception:
        return int(code), {"raw": text[:300]}


def rest(path, method="GET", body=None):
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY}
    if body is not None:
        h["Content-Type"] = "application/json"
    return call(method, path, h, body, raw_base=BASE + "/rest/v1")


def wait_outbox(kind, to_email, since_id, tries=14):
    # Return the row only once the mailerd has sent it; keep polling while it
    # sits 'queued', and return early on a terminal non-sent status.
    for _ in range(tries):
        _, rows = rest(f"/ex_outbox?kind=eq.{kind}&to_email=eq.{to_email}&id=gt.{since_id}&select=*&order=id.desc&limit=1")
        if rows:
            if rows[0]["status"] == "sent":
                return rows[0]
            if rows[0]["status"] in ("failed", "skipped_invalid_domain"):
                return rows[0]
        time.sleep(3)
    _, rows = rest(f"/ex_outbox?kind=eq.{kind}&to_email=eq.{to_email}&id=gt.{since_id}&select=*&order=id.desc&limit=1")
    return rows[0] if rows else None


# --- setup ---
_, w = rest("/ex_wallets?user_id=eq.1&select=balance_cents,held_cents")
founder_before = w[0]
_, ob = rest("/ex_outbox?select=id&order=id.desc&limit=1")
since = ob[0]["id"] if ob else 0
print("founder wallet before:", founder_before, "| outbox watermark:", since)

code, reg = call("POST", "/agent/register", body={
    "name": "Mail Probe", "category": "writing",
    "email": "zad112911@gmail.com", "skills": "writing, guides",
    "rate": 9, "tagline": "throwaway mail probe", "description": "throwaway mail probe"})
check("register probe agent 201", code == 201, str(reg)[:200])
with open("/tmp/mail_probe_state.json", "w") as f:
    json.dump(reg, f)
AG = {"X-Agent-Key": reg["api_key"]}
probe_user = reg["owner"]["id"]
probe_agent = reg["agent"]["id"]
print("probe user", probe_user, "agent", probe_agent)

# --- 1. founder posts the job -> job_posted emails to every other user ---
code, job = call("POST", "/jobs", {"X-API-Key": ADMIN}, {
    "title": "Write a one-page welcome guide for new Agent Exchange members",
    "description": "Write a friendly one-page welcome guide for people who just joined the Agent Exchange: what the marketplace is, how escrow protects both sides, how to place a first bid, and how delivery and payment work. Plain language, one page. Deliverable: the guide as a text or document file.",
    "category": "writing", "budget": 10, "mode": "bidding", "deadline_hours": 168})
check("founder posts job 201", code == 201, str(job)[:200])
job_id = job["id"]
print("job", job_id)

row = wait_outbox("job_posted", "zad112911@gmail.com", since)
check("job_posted email to probe owner queued+sent", bool(row) and row["status"] == "sent", str(row)[:200])
_, rows = rest(f"/ex_outbox?kind=eq.job_posted&id=gt.{since}&select=to_email,status")
recips = {r["to_email"] for r in rows}
check("job_posted went to all other users, not the poster",
      {"ayiijumo@gmail.com", "mceeomoba@outlook.com", "novaagent@mail.instinct.com", "zad112911@gmail.com"} <= recips
      and "fleet@novamail.store" not in recips, str(recips))

# --- 2. probe bids -> bid_received email to the poster ---
code, bid = call("POST", f"/agent/jobs/{job_id}/bid", AG, {"amount": 9, "eta_hours": 24, "pitch": "I can write this guide today."})
check("probe bid 201", code == 201, str(bid)[:200])
bid_id = bid["id"]
row = wait_outbox("bid_received", "fleet@novamail.store", since)
check("bid_received email to poster sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("bid email names bidder + amount", bool(row) and row["payload"].get("bidder_name") == "Mail Probe" and row["payload"].get("amount") == "$9.00", str(row and row["payload"])[:200])

# --- 3. founder awards -> job_awarded email to the winner's owner ---
code, aw = call("POST", f"/jobs/{job_id}/award", {"X-API-Key": ADMIN}, {"bid_id": bid_id})
check("award 200", code == 200, str(aw)[:200])
row = wait_outbox("job_awarded", "zad112911@gmail.com", since)
check("job_awarded email sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("award email carries a deadline", bool(row) and "UTC" in str(row["payload"].get("deadline", "")), str(row and row["payload"])[:200])

# --- 4. probe delivers a real file (web route, owner JWT) -> job_delivered ---
code, login = call("POST", "/auth/login", body={"email": "zad112911@gmail.com", "password": reg["owner"]["password"]})
check("probe owner login 200", code == 200, str(login)[:150])
token = login.get("token") or login.get("access_token") or (login.get("session") or {}).get("token")
with open("/tmp/welcome-guide.txt", "w") as f:
    f.write("Welcome to the Agent Exchange!\n\nThe Agent Exchange is a marketplace where people hire AI agents to do real work, and agents get hired and paid. Every job is protected by escrow: the poster's money is held safely when the job starts and is only released when the delivered work is approved.\n\nPlacing your first bid: open a job, read the brief, and bid the price you can do it for. Keep your delivery promise - the deadline in your award email is the time you committed to.\n\nDelivery: always deliver the actual files through the job page, with notes saying what is inside. Payment lands in your wallet the moment the poster approves.\n")
cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", "POST", API + f"/jobs/{job_id}/deliver",
       "-H", f"Authorization: Bearer {token}",
       "-F", "file=@/tmp/welcome-guide.txt", "-F", "notes=The welcome guide, as a text file. It covers what the marketplace is, escrow, placing a first bid, and how delivery and payment work."]
out = subprocess.run(cmd, capture_output=True, text=True).stdout
text, dcode = out.rsplit("\n", 1)
check("deliver with file 200", dcode == "200", text[:200])
row = wait_outbox("job_delivered", "fleet@novamail.store", since)
check("job_delivered email to poster sent", bool(row) and row["status"] == "sent", str(row)[:200])

# --- 5. founder completes -> payment_received + payment_sent ---
code, comp = call("POST", f"/jobs/{job_id}/complete", {"X-API-Key": ADMIN})
check("complete 200", code == 200, str(comp)[:200])
row = wait_outbox("payment_received", "zad112911@gmail.com", since)
check("payment_received email sent", bool(row) and row["status"] == "sent", str(row)[:200])
p = (row or {}).get("payload", {})
check("worker email: $8.10 in, wallet $0.00 -> $8.10",
      p.get("amount") == "$8.10" and p.get("wallet_before") == "$0.00" and p.get("wallet_after") == "$8.10", str(p)[:250])
row2 = wait_outbox("payment_sent", "fleet@novamail.store", since)
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
check("founder balance dropped by exactly the $9 award",
      fw["balance_cents"] == founder_before["balance_cents"] - 900 and fw["held_cents"] == founder_before["held_cents"],
      str(fw))

print(f"\nRESULT: {ok} passed, {fail} failed")
print(json.dumps({"job_id": job_id, "probe_user": probe_user, "probe_agent": probe_agent, "outbox_since": since}))
sys.exit(1 if fail else 0)
