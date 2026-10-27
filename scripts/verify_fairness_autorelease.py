#!/usr/bin/env python3
"""Live E2E for the FAIRNESS LOCKED DESIGN + SHADOW BAN + WALLET FREEZE
(owner orders 2026-10-27). Covers, against the LIVE deployed function
and one-shot sweeper cycles:
  - acceptance checklist stored at post + derived default when absent
  - checklist FROZEN at award (downstream logic reads only the frozen
    snapshot - proven by mutating the live column and showing dispute
    validation still keys on the frozen list)
  - deliver sets the delivery map + review_deadline = delivered_at+48h
  - dispute without item / short evidence / out-of-frozen-range item
    -> 400; valid dispute opens the evidence round (+48h, admin +3d)
  - dispute_respond once only; re-deliver once only (deadline extends)
  - sweeper dispute-default past the admin deadline auto-pays the
    worker EXACTLY (fee + guarantee pool) and strikes the poster
  - sweeper auto-release on a past-deadline delivered job pays EXACTLY
  - reminder flags fire once and not twice (24h + 6h, one mail each)
  - per-milestone 48h auto-release pays the milestone share exactly
  - contract job with a recorded final_outcome refuses dispute
  - shadow ban: profile 404 public/other, 200 owner+admin, list /
    leaderboard / floor exclusion, audit row, NO notification, unban
    restores exactly
  - wallet freeze: payout create rejected, pre-freeze payout held at
    the walletd execution re-check (logic test, no chain send),
    deposit path unaffected, unfreeze restores payout creation
House style: mailer PAUSEd throughout, everything seeded/acted via
the real API where a route exists, full reversal in finally, wallet /
outbox / pool baselines asserted byte-identical at the end."""
import base64
import hashlib
import hmac as hmac_mod
import io
import json
import subprocess
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = {}
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip()
SRK = ENV["SUPABASE_SERVICE_ROLE_KEY"]
JWT_SECRET = ENV["EXCHANGE_JWT_SECRET"]
REST = "https://xjpfyqzqqjeejrxzafth.supabase.co/rest/v1"
API = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api"
ADMIN_KEY = (ROOT / ".admin-api-key").read_text().strip()
PAUSE = Path.home() / ".exchange-mail" / "PAUSE"
AMOUNT, FEE = 1500, 150
POOL_CUT = FEE // 10  # 10% of the fee funds the guarantee pool
CHECKS = 0


def ok(cond, label, extra=""):
    global CHECKS
    CHECKS += 1
    assert cond, f"FAIL: {label} {extra}"
    print(f"  ok {CHECKS}: {label}")


def curl(args, inp=None):
    return subprocess.run(["curl", "-s"] + args, input=inp, capture_output=True).stdout.decode()


def rest(path, method="GET", body=None):
    a = ["-X", method, f"{REST}/{path}", "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"]
    if body is not None:
        a += ["-H", "Content-Type: application/json", "-H", "Prefer: return=representation",
              "-d", json.dumps(body)]
    out = curl(a)
    return json.loads(out) if out.strip() else []


def rpc(name, params):
    out = curl(["-X", "POST", f"{REST}/rpc/{name}", "-H", f"apikey: {SRK}",
                "-H", f"Authorization: Bearer {SRK}", "-H", "Content-Type: application/json",
                "-d", json.dumps(params)])
    return out


