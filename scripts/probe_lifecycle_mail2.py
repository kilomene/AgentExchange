#!/usr/bin/env python3
"""Live E2E probe, round 2 of lifecycle emails (2026-10-26).

Reuses round 1's probe agent 39 "Mail Probe" (owner zad112911@gmail.com,
user 41, wallet holds the $8.10 it earned) and the completed job 52.
Scenarios:
 R  founder reviews job 52        -> review_received to the worker's owner
 N  two agents bid, founder picks -> bid_not_selected to the loser's owner
    the other one                    (+ job_awarded to the winner's owner)
 C  founder cancels a bid-on job   -> job_cancelled to the bidder's owner
 D  deliver -> poster disputes    -> dispute_opened to worker AND admin
    -> admin resolves for agent    -> dispute_resolved to both, worker paid
All identities/jobs are printed at the end for the caller's cleanup.
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
reg1 = json.load(open("/tmp/mail_probe_state.json"))
AG1 = {"X-Agent-Key": reg1["api_key"]}
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


def wait_outbox(kind, to_email, since, tries=14):
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


def money(c):
    return "$" + f"{c/100:,.2f}"


_, ob = rest("/ex_outbox?select=id&order=id.desc&limit=1")
since = ob[0]["id"]
_, w = rest("/ex_wallets?user_id=eq.1&select=balance_cents,held_cents")
founder_start = w[0]
_, w = rest("/ex_wallets?user_id=eq.41&select=balance_cents,held_cents")
worker_start = w[0]["balance_cents"]
print("watermark:", since, "| founder:", founder_start, "| worker41 balance:", worker_start)

# ---------- R: review on completed job 52 ----------
code, rv = call("POST", "/jobs/52/review", {"X-API-Key": ADMIN},
                {"stars": 5, "body": "Clear, friendly guide delivered as a clean file. Exactly what the job asked for."})
check("review posted 200/201", code in (200, 201), str(rv)[:200])
row = wait_outbox("review_received", "zad112911@gmail.com", since)
check("review_received email sent", bool(row) and row["status"] == "sent", str(row)[:200])
p = (row or {}).get("payload", {})
check("review email: 5 stars + text + average",
      p.get("stars") == 5 and "friendly guide" in str(p.get("review", "")) and str(p.get("rating_avg")) in ("5", "5.0"),
      str(p)[:250])

# ---------- setup agent 2 ----------
code, reg2 = call("POST", "/agent/register", body={
    "name": "Mail Probe Two", "category": "content",
    "email": "mceeomoba@gmail.com", "skills": "design, content",
    "rate": 8, "tagline": "throwaway mail probe 2", "description": "throwaway mail probe 2"})
check("register probe agent 2 201", code == 201, str(reg2)[:200])
with open("/tmp/mail_probe2_state.json", "w") as f:
    json.dump(reg2, f)
AG2 = {"X-Agent-Key": reg2["api_key"]}

# ---------- N: not selected ----------
code, job = call("POST", "/jobs", {"X-API-Key": ADMIN}, {
    "title": "Design a simple price-list card for a coffee shop",
    "description": "One clean price-list card for a small coffee shop menu: espresso drinks and three pastries, prices in dollars, friendly tone. Deliverable: the card as a document or image file with the text laid out.",
    "category": "content", "budget": 10, "mode": "bidding", "deadline_hours": 168})
jobN = job["id"]
check("job N posted", code == 201, str(job)[:150])
_, b1 = call("POST", f"/agent/jobs/{jobN}/bid", AG1, {"amount": 9, "eta_hours": 24, "pitch": "Clean layout, same day."})
_, b2 = call("POST", f"/agent/jobs/{jobN}/bid", AG2, {"amount": 8.5, "eta_hours": 12, "pitch": "Cheaper and faster."})
check("both bids placed", "id" in b1 and "id" in b2, f"{b1} {b2}")
code, aw = call("POST", f"/jobs/{jobN}/award", {"X-API-Key": ADMIN}, {"bid_id": b2["id"]})
check("award to agent 2 200", code == 200, str(aw)[:150])
row = wait_outbox("bid_not_selected", "zad112911@gmail.com", since)
check("bid_not_selected email to loser owner sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("not-selected email names the winner", bool(row) and row["payload"].get("winner_name") == "Mail Probe Two", str(row and row["payload"])[:200])
row = wait_outbox("job_awarded", "mceeomoba@gmail.com", since)
check("job_awarded email to winner owner sent", bool(row) and row["status"] == "sent", str(row)[:200])
code, dv = call("POST", f"/agent/jobs/{jobN}/deliver", AG2,
                {"notes": "The price-list card, laid out as a document with all drinks and pastries priced. Download link attached.", "link": "https://exchange.novamail.store/#/docs"})
check("agent 2 delivers", code == 200, str(dv)[:200])
code, cp = call("POST", f"/jobs/{jobN}/action", {"X-API-Key": ADMIN}, {"action": "complete"})
check("job N completed", code == 200, str(cp)[:150])

# ---------- C: cancelled ----------
code, job = call("POST", "/jobs", {"X-API-Key": ADMIN}, {
    "title": "Write five taglines for a fictional bakery",
    "description": "Five short, warm taglines for a fictional neighborhood bakery called Golden Crust. Deliverable: the five taglines in a text file.",
    "category": "writing", "budget": 10, "mode": "bidding", "deadline_hours": 168})
jobC = job["id"]
_, b1 = call("POST", f"/agent/jobs/{jobC}/bid", AG1, {"amount": 9, "eta_hours": 24, "pitch": "Sweet and short."})
check("bid on job C placed", "id" in b1, str(b1)[:150])
code, cx = call("POST", f"/jobs/{jobC}/action", {"X-API-Key": ADMIN}, {"action": "cancel"})
check("job C cancelled 200", code == 200, str(cx)[:150])
row = wait_outbox("job_cancelled", "zad112911@gmail.com", since)
check("job_cancelled email to bidder owner sent", bool(row) and row["status"] == "sent", str(row)[:200])

# ---------- D: dispute opened + resolved for the agent ----------
code, job = call("POST", "/jobs", {"X-API-Key": ADMIN}, {
    "title": "Summarize a one-page article about remote work",
    "description": "Summarize a one-page article about remote work trends into five bullet points a busy manager can read in one minute. Deliverable: the summary as a text file.",
    "category": "writing", "budget": 10, "mode": "bidding", "deadline_hours": 168})
jobD = job["id"]
_, b1 = call("POST", f"/agent/jobs/{jobD}/bid", AG1, {"amount": 9, "eta_hours": 24, "pitch": "Crisp bullets, same day."})
code, aw = call("POST", f"/jobs/{jobD}/award", {"X-API-Key": ADMIN}, {"bid_id": b1["id"]})
check("job D awarded", code == 200, str(aw)[:150])
code, dv = call("POST", f"/agent/jobs/{jobD}/deliver", AG1,
                {"notes": "The five-bullet summary of the remote-work article, as a text document at the link.", "link": "https://exchange.novamail.store/#/docs"})
check("job D delivered", code == 200, str(dv)[:200])
code, dp = call("POST", f"/jobs/{jobD}/action", {"X-API-Key": ADMIN},
                {"action": "dispute", "reason": "Probe dispute: checking the dispute emails end to end."})
check("dispute opened 200", code == 200, str(dp)[:150])
row = wait_outbox("dispute_opened", "zad112911@gmail.com", since)
check("dispute_opened email to worker sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("dispute email carries the reason", bool(row) and "checking the dispute emails" in str(row["payload"].get("reason", "")), str(row and row["payload"])[:200])
row = wait_outbox("dispute_opened", "fleet@novamail.store", since)
check("dispute_opened email to admin sent (admin flag)", bool(row) and row["status"] == "sent" and row["payload"].get("admin") is True, str(row)[:200])
code, rs = call("POST", f"/admin/jobs/{jobD}/resolve", {"X-API-Key": ADMIN}, {"resolution": "agent"})
check("dispute resolved for agent 200", code == 200, str(rs)[:150])
row = wait_outbox("dispute_resolved", "zad112911@gmail.com", since)
check("dispute_resolved email to worker sent", bool(row) and row["status"] == "sent", str(row)[:200])
_, w = rest("/ex_wallets?user_id=eq.41&select=balance_cents")
exp_after = money(w[0]["balance_cents"])
p = (row or {}).get("payload", {})
check("resolved email: $8.10 received + wallet figure matches reality",
      p.get("amount") == "$8.10" and p.get("wallet_after") == exp_after,
      f"payload={str(p)[:250]} expected wallet_after={exp_after}")
row = wait_outbox("dispute_resolved", "fleet@novamail.store", since)
check("dispute_resolved email to poster sent", bool(row) and row["status"] == "sent", str(row)[:200])

_, w = rest("/ex_wallets?user_id=eq.1&select=balance_cents,held_cents")
check("founder held back to start (all jobs settled)",
      w[0]["held_cents"] == founder_start["held_cents"], f"start={founder_start} now={w[0]}")

print(f"\nRESULT: {ok} passed, {fail} failed")
print(json.dumps({"jobN": jobN, "jobC": jobC, "jobD": jobD,
                  "agent2_user": reg2["owner"]["id"], "agent2_agent": reg2["agent"]["id"],
                  "founder_start": founder_start, "founder_now": w[0]}))
sys.exit(1 if fail else 0)
