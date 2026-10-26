#!/usr/bin/env python3
"""Live E2E for job-chat safety (owner order 2026-10-26). Posts ONE violating
test message to job 15 as the founder, proves it is stored + served fully
masked, then - in a finally block, so a failure can never leave residue -
deletes the message and ONLY the notifications created inside this test's
time window, and proves the thread and the mail outbox are exactly as
before. No email is ever queued by chat posts."""
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
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()

RAW = ("Safety test: see https://bad.example.com/x or mail me at tester99@gmail.com "
       "or call 323-487-8017, ig is @ swift.test99, this is fucking bad")
LEAKS = ["bad.example", "tester99", "487-8017", "swift.test99", "fuck"]


def curl(args, inp=None):
    r = subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True, text=True)
    return r.stdout


def rest(path, method="GET"):
    return curl(["-X", method, f"{REST}/{path}",
                 "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"])


def outbox_state():
    rows = json.loads(rest("ex_outbox?select=id&order=id.desc&limit=1"))
    cnt = json.loads(rest("ex_outbox?select=id"))
    return (rows[0]["id"] if rows else 0), len(cnt)


def msgs15():
    return json.loads(rest("ex_messages?job_id=eq.15&select=id,body&order=id.asc"))


before_ids = [m["id"] for m in msgs15()]
ob_max0, ob_cnt0 = outbox_state()
print(f"before: job15 ids={before_ids} outbox max={ob_max0} count={ob_cnt0}")
T0 = int(time.time()) - 5
mid = None
try:
    out = curl(["-X", "POST", f"{API}/jobs/15/messages",
                "-H", f"X-API-Key: {ADMIN_KEY}", "-H", "Content-Type: application/json",
                "-d", json.dumps({"body": RAW})])
    posted = json.loads(out)
    mid = posted.get("id")
    print("posted message id:", mid)
    assert mid, f"post failed: {out[:300]}"

    stored = [m for m in msgs15() if m["id"] == mid]
    assert stored, "test message not stored"
    body = stored[0]["body"]
    print("stored body:", body)
    for leak in LEAKS:
        assert leak not in body.lower(), f"LEAK in stored body: {leak}"
    assert body.count("[hidden]") >= 5, "expected at least 5 hidden parts"

    pj = json.loads(curl([f"{API}/jobs/15"]))
    pm = [m for m in pj.get("messages", []) if m["id"] == mid]
    assert pm, "test message missing from public read"
    for leak in LEAKS:
        assert leak not in pm[0]["body"].lower(), f"LEAK in public read: {leak}"
    print("public read body:", pm[0]["body"])
    print("PASS: stored + served fully masked")
finally:
    if mid:
        rest(f"ex_messages?id=eq.{mid}", method="DELETE")
    notifs = json.loads(rest(f"ex_notifications?user_id=eq.4&type=eq.message&created_at=gte.{T0}&select=id"))
    for n in notifs:
        rest(f"ex_notifications?id=eq.{n['id']}", method="DELETE")
        print("deleted notification", n["id"])

after_ids = [m["id"] for m in msgs15()]
ob_max1, ob_cnt1 = outbox_state()
assert after_ids == before_ids, f"thread not restored: {after_ids} vs {before_ids}"
assert (ob_max1, ob_cnt1) == (ob_max0, ob_cnt0), f"outbox changed {ob_max0}/{ob_cnt0} -> {ob_max1}/{ob_cnt1}"
print(f"restored: job15 ids={after_ids} outbox max={ob_max1} count={ob_cnt1} (zero mail)")
print("E2E COMPLETE")
