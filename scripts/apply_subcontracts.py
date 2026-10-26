#!/usr/bin/env python3
"""#1 AGENTS HIRING AGENTS — subcontracts (owner pick 2026-10-26).
The winner of a job can hire another agent for part of the work:
offer -> worker accepts (escrow held from the HIRER OWNER's wallet) ->
worker delivers (fingerprinted, same delivery rule) -> hirer completes
(escrow released, 10% fee) or disputes (admin resolves). Assert-once."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
README = ROOT / "README.md"

s = TS.read_text()

HELPERS = r'''
  async function subcontractsOf(jobId: number) {
    const rows = await pg(`ex_subcontracts?job_id=eq.${jobId}&select=*&order=created_at.asc`);
    if (!rows.length) return rows;
    const ids = [...new Set(rows.flatMap((r: any) => [r.hirer_agent_id, r.worker_agent_id]))];
    const agents = await pg(`ex_agents?id=in.(${ids.join(",")})&select=id,name,avatar`);
    const byId = new Map(agents.map((a: any) => [a.id, a]));
    return rows.map((r: any) => ({ ...r, hirer_name: byId.get(r.hirer_agent_id)?.name || "?", worker_name: byId.get(r.worker_agent_id)?.name || "?" }));
  }
  async function createSubcontract(job: any, hirer: any, b: any) {
    if (job.awarded_agent_id !== hirer.id) throw Object.assign(new Error("only the agent who won this job can subcontract it"), { status: 403 });
    if (!["awarded", "delivered"].includes(job.status)) throw Object.assign(new Error(`cannot subcontract a job in status ${job.status}`), { status: 400 });
    const workerId = parseInt(b.worker_agent_id);
    const worker = await one(`ex_agents?id=eq.${workerId}&select=*`);
    if (!worker) throw Object.assign(new Error("worker agent not found"), { status: 404 });
    if (worker.id === hirer.id) throw Object.assign(new Error("an agent cannot subcontract to itself"), { status: 400 });
    if (worker.status !== "active") throw Object.assign(new Error("that agent is not active"), { status: 400 });
    if (worker.owner_id === job.poster_user_id) throw Object.assign(new Error("the job's poster cannot be subcontracted on their own job"), { status: 400 });
    const amount = parseInt(b.amount_cents || 0) || cents(Number(b.amount || 0) * 100);
    if (amount < 50) throw Object.assign(new Error("minimum subcontract is $0.50"), { status: 400 });
    const live = await pg(`ex_subcontracts?job_id=eq.${job.id}&status=in.(offered,accepted,delivered,disputed)&select=amount_cents`);
    const committed = live.reduce((a: number, r: any) => a + (r.amount_cents || 0), 0);
    if (committed + amount > job.agreed_cents) throw Object.assign(new Error(`subcontracts on this job cannot exceed the agreed price $${(job.agreed_cents / 100).toFixed(2)} (already committed $${(committed / 100).toFixed(2)})`), { status: 400 });
    const brief = String(b.brief || "").trim();
    if (brief.length < 4) throw Object.assign(new Error("describe the subcontract work in the brief"), { status: 400 });
    const rows = await pg("ex_subcontracts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, hirer_agent_id: hirer.id, worker_agent_id: worker.id, brief: brief.slice(0, 4000), amount_cents: amount, status: "offered", created_at: now() }) });
    await notify(worker.owner_id, "award", `${hirer.name} wants to hire ${worker.name} for $${(amount / 100).toFixed(2)} on "${job.title}" - accept or decline in the API (POST /agent/subcontracts/${rows[0].id}/accept)`, `#/job/${job.id}`);
    return rows[0];
  }
  async function acceptSubcontract(sub: any, worker: any) {
    if (sub.worker_agent_id !== worker.id) throw Object.assign(new Error("only the offered agent can accept"), { status: 403 });
    if (sub.status !== "offered") throw Object.assign(new Error(`subcontract is ${sub.status}`), { status: 400 });
    const job = await one(`ex_jobs?id=eq.${sub.job_id}&select=*`);
    const t = now();
    const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.offered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "accepted", accepted_at: t, work_deadline: job?.work_deadline || null }) });
    if (!updated.length) throw Object.assign(new Error("subcontract was already answered"), { status: 409 });
    try {
      await rpc("ex_hold_escrow", { p_user: worker.owner_id === sub.hirer_agent_id ? worker.owner_id : (await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`))?.owner_id, p_amount: sub.amount_cents, p_ref: `sub:${sub.id}`, p_note: `Subcontract escrow on job ${sub.job_id}`, p_now: t });
    } catch (e: any) {
      await pg(`ex_subcontracts?id=eq.${sub.id}`, { method: "PATCH", body: JSON.stringify({ status: "offered", accepted_at: null }) });
      if (String(e?.message || "").includes("insufficient balance")) throw Object.assign(new Error("the hirer's owner wallet cannot cover this subcontract's escrow - the offer stays open until they top up"), { status: 400 });
      throw e;
    }
    const hirer = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
    if (hirer) await notify(hirer.owner_id, "award", `${worker.name} accepted your subcontract on "${job?.title}" - $${(sub.amount_cents / 100).toFixed(2)} is now held in escrow`, `#/job/${sub.job_id}`);
    return updated[0];
  }
  async function deliverSubcontract(sub: any, input: DeliveryInput) {
    const notes = String(input.notes || "").trim();
    if (notes.length < 2) throw Object.assign(new Error("delivery notes required - say what is inside and what the buyer must edit or replace"), { status: 400 });
    const link = String(input.link || "").trim();
    if (link && !/^https?:\/\/.+/i.test(link)) throw Object.assign(new Error("the download link must be a full https:// link (Dropbox, Google Drive, MEGA)"), { status: 400 });
    if (!input.file && !link) throw Object.assign(new Error(DELIVERY_RULE_MSG), { status: 400 });
    if (sub.status !== "accepted") throw Object.assign(new Error(`cannot deliver a subcontract in status ${sub.status}`), { status: 400 });
    let stored: any = null;
    if (input.file) stored = await storeDeliveryFile(sub.job_id, input.file);
    const patch: Record<string, unknown> = { status: "delivered", deliverable: notes.slice(0, 8000), delivery_link: link.slice(0, 1000), delivered_at: now() };
    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_sha256 = stored.sha256; patch.delivery_check = stored.check; }
    else if (link) { patch.delivery_sha256 = await sha256hex(link); patch.delivery_check = { verdict: "link", checked_at: now(), checks: [{ name: "download link", ok: true, detail: "link deliveries cannot be content-checked; the fingerprint covers the URL itself" }] }; }
    const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.accepted`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    if (!updated.length) { if (stored) await deleteDeliveryFile(stored.storage_path); throw Object.assign(new Error("subcontract was already delivered"), { status: 409 }); }
    const hirer = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
    if (hirer) await notify(hirer.owner_id, "delivery", `A subcontract on job ${sub.job_id} has been delivered - review and complete it to release payment`, `#/job/${sub.job_id}`);
    return updated[0];
  }
  async function completeSubcontract(sub: any) {
    if (sub.status !== "delivered") throw Object.assign(new Error(`cannot complete a subcontract in status ${sub.status}`), { status: 400 });
    const worker = await one(`ex_agents?id=eq.${sub.worker_agent_id}&select=*`);
    const hirer = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
    if (!worker || !hirer) throw Object.assign(new Error("agent not found"), { status: 404 });
    const pct = await feePct();
    const fee = Math.round((sub.amount_cents * pct) / 100);
    const t = now();
    const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.delivered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed" }) });
    if (!updated.length) throw Object.assign(new Error("subcontract was already settled"), { status: 409 });
    await rpc("ex_release_escrow", { p_poster: hirer.owner_id, p_seller: worker.owner_id, p_price: sub.amount_cents, p_fee: fee, p_ref: `sub:${sub.id}`, p_now: t });
    await fundGuaranteePool(fee);
    await pg(`ex_agents?id=eq.${worker.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (worker.jobs_completed || 0) + 1, earnings_cents: (worker.earnings_cents || 0) + (sub.amount_cents - fee) }) });
    await notify(worker.owner_id, "payment", `Subcontract on job ${sub.job_id} completed - $${((sub.amount_cents - fee) / 100).toFixed(2)} landed in your wallet`, `#/job/${sub.job_id}`);
    return updated[0];
  }
'''
anchor = "  async function milestonesOf(jobId: number) {"
assert s.count(anchor) == 1
s = s.replace(anchor, HELPERS + anchor)

# fix the hold caller inside acceptSubcontract: the hirer owner id must
# come from the hirer agent row - simplify the convoluted ternary.
old_hold = '''      await rpc("ex_hold_escrow", { p_user: worker.owner_id === sub.hirer_agent_id ? worker.owner_id : (await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`))?.owner_id, p_amount: sub.amount_cents, p_ref: `sub:${sub.id}`, p_note: `Subcontract escrow on job ${sub.job_id}`, p_now: t });'''
assert s.count(old_hold) == 1
s = s.replace(old_hold, '''      const hirerRow = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
      await rpc("ex_hold_escrow", { p_user: hirerRow?.owner_id, p_amount: sub.amount_cents, p_ref: `sub:${sub.id}`, p_note: `Subcontract escrow on job ${sub.job_id}`, p_now: t });''')

# agent routes
AGENT_ROUTES = r'''
    if (path.match(/^\/agent\/jobs\/\d+\/subcontracts$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const b = await body();
      try { return json({ subcontract: await createSubcontract(job, agent, b) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path === "/agent/subcontracts" && method === "GET") {
      const asHirer = await pg(`ex_subcontracts?hirer_agent_id=eq.${agent.id}&select=*&order=created_at.desc&limit=100`);
      const asWorker = await pg(`ex_subcontracts?worker_agent_id=eq.${agent.id}&select=*&order=created_at.desc&limit=100`);
      return json({ as_hirer: asHirer, as_worker: asWorker });
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/accept$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      try { return json({ subcontract: await acceptSubcontract(sub, agent) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/decline$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      if (sub.worker_agent_id !== agent.id) return err("only the offered agent can decline", 403);
      if (sub.status !== "offered") return err(`subcontract is ${sub.status}`);
      const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.offered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "declined" }) });
      if (!updated.length) return err("subcontract was already answered", 409);
      const hirer = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
      if (hirer) await notify(hirer.owner_id, "award", `Your subcontract offer on job ${sub.job_id} was declined`, `#/job/${sub.job_id}`);
      return json({ subcontract: updated[0] });
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/deliver$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      if (sub.worker_agent_id !== agent.id) return err("only the subcontract worker can deliver", 403);
      const input = await readDeliveryInput(req);
      try { return json({ subcontract: await deliverSubcontract(sub, input) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/complete$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      if (sub.hirer_agent_id !== agent.id) return err("only the hiring agent can complete a subcontract", 403);
      try { return json({ subcontract: await completeSubcontract(sub) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/cancel$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      if (sub.hirer_agent_id !== agent.id) return err("only the hiring agent can cancel", 403);
      if (sub.status === "offered") {
        const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.offered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "cancelled" }) });
        if (!updated.length) return err("subcontract already answered", 409);
        return json({ subcontract: updated[0] });
      }
      if (sub.status === "accepted") {
        const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.accepted`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "cancelled" }) });
        if (!updated.length) return err("subcontract already settled", 409);
        await rpc("ex_refund_escrow", { p_poster: agent.owner_id, p_price: sub.amount_cents, p_ref: `sub:${sub.id}`, p_note: "Subcontract cancelled by the hirer - escrow refunded", p_now: now() });
        const worker = await one(`ex_agents?id=eq.${sub.worker_agent_id}&select=owner_id`);
        if (worker) await notify(worker.owner_id, "award", `A subcontract on job ${sub.job_id} was cancelled - its escrow was refunded to the hirer`, `#/job/${sub.job_id}`);
        return json({ subcontract: updated[0] });
      }
      return err(`cannot cancel a subcontract in status ${sub.status}`);
    }
    if (path.match(/^\/agent\/subcontracts\/\d+\/dispute$/) && method === "POST") {
      const sub = await one(`ex_subcontracts?id=eq.${parseInt(seg[2])}&select=*`);
      if (!sub) return err("subcontract not found", 404);
      const b = await body();
      const isParty = sub.hirer_agent_id === agent.id || sub.worker_agent_id === agent.id;
      if (!isParty) return err("not your subcontract", 403);
      if (!["accepted", "delivered"].includes(sub.status)) return err(`cannot dispute a subcontract in status ${sub.status}`);
      const reason = String(b.reason || "").trim();
      if (reason.length < 4) return err("say what went wrong (a few words at least)");
      const updated = await pg(`ex_subcontracts?id=eq.${sub.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "disputed", dispute_reason: reason.slice(0, 1000) }) });
      const admins = await pg("ex_users?role=eq.admin&select=id");
      for (const a of admins) await notify(a.id, "dispute", `Subcontract ${sub.id} on job ${sub.job_id} is disputed: ${reason.slice(0, 140)}`, `#/job/${sub.job_id}`);
      return json({ subcontract: updated[0] });
    }
'''
anchor2 = '    if (path.match(/^\\/agent\\/jobs\\/\\d+\\/milestones\\/\\d+\\/deliver$/) && method === "POST") {'
assert s.count(anchor2) == 1
s = s.replace(anchor2, AGENT_ROUTES + anchor2)

# owner visibility + admin dispute resolution (admin block route is owner-JWT)
OWNER_ROUTE = r'''
  if (path === "/my/subcontracts" && method === "GET") {
    const u = await requireUser(req);
    const mine = await pg(`ex_agents?owner_id=eq.${u.id}&select=id`);
    const ids = mine.map((a: any) => a.id);
    if (!ids.length) return json({ as_hirer: [], as_worker: [] });
    const asHirer = await pg(`ex_subcontracts?hirer_agent_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=100`);
    const asWorker = await pg(`ex_subcontracts?worker_agent_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=100`);
    return json({ as_hirer: asHirer, as_worker: asWorker });
  }
'''
anchor3 = '  if (path.match(/^\\/jobs\\/\\d+\\/milestones\\/\\d+\\/deliver$/) && method === "POST") {'
assert s.count(anchor3) == 1
s = s.replace(anchor3, OWNER_ROUTE + anchor3)

ADMIN_SUB = r'''
    if (path.match(/^\/admin\/subcontracts\/\d+\/resolve$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const sub = await one(`ex_subcontracts?id=eq.${id}&select=*`);
      if (!sub || sub.status !== "disputed") return err("disputed subcontract not found", 404);
      const worker = await one(`ex_agents?id=eq.${sub.worker_agent_id}&select=*`);
      const hirer = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
      if (!worker || !hirer) return err("agent not found", 404);
      const t = now();
      if (b.resolution === "worker") {
        const pct = await feePct();
        const fee = Math.round((sub.amount_cents * pct) / 100);
        await pg(`ex_subcontracts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
        await rpc("ex_release_escrow", { p_poster: hirer.owner_id, p_seller: worker.owner_id, p_price: sub.amount_cents, p_fee: fee, p_ref: `sub:${id}`, p_now: t });
        await fundGuaranteePool(fee);
        await pg(`ex_agents?id=eq.${worker.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (worker.jobs_completed || 0) + 1, earnings_cents: (worker.earnings_cents || 0) + (sub.amount_cents - fee) }) });
        await notify(worker.owner_id, "payment", `Subcontract dispute on job ${sub.job_id} resolved for the worker - $${((sub.amount_cents - fee) / 100).toFixed(2)} landed in your wallet`, `#/job/${sub.job_id}`);
        await notify(hirer.owner_id, "dispute", `Subcontract dispute on job ${sub.job_id} was resolved for the worker`, `#/job/${sub.job_id}`);
      } else if (b.resolution === "hirer") {
        await pg(`ex_subcontracts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
        await rpc("ex_refund_escrow", { p_poster: hirer.owner_id, p_price: sub.amount_cents, p_ref: `sub:${id}`, p_note: "Subcontract dispute resolved for the hirer - escrow refunded", p_now: t });
        await notify(hirer.owner_id, "dispute", `Subcontract dispute on job ${sub.job_id} was resolved for you - the escrow was refunded`, `#/job/${sub.job_id}`);
        await notify(worker.owner_id, "dispute", `Subcontract dispute on job ${sub.job_id} was resolved for the hirer`, `#/job/${sub.job_id}`);
      } else return err("resolution must be hirer or worker");
      return json({ ok: true });
    }
'''
anchor4 = '    if (path === "/admin/guarantee" && method === "GET") {'
assert s.count(anchor4) == 1
s = s.replace(anchor4, ADMIN_SUB + anchor4)

# job detail includes the subcontract chain (web + agent)
old_wd2 = '''    (jobView as any).milestones = await milestonesOf(id);'''
assert s.count(old_wd2) == 1
s = s.replace(old_wd2, old_wd2 + '''
    (jobView as any).subcontracts = await subcontractsOf(id);''')
old_ad2 = '''      (jobView as any).milestones = await milestonesOf(jobId);'''
assert s.count(old_ad2) == 1
s = s.replace(old_ad2, old_ad2 + '''
      (jobView as any).subcontracts = await subcontractsOf(jobId);''')

old_help = '''          milestones: "Jobs can split escrow into'''
assert s.count(old_help) == 1
s = s.replace(old_help, '''          subcontracts: "Agents hiring agents: the agent who WON a job can subcontract part of it (POST /agent/jobs/:id/subcontracts {worker_agent_id, amount_cents, brief}; the total across live subcontracts cannot exceed the agreed price, and the job's poster cannot be a worker). The offered agent accepts (POST /agent/subcontracts/:id/accept - escrow is held from the HIRER OWNER's wallet) or declines; delivers like any delivery (POST /agent/subcontracts/:id/deliver, file or big-file link + notes, fingerprinted); the hirer completes (POST /agent/subcontracts/:id/complete - escrow released minus the 10% fee) or either side disputes (POST /agent/subcontracts/:id/dispute; an admin resolves via POST /admin/subcontracts/:id/resolve). GET /agent/subcontracts lists yours; owners see GET /my/subcontracts.",
          milestones: "Jobs can split escrow into''')

TS.write_text(s)
print("backend patched")

# ---------- frontend: subcontract chain panel on the job page ----------
a = APP.read_text()
old_panel = '''      ${(j.milestones || []).length ? `<div class="panel rv" style="--d:.08s"><h3>${ic("layers")} Milestones</h3>'''
assert a.count(old_panel) == 1
a = a.replace(old_panel, '''      ${(j.subcontracts || []).length ? `<div class="panel rv" style="--d:.07s"><h3>${ic("link")} Work chain — agents hiring agents</h3>
        <p class="small mut mt">The winner of this job hired other agents for parts of the work. Each subcontract has its own escrow.</p>
        ${(j.subcontracts || []).map((sc) => `<p class="mt small"><b>${esc(sc.hirer_name)}</b> hired <b>${esc(sc.worker_name)}</b> — ${money(sc.amount_cents)} <span class="pill">${sc.status}</span><br><span class="mut">${esc(sc.brief)}</span>${sc.delivery_sha256 ? `<br>🔒 fingerprint <code>${esc(String(sc.delivery_sha256).slice(0, 12))}…</code>` : ""}</p>`).join("")}
      </div>` : ""}
''' + old_panel)
old_rule = '''<br>- <b>Guarantee pool</b> - 1% of every completed job (10% of the platform fee) is earmarked into a public buyer-protection pool that admins pay claims from.</p>'''
assert a.count(old_rule) == 1
a = a.replace(old_rule, old_rule.replace("</p>", "") + '''<br>- <b>Agents hiring agents</b> - the winner of a job can subcontract parts of it to other agents, each with its own escrow, delivery and payment.</p>''')
APP.write_text(a)
print("frontend patched")

r = README.read_text()
old_r = "**Milestone escrow:**"
assert r.count(old_r) == 1
r = r.replace(old_r, "**Agents hiring agents (subcontracts):** a job's winner can hire other agents for parts of the work (`POST /agent/jobs/:id/subcontracts`) — escrow held from the hirer's owner wallet at acceptance, fingerprinted delivery, release minus the 10% fee on completion, admin-resolved disputes. " + old_r)
README.write_text(r)
print("README patched")
print("DONE")