def sql(stmt):
    f = Path("/tmp/verify_fairness.sql")
    f.write_text(stmt)
    r = subprocess.run(["python3", str(ROOT / "scripts/apply_sql.py"), str(f)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def jwt_for(uid):
    def b64(x):
        return base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    now_s = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    pay = b64(json.dumps({"sub": uid, "iat": now_s, "exp": now_s + 3600}).encode())
    sig = b64(hmac_mod.new(JWT_SECRET.encode(), f"{head}.{pay}".encode(), hashlib.sha256).digest())
    return f"{head}.{pay}.{sig}"


def api(method, path, jwt=None, api_key=None, agent_key=None, body=None, form=None):
    a = ["-X", method, f"{API}{path}", "-w", "\n%{http_code}"]
    if jwt:
        a += ["-H", f"Authorization: Bearer {jwt}"]
    if api_key:
        a += ["-H", f"X-API-Key: {api_key}"]
    if agent_key:
        a += ["-H", f"X-Agent-Key: {agent_key}"]
    if form:
        for k, v in form:
            a += ["-F", f"{k}={v}"]
    elif body is not None:
        a += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    raw = curl(a)
    text, _, code = raw.rpartition("\n")
    try:
        parsed = json.loads(text) if text.strip() else {}
    except Exception:
        parsed = {"raw": text}
    return int(code), parsed


def wallet(uid):
    rows = rest(f"ex_wallets?user_id=eq.{uid}&select=balance_cents,held_cents")
    return rows[0]["balance_cents"], rows[0]["held_cents"]


def pool():
    rows = rest("ex_settings?key=eq.guarantee_pool_cents&select=value")
    return int(rows[0]["value"])


def outbox_state():
    rows = rest("ex_outbox?select=id&order=id.desc&limit=1")
    cnt = rest("ex_outbox?select=id")
    return (rows[0]["id"] if rows else 0), len(cnt)


def user_row(uid):
    return rest(f"ex_users?id=eq.{uid}&select=*")[0]


def agent13():
    return rest("ex_agents?id=eq.13&select=jobs_completed,earnings_cents,strikes")[0]


def job_row(jid):
    return rest(f"ex_jobs?id=eq.{jid}&select=*")[0]


def sweeper_once():
    env = dict(__import__("os").environ)
    env.update({
        "SUPABASE_URL": ENV["SUPABASE_URL"],
        "SUPABASE_SERVICE_ROLE_KEY": SRK,
        "SWEEPER_ONLY": "fairness",
        "SWEEPER_ONCE": "1",
    })
    r = subprocess.run(["node", "sweeper/service.mjs"], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    return r.stdout


def make_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("index.html", "<!doctype html><html><head><title>Verify</title></head><body>ok</body></html>")
        z.writestr("README.md", "# Verify delivery\nOpen index.html. Replace nothing.")
    p = Path("/tmp/verify_fairness.zip")
    p.write_bytes(buf.getvalue())
    return str(p)


def post_job(jwt, payload):
    code, r = api("POST", "/jobs", jwt=jwt, body=payload)
    assert code in (200, 201), (code, r)
    j = r.get("job") or r
    return j["id"]


def seed_bid_award(job_id, jwt_poster):
    now_s = int(time.time())
    bid = rest("ex_bids", method="POST", body={
        "job_id": job_id, "agent_id": 13, "bidder_user_id": 4,
        "amount_cents": AMOUNT, "eta_hours": 24, "pitch": "verify bid",
        "status": "active", "created_at": now_s})[0]
    code, r = api("POST", f"/jobs/{job_id}/award", jwt=jwt_poster, body={"bid_id": bid["id"]})
    assert code in (200, 201), (code, r)
    return bid["id"]


def deliver_zip(job_id, jwt, checklist_map=None, notes="ZIP with index.html and README - open index.html, replace nothing."):
    form = [("action", "deliver"), ("deliverable", notes),
            ("file", f"@{make_zip()};type=application/zip")]
    if checklist_map is not None:
        # multipart field order matters little; file must keep its @ form
        form = [("action", "deliver"), ("deliverable", notes),
                ("delivery_checklist_map", json.dumps(checklist_map)),
                ("file", f"@{make_zip()};type=application/zip")]
    return api("POST", f"/jobs/{job_id}/action", jwt=jwt, form=form)


def main():
    assert not PAUSE.exists(), "PAUSE already present - someone else paused the mailer; stop"
    PAUSE.write_text("verify_fairness_autorelease\n")
    time.sleep(6)
    T0 = int(time.time()) - 5
    J1 = jwt_for(1)
    J4 = jwt_for(4)
    created_jobs, settled = [], []
    throw = {"user": None, "agent": None, "job": None, "payouts": []}
    w1_0, w4_0 = wallet(1), wallet(4)
    ob0 = outbox_state()
    pool0 = pool()
    ag0 = agent13()
    strikes0 = user_row(1)["strikes"] or 0
    exp_w4 = w4_0[0]      # expected user-4 balance, tracked through settlements
    exp_pool = pool0
    print(f"baseline: founder {w1_0} user4 {w4_0} pool {pool0} outbox {ob0} agent13 {ag0} strikes1 {strikes0}")
    try:
        # ---------- 1. checklist stored at post + derived default ----------
        print("== checklist at post ==")
        checklist_a = ["Full report in a ZIP", "Sources cited for every claim", "Summary under 300 words"]
        ja = post_job(J1, {"title": "VERIFY fairness A (throwaway)", "description": "Throwaway fairness verification job A.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": checklist_a})
        created_jobs.append(ja)
        jr = job_row(ja)
        ok(jr["acceptance_checklist"] == checklist_a, "posted checklist stored verbatim", str(jr["acceptance_checklist"]))
        jd = post_job(J1, {"title": "VERIFY fairness derived (throwaway)",
                           "description": "Research task. Deliverable: a one-page PDF brief.",
                           "category": "research", "budget": 15, "mode": "bidding"})
        created_jobs.append(jd)
        jr = job_row(jd)
        ok(isinstance(jr["acceptance_checklist"], list) and len(jr["acceptance_checklist"]) == 1
           and "one-page PDF brief" in jr["acceptance_checklist"][0],
           "absent checklist derives a single item from the deliverable", str(jr["acceptance_checklist"]))
        code, r = api("POST", f"/jobs/{jd}/action", jwt=J1, body={"action": "cancel"})
        ok(code == 200, "derived-default job cancelled again (escrow refunded)", str(r)[:200])

        # ---------- 2. freeze at award ----------
        print("== freeze at award ==")
        seed_bid_award(ja, J1)
        jr = job_row(ja)
        ok(jr["status"] == "awarded" and jr["checklist_frozen"] == checklist_a and jr["checklist_frozen_at"],
           "checklist frozen at award with timestamp", str({k: jr[k] for k in ("status", "checklist_frozen", "checklist_frozen_at")}))
        # mutate the LIVE column: 6 items incl. index 5 which the frozen list lacks
        rest(f"ex_jobs?id=eq.{ja}", method="PATCH",
             body={"acceptance_checklist": checklist_a + ["EXTRA X", "EXTRA Y", "EXTRA Z"]})
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J1, body={"action": "edit", "acceptance_checklist": ["hacked"]})
        ok(code >= 400, "post-award checklist edit attempt rejected", f"{code} {str(r)[:160]}")

        # ---------- 3. delivery: map + 48h clock ----------
        print("== delivery ==")
        cmap = ["index.html + README in the ZIP", "README lists every source", "README opens with the summary"]
        code, r = deliver_zip(ja, J4, checklist_map=cmap)
        ok(code == 200 and (r.get("job") or {}).get("status") == "delivered", "worker delivered job A", f"{code} {str(r)[:200]}")
        jr = job_row(ja)
        ok(jr["delivery_checklist_map"] == cmap, "delivery checklist map stored", str(jr["delivery_checklist_map"]))
        ok(abs((jr["review_deadline"] - jr["delivered_at"]) - 172800) <= 5,
           "review_deadline = delivered_at + 48h", f"{jr['delivered_at']} -> {jr['review_deadline']}")
        code, r = api("GET", f"/jobs/{ja}/evidence", api_key=ADMIN_KEY)
        fair = (r.get("evidence") or {}).get("fairness") or {}
        ok(fair.get("checklist") == checklist_a and len(fair.get("promised_vs_delivered") or []) == 3
           and fair["promised_vs_delivered"][1]["delivery_note"] == cmap[1],
           "evidence pack shows promised-vs-delivered from the FROZEN list", str(fair)[:240])

        # ---------- 4/5/6. dispute validation + evidence round ----------
        print("== dispute validation + evidence round ==")
        ev60 = "The ZIP has no sources section at all, item two was promised but is missing entirely."
        assert len(ev60) >= 40
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J1, body={"action": "dispute", "dispute_evidence": ev60})
        ok(code == 400, "dispute without a checklist item -> 400", f"{code} {str(r)[:160]}")
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J1,
                      body={"action": "dispute", "dispute_item_index": 1, "dispute_evidence": "too short"})
        ok(code == 400, "dispute with short evidence -> 400", f"{code} {str(r)[:160]}")
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J1,
                      body={"action": "dispute", "dispute_item_index": 5, "dispute_evidence": ev60})
        ok(code == 400, "dispute item valid only in the MUTATED list -> 400 (frozen list rules)",
           f"{code} {str(r)[:160]}")
        rest(f"ex_jobs?id=eq.{ja}", method="PATCH", body={"acceptance_checklist": checklist_a})
        t_dispute = int(time.time())
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J1,
                      body={"action": "dispute", "dispute_item_index": 1, "dispute_evidence": ev60})
        ok(code == 200, "valid dispute (frozen item 1 + substantive evidence) opens", f"{code} {str(r)[:160]}")
        jr = job_row(ja)
        ok(jr["status"] == "disputed" and jr["dispute_item_index"] == 1 and jr["dispute_evidence"] == ev60,
           "dispute record stored (item + evidence)", str({k: jr[k] for k in ("status", "dispute_item_index")}))
        ok(abs(jr["dispute_deadline"] - (t_dispute + 172800)) <= 300
           and jr["dispute_admin_deadline"] - jr["dispute_deadline"] == 259200,
           "evidence round = +48h, admin deadline = +3 days after", f"{jr['dispute_deadline']} / {jr['dispute_admin_deadline']}")
        dl_before = jr["dispute_deadline"]
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J4,
                      body={"action": "dispute_respond", "response": "Sources are in the README, section two, every claim has one."})
        ok(code == 200, "worker dispute_respond accepted (once)", f"{code} {str(r)[:160]}")
        code, r = api("POST", f"/jobs/{ja}/action", jwt=J4,
                      body={"action": "dispute_respond", "response": "Second response must fail."})
        ok(code >= 400, "second dispute_respond rejected", f"{code} {str(r)[:160]}")
        code, r = deliver_zip(ja, J4, checklist_map=cmap)
        ok(code == 200, "re-delivery inside the evidence round accepted", f"{code} {str(r)[:160]}")
        jr = job_row(ja)
        ok(jr["status"] == "disputed" and jr["dispute_redelivered"] is True and jr["dispute_deadline"] > dl_before,
           "re-delivery refreshed the pack and extended the dispute deadline once",
           str({k: jr[k] for k in ("status", "dispute_redelivered", "dispute_deadline")}))
        code, r = deliver_zip(ja, J4, checklist_map=cmap)
        ok(code >= 400, "second re-delivery rejected", f"{code} {str(r)[:160]}")

        # ---------- 7. dispute default (no admin decision) ----------
        print("== dispute default ==")
        rest(f"ex_jobs?id=eq.{ja}", method="PATCH", body={"dispute_admin_deadline": int(time.time()) - 10})
        out = sweeper_once()
        jr = job_row(ja)
        ok(jr["status"] == "completed" and jr["settled_via"] == "dispute_default_no_admin",
           "disputed job past admin deadline auto-resolved FOR THE WORKER", jr["settled_via"] or "")
        settled.append(ja)
        exp_w4 += AMOUNT - FEE
        exp_pool += POOL_CUT
        ok(wallet(4)[0] == exp_w4, f"worker paid exactly: user4 balance == {exp_w4}", str(wallet(4)))
        ok(pool() == exp_pool, f"guarantee pool +{POOL_CUT} == {exp_pool}", str(pool()))
        ok((user_row(1)["strikes"] or 0) == strikes0 + 1, "poster took the dispute-loss strike",
           str(user_row(1)["strikes"]))

        # ---------- 3b. auto-release on silence ----------
        print("== auto-release ==")
        jb = post_job(J1, {"title": "VERIFY fairness B auto-release (throwaway)", "description": "Throwaway fairness job B.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["Report delivered", "Sources cited"]})
        created_jobs.append(jb)
        seed_bid_award(jb, J1)
        code, r = deliver_zip(jb, J4)
        ok(code == 200, "job B delivered (no map - map is optional)", f"{code} {str(r)[:160]}")
        rest(f"ex_jobs?id=eq.{jb}", method="PATCH", body={"review_deadline": int(time.time()) - 60})
        sweeper_once()
        jr = job_row(jb)
        ok(jr["status"] == "completed" and jr["settled_via"] == "auto_release_silence",
           "past-deadline delivered job auto-released on silence", jr["settled_via"] or "")
        settled.append(jb)
        exp_w4 += AMOUNT - FEE
        exp_pool += POOL_CUT
        ok(wallet(4)[0] == exp_w4 and pool() == exp_pool,
           f"auto-release wallet math exact (user4 {exp_w4}, pool {exp_pool})", f"{wallet(4)} pool {pool()}")

        # ---------- 4b. reminders fire once ----------
        print("== reminders ==")
        jc = post_job(J1, {"title": "VERIFY fairness C reminders (throwaway)", "description": "Throwaway fairness job C.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["Report delivered", "Sources cited"]})
        created_jobs.append(jc)
        seed_bid_award(jc, J1)
        code, r = deliver_zip(jc, J4, checklist_map=["in the ZIP", "README sources section"])
        ok(code == 200, "job C delivered", f"{code} {str(r)[:160]}")

        def reminder_mails(jid):
            rows = rest(f"ex_outbox?kind=eq.review_reminder&created_at=gte.{T0}&select=id,payload")
            return [x for x in rows if f"#/job/{jid}" in json.dumps(x.get("payload") or {})]

        rest(f"ex_jobs?id=eq.{jc}", method="PATCH", body={"review_deadline": int(time.time()) + 23 * 3600})
        sweeper_once()
        jr = job_row(jc)
        ok(jr["reminder_24h_sent"] is True and jr["reminder_6h_sent"] is False and len(reminder_mails(jc)) == 1,
           "24h reminder fired once (flag + exactly one queued email)",
           str({k: jr[k] for k in ("reminder_24h_sent", "reminder_6h_sent")}))
        sweeper_once()
        jr = job_row(jc)
        ok(len(reminder_mails(jc)) == 1 and jr["reminder_6h_sent"] is False,
           "second sweeper cycle does NOT re-fire the 24h reminder", "")
        rest(f"ex_jobs?id=eq.{jc}", method="PATCH", body={"review_deadline": int(time.time()) + 5 * 3600})
        sweeper_once()
        jr = job_row(jc)
        ok(jr["reminder_6h_sent"] is True and len(reminder_mails(jc)) == 2,
           "6h reminder fired (second and last reminder mail)", str(len(reminder_mails(jc))))
        sweeper_once()
        ok(len(reminder_mails(jc)) == 2, "reminders never fire a third time", "")
        code, r = api("POST", f"/jobs/{jc}/action", jwt=J1, body={"action": "complete"})
        ok(code == 200, "job C completed by poster approval", f"{code} {str(r)[:160]}")
        settled.append(jc)
        exp_w4 += AMOUNT - FEE
        exp_pool += POOL_CUT

        # ---------- 3c. per-milestone auto-release ----------
        print("== milestones ==")
        jdm = post_job(J1, {"title": "VERIFY fairness D milestones (throwaway)", "description": "Throwaway milestone job.",
                            "category": "research", "budget": 15, "mode": "bidding",
                            "acceptance_checklist": ["Both parts delivered"],
                            "milestones": [{"title": "Part one", "pct": 50}, {"title": "Part two", "pct": 50}]})
        created_jobs.append(jdm)
        seed_bid_award(jdm, J1)
        ms = rest(f"ex_milestones?job_id=eq.{jdm}&select=*&order=idx.asc")
        ok(len(ms) == 2 and [m["amount_cents"] for m in ms] == [750, 750],
           "milestones priced at award (750/750)", str([m["amount_cents"] for m in ms]))
        m1, m2 = ms[0], ms[1]
        code, r = api("POST", f"/jobs/{jdm}/milestones/{m1['id']}/deliver", jwt=J4,
                      form=[("deliverable", "Part one delivered - ZIP with the files, replace nothing."),
                            ("file", f"@{make_zip()};type=application/zip")])
        ok(code == 200, "milestone 1 delivered via API", f"{code} {str(r)[:200]}")
        m1r = rest(f"ex_milestones?id=eq.{m1['id']}&select=*")[0]
        ok(abs((m1r["review_deadline"] - m1r["delivered_at"]) - 172800) <= 5,
           "milestone review_deadline = delivered_at + 48h", f"{m1r['delivered_at']} -> {m1r['review_deadline']}")
        rest(f"ex_milestones?id=eq.{m1['id']}", method="PATCH", body={"review_deadline": int(time.time()) - 60})
        ag_before = agent13()
        sweeper_once()
        m1r = rest(f"ex_milestones?id=eq.{m1['id']}&select=*")[0]
        exp_w4 += 750 - 75
        ok(m1r["status"] == "released" and wallet(4)[0] == exp_w4,
           f"milestone auto-release paid exactly 750-75 (user4 {exp_w4})", f"{m1r['status']} {wallet(4)}")
        ok(job_row(jdm)["status"] != "completed" and agent13()["jobs_completed"] == ag_before["jobs_completed"],
           "job not completed and stats untouched until the last milestone", "")
        code, r = api("POST", f"/jobs/{jdm}/milestones/{m2['id']}/deliver", jwt=J4,
                      form=[("deliverable", "Part two delivered - ZIP with the files, replace nothing."),
                            ("file", f"@{make_zip()};type=application/zip")])
        ok(code == 200, "milestone 2 delivered via API", f"{code} {str(r)[:200]}")
        code, r = api("POST", f"/jobs/{jdm}/milestones/{m2['id']}/release", jwt=J1, body={})
        ok(code == 200, "milestone 2 released by poster", f"{code} {str(r)[:200]}")
        exp_w4 += 750 - 75
        exp_pool += POOL_CUT
        settled.append(jdm)
        ok(job_row(jdm)["status"] == "completed" and wallet(4)[0] == exp_w4 and pool() == exp_pool,
           f"milestone job finalized exactly (user4 {exp_w4}, pool {exp_pool})", f"{wallet(4)} pool {pool()}")

        # ---------- 8. contract job with recorded outcome refuses dispute ----------
        print("== contract dispute refusal ==")
        now_s = int(time.time())
        je = rest("ex_jobs", method="POST", body={
            "poster_user_id": 1, "title": "VERIFY fairness E contract (throwaway)",
            "description": "Throwaway contract job.", "category": "business", "mode": "bidding",
            "budget_cents": AMOUNT, "status": "delivered", "job_kind": "contract",
            "awarded_agent_id": 13, "agreed_cents": AMOUNT, "fee_cents": FEE,
            "delivered_at": now_s, "review_deadline": now_s + 172800,
            "acceptance_checklist": ["Email sent and answered"], "checklist_frozen": ["Email sent and answered"],
            "checklist_frozen_at": now_s, "deliverable": "", "dispute_reason": "",
            "created_at": now_s, "updated_at": now_s})[0]["id"]
        created_jobs.append(je)
        rest("ex_contract_jobs", method="POST", body={
            "job_id": je, "capability": "email_send", "contact_name": "", "contact_phone": "",
            "brief_extra": "", "questions": [], "window_tz": "UTC", "window_start": now_s - 3600,
            "window_end": now_s + 3600, "max_attempts": 3, "pay_rule": {"sent_completed": 100},
            "poster_attestation": "", "final_outcome": "sent_completed", "proof_transcript": "",
            "proof_answers": [], "window_notified": False, "created_at": now_s,
            "recipient_email": "", "email_subject": "", "email_instructions": "",
            "proof_headers": "", "proof_body": "", "schedule_file_name": "", "schedule_file_size": 0,
            "schedule_file_type": "", "schedule_storage_path": "", "schedule_sha256": "",
            "schedule_cadence": "", "est_minutes": 0})
        sql(f"select ex_hold_escrow(1, {AMOUNT}, 'job:{je}', 'verify hold', {now_s});")
        code, r = api("POST", f"/jobs/{je}/action", jwt=J1,
                      body={"action": "dispute", "dispute_item_index": 0, "dispute_evidence": ev60})
        ok(code == 400 and "cannot be disputed away" in json.dumps(r),
           "contract job with recorded final_outcome refuses dispute", f"{code} {str(r)[:200]}")
        sql(f"select ex_refund_escrow(1, {AMOUNT}, 'job:{je}', 'verify cleanup refund', {int(time.time())});")
        rest(f"ex_contract_jobs?job_id=eq.{je}", method="DELETE")
        rest(f"ex_jobs?id=eq.{je}", method="DELETE")
        created_jobs.remove(je)

        # ---------- A. shadow ban ----------
        print("== shadow ban ==")
        now_s = int(time.time())
        tuid = rest("ex_users", method="POST", body={
            "email": f"verify-throwaway-{now_s}@example.com", "name": "Verify Throwaway",
            "password_hash": "x", "role": "user", "created_at": now_s, "email_verified": True})[0]["id"]
        throw["user"] = tuid
        rest("ex_wallets", method="POST", body={"user_id": tuid, "balance_cents": 0, "held_cents": 0})
        plain_key = f"verifykey{now_s}"
        tagent = rest("ex_agents", method="POST", body={
            "owner_id": tuid, "name": f"VerifyThrow Agent {now_s}", "status": "active",
            "is_human": False, "category": "research",
            "api_key_hash": hashlib.sha256(plain_key.encode()).hexdigest(), "created_at": now_s})[0]
        throw["agent"] = tagent["id"]
        tjob = rest("ex_jobs", method="POST", body={
            "poster_user_id": tuid, "title": f"VerifyThrow open job {now_s}", "description": "throwaway",
            "category": "research", "mode": "bidding", "budget_cents": 1000, "status": "open",
            "job_kind": "standard", "deliverable": "", "dispute_reason": "",
            "created_at": now_s, "updated_at": now_s})[0]["id"]
        throw["job"] = tjob
        JT = jwt_for(tuid)
        code, r = api("GET", "/agent/help", agent_key=plain_key)
        ok(code == 200 and "fairness_auto_release" in json.dumps(r),
           "agent help carries the fairness_auto_release policy", f"{code}")
        code, r = api("GET", f"/agents?q=VerifyThrow", jwt=None)
        ok(any(a["id"] == tagent["id"] for a in r.get("agents", [])), "agent listed before ban", "")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 200, "agent profile public 200 before ban", f"{code}")
        code, r = api("GET", "/jobs", jwt=None)
        ok(any(j["id"] == tjob for j in r.get("jobs", [])), "open job on the floor before ban", "")
        t_ban = int(time.time())
        code, r = api("POST", f"/admin/users/{tuid}/shadow-ban", api_key=ADMIN_KEY, body={"banned": True})
        ok(code == 200 and r.get("shadow_banned") is True, "admin shadow-ban endpoint", f"{code} {str(r)[:120]}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 404, "shadow-banned profile 404 for the public", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=J4)
        ok(code == 404, "shadow-banned profile 404 for other signed-in users", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=JT)
        ok(code == 200, "shadow-banned profile still 200 for the OWNER", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", api_key=ADMIN_KEY)
        ok(code == 200, "shadow-banned profile still 200 for ADMIN", f"{code}")
        code, r = api("GET", "/agents?q=VerifyThrow", jwt=None)
        ok(not any(a["id"] == tagent["id"] for a in r.get("agents", [])), "agent gone from list/search while banned", "")
        code, r = api("GET", "/leaderboard", jwt=None)
        ok(not any(a["id"] == tagent["id"] for a in r.get("agents", [])), "agent gone from leaderboard while banned", "")
        code, r = api("GET", "/jobs", jwt=None)
        ok(not any(j["id"] == tjob for j in r.get("jobs", [])), "open jobs gone from the floor while banned", "")
        code, r = api("GET", f"/jobs/{tjob}", jwt=None)
        ok(code == 404, "banned poster's job detail 404 for the public", f"{code}")
        code, r = api("GET", f"/jobs/{tjob}", jwt=JT)
        ok(code == 200, "banned poster still opens their own job", f"{code}")
        audit = rest(f"ex_admin_audit?target_user_id=eq.{tuid}&action=eq.shadow_ban&select=id")
        ok(len(audit) >= 1, "shadow ban written to the admin audit trail", "")
        notifs = rest(f"ex_notifications?user_id=eq.{tuid}&created_at=gte.{t_ban}&select=id")
        ok(len(notifs) == 0, "NO notification of any kind reached the banned user", str(notifs))
        code, r = api("POST", f"/admin/users/{tuid}/shadow-ban", api_key=ADMIN_KEY, body={"banned": False})
        ok(code == 200 and r.get("shadow_banned") is False, "admin unban endpoint", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 200, "unban restores the public profile exactly", f"{code}")
        code, r = api("GET", "/jobs", jwt=None)
        ok(any(j["id"] == tjob for j in r.get("jobs", [])), "unban restores floor visibility exactly", "")

        # ---------- B. wallet freeze ----------
        print("== wallet freeze ==")
        sql(f"select ex_move_balance({tuid}, 2000, 'test_fund', 'verify:freeze', 'e2e funding', {int(time.time())});")
        evm = "0x" + "11" * 20
        code, r = api("POST", "/wallet/payout", jwt=JT,
                      body={"amount": 10, "method": "crypto", "asset": "USDT", "destination": evm})
        ok(code == 201, "payout creation works before freeze", f"{code} {str(r)[:160]}")
        throw["payouts"].append(r["id"])
        code, r = api("POST", f"/admin/users/{tuid}/wallet-freeze", api_key=ADMIN_KEY,
                      body={"frozen": True, "reason": "e2e freeze test"})
        ok(code == 200 and r.get("wallet_frozen") is True, "admin wallet-freeze endpoint", f"{code} {str(r)[:120]}")
        code, r = api("POST", "/wallet/payout", jwt=JT,
                      body={"amount": 10, "method": "crypto", "asset": "USDT", "destination": evm})
        ok(code == 403 and "frozen" in json.dumps(r).lower(),
           "frozen wallet payout creation rejected - not a single penny", f"{code} {str(r)[:200]}")
        code, r = api("GET", "/wallet", jwt=JT)
        ok((r.get("wallet") or {}).get("wallet_frozen") is True,
           "owner sees the frozen state on their own wallet", str(r.get("wallet"))[:160])
        rest(f"ex_payouts?id=eq.{throw['payouts'][0]}", method="PATCH", body={"execution_status": "approved"})
        r2 = subprocess.run(["node", "wallet-service/test/freeze.test.mjs"], cwd=ROOT,
                            capture_output=True, text=True)
        ok(r2.returncode == 0 and "ALL ASSERTIONS PASSED" in r2.stdout,
           "walletd execution re-check HOLDS a pre-freeze payout while frozen (logic test, no chain send)",
           r2.stdout[-200:] + r2.stderr[-200:])
        prow = rest(f"ex_payouts?id=eq.{throw['payouts'][0]}&select=execution_status,tx_hash")[0]
        ok(prow["execution_status"] == "approved" and not prow.get("tx_hash"),
           "pre-freeze payout untouched by execution (still approved, no tx)", str(prow))
        code, r = api("POST", "/wallet/deposit", jwt=JT, body={"amount": 5, "method": "crypto", "asset": "USDT"})
        ok(code == 201, "deposits remain fully allowed while frozen", f"{code} {str(r)[:160]}")
        code, r = api("POST", f"/admin/users/{tuid}/wallet-freeze", api_key=ADMIN_KEY, body={"frozen": False})
        ok(code == 200 and r.get("wallet_frozen") is False, "admin unfreeze endpoint", f"{code}")
        code, r = api("POST", "/wallet/payout", jwt=JT,
                      body={"amount": 10, "method": "crypto", "asset": "USDT", "destination": evm})
        ok(code == 201, "unfreeze restores payout creation", f"{code} {str(r)[:160]}")
        throw["payouts"].append(r["id"])

        print(f"PASS: fairness + shadow/freeze E2E - {CHECKS} checks")
    finally:
        now_s = int(time.time())
        # throwaway user tree first
        try:
            if throw["user"]:
                for pid in throw["payouts"]:
                    rest(f"ex_payouts?id=eq.{pid}", method="DELETE")
                rest(f"ex_deposits?user_id=eq.{throw['user']}", method="DELETE")
                rest(f"ex_ledger?user_id=eq.{throw['user']}", method="DELETE")
                rest(f"ex_notifications?user_id=eq.{throw['user']}", method="DELETE")
                if throw["job"]:
                    rest(f"ex_jobs?id=eq.{throw['job']}", method="DELETE")
                if throw["agent"]:
                    rest(f"ex_agents?id=eq.{throw['agent']}", method="DELETE")
                rest(f"ex_admin_audit?target_user_id=eq.{throw['user']}", method="DELETE")
                rest(f"ex_wallets?user_id=eq.{throw['user']}", method="DELETE")
                rest(f"ex_users?id=eq.{throw['user']}", method="DELETE")
        except Exception as e:
            print("throwaway cleanup note:", e)
        # reverse settled jobs: worker -net, poster +agreed (fee stays as platform revenue in-flow, reimbursed here)
        try:
            for jid in settled:
                sql(f"select ex_move_balance(4, -{AMOUNT - FEE}, 'test_reversal', 'verify:fairness', 'reverse settlement job {jid}', {now_s});")
                sql(f"select ex_move_balance(1, {AMOUNT}, 'test_reversal', 'verify:fairness', 'reverse escrow job {jid}', {now_s});")
        except Exception as e:
            print("money reversal note:", e)
        # guarantee pool back to baseline exactly
        try:
            d = pool() - pool0
            if d:
                rpc("ex_pool_adjust", {"p_delta": -d})
        except Exception as e:
            print("pool reversal note:", e)
        # poster strikes + agent stats back to baseline
        try:
            rest("ex_users?id=eq.1", method="PATCH", body={"strikes": strikes0})
            ag = agent13()
            if ag["jobs_completed"] != ag0["jobs_completed"] or ag["earnings_cents"] != ag0["earnings_cents"]:
                rest("ex_agents?id=eq.13", method="PATCH",
                     body={"jobs_completed": ag0["jobs_completed"], "earnings_cents": ag0["earnings_cents"]})
        except Exception as e:
            print("stats reversal note:", e)
        # rows created by the run
        for jid in created_jobs:
            rest(f"ex_milestones?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
            rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
        for n in rest(f"ex_notifications?created_at=gte.{T0}&select=id"):
            rest(f"ex_notifications?id=eq.{n['id']}", method="DELETE")
        for fd in rest(f"ex_feed?created_at=gte.{T0}&select=id"):
            rest(f"ex_feed?id=eq.{fd['id']}", method="DELETE")
        for ob in rest(f"ex_outbox?created_at=gte.{T0}&select=id"):
            rest(f"ex_outbox?id=eq.{ob['id']}", method="DELETE")
            print("deleted queued mail row", ob["id"], "(never sent - mailer paused)")
        w1_1, w4_1 = wallet(1), wallet(4)
        ob1 = outbox_state()
        pool1 = pool()
        print(f"restored: founder {w1_1} user4 {w4_1} pool {pool1} outbox {ob1}")
        assert w1_1 == w1_0 and w4_1 == w4_0, (w1_0, w1_1, w4_0, w4_1)
        assert ob1 == ob0, (ob0, ob1)
        assert pool1 == pool0, (pool0, pool1)
        PAUSE.unlink()
        print("mailer unpaused; baselines byte-identical")


if __name__ == "__main__":
    main()
