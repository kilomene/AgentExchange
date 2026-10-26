#!/usr/bin/env python3
"""Star-rating E2E (2026-10-26): a fresh mini-cycle ending in a 4-star
review for probe agent 39, so the review email to zad112911@gmail.com must
carry 4 gold star images + 1 pale star image embedded inline. The caller
then opens the real message in Gmail and counts the image parts.
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


_, ob = rest("/ex_outbox?select=id&order=id.desc&limit=1")
since = ob[0]["id"]
print("watermark:", since)

code, job = call("POST", "/jobs", {"X-API-Key": ADMIN}, {
    "title": "Proofread a one-page product description",
    "description": "Proofread a one-page product description for a fictional smart water bottle: fix grammar, tighten the wording, keep the friendly tone. Deliverable: the corrected description as a text file.",
    "category": "writing", "budget": 10, "mode": "bidding", "deadline_hours": 168})
jobE = job["id"]
check("job E posted", code == 201, str(job)[:150])
_, b1 = call("POST", f"/agent/jobs/{jobE}/bid", AG1, {"amount": 9, "eta_hours": 24, "pitch": "Sharp eye, same day."})
code, aw = call("POST", f"/jobs/{jobE}/award", {"X-API-Key": ADMIN}, {"bid_id": b1["id"]})
check("job E awarded", code == 200, str(aw)[:150])
code, dv = call("POST", f"/agent/jobs/{jobE}/deliver", AG1,
                {"notes": "The corrected product description, grammar fixed and wording tightened, at the link.", "link": "https://exchange.novamail.store/#/docs"})
check("job E delivered", code == 200, str(dv)[:200])
code, cp = call("POST", f"/jobs/{jobE}/action", {"X-API-Key": ADMIN}, {"action": "complete"})
check("job E completed", code == 200, str(cp)[:150])
code, rv = call("POST", f"/jobs/{jobE}/review", {"X-API-Key": ADMIN},
                {"stars": 4, "body": "Fast, clean work. Accurate and easy to read - one small formatting nit, otherwise excellent."})
check("4-star review posted", code in (200, 201), str(rv)[:200])

row = None
for _ in range(14):
    _, rows = rest(f"/ex_outbox?kind=eq.review_received&to_email=eq.zad112911@gmail.com&id=gt.{since}&select=*&order=id.desc&limit=1")
    if rows and rows[0]["status"] == "sent":
        row = rows[0]
        break
    if rows and rows[0]["status"] in ("failed", "skipped_invalid_domain"):
        row = rows[0]
        break
    time.sleep(3)
check("4-star review email sent", bool(row) and row["status"] == "sent", str(row)[:200])
check("payload stars == 4", bool(row) and row["payload"].get("stars") == 4, str(row and row["payload"])[:200])
print(f"\nRESULT: {ok} passed, {fail} failed")
print(json.dumps({"jobE": jobE, "review_outbox_id": (row or {}).get("id")}))
sys.exit(1 if fail else 0)
