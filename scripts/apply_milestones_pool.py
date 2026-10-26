#!/usr/bin/env python3
"""#6 MILESTONES + GUARANTEE POOL (owner pick 2026-10-26).
Milestone escrow: jobs can be posted with percentage milestones; each is
delivered (with verified-delivery fingerprinting) and released
separately; disputes/removals/sweeper refund only the unreleased rest.
Guarantee pool: 10% of every fee is earmarked into a public pool;
admins pay claims from it. Assert-exactly-once edits."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
SWEEPER = ROOT / "sweeper/service.mjs"
README = ROOT / "README.md"

s = TS.read_text()

# ---------- module-scope milestone input validation ----------
MOD = r'''
// MILESTONE ESCROW (owner pick, 2026-10-26): a job may split its budget
// into percentage milestones, each delivered + released separately.
function cleanMilestones(raw: any): { title: string; pct: number }[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw Object.assign(new Error("milestones must be a list of {title, pct}"), { status: 400 });
  if (raw.length < 2 || raw.length > 6) throw Object.assign(new Error("a job can have 2 to 6 milestones (or none for a single payment)"), { status: 400 });
  const out = raw.map((m: any) => ({ title: String(m?.title || "").trim().slice(0, 120), pct: Math.round(Number(m?.pct || 0)) }));
  if (out.some((m) => m.title.length < 2)) throw Object.assign(new Error("every milestone needs a title"), { status: 400 });
  if (out.some((m) => m.pct < 5 || m.pct > 95)) throw Object.assign(new Error("every milestone must be between 5% and 95% of the price"), { status: 400 });
  if (out.reduce((a, m) => a + m.pct, 0) !== 100) throw Object.assign(new Error("milestone percentages must add up to exactly 100"), { status: 400 });
  return out;
}
'''
anchor = "async function storeDeliveryFile(jobId: number, file: File) {"
assert s.count(anchor) == 1
s = s.replace(anchor, MOD + anchor)

# ---------- handler-scope helpers ----------
HELPERS = r'''
  async function milestonesOf(jobId: number) {
    return await pg(`ex_milestones?job_id=eq.${jobId}&select=*&order=idx.asc`);
  }
  async function releasedMilestoneSum(jobId: number) {
    const ms = await pg(`ex_milestones?job_id=eq.${jobId}&status=eq.released&select=amount_cents`);
    return ms.reduce((a: number, m: any) => a + (m.amount_cents || 0), 0);
  }
  async function guaranteePoolCents() {
    const row = await one(`ex_settings?key=eq.guarantee_pool_cents&select=value`);
    return parseInt(row?.value || "0") || 0;
  }
  async function fundGuaranteePool(feeCents: number) {
    // GUARANTEE POOL: 10% of the platform fee (1% of the job price) is
    // earmarked for buyer protection on every completion.
    const cut = Math.round((feeCents || 0) * 0.10);
    if (cut <= 0) return;
    const cur = await guaranteePoolCents();
    await pg(`ex_settings?key=eq.guarantee_pool_cents`, { method: "PATCH", body: JSON.stringify({ value: String(cur + cut) }) });
  }
  async function deliverMilestone(job: any, m: any, input: DeliveryInput) {
    const notes = String(input.notes || "").trim();
    if (notes.length < 2) throw Object.assign(new Error("delivery notes required - say what is inside and what the buyer must edit or replace"), { status: 400 });
    const link = String(input.link || "").trim();
    if (link && !/^https?:\/\/.+/i.test(link)) throw Object.assign(new Error("the download link must be a full https:// link (Dropbox, Google Drive, MEGA)"), { status: 400 });
    if (!input.file && !link) throw Object.assign(new Error(DELIVERY_RULE_MSG), { status: 400 });
    if (!["awarded", "delivered"].includes(job.status)) throw Object.assign(new Error(`cannot deliver a milestone on a job in status ${job.status}`), { status: 400 });
    if (m.status !== "pending") throw Object.assign(new Error(`milestone ${m.idx + 1} is already ${m.status}`), { status: 400 });
    let stored: any = null;
    if (input.file) stored = await storeDeliveryFile(job.id, input.file);
    const patch: Record<string, unknown> = { status: "delivered", deliverable: notes.slice(0, 8000), delivery_link: link.slice(0, 1000), delivered_at: now() };
    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_sha256 = stored.sha256; patch.delivery_check = stored.check; }
    else if (link) { patch.delivery_sha256 = await sha256hex(link); patch.delivery_check = { verdict: "link", checked_at: now(), checks: [{ name: "download link", ok: true, detail: "link deliveries cannot be content-checked; the fingerprint covers the URL itself" }] }; }
    const updated = await pg(`ex_milestones?id=eq.${m.id}&status=eq.pending`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    if (!updated.length) { if (stored) await deleteDeliveryFile(stored.storage_path); throw Object.assign(new Error("milestone was already delivered"), { status: 409 }); }
    const all = await milestonesOf(job.id);
    const allDelivered = all.every((x: any) => x.status === "delivered" || x.status === "released");
    if (allDelivered && job.status === "awarded") {
      await pg(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { method: "PATCH", body: JSON.stringify({ status: "delivered", delivered_at: now(), deliverable: `All ${all.length} milestones delivered - release each milestone to pay.`, updated_at: now() }) });
      const dAgentName = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name`))?.name : null;
      await queueLifecycleMail("job_delivered", job.poster_user_id, { agent_name: dAgentName || "The worker", title: job.title, notes: "All milestones delivered - release each one to pay.", link: `${SITE_URL}/#/job/${job.id}` });
    }
    await notify(job.poster_user_id, "delivery", `Milestone ${m.idx + 1} of "${job.title}" delivered - review and release it`, `#/job/${job.id}`);
    return updated[0];
  }
  async function finalizeMilestoneJob(job: any) {
    const t = now();
    const updated = await pg(`ex_jobs?id=eq.${job.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed", updated_at: t }) });
    if (!updated.length) throw Object.assign(new Error("job already settled"), { status: 400 });
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
    // Total fee actually taken = the sum of the per-milestone fees.
    const pctF = await feePct();
    const allMs = await milestonesOf(job.id);
    const totalFees = allMs.reduce((a: number, m: any) => a + Math.round((m.amount_cents * pctF) / 100), 0);
    if (agent) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (job.agreed_cents - totalFees) }) });
    await fundGuaranteePool(totalFees);
    const awardedOwner = agent?.owner_id;
    if (awardedOwner) {
      await notify(awardedOwner, "payment", `"${job.title}" fully released - $${((job.agreed_cents - totalFees) / 100).toFixed(2)} landed in your wallet across its milestones`, `#/job/${job.id}`);
      const sellerWalletAfter = await walletOf(awardedOwner).catch(() => null);
      const sellerWalletBefore = { balance_cents: (sellerWalletAfter?.balance_cents || 0) - (job.agreed_cents - totalFees) };
      await queueLifecycleMail("payment_received", awardedOwner, { title: job.title, amount: fmtMoney(job.agreed_cents - totalFees), wallet_before: fmtMoney(sellerWalletBefore.balance_cents), wallet_after: fmtMoney(sellerWalletAfter?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` });
    }
    const posterWalletAfter = await walletOf(job.poster_user_id).catch(() => null);
    await queueLifecycleMail("payment_sent", job.poster_user_id, { title: job.title, agent_name: agent?.name || "The worker", amount: fmtMoney(job.agreed_cents), wallet_balance: fmtMoney(posterWalletAfter?.balance_cents || 0), escrow_held: fmtMoney(posterWalletAfter?.held_cents || 0), wallet_total: fmtMoney((posterWalletAfter?.balance_cents || 0) + (posterWalletAfter?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` });
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_completed", job_id: job.id, title: job.title, paid_cents: job.agreed_cents - totalFees });
    await feed("completed", `"${job.title}" completed - $${(job.agreed_cents / 100).toFixed(2)} paid out across milestones`, job.id);
    return updated[0];
  }
  async function releaseMilestone(job: any, m: any) {
    if (m.status !== "delivered") throw Object.assign(new Error(`milestone ${m.idx + 1} is ${m.status} - only delivered milestones can be released`), { status: 400 });
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
    if (!agent) throw Object.assign(new Error("awarded agent not found"), { status: 404 });
    const pct = await feePct();
    const feeM = Math.round((m.amount_cents * pct) / 100);
    const t = now();
    const updated = await pg(`ex_milestones?id=eq.${m.id}&status=eq.delivered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "released", released_at: t }) });
    if (!updated.length) throw Object.assign(new Error("milestone was already released"), { status: 409 });
    await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: agent.owner_id, p_price: m.amount_cents, p_fee: feeM, p_ref: `job:${job.id}:m${m.idx + 1}`, p_now: t });
    await notify(agent.owner_id, "payment", `Milestone ${m.idx + 1} of "${job.title}" released - $${((m.amount_cents - feeM) / 100).toFixed(2)} landed in your wallet`, `#/job/${job.id}`);
    const all = await milestonesOf(job.id);
    if (all.every((x: any) => x.status === "released")) {
      const fresh = await one(`ex_jobs?id=eq.${job.id}&select=*`);
      await finalizeMilestoneJob(fresh);
    }
    return updated[0];
  }
'''
# deliverJob + completeJob guards for milestone jobs — these edits run
# BEFORE the HELPERS insert because deliverMilestone shares deliverJob's
# opening lines (an anchor would match twice after the insert).
old_dg = '''    let stored: any = null;
    if (input.file) stored = await storeDeliveryFile(job.id, input.file);'''
assert s.count(old_dg) == 1
s = s.replace(old_dg, '''    const msGuard = await milestonesOf(job.id);
    if (msGuard.length) throw Object.assign(new Error("this job pays by milestones - deliver each milestone separately (POST /jobs/:id/milestones/:milestoneId/deliver)"), { status: 400 });
    let stored: any = null;
    if (input.file) stored = await storeDeliveryFile(job.id, input.file);''')

old_cg = '''  async function completeJob(job: any) {
    const awardedOwner'''
assert s.count(old_cg) == 1
s = s.replace(old_cg, '''  async function completeJob(job: any) {
    const msGuard = await milestonesOf(job.id);
    if (msGuard.length) throw Object.assign(new Error("this job pays by milestones - release each delivered milestone instead (POST /jobs/:id/milestones/:milestoneId/release)"), { status: 400 });
    const awardedOwner''')

anchor2 = "  async function deliverJob(job: any, input: DeliveryInput) {"
assert s.count(anchor2) == 1
s = s.replace(anchor2, HELPERS + anchor2)

# pool funding inside completeJob (after escrow release)
old_rel = '''    await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${job.id}`, p_now: t });
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);'''
assert s.count(old_rel) == 1
s = s.replace(old_rel, '''    await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${job.id}`, p_now: t });
    await fundGuaranteePool(job.fee_cents);
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);''')

# postJob: validate + insert milestones
old_val = '''    const mode = b.mode === "fixed" ? "fixed" : "bidding";'''
assert s.count(old_val) == 1
s = s.replace(old_val, '''    const mode = b.mode === "fixed" ? "fixed" : "bidding";
    const milestoneSpec = cleanMilestones(b.milestones);''')

old_ins = '''      const job = rows[0];
      await pg(`ex_ledger?user_id=eq.${posterUserId}&type=eq.escrow_hold&ref=eq.job:new&order=created_at.desc&limit=1`, { method: "PATCH", body: JSON.stringify({ ref: `job:${job.id}` }) });'''
assert s.count(old_ins) == 1
s = s.replace(old_ins, '''      const job = rows[0];
      if (milestoneSpec) {
        for (let i = 0; i < milestoneSpec.length; i++) {
          await pg("ex_milestones", { method: "POST", body: JSON.stringify({ job_id: job.id, idx: i, title: milestoneSpec[i].title, pct: milestoneSpec[i].pct, created_at: t }) });
        }
      }
      await pg(`ex_ledger?user_id=eq.${posterUserId}&type=eq.escrow_hold&ref=eq.job:new&order=created_at.desc&limit=1`, { method: "PATCH", body: JSON.stringify({ ref: `job:${job.id}` }) });''')

# awardJob: price the milestones at the agreed price
old_award = '''    await pg(`ex_bids?id=eq.${bid.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });'''
assert s.count(old_award) == 1
s = s.replace(old_award, '''    const msAward = await milestonesOf(job.id);
    if (msAward.length) {
      let assigned = 0;
      for (let i = 0; i < msAward.length; i++) {
        const amt = i === msAward.length - 1 ? bid.amount_cents - assigned : Math.round((bid.amount_cents * msAward[i].pct) / 100);
        assigned += amt;
        await pg(`ex_milestones?id=eq.${msAward[i].id}`, { method: "PATCH", body: JSON.stringify({ amount_cents: amt }) });
      }
    }
    await pg(`ex_bids?id=eq.${bid.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });''')

# dispute resolution: refund/release only the unreleased remainder
old_dp = '''        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${id}`, p_note: "Dispute resolved for poster — escrow refunded", p_now: t });'''
assert s.count(old_dp) == 1
s = s.replace(old_dp, '''        const relSumP = await releasedMilestoneSum(id);
        if (job.agreed_cents - relSumP > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents - relSumP, p_ref: `job:${id}`, p_note: "Dispute resolved for poster — unreleased escrow refunded (released milestones stay paid)", p_now: t });''')

old_da = '''        await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: agent.owner_id, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${id}`, p_now: t });'''
assert s.count(old_da) == 1
s = s.replace(old_da, '''        const relSumA = await releasedMilestoneSum(id);
        const remainderA = job.agreed_cents - relSumA;
        if (remainderA > 0) { const msFeesA = (await milestonesOf(id)).filter((m: any) => m.status === "released").reduce((a: number, m: any) => a + Math.round((m.amount_cents * 10) / 100), 0); await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: agent.owner_id, p_price: remainderA, p_fee: Math.max(0, job.fee_cents - msFeesA), p_ref: `job:${id}`, p_now: t }); await fundGuaranteePool(Math.max(0, job.fee_cents - msFeesA)); }''')

old_rm = '''        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${id}`, p_note: "Job removed by admin - escrow refunded (posting fee kept)", p_now: t });'''
assert s.count(old_rm) == 1
s = s.replace(old_rm, '''        const relSumR = await releasedMilestoneSum(id);
        if (job.agreed_cents - relSumR > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents - relSumR, p_ref: `job:${id}`, p_note: "Job removed by admin - unreleased escrow refunded (posting fee kept)", p_now: t });''')

# job detail responses include milestones (web + agent)
old_wd = '''    const jobView = publicJobView(j, canSeeDelivery);'''
assert s.count(old_wd) == 1
s = s.replace(old_wd, '''    const jobView = publicJobView(j, canSeeDelivery);
    (jobView as any).milestones = await milestonesOf(id);''')

# milestone routes (web)
WEB_ROUTES = r'''
  if (path.match(/^\/jobs\/\d+\/milestones\/\d+\/deliver$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]); const mid = parseInt(seg[3]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (awardedOwner !== u.id) return err("only the winning worker can deliver milestones", 403);
    const m = await one(`ex_milestones?id=eq.${mid}&job_id=eq.${jobId}&select=*`);
    if (!m) return err("milestone not found", 404);
    const input = await readDeliveryInput(req);
    try { return json({ milestone: await deliverMilestone(j, m, input) }); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/jobs\/\d+\/milestones\/\d+\/release$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]); const mid = parseInt(seg[3]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j || j.poster_user_id !== u.id) return err("job not found", 404);
    const m = await one(`ex_milestones?id=eq.${mid}&job_id=eq.${jobId}&select=*`);
    if (!m) return err("milestone not found", 404);
    try { return json({ milestone: await releaseMilestone(j, m) }); } catch (e: any) { return err(e.message, e.status || 400); }
  }
'''
anchor3 = '  if (path.match(/^\\/jobs\\/\\d+\\/evidence$/) && method === "GET") {'
assert s.count(anchor3) == 1
s = s.replace(anchor3, WEB_ROUTES + anchor3)

# milestone routes (agent)
AGENT_ROUTES = r'''
    if (path.match(/^\/agent\/jobs\/\d+\/milestones\/\d+\/deliver$/) && method === "POST") {
      const jobId = parseInt(seg[2]); const mid = parseInt(seg[4]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j) return err("job not found", 404);
      if (j.awarded_agent_id !== agent.id) return err("only the winning agent can deliver milestones", 403);
      const m = await one(`ex_milestones?id=eq.${mid}&job_id=eq.${jobId}&select=*`);
      if (!m) return err("milestone not found", 404);
      const input = await readDeliveryInput(req);
      try { return json({ milestone: await deliverMilestone(j, m, input) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/milestones\/\d+\/release$/) && method === "POST") {
      const jobId = parseInt(seg[2]); const mid = parseInt(seg[4]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j || j.poster_user_id !== agent.owner_id) return err("job not found", 404);
      const m = await one(`ex_milestones?id=eq.${mid}&job_id=eq.${jobId}&select=*`);
      if (!m) return err("milestone not found", 404);
      try { return json({ milestone: await releaseMilestone(j, m) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
'''
anchor4 = '    if (path.match(/^\\/agent\\/jobs\\/\\d+\\/evidence$/) && method === "GET") {'
assert s.count(anchor4) == 1
s = s.replace(anchor4, AGENT_ROUTES + anchor4)

# agent job detail includes milestones
old_ad = '''      const jobView = publicJobView(j, isParty);'''
assert s.count(old_ad) == 1
s = s.replace(old_ad, '''      const jobView = publicJobView(j, isParty);
      (jobView as any).milestones = await milestonesOf(jobId);''')

# /stats gains the pool
old_stats = '''      volume_cents: completed.reduce((s: number, j: any) => s + (j.agreed_cents || 0), 0),'''
assert s.count(old_stats) == 1
s = s.replace(old_stats, old_stats + '''
      guarantee_pool_cents: await guaranteePoolCents(),''')

# admin guarantee endpoints
ADMIN_G = r'''
    if (path === "/admin/guarantee" && method === "GET") {
      const claims = await pg("ex_guarantee_claims?select=*&order=created_at.desc&limit=50");
      return json({ pool_cents: await guaranteePoolCents(), claims });
    }
    if (path === "/admin/guarantee/pay" && method === "POST") {
      const b = await body();
      const target = await one(`ex_users?id=eq.${parseInt(b.user_id)}&select=id,name`);
      if (!target) return err("user not found", 404);
      const amount = cents(Number(b.amount || 0) * 100) || parseInt(b.amount_cents || 0);
      if (amount <= 0) return err("amount required");
      const pool = await guaranteePoolCents();
      if (amount > pool) return err(`the guarantee pool holds $${(pool / 100).toFixed(2)} - a claim cannot exceed the pool`, 400);
      const t = now();
      const claimRows = await pg("ex_guarantee_claims", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: target.id, job_id: b.job_id ? parseInt(b.job_id) : null, amount_cents: amount, reason: String(b.reason || "").slice(0, 500), status: "paid", created_at: t }) });
      await rpc("ex_move_balance", { p_user: target.id, p_amount: amount, p_type: "guarantee_payout", p_ref: `guarantee:${claimRows[0].id}`, p_note: `Guarantee pool payout: ${String(b.reason || "").slice(0, 200)}`, p_now: t });
      await pg(`ex_settings?key=eq.guarantee_pool_cents`, { method: "PATCH", body: JSON.stringify({ value: String(pool - amount) }) });
      await notify(target.id, "payment", `Buyer protection: $${(amount / 100).toFixed(2)} was paid to your wallet from the Exchange guarantee pool. ${String(b.reason || "").slice(0, 200)}`, "#/wallet");
      return json({ claim: claimRows[0], pool_cents: pool - amount });
    }
'''
anchor5 = '    if (path === "/admin/deposits" && method === "GET") {'
assert s.count(anchor5) == 1
s = s.replace(anchor5, ADMIN_G + anchor5)

old_help = '''          skill_trials: "Prove-it skill trials:'''
assert s.count(old_help) == 1
s = s.replace(old_help, '''          milestones: "Jobs can split escrow into 2-6 percentage milestones (POST /jobs with milestones:[{title,pct}] summing to 100). Amounts are priced at award from the agreed price. The winner delivers each milestone (POST /jobs/:id/milestones/:mid/deliver or /agent/...), the poster releases each one (POST /jobs/:id/milestones/:mid/release or /agent/...); escrow releases per milestone with the 10% fee taken per milestone. Disputes, admin removals and deadline refunds only ever touch the UNRELEASED remainder.",
          guarantee_pool: "Buyer protection: 10% of every platform fee (1% of each completed job) is earmarked into the guarantee pool (see GET /stats guarantee_pool_cents). Admins pay claims from it via POST /admin/guarantee/pay; claims are audited in ex_guarantee_claims.",
          skill_trials: "Prove-it skill trials:''')

TS.write_text(s)
print("backend patched")

# ---------- sweeper: deadline refunds only touch the unreleased remainder ----------
w = SWEEPER.read_text()
old_sw = '''    if (!claimed || !claimed.length) continue; // someone else handled it
    try {
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed with no delivery - escrow automatically refunded", p_now: t });'''
assert w.count(old_sw) == 1
new_sw = '''    if (!claimed || !claimed.length) continue; // someone else handled it
    // MILESTONE ESCROW: only the UNRELEASED remainder refunds - released
    // milestones stay paid. Computed before the try so the notifications
    // after the refund can name the real amount.
    const relMs = await get(`ex_milestones?job_id=eq.${job.id}&status=eq.released&select=amount_cents`).catch(() => []);
    const refundAmt = job.agreed_cents - (relMs || []).reduce((a, m) => a + (m.amount_cents || 0), 0);
    try {
      if (refundAmt > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refundAmt, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed - unreleased escrow automatically refunded (released milestones stay paid)", p_now: t });'''
w = w.replace(old_sw, new_sw)
old_sw2 = '''`" was cancelled automatically - the delivery deadline passed with no delivery, and your escrow (${money(job.agreed_cents)}) was refunded to your wallet`'''
assert w.count(old_sw2) == 1
w = w.replace(old_sw2, '''`" was cancelled automatically - the delivery deadline passed, and your unreleased escrow (${money(refundAmt)}) was refunded to your wallet`''')
old_sw3 = '''{ name: poster.name || "", title: job.title, amount: money(job.agreed_cents), wallet_after:'''
assert w.count(old_sw3) == 1
w = w.replace(old_sw3, '''{ name: poster.name || "", title: job.title, amount: money(refundAmt), wallet_after:''')
SWEEPER.write_text(w)
print("sweeper patched")

# ---------- frontend ----------
a = APP.read_text()

# post form: milestones editor
old_pf = '''    <div class="grow"><label>Bidding window (hours)</label><input id="j-deadline" type="number" min="1" value="48"></div></div>'''
assert a.count(old_pf) == 1
a = a.replace(old_pf, old_pf + '''
    <label class="mt">Milestones (optional) — split the payment into stages</label>
    <div id="ms-rows"></div>
    <button class="btn ghost sm" id="ms-add" type="button">+ Add a milestone</button>
    <p class="small mut">Leave empty for one single payment. With milestones, each stage is delivered and released separately; percentages must add up to 100.</p>''')

old_submit = '''      const r = await api("/jobs", { method: "POST", body: { title: $("#j-title").value, description: $("#j-desc").value, category: $("#j-cat").value, budget: $("#j-budget").value, mode: $("#j-mode").value, deadline_hours: $("#j-deadline").value } });'''
assert a.count(old_submit) == 1
a = a.replace(old_submit, '''      const ms = [...document.querySelectorAll(".ms-row")].map((row) => ({ title: row.querySelector(".ms-t").value, pct: Number(row.querySelector(".ms-p").value || 0) })).filter((m) => m.title.trim());
      const r = await api("/jobs", { method: "POST", body: { title: $("#j-title").value, description: $("#j-desc").value, category: $("#j-cat").value, budget: $("#j-budget").value, mode: $("#j-mode").value, deadline_hours: $("#j-deadline").value, ...(ms.length ? { milestones: ms } : {}) } });''')

# wire the add-milestone button: attach after the post form renders (the submit handler lives nearby)
old_btn_anchor = '''    $("#j-cat").innerHTML'''
if a.count(old_btn_anchor) == 1:
    a = a.replace(old_btn_anchor, '''    const msAdd = $("#ms-add"); if (msAdd) msAdd.onclick = () => { const d = document.createElement("div"); d.className = "flex ms-row"; d.innerHTML = '<input class="ms-t grow" placeholder="Milestone title (e.g. First draft)"><input class="ms-p" type="number" min="5" max="95" value="50" style="max-width:90px"><span class="small mut">%</span>'; $("#ms-rows").appendChild(d); };
    $("#j-cat").innerHTML''')

# job page: milestones panel + actions
old_chat_panel = '''      <div class="panel rv" style="--d:.1s"><h3>${ic("msg")} Job chat</h3>'''
assert a.count(old_chat_panel) == 1
a = a.replace(old_chat_panel, '''      ${(j.milestones || []).length ? `<div class="panel rv" style="--d:.08s"><h3>${ic("layers")} Milestones</h3>
        <p class="small mut mt">This job pays in stages. Each milestone is delivered and released separately.</p>
        ${(j.milestones || []).map((m) => `<div class="notif" style="align-items:flex-start"><span class="grow"><b>${m.idx + 1}. ${esc(m.title)}</b> <span class="pill">${m.status}</span><br>
          <span class="small mut">${money(m.amount_cents)} (${m.pct}%)${m.delivery_sha256 ? ` · 🔒 fingerprint <code>${esc(String(m.delivery_sha256).slice(0, 12))}…</code>${m.delivery_check && m.delivery_check.verdict ? ` · checks ${esc(m.delivery_check.verdict)}` : ""}` : ""}</span>
          ${m.deliverable ? `<br><span class="small" style="white-space:pre-wrap">${esc(m.deliverable)}</span>` : ""}</span>
          ${(isPoster && m.status === "delivered") ? `<button class="btn sm green" data-msrelease="${m.id}">Release ${money(m.amount_cents)}</button>` : ""}
          ${(awardedMine && m.status === "pending") ? `<span class="flex"><input type="file" id="msf-${m.id}"><input id="msn-${m.id}" placeholder="Delivery notes…" style="min-width:180px"><button class="btn sm" data-msdeliver="${m.id}">Deliver</button></span>` : ""}
        </div>`).join("")}
      </div>` : ""}
''' + old_chat_panel)

old_dl2 = '''  const ev = $("#ev-pack");'''
assert a.count(old_dl2) == 1
a = a.replace(old_dl2, '''  document.querySelectorAll("[data-msrelease]").forEach((b) => b.onclick = async () => { if (!confirm("Release this milestone? Its payment goes to the worker now.")) return; try { await api(`/jobs/${id}/milestones/${b.dataset.msrelease}/release`, { method: "POST", body: {} }); toast("Milestone released"); await refreshMe(); viewJob(id); } catch (e) { toast(e.message); } });
  document.querySelectorAll("[data-msdeliver]").forEach((b) => b.onclick = async () => { const mid = b.dataset.msdeliver; try { const f = $(`#msf-${mid}`).files[0]; const notes = $(`#msn-${mid}`).value; if (f) { const fd = new FormData(); fd.append("action", "deliver"); fd.append("deliverable", notes); fd.append("file", f); const res = await fetch(API + `/jobs/${id}/milestones/${mid}/deliver`, { method: "POST", headers: { ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, body: fd }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || "deliver failed"); } else await api(`/jobs/${id}/milestones/${mid}/deliver`, { method: "POST", body: { deliverable: notes, link: "" } }); toast("Milestone delivered"); viewJob(id); } catch (e) { toast(e.message); } });
''' + old_dl2)

# docs rules additions
old_rule = '''<br>- <b>Skill trials</b> - every category has a short prove-it trial. Passing earns the agent a public verified-skill badge and unlocks jobs over <b>$100</b> in that category.</p>'''
assert a.count(old_rule) == 1
a = a.replace(old_rule, old_rule.replace("</p>", "") + '''<br>- <b>Milestones</b> - a job can split its escrow into 2-6 stages; each stage is delivered and released separately, and disputes only ever touch the unreleased stages.<br>- <b>Guarantee pool</b> - 1% of every completed job (10% of the platform fee) is earmarked into a public buyer-protection pool that admins pay claims from.</p>''')

APP.write_text(a)
print("frontend patched")

r = README.read_text()
old_r = "**Prove-it skill trials:**"
assert r.count(old_r) == 1
r = r.replace(old_r, "**Milestone escrow:** a job can split its budget into 2-6 percentage milestones (`milestones:[{title,pct}]` at posting) — each is delivered (fingerprinted, like any delivery) and released separately; disputes and refunds only touch the unreleased remainder. **Guarantee pool:** 10% of every platform fee (1% of each completed job) funds a public buyer-protection pool (`GET /stats` → `guarantee_pool_cents`); admins pay claims via `POST /admin/guarantee/pay`. " + old_r)
README.write_text(r)
print("README patched")
print("DONE")
