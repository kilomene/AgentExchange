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
  - shadow ban (expansion): ghosting incl. jobs/listings; the user IS
    told exactly once (self-only badge + case ID, one notification,
    one notice email), then total notification/email suppression at
    queue time AND at mailer send time; immutable evidence pack per
    case; reports open cases (never auto-ban); agent appeal lands in
    the admin queue; AUTO-BAN on 3 strikes (sweeper dispute default)
    and on a bad-faith dispute lost against a verified delivery;
    unban restores everything. Profile 404 public/other, 200 owner+admin, list /
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
    foreign_settled = []
    forfeit_poster_settled = []
    victim_refund_total = [0]
    throw = {"user": None, "agent": None, "job": None, "payouts": [], "user2": None,
             "scam": None, "scam_agent": None, "scam2": None}
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

        # ---------- A. shadow ban (expansion: told + suppressed + cases) ----------
        print("== shadow ban ==")
        now_s = int(time.time())
        temail = f"verify-throwaway-{now_s}@example.com"
        tuid = rest("ex_users", method="POST", body={
            "email": temail, "name": "Verify Throwaway",
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
        ok(code == 200 and "fairness_auto_release" in json.dumps(r) and "shadow_ban" in json.dumps(r),
           "agent help carries the fairness + shadow-ban policies", f"{code}")
        code, r = api("GET", f"/agents?q=VerifyThrow", jwt=None)
        ok(any(a["id"] == tagent["id"] for a in r.get("agents", [])), "agent listed before ban", "")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 200, "agent profile public 200 before ban", f"{code}")
        code, r = api("GET", "/jobs", jwt=None)
        ok(any(j["id"] == tjob for j in r.get("jobs", [])), "open job on the floor before ban", "")

        # reports: a report opens an admin case — it NEVER bans by itself
        code, r = api("POST", "/reports", jwt=J4, body={
            "target_user_id": tuid, "reason": "suspected scam: took a deposit off-platform and vanished",
            "evidence_text": "chat screenshots referenced", "evidence_refs": ["chat:job-999"]})
        ok(code == 200 and r.get("report_id"), "web scam report accepted (opens a case)", f"{code} {str(r)[:160]}")
        code, r = api("POST", "/agent/reports", agent_key=plain_key, body={
            "target_user_id": 4, "reason": "agent-channel report for the queue test",
            "evidence_text": "evidence supplied with the report"})
        ok(code == 200 and r.get("report_id"), "agent scam report accepted (opens a case)", f"{code} {str(r)[:160]}")
        ok(not user_row(tuid).get("shadow_banned"), "a single report alone does NOT auto-ban", "")

        # pre-ban award -> a job_awarded mail sits QUEUED for the throwaway
        jp = post_job(J1, {"title": "VERIFY shadow pre-ban award (throwaway)", "description": "Throwaway.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["deliverable file present"]})
        created_jobs.append(jp)
        bid_t = rest("ex_bids", method="POST", body={
            "job_id": jp, "agent_id": tagent["id"], "bidder_user_id": tuid,
            "amount_cents": AMOUNT, "eta_hours": 24, "pitch": "verify bid",
            "status": "active", "created_at": int(time.time())})[0]
        code, r = api("POST", f"/jobs/{jp}/award", jwt=J1, body={"bid_id": bid_t["id"]})
        ok(code in (200, 201), "pre-ban award to the throwaway agent lands", f"{code} {str(r)[:160]}")
        pre_mail = rest(f"ex_outbox?to_email=eq.{temail}&kind=eq.job_awarded&select=id,status")
        ok(len(pre_mail) == 1 and pre_mail[0]["status"] == "queued",
           "pre-ban job_awarded mail queued for the throwaway", str(pre_mail))
        pre_mail_id = pre_mail[0]["id"]
        # id sets, so the ban-notice asserts below cannot race a
        # same-second timestamp boundary
        pre_notif_ids = {n["id"] for n in rest(f"ex_notifications?user_id=eq.{tuid}&select=id")}
        pre_mail_ids = {m["id"] for m in rest(f"ex_outbox?to_email=eq.{temail}&select=id")}

        t_ban = int(time.time())
        code, r = api("POST", f"/admin/users/{tuid}/shadow-ban", api_key=ADMIN_KEY,
                      body={"banned": True, "reason": "e2e: suspected scam ring"})
        case_code = r.get("case_code") or ""
        ok(code == 200 and r.get("shadow_banned") is True and case_code.startswith("SB-"),
           "admin shadow-ban endpoint returns a case ID", f"{code} {str(r)[:160]}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 404, "shadow-banned profile 404 for the public", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=J4)
        ok(code == 404 and "shadow" not in json.dumps(r).lower(),
           "shadow-banned profile 404 for other users, no badge leaks", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=JT)
        ag_view = r.get("agent") or {}
        ok(code == 200 and ag_view.get("shadow_banned") is True and ag_view.get("shadow_case_code") == case_code,
           "OWNER sees the Shadow Banned badge + case ID on their own profile", f"{code} {str(ag_view)[:200]}")
        code, r = api("GET", f"/agents/{tagent['id']}", api_key=ADMIN_KEY)
        ok(code == 200 and (r.get("agent") or {}).get("shadow_banned") is True,
           "ADMIN sees the profile + badge", f"{code}")
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
        # the user IS told — exactly once: one notification + one email, both with the case ID
        notifs = [n for n in rest(f"ex_notifications?user_id=eq.{tuid}&select=id,body") if n["id"] not in pre_notif_ids]
        ok(len(notifs) == 1 and case_code in (notifs[0].get("body") or ""),
           "exactly ONE notification reaches the banned user: the ban notice with the case ID", str(notifs)[:220])
        mails = [m for m in rest(f"ex_outbox?to_email=eq.{temail}&select=id,kind,payload") if m["id"] not in pre_mail_ids]
        ok(len(mails) == 1 and mails[0]["kind"] == "shadow_ban_notice"
           and (mails[0].get("payload") or {}).get("case_id") == case_code,
           "exactly ONE email queued for the banned user: the notice with the case ID", str(mails)[:220])
        notice_mail_id = mails[0]["id"]
        cases = rest(f"ex_shadow_cases?user_id=eq.{tuid}&status=eq.active&select=case_code,trigger_rule,evidence_pack")
        ok(len(cases) == 1 and cases[0]["case_code"] == case_code
           and cases[0]["trigger_rule"] == "manual_admin"
           and len((cases[0].get("evidence_pack") or {}).get("agents") or []) >= 1,
           "evidence pack snapshotted on the case at ban time", str(cases)[:220])

        # queue-time suppression: award a second job to the banned agent
        jp2 = post_job(J1, {"title": "VERIFY shadow suppression (throwaway)", "description": "Throwaway.",
                            "category": "research", "budget": 15, "mode": "bidding",
                            "acceptance_checklist": ["deliverable file present"]})
        created_jobs.append(jp2)
        bid_t2 = rest("ex_bids", method="POST", body={
            "job_id": jp2, "agent_id": tagent["id"], "bidder_user_id": tuid,
            "amount_cents": AMOUNT, "eta_hours": 24, "pitch": "verify bid",
            "status": "active", "created_at": int(time.time())})[0]
        code, r = api("POST", f"/jobs/{jp2}/award", jwt=J1, body={"bid_id": bid_t2["id"]})
        ok(code in (200, 201), "second award to the banned agent still processes (money in flight)", f"{code}")
        notifs = [n for n in rest(f"ex_notifications?user_id=eq.{tuid}&select=id") if n["id"] not in pre_notif_ids]
        ok(len(notifs) == 1, "queue-time suppression: the award queued NO new notification", str(notifs))
        mails = rest(f"ex_outbox?to_email=eq.{temail}&select=id")
        ok(len(mails) == len(pre_mail_ids) + 1, "queue-time suppression: the award queued NO new email (pre-ban + notice only)", str(mails))
        code, r = api("PUT", f"/admin/users/{tuid}", api_key=ADMIN_KEY, body={"verified_badge": True})
        notifs = [n for n in rest(f"ex_notifications?user_id=eq.{tuid}&select=id") if n["id"] not in pre_notif_ids]
        ok(len(notifs) == 1, "even an admin badge-grant notification is suppressed while banned", str(notifs))
        # release the two test escrows (the jobs themselves are swept in finally)
        for jx in (jp, jp2):
            sql(f"select ex_refund_escrow(1, {AMOUNT}, 'job:{jx}', 'verify cleanup refund', {int(time.time())});")
            rest(f"ex_jobs?id=eq.{jx}", method="PATCH", body={"status": "refunded"})

        # send-time suppression via the REAL mailer module (mailer is PAUSED;
        # this drives its own checkAndSuppress against the live rows)
        def send_time_check(row_id):
            js = (
                'import { SupabaseAdmin } from "file://' + str(ROOT) + '/mail-service/src/supabase.mjs";\n'
                'import { checkAndSuppress } from "file://' + str(ROOT) + '/mail-service/src/suppression.mjs";\n'
                'const db = new SupabaseAdmin({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });\n'
                f'const rows = await db.list("ex_outbox?id=eq.{row_id}&select=*");\n'
                'const suppressed = await checkAndSuppress(db, rows[0]);\n'
                f'const after = await db.list("ex_outbox?id=eq.{row_id}&select=status,attempts");\n'
                'console.log(JSON.stringify({ suppressed, status: after[0].status, attempts: after[0].attempts }));\n')
            Path("/tmp/suppress_check.mjs").write_text(js)
            env = dict(__import__("os").environ)
            env.update({"SUPABASE_URL": ENV["SUPABASE_URL"], "SUPABASE_SERVICE_ROLE_KEY": SRK})
            r2 = subprocess.run(["node", "/tmp/suppress_check.mjs"], capture_output=True, text=True, env=env)
            assert r2.returncode == 0, r2.stdout[-500:] + r2.stderr[-500:]
            return json.loads(r2.stdout.strip().splitlines()[-1])
        chk = send_time_check(pre_mail_id)
        ok(chk["suppressed"] is True and chk["status"] == "suppressed_shadow_ban" and chk["attempts"] in (0, None),
           "send-time suppression: pre-ban queued mail suppressed, no attempt burned", str(chk))
        chk = send_time_check(notice_mail_id)
        ok(chk["suppressed"] is False and chk["status"] == "queued",
           "send-time check never suppresses the ban notice itself", str(chk))

        # appeal via the agent API lands in the ONE admin queue, tied to the pack
        code, r = api("POST", "/agent/shadow-appeal", agent_key=plain_key, body={
            "case_code": case_code,
            "evidence_text": "I did not scam anyone: the delivery was sent in full and the poster confirmed receipt in chat before going silent.",
            "evidence_refs": ["delivery:sha256:verify", "chat:job-999"]})
        ok(code == 200 and r.get("case_code") == case_code, "agent appeal accepted against the case ID", f"{code} {str(r)[:160]}")
        code, r = api("GET", "/admin/reports", api_key=ADMIN_KEY)
        ok(any(x.get("kind") == "shadow_appeal" and x.get("case_code") == case_code for x in r.get("reports", [])),
           "appeal visible in the admin queue, linked to the case", "")
        code, r = api("GET", "/admin/shadow-cases", api_key=ADMIN_KEY)
        ok(any(x.get("case_code") == case_code for x in r.get("cases", [])),
           "case visible in the admin shadow-case queue", "")

        code, r = api("POST", f"/admin/users/{tuid}/shadow-ban", api_key=ADMIN_KEY, body={"banned": False})
        ok(code == 200 and r.get("shadow_banned") is False, "admin unban endpoint", f"{code}")
        code, r = api("GET", f"/agents/{tagent['id']}", jwt=None)
        ok(code == 200 and not (r.get("agent") or {}).get("shadow_banned"),
           "unban restores the public profile exactly (no badge)", f"{code}")
        code, r = api("GET", "/jobs", jwt=None)
        ok(any(j["id"] == tjob for j in r.get("jobs", [])), "unban restores floor visibility exactly", "")
        t_lift = int(time.time())
        code, r = api("PUT", f"/admin/users/{tuid}", api_key=ADMIN_KEY, body={"verified_badge": True})
        notifs = rest(f"ex_notifications?user_id=eq.{tuid}&created_at=gte.{t_lift}&select=id")
        ok(len(notifs) >= 1, "notifications resume after the lift", str(notifs))

        # ---------- A2. auto shadow ban: 3 strikes (sweeper dispute default) ----------
        print("== auto shadow ban: 3 strikes ==")
        rest("ex_users?id=eq." + str(tuid), method="PATCH", body={"strikes": 2})
        sql(f"select ex_move_balance({tuid}, 2000, 'test_fund', 'verify:autoban', 'e2e funding', {int(time.time())});")
        now_s = int(time.time())
        jf = rest("ex_jobs", method="POST", body={
            "poster_user_id": tuid, "awarded_agent_id": 13, "title": "VERIFY autoban strikes (throwaway)",
            "description": "throwaway", "category": "research", "mode": "bidding",
            "budget_cents": AMOUNT, "agreed_cents": AMOUNT, "fee_cents": FEE, "status": "disputed",
            "job_kind": "standard", "deliverable": "", "dispute_reason": "",
            "delivered_at": now_s - 90000, "dispute_deadline": now_s - 80000,
            "dispute_admin_deadline": now_s - 3600,
            "acceptance_checklist": ["deliverable file present"], "checklist_frozen": ["deliverable file present"],
            "created_at": now_s - 100000, "updated_at": now_s - 90000})[0]["id"]
        foreign_settled.append(jf)
        sql(f"select ex_hold_escrow({tuid}, {AMOUNT}, 'job:{jf}', 'verify hold', {now_s});")
        t_auto = int(time.time())
        sweeper_once()
        ok(wallet(4)[0] == exp_w4 + (AMOUNT - FEE), "dispute default still pays the worker exactly", f"{wallet(4)} vs {exp_w4}")
        exp_w4 += AMOUNT - FEE
        exp_pool += 15
        # The LIVE sweeper daemon shares this work on its 60s cycle and
        # may be the one that lands the strike + ban — poll briefly for
        # the end state instead of racing its post-strike steps.
        urow = user_row(tuid)
        for _ in range(20):
            if urow.get("shadow_banned") is True and (urow.get("strikes") or 0) == 3:
                break
            time.sleep(2)
            urow = user_row(tuid)
        ok(urow.get("shadow_banned") is True and (urow.get("strikes") or 0) == 3,
           "AUTO-BAN fired: the dispute-default strike took the poster to 3 and shadow-banned the account", str(urow)[:200])
        cases = rest(f"ex_shadow_cases?user_id=eq.{tuid}&status=eq.active&select=case_code,trigger_rule,evidence_pack")
        for _ in range(15):
            if len(cases) == 1:
                break
            time.sleep(2)
            cases = rest(f"ex_shadow_cases?user_id=eq.{tuid}&status=eq.active&select=case_code,trigger_rule,evidence_pack")
        ok(len(cases) == 1 and cases[0]["trigger_rule"] == "auto_3_strikes"
           and (cases[0].get("evidence_pack") or {}).get("user"),
           "auto-ban case + evidence pack created by the system", str(cases)[:220])
        auto_code = cases[0]["case_code"]
        notifs = rest(f"ex_notifications?user_id=eq.{tuid}&created_at=gte.{t_auto}&select=id,body")
        ok(len(notifs) == 1 and auto_code in (notifs[0].get("body") or ""),
           "auto-ban sent exactly the one notice (dispute mails suppressed after it)", str(notifs)[:220])
        mails = rest(f"ex_outbox?to_email=eq.{temail}&kind=eq.shadow_ban_notice&select=id")
        ok(len(mails) == 2, "one notice email per ban (manual + auto), nothing else", str(mails))
        code, r = api("POST", f"/admin/users/{tuid}/shadow-ban", api_key=ADMIN_KEY, body={"banned": False})
        ok(code == 200 and not user_row(tuid).get("shadow_banned"), "auto-ban lifts like a manual ban", f"{code}")

        # ---------- A3. auto shadow ban: bad-faith dispute vs verified delivery ----------
        print("== auto shadow ban: bad-faith dispute ==")
        now_s = int(time.time())
        uid2 = rest("ex_users", method="POST", body={
            "email": f"verify-throwaway2-{now_s}@example.com", "name": "Verify Throwaway Two",
            "password_hash": "x", "role": "user", "created_at": now_s, "email_verified": True})[0]["id"]
        throw["user2"] = uid2
        rest("ex_wallets", method="POST", body={"user_id": uid2, "balance_cents": 0, "held_cents": 0})
        sql(f"select ex_move_balance({uid2}, 2000, 'test_fund', 'verify:badfaith', 'e2e funding', {now_s});")
        jg = rest("ex_jobs", method="POST", body={
            "poster_user_id": uid2, "awarded_agent_id": 13, "title": "VERIFY autoban badfaith (throwaway)",
            "description": "throwaway", "category": "research", "mode": "bidding",
            "budget_cents": AMOUNT, "agreed_cents": AMOUNT, "fee_cents": FEE, "status": "disputed",
            "job_kind": "standard", "deliverable": "delivered", "dispute_reason": "poster claims it never arrived",
            "delivered_at": now_s - 90000,
            "delivery_check": {"verdict": "passed", "score": 100},
            "acceptance_checklist": ["deliverable file present"], "checklist_frozen": ["deliverable file present"],
            "created_at": now_s - 100000, "updated_at": now_s - 90000})[0]["id"]
        foreign_settled.append(jg)
        sql(f"select ex_hold_escrow({uid2}, {AMOUNT}, 'job:{jg}', 'verify hold', {now_s});")
        code, r = api("POST", f"/admin/jobs/{jg}/resolve", api_key=ADMIN_KEY, body={"resolution": "agent"})
        ok(code in (200, 201), "admin resolves the dispute for the agent", f"{code} {str(r)[:160]}")
        ok(wallet(4)[0] == exp_w4 + (AMOUNT - FEE), "bad-faith resolution pays the worker exactly", f"{wallet(4)} vs {exp_w4}")
        exp_w4 += AMOUNT - FEE
        exp_pool += 15
        urow2 = user_row(uid2)
        ok(urow2.get("shadow_banned") is True,
           "AUTO-BAN fired: poster lost a dispute against a VERIFIED delivery", str(urow2)[:200])
        cases = rest(f"ex_shadow_cases?user_id=eq.{uid2}&status=eq.active&select=case_code,trigger_rule")
        ok(len(cases) == 1 and cases[0]["trigger_rule"] == "auto_bad_faith_dispute",
           "bad-faith auto-ban case created with its trigger named", str(cases)[:200])
        ok(not user_row(uid2).get("wallet_frozen"), "auto-ban does NOT auto-freeze the wallet (separate tools)", "")

        # ---------- D. forfeiture: victims-first waterfall ----------
        print("== forfeiture: victims-first waterfall ==")
        now_s = int(time.time())
        sid = rest("ex_users", method="POST", body={
            "email": f"verify-scammer-{now_s}@example.com", "name": "Verify Scammer",
            "password_hash": "x", "role": "user", "created_at": now_s, "email_verified": True})[0]["id"]
        throw["scam"] = sid
        rest("ex_wallets", method="POST", body={"user_id": sid, "balance_cents": 0, "held_cents": 0})
        skey = f"verifykeyS{now_s}"
        sagent = rest("ex_agents", method="POST", body={
            "owner_id": sid, "name": f"VerifyScam Agent {now_s}", "status": "active",
            "is_human": False, "category": "research",
            "api_key_hash": hashlib.sha256(skey.encode()).hexdigest(), "created_at": now_s})[0]
        throw["scam_agent"] = sagent["id"]
        JS = jwt_for(sid)
        sql(f"select ex_move_balance({sid}, 10000, 'test_fund', 'verify:forfeit', 'e2e funding', {now_s});")
        # P1: scammer posts, agent 13 works, work COMPLETED (delivered) — escrow held
        p1 = post_job(JS, {"title": "VERIFY forfeit P1 completed work (throwaway)", "description": "Throwaway.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["deliverable file present"]})
        seed_bid_award(p1, JS)
        code, r = deliver_zip(p1, J4, checklist_map=["the ZIP, index.html"])
        ok(code == 200, "P1 delivered by the honest worker (work completed, escrow held)", f"{code} {str(r)[:160]}")
        # P2: scammer posts, awarded, work NEVER delivered — uncompleted escrow
        p2 = post_job(JS, {"title": "VERIFY forfeit P2 uncompleted (throwaway)", "description": "Throwaway.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["deliverable file present"]})
        created_jobs.append(p2)
        seed_bid_award(p2, JS)
        # W1: founder posts, the scammer's agent wins and COMPLETES the work
        w1 = post_job(J1, {"title": "VERIFY forfeit W1 scam agent work (throwaway)", "description": "Throwaway.",
                           "category": "research", "budget": 15, "mode": "bidding",
                           "acceptance_checklist": ["deliverable file present"]})
        created_jobs.append(w1)
        forfeit_poster_settled.append(w1)
        bid_s = rest("ex_bids", method="POST", body={
            "job_id": w1, "agent_id": sagent["id"], "bidder_user_id": sid,
            "amount_cents": AMOUNT, "eta_hours": 24, "pitch": "verify bid",
            "status": "active", "created_at": int(time.time())})[0]
        code, r = api("POST", f"/jobs/{w1}/award", jwt=J1, body={"bid_id": bid_s["id"]})
        ok(code in (200, 201), "W1 awarded to the scammer's agent", f"{code}")
        code, r = api("POST", f"/agent/jobs/{w1}/deliver", agent_key=skey, form=[
            ("deliverable", "ZIP with index.html and README - open index.html, replace nothing."),
            ("delivery_checklist_map", json.dumps(["the ZIP, index.html"])),
            ("file", f"@{make_zip()};type=application/zip")])
        ok(code in (200, 201), "W1 delivered by the scammer's agent (its completed work)", f"{code} {str(r)[:160]}")
        w_s = wallet(sid)
        ok(w_s == (6600, 3000), "scammer wallet staged: 6600 balance / 3000 held (P1+P2 escrow)", str(w_s))
        # ban + freeze, then the gates
        code, r = api("POST", f"/admin/users/{sid}/shadow-ban", api_key=ADMIN_KEY,
                      body={"banned": True, "reason": "e2e forfeiture: proven scam ring"})
        scode = r.get("case_code") or ""
        ok(code == 200 and scode.startswith("SB-"), "scammer shadow-banned with a case", f"{code} {str(r)[:140]}")
        scase = rest(f"ex_shadow_cases?user_id=eq.{sid}&status=eq.active&select=id,case_code")[0]
        code, r = api("POST", f"/admin/users/{sid}/wallet-freeze", api_key=ADMIN_KEY,
                      body={"frozen": True, "reason": "e2e forfeiture"})
        ok(code == 200 and r.get("wallet_frozen") is True, "scammer wallet frozen", f"{code}")
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/forfeit", api_key=ADMIN_KEY,
                      body={"victims": [{"user_id": 4, "amount_cents": 2000}]})
        ok(code == 400 and "proven_scam" in json.dumps(r),
           "GATE: no investigation finding -> forfeiture refused", f"{code} {str(r)[:180]}")
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/investigation", api_key=ADMIN_KEY,
                      body={"finding": "proven_scam", "appeal_deadline": int(time.time()) + 86400})
        ok(code == 200, "investigation finding recorded: proven_scam", f"{code} {str(r)[:140]}")
        code, r = api("POST", "/agent/shadow-appeal", agent_key=skey, body={
            "case_code": scode,
            "evidence_text": "I did nothing wrong, the deliveries speak for themselves, please review the pack again.",
            "evidence_refs": ["delivery:sha256:verify"]})
        ok(code == 200, "scammer's appeal filed (appeal window open)", f"{code} {str(r)[:140]}")
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/forfeit", api_key=ADMIN_KEY,
                      body={"victims": [{"user_id": 4, "amount_cents": 2000}]})
        ok(code == 400 and "appeal" in json.dumps(r).lower(),
           "GATE: appeal still open -> forfeiture refused", f"{code} {str(r)[:180]}")
        ok(wallet(sid) == (6600, 3000) and wallet(4)[0] == exp_w4,
           "nothing moved while the gates were closed (escrow unwinds untouched)", f"{wallet(sid)} {wallet(4)}")
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/investigation", api_key=ADMIN_KEY,
                      body={"appeal_outcome": "failed"})
        ok(code == 200, "appeal recorded as failed — gate opens", f"{code}")
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/forfeit", api_key=ADMIN_KEY,
                      body={"victims": [{"user_id": 4, "amount_cents": 2000}]})
        f = r.get("forfeiture") or {}
        ok(code == 200 and r.get("ok") is True, "forfeiture executes as ONE admin action", f"{code} {str(r)[:220]}")
        ok(f.get("completed_work_paid") == AMOUNT - FEE,
           "RULE 1: the honest worker on P1 was paid in full from escrow (1500-150)", str(f))
        ok(f.get("completed_work_credited") == AMOUNT - FEE,
           "RULE 1: the scammer agent's own completed work (W1) settled into its frozen balance", str(f))
        ok(f.get("escrow_remitted") == AMOUNT,
           "RULE 2: P2's uncompleted escrow remitted to Nova in full", str(f))
        ok(f.get("victim_paid") == 1800 and f.get("victim_charges") == 200,
           "RULE 3: victim refunded exactly 90% of 2000, Nova's charge exactly 10%", str(f))
        ok(f.get("remainder_forfeited") == 5950,
           "RULE 4: remainder forfeited to Nova (6600 + 1350 W1 credit - 2000 victim gross)", str(f))
        ok(wallet(sid) == (0, 0), "scammer wallet ends at zero balance / zero held", str(wallet(sid)))
        ok(wallet(4)[0] == exp_w4 + (AMOUNT - FEE) + 1800,
           "worker/victim (user 4) received exactly 1350 + 1800", f"{wallet(4)} vs {exp_w4}")
        exp_w4 += (AMOUNT - FEE) + 1800
        victim_refund_total[0] += 1800
        foreign_settled.append(p1)
        ok(pool() == exp_pool + 7680,
           "guarantee pool delta exact: 15+15 completion shares + 1500 remit + 200 charge + 5950 remainder", f"{pool()} vs {exp_pool}")
        exp_pool += 7680
        sledger = [x for x in rest(f"ex_ledger?user_id=eq.{sid}&select=type,amount_cents,ref") if x.get("ref") == f"case:{scode}"]
        ok(sorted((x["type"], x["amount_cents"]) for x in sledger) == sorted([
            ("forfeiture_escrow_remit", -1500), ("forfeiture_victim_refund", -2000), ("forfeiture_nova", -5950)]),
           "per-step ledger entries on the scammer carry the case ID ref", str(sledger))
        vledger = [x for x in rest("ex_ledger?user_id=eq.4&select=type,amount_cents,ref") if x.get("type") == "victim_refund" and x.get("ref") == f"case:{scode}"]
        ok(len(vledger) == 1 and vledger[0]["amount_cents"] == 1800,
           "victim's ledger credit is exactly 1800 with the case ID ref", str(vledger))
        audit = rest(f"ex_admin_audit?target_user_id=eq.{sid}&action=eq.forfeiture_execute&select=detail")
        ok(len(audit) == 1 and (audit[0].get("detail") or {}).get("case_code") == scode,
           "audit entry for the execution carries the case ID", str(audit)[:200])
        case_after = rest(f"ex_shadow_cases?id=eq.{scase['id']}&select=forfeiture_status")[0]
        ok(case_after["forfeiture_status"] == "executed", "case marked executed (one-shot)", str(case_after))
        code, r = api("POST", f"/admin/shadow-cases/{scase['id']}/forfeit", api_key=ADMIN_KEY, body={"victims": []})
        ok(code == 400, "forfeiture cannot execute twice", f"{code}")
        # frozen-but-not-proven: a second banned+frozen account with NO finding
        now_s = int(time.time())
        sid2 = rest("ex_users", method="POST", body={
            "email": f"verify-frozen-{now_s}@example.com", "name": "Verify Frozen Only",
            "password_hash": "x", "role": "user", "created_at": now_s, "email_verified": True})[0]["id"]
        throw["scam2"] = sid2
        rest("ex_wallets", method="POST", body={"user_id": sid2, "balance_cents": 5000, "held_cents": 0})
        code, r = api("POST", f"/admin/users/{sid2}/shadow-ban", api_key=ADMIN_KEY, body={"banned": True, "reason": "e2e: suspicion only"})
        code, r = api("POST", f"/admin/users/{sid2}/wallet-freeze", api_key=ADMIN_KEY, body={"frozen": True})
        case2 = rest(f"ex_shadow_cases?user_id=eq.{sid2}&status=eq.active&select=id")[0]
        code, r = api("POST", f"/admin/shadow-cases/{case2['id']}/forfeit", api_key=ADMIN_KEY, body={"victims": []})
        ok(code == 400 and "proven" in json.dumps(r).lower(),
           "a frozen-but-NOT-proven account cannot be forfeited at all", f"{code} {str(r)[:160]}")
        ok(wallet(sid2) == (5000, 0), "the unproven account's money is untouched", str(wallet(sid2)))

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
            # foreign-posted settlements (auto-ban sections): reverse the
            # worker side only — the poster wallets are throwaway rows,
            # deleted below with their trees.
            for jid in foreign_settled:
                sql(f"select ex_move_balance(4, -{AMOUNT - FEE}, 'test_reversal', 'verify:fairness', 'reverse foreign settlement job {jid}', {now_s});")
                rest(f"ex_milestones?job_id=eq.{jid}", method="DELETE")
                rest(f"ex_bids?job_id=eq.{jid}", method="DELETE")
                rest(f"ex_messages?job_id=eq.{jid}", method="DELETE")
                rest(f"ex_jobs?id=eq.{jid}", method="DELETE")
        except Exception as e:
            print("money reversal note:", e)
        # forfeiture settlements: poster (user 1) reimbursed for W1; the
        # victim refund to user 4 comes back out (pool is restored globally)
        try:
            for jid in forfeit_poster_settled:
                sql(f"select ex_move_balance(1, {AMOUNT}, 'test_reversal', 'verify:fairness', 'reverse forfeiture settlement job {jid}', {now_s});")
            if victim_refund_total[0]:
                sql(f"select ex_move_balance(4, -{victim_refund_total[0]}, 'test_reversal', 'verify:fairness', 'reverse victim refund', {now_s});")
        except Exception as e:
            print("forfeiture reversal note:", e)
        # scammer trees (forfeiture section)
        try:
            for skey_ in ("scam", "scam2"):
                su = throw.get(skey_)
                if su:
                    rest(f"ex_payouts?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_deposits?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_ledger?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_notifications?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_shadow_cases?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_reports?reporter_user_id=eq.{su}", method="DELETE")
                    rest(f"ex_admin_audit?target_user_id=eq.{su}", method="DELETE")
                    rest(f"ex_wallets?user_id=eq.{su}", method="DELETE")
                    rest(f"ex_users?id=eq.{su}", method="DELETE")
            if throw.get("scam_agent"):
                rest(f"ex_agents?id=eq.{throw['scam_agent']}", method="DELETE")
        except Exception as e:
            print("scammer cleanup note:", e)
        # second throwaway (bad-faith poster) tree + shadow case/report rows
        try:
            if throw.get("user2"):
                rest(f"ex_ledger?user_id=eq.{throw['user2']}", method="DELETE")
                rest(f"ex_notifications?user_id=eq.{throw['user2']}", method="DELETE")
                rest(f"ex_admin_audit?target_user_id=eq.{throw['user2']}", method="DELETE")
                rest(f"ex_wallets?user_id=eq.{throw['user2']}", method="DELETE")
                rest(f"ex_users?id=eq.{throw['user2']}", method="DELETE")
            for c in rest(f"ex_shadow_cases?created_at=gte.{T0}&select=id"):
                rest(f"ex_shadow_cases?id=eq.{c['id']}", method="DELETE")
            for rp in rest(f"ex_reports?created_at=gte.{T0}&select=id"):
                rest(f"ex_reports?id=eq.{rp['id']}", method="DELETE")
            if throw["user"]:
                rest(f"ex_shadow_cases?user_id=eq.{throw['user']}", method="DELETE")
                rest(f"ex_reports?reporter_user_id=eq.{throw['user']}", method="DELETE")
        except Exception as e:
            print("shadow cleanup note:", e)
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
