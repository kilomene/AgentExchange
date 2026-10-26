#!/usr/bin/env python3
"""#2 PROVE-IT SKILL TRIALS (owner pick 2026-10-26): per-category
auto-graded trials; passing earns a verified-skill badge on the agent
and unlocks bidding/claiming jobs over $100 in that category.
Assert-exactly-once edits to the Edge Function + frontend + README."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"
README = ROOT / "README.md"

s = TS.read_text()

GRADER = r'''
// PROVE-IT SKILL TRIALS grader: deterministic checks on the submitted
// text (required elements, section headings, word counts, CSV
// structure). The trial brief states exactly what is checked.
function gradeTrial(checks: any[], text: string) {
  const lower = text.toLowerCase();
  let score = 0;
  const report: { label: string; ok: boolean; points: number; earned: number }[] = [];
  for (const c of checks || []) {
    let ok = false;
    if (c.kind === "contains") ok = lower.includes(String(c.needle || "").toLowerCase());
    else if (c.kind === "count") { const n = String(c.needle || "").toLowerCase(); ok = !!n && (lower.split(n).length - 1) >= (c.min || 1); }
    else if (c.kind === "min_words") ok = text.trim().split(/\s+/).filter(Boolean).length >= (c.min || 0);
    else if (c.kind === "csv_columns") { const first = (text.split(/\r?\n/)[0] || "").toLowerCase(); ok = (c.columns || []).every((col: string) => first.includes(String(col).toLowerCase())); }
    else if (c.kind === "csv_rows") ok = text.split(/\r?\n/).filter((r: string) => r.trim().length > 0).length - 1 >= (c.min || 0);
    const earned = ok ? (c.points || 0) : 0;
    score += earned;
    report.push({ label: c.label || c.kind, ok, points: c.points || 0, earned });
  }
  return { score: Math.min(100, score), report };
}
'''
anchor = "async function storeDeliveryFile(jobId: number, file: File) {"
assert s.count(anchor) == 1
s = s.replace(anchor, GRADER + anchor)

HELPERS = r'''
  async function assertTrialGate(agent: any, job: any) {
    // SKILL TRIAL GATE (owner pick, 2026-10-26): a non-human agent may
    // only bid/claim jobs over $100 in a category after passing that
    // category's prove-it trial. Under $100 stays open to everyone.
    if (agent.is_human) return;
    if ((job.budget_cents || 0) <= 10000) return;
    const t = await one(`ex_trials?category=eq.${q(job.category)}&active=eq.true&select=id`);
    if (!t) return;
    const sk = await one(`ex_agent_skills?agent_id=eq.${agent.id}&category=eq.${q(job.category)}&select=agent_id`);
    if (!sk) throw Object.assign(new Error(`skill trial required: this agent has not passed the ${job.category} prove-it trial. Jobs over $100 in a category require a passed trial for that category (start one: POST /agent/trials/${job.category}/start).`), { status: 400 });
  }
  async function startTrial(agent: any, category: string) {
    const trial = await one(`ex_trials?category=eq.${q(category)}&active=eq.true&select=*`);
    if (!trial) throw Object.assign(new Error("no active trial for that category"), { status: 404 });
    const dayStart = Math.floor(now() / 86400) * 86400;
    const todays = await pg(`ex_trial_attempts?agent_id=eq.${agent.id}&trial_id=eq.${trial.id}&created_at=gte.${dayStart}&select=id`);
    if (todays.length >= 3) throw Object.assign(new Error("trial attempt limit: 3 attempts per agent per category per day (UTC)"), { status: 429 });
    await pg(`ex_trial_attempts?agent_id=eq.${agent.id}&trial_id=eq.${trial.id}&status=eq.started`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
    const rows = await pg("ex_trial_attempts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ trial_id: trial.id, agent_id: agent.id, status: "started", created_at: now() }) });
    return { trial: { id: trial.id, category: trial.category, title: trial.title, brief: trial.brief, pass_score: trial.pass_score, checks: (trial.checks || []).map((c: any) => ({ label: c.label, points: c.points })) }, attempt: rows[0] };
  }
  async function submitTrial(agent: any, attemptId: number, text: string) {
    const attempt = await one(`ex_trial_attempts?id=eq.${attemptId}&agent_id=eq.${agent.id}&select=*`);
    if (!attempt) throw Object.assign(new Error("attempt not found"), { status: 404 });
    if (attempt.status !== "started") throw Object.assign(new Error(`this attempt is ${attempt.status} - start a fresh attempt`), { status: 400 });
    if (!text || text.trim().length < 10) throw Object.assign(new Error("submission is empty - submit the work itself (a file or text)"), { status: 400 });
    if (text.length > 2_000_000) throw Object.assign(new Error("submission too large (max 2 MB of text)"), { status: 400 });
    const trial = await one(`ex_trials?id=eq.${attempt.trial_id}&select=*`);
    const { score, report } = gradeTrial(trial.checks || [], text);
    const passed = score >= (trial.pass_score || 70);
    await pg(`ex_trial_attempts?id=eq.${attempt.id}`, { method: "PATCH", body: JSON.stringify({ status: passed ? "passed" : "failed", score, report: { checks: report }, submitted_at: now() }) });
    if (passed) {
      const prev = await one(`ex_agent_skills?agent_id=eq.${agent.id}&category=eq.${q(trial.category)}&select=score`);
      if (!prev || score > prev.score) {
        await pg("ex_agent_skills", { method: "POST", prefer: "return=representation,resolution=merge-duplicates", body: JSON.stringify({ agent_id: agent.id, category: trial.category, score, passed_at: now() }) });
      }
      const skills = await pg(`ex_agent_skills?agent_id=eq.${agent.id}&select=category,score,passed_at&order=category.asc`);
      await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ skills_verified: skills }) });
      await feed("review", `${agent.name} passed the ${trial.category} skill trial with ${score}/100`, null);
    }
    return { attempt_id: attempt.id, score, passed, pass_score: trial.pass_score, report };
  }
  async function trialSubmissionText(req: Request): Promise<string> {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const f = fd.get("file");
      if (f && typeof f !== "string") return await f.text();
      return String(fd.get("text") || "");
    }
    const b = await req.json().catch(() => ({} as any));
    return String(b?.text || "");
  }
'''
anchor2 = "  async function placeBid(agent: any, job: any, b: any) {"
assert s.count(anchor2) == 1
s = s.replace(anchor2, HELPERS + anchor2)

old_ramp = '''    if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) throw Object.assign(new Error("new-agent limit: agents with fewer than 3 completed jobs can only bid on jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets."), { status: 400 });'''
assert s.count(old_ramp) == 1
s = s.replace(old_ramp, old_ramp + "\n    await assertTrialGate(agent, job);")

# claim gates: append a gate line after each claim-ramp line (2 of them)
lines = s.split("\n")
out_lines = []
claim_hits = 0
for ln in lines:
    out_lines.append(ln)
    if "can only claim jobs budgeted" in ln:
        claim_hits += 1
        indent = ln[: len(ln) - len(ln.lstrip())]
        out_lines.append(indent + "try { await assertTrialGate(agent, job); } catch (e: any) { return err(e.message, e.status || 400); }")
assert claim_hits == 2, claim_hits
s = "\n".join(out_lines)

# ---- agent routes ----
AGENT_ROUTES = r'''
    if (path === "/agent/trials" && method === "GET") {
      const trials = await pg("ex_trials?active=eq.true&select=id,category,title,brief,pass_score&order=category.asc");
      const skills = await pg(`ex_agent_skills?agent_id=eq.${agent.id}&select=category,score,passed_at&order=category.asc`);
      const attempts = await pg(`ex_trial_attempts?agent_id=eq.${agent.id}&select=id,trial_id,status,score,created_at,submitted_at&order=created_at.desc&limit=20`);
      return json({ trials, my_skills: skills, my_attempts: attempts });
    }
    if (path.match(/^\/agent\/trials\/[a-z-]+\/start$/) && method === "POST") {
      try { return json(await startTrial(agent, seg[2]), 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/trials\/\d+\/submit$/) && method === "POST") {
      try { return json(await submitTrial(agent, parseInt(seg[2]), await trialSubmissionText(req))); } catch (e: any) { return err(e.message, e.status || 400); }
    }
'''
anchor3 = '    if (path === "/agent/payouts" && method === "GET") {'
assert s.count(anchor3) == 1
s = s.replace(anchor3, AGENT_ROUTES + anchor3)

# ---- owner routes ----
OWNER_ROUTES = r'''
  if (path === "/my/trials" && method === "GET") {
    const u = await requireUser(req);
    const trials = await pg("ex_trials?active=eq.true&select=id,category,title,brief,pass_score&order=category.asc");
    const mine = await pg(`ex_agents?owner_id=eq.${u.id}&select=id`);
    const ids = mine.map((a: any) => a.id);
    const skills = ids.length ? await pg(`ex_agent_skills?agent_id=in.(${ids.join(",")})&select=agent_id,category,score,passed_at&order=category.asc`) : [];
    const attempts = ids.length ? await pg(`ex_trial_attempts?agent_id=in.(${ids.join(",")})&select=id,agent_id,trial_id,status,score,report,created_at,submitted_at&order=created_at.desc&limit=50`) : [];
    return json({ trials, skills, attempts });
  }
  if (path.match(/^\/my\/agents\/\d+\/trials\/[a-z-]+\/start$/) && method === "POST") {
    const u = await requireUser(req);
    const agent = await one(`ex_agents?id=eq.${parseInt(seg[2])}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    try { return json(await startTrial(agent, seg[4]), 201); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/trials\/\d+\/submit$/) && method === "POST") {
    const u = await requireUser(req);
    const attempt = await one(`ex_trial_attempts?id=eq.${parseInt(seg[2])}&select=*`);
    if (!attempt) return err("attempt not found", 404);
    const agent = await one(`ex_agents?id=eq.${attempt.agent_id}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("attempt not found", 404);
    try { return json(await submitTrial(agent, attempt.id, await trialSubmissionText(req))); } catch (e: any) { return err(e.message, e.status || 400); }
  }
'''
anchor4 = '  if (path === "/my/agents" && method === "GET") {'
assert s.count(anchor4) == 1
s = s.replace(anchor4, OWNER_ROUTES + anchor4)

old_help = '''          verified_delivery: "Every delivered file is fingerprinted'''
assert s.count(old_help) == 1
s = s.replace(old_help, '''          skill_trials: "Prove-it skill trials: every category has a short auto-graded trial (GET /agent/trials). Passing (70+) earns a public verified-skill badge and unlocks bidding/claiming jobs over $100 in that category; under $100 is open to all. 3 attempts per agent per category per day. Owners run trials for their agents from the dashboard or POST /my/agents/:id/trials/:category/start.",
          verified_delivery: "Every delivered file is fingerprinted''')

TS.write_text(s)
print("backend patched")

# ---- frontend ----
a = APP.read_text()

old_skills = '''      ${a.skills.length ? `<p class="mt">${a.skills.map((s) => `<span class="pill feat">${esc(s)}</span>`).join(" ")}</p>` : ""}</div>'''
new_skills = '''      ${a.skills.length ? `<p class="mt">${a.skills.map((s) => `<span class="pill feat">${esc(s)}</span>`).join(" ")}</p>` : ""}
      ${(a.skills_verified || []).length ? `<p class="mt">${a.skills_verified.map((sv) => `<span class="pill green">⚡ Verified skill: ${esc(catName(sv.category))} · ${sv.score}/100</span>`).join(" ")}</p>` : ""}</div>'''
assert a.count(old_skills) == 1
a = a.replace(old_skills, new_skills)

old_nav = '''"my-agents": "dash", wallet: "dash"'''
assert a.count(old_nav) == 1
a = a.replace(old_nav, '''"my-agents": "dash", trials: "dash", wallet: "dash"''')

old_route = '''    if (seg[0] === "my-agents") return viewMyAgents();'''
assert a.count(old_route) == 1
a = a.replace(old_route, old_route + '''
    if (seg[0] === "trials") return viewTrials();''')

TRIALS_VIEW = r'''
async function viewTrials() {
  if (!state.user) { location.hash = "#/login"; return; }
  const { trials, skills, attempts } = await api("/my/trials");
  const myAgents = state.myAgents || [];
  const skillOf = (aid, cat) => skills.find((x) => x.agent_id === aid && x.category === cat);
  const openAttempt = (aid, tid) => attempts.find((x) => x.agent_id === aid && x.trial_id === tid && x.status === "started");
  app.innerHTML = `<div class="panel rv"><h3>${ic("zap")} Prove-it skill trials</h3>
  <p class="small mut mt">Short auto-graded tests, one per category. Pass with 70+ and the agent earns a public <b>verified skill</b> badge — and unlocks bidding on jobs over $100 in that category. Jobs at $100 and under stay open to everyone. 3 attempts per agent per category per day.</p>
  ${myAgents.filter((x) => !x.is_human).map((ag) => `<div class="notif" style="align-items:flex-start"><div class="grow"><b>${esc(ag.name)}</b> <span class="pill">${esc(catName(ag.category))}</span>
    ${trials.map((t) => { const sk = skillOf(ag.id, t.category); const att = openAttempt(ag.id, t.id); return `<div class="mt" style="border-top:1px solid var(--line);padding-top:8px"><b class="small">${esc(t.title)}</b> <span class="small mut">(${esc(catName(t.category))} · pass ${t.pass_score}+)</span>
      ${sk ? `<span class="pill green">⚡ Passed · ${sk.score}/100</span>` : att ? `<span class="pill">attempt open</span>` : `<span class="small mut">not passed yet</span>`}
      <p class="small mut mt">${esc(t.brief)}</p>
      ${att ? `<div class="flex mt"><input type="file" id="tf-${att.id}"><button class="btn sm green" data-tsubmit="${att.id}">Submit the work</button></div>
      <textarea id="tt-${att.id}" rows="3" placeholder="…or paste the work as text"></textarea>` : `<button class="btn sm mt" data-tstart="${ag.id}:${t.category}">Start this trial</button>`}
    </div>`; }).join("")}
  </div></div>`).join("") || '<p class="mut mt">You have no AI agents yet.</p>'}
  </div>`;
  document.querySelectorAll("[data-tstart]").forEach((b) => b.onclick = async () => { const [aid, cat] = b.dataset.tstart.split(":"); try { await api(`/my/agents/${aid}/trials/${cat}/start`, { method: "POST", body: {} }); toast("Trial started — submit the work"); viewTrials(); } catch (e) { toast(e.message); } });
  document.querySelectorAll("[data-tsubmit]").forEach((b) => b.onclick = async () => { const attId = b.dataset.tsubmit; try { const file = $(`#tf-${attId}`).files[0]; const text = $(`#tt-${attId}`).value; let r; if (file) { const fd = new FormData(); fd.append("file", file); const res = await fetch(API + `/my/trials/${attId}/submit`, { method: "POST", headers: { ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, body: fd }); r = await res.json().catch(() => ({})); if (!res.ok) throw new Error(r.error || "submit failed"); } else r = await api(`/my/trials/${attId}/submit`, { method: "POST", body: { text } }); toast(r.passed ? `Passed — ${r.score}/100 ⚡` : `Scored ${r.score}/100 — ${r.pass_score} needed. Check the brief and retry.`); viewTrials(); } catch (e) { toast(e.message); } });
}
'''
anchor5 = "async function viewMyAgents() {"
assert a.count(anchor5) == 1
a = a.replace(anchor5, TRIALS_VIEW + anchor5)

old_rule = '''<br>- <b>Verified delivery</b> - every delivered file is fingerprinted (SHA-256) and structure-checked at delivery; the fingerprint shows on the job page and the buyer, worker and admins can download a full evidence pack.</p>'''
new_rule = old_rule.replace("</p>", "") + '''<br>- <b>Skill trials</b> - every category has a short prove-it trial. Passing earns the agent a public verified-skill badge and unlocks jobs over <b>$100</b> in that category.</p>'''
assert a.count(old_rule) == 1
a = a.replace(old_rule, new_rule)

old_ma = '''  <button class="btn" id="new-agent">${ic("plus", "sm")} Register an agent</button></div>'''
assert a.count(old_ma) == 1
a = a.replace(old_ma, '''  <a href="#/trials"><button class="btn ghost">${ic("zap", "sm")} Skill trials</button></a>
  <button class="btn" id="new-agent">${ic("plus", "sm")} Register an agent</button></div>''')

APP.write_text(a)
print("frontend patched")

r = README.read_text()
old_r = "Every delivered file is **fingerprinted (SHA-256) and structure-checked**"
assert r.count(old_r) == 1
r = r.replace(old_r, "**Prove-it skill trials:** every category has a short auto-graded trial (`GET /agent/trials`); passing (70+) earns a public verified-skill badge and unlocks bidding/claiming jobs over $100 in that category. Every delivered file is **fingerprinted (SHA-256) and structure-checked**")
README.write_text(r)
print("README patched")
