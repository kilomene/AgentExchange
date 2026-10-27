// exchange-sweeper - the Exchange's time-based rules (owner's batch-2,
// 2026-10-26). Runs every 60 seconds:
//  1. DEADLINE ENFORCEMENT: a job still 'awarded' past its work_deadline
//     is cancelled automatically and its escrow refunds to the poster.
//     The status flip (awarded -> cancelled) is the claim: only the cycle
//     that wins it refunds, and a failed refund reverts the flip so the
//     next cycle retries. Poster and worker are notified + emailed.
//  2. INACTIVITY SUSPENSION (owner's batch-3, 2026-10-26; replaces the old
//     30-day pause): an agent with no activity for 14 days is SUSPENDED
//     with suspension_reason='inactivity'. Its owner brings it back from
//     the dashboard by paying a $5 fine. Activity = any agent-API call
//     (last_active_at is stamped by the API), bids, contracts or chat.
//  3. BAN-EVASION ALT SCAN: a non-admin account whose sign-up or last IP
//     matches a banned account's address is suspended, its own addresses
//     join the ban list, and the admins are notified. Admin accounts are
//     never auto-suspended (a shared address must not lock out the owner).
//  4. Housekeeping: prune ex_rate_counters windows older than a day.
//  5. DELIVERED AUTO-RELEASE (poster-ghosting fix): a job sitting in
//     'delivered' for 14 days with no approval and no dispute settles
//     exactly like a completion - escrow releases to the worker (only
//     the unreleased remainder on milestone jobs), stats and the
//     guarantee pool are credited, both sides are notified + emailed.
//     At 7 days the poster first gets ONE in-app reminder. CONTRACT
//     jobs settle by their PAY RULE here (outcome / per-entry /
//     per-minute math mirroring the backend's completeContractJob) -
//     never the full agreed price.
//  6. SCHEDULED CONTRACTS (Phase D): exempt from the +24h window
//     refund and from deadline refunds - they run on the schedule
//     clock. At schedule_end + 48h with the job still awarded, the
//     run auto-settles: proved entries pay their outcome share of the
//     agreed price, everything else refunds (full refund + cancelled
//     when nothing was earned).
// Zero dependencies; talks to PostgREST with the service key via curl
// (which honors the host's egress proxy, like every other host service).
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || "https://exchange.novamail.store";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const REST = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const nowSec = () => Math.floor(Date.now() / 1000);
const money = (c) => "$" + (Number(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// SECRET REDACTION (audit fix): auth headers travel in a curl config
// file (-K, mode 0600 in a 0700 temp dir), never on the command line —
// execFile error messages embed the full argv, and the old -H form wrote
// the service-role key into journald on every failed call. As a second
// layer, every error this runner produces is passed through redact().
const cfgDir = mkdtempSync(join(tmpdir(), "exchange-sweeper-"));
chmodSync(cfgDir, 0o700);
const cfgFile = join(cfgDir, "curlrc");
writeFileSync(cfgFile, [
  `header = "apikey: ${SERVICE_KEY}"`,
  `header = "Authorization: Bearer ${SERVICE_KEY}"`,
  `header = "Content-Type: application/json"`,
  "",
].join("\n"), { mode: 0o600 });
chmodSync(cfgFile, 0o600);
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best-effort */ } process.exit(0); });
}
const redact = (s) => String(s ?? "").split(SERVICE_KEY).join("[redacted]");

function curl(method, url, body, prefer) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-w", "\n%{http_code}", "-X", method, url, "-K", cfgFile];
    if (prefer) args.push("-H", `Prefer: ${prefer}`);
    if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
    execFile("curl", args, { maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
      if (e) return reject(new Error(redact(e.message)));
      const cut = stdout.lastIndexOf("\n");
      const text = stdout.slice(0, cut);
      const code = parseInt(stdout.slice(cut + 1), 10);
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (code >= 400) return reject(new Error(redact(`${method} ${url.split("?")[0]} -> ${code}: ${text.slice(0, 200)}`)));
      resolve(data);
    });
  });
}
const get = (path) => curl("GET", `${REST}/${path}`);
const patch = (path, body, prefer) => curl("PATCH", `${REST}/${path}`, body, prefer);
const post = (path, body, prefer) => curl("POST", `${REST}/${path}`, body, prefer);
const rpc = (fn, args) => curl("POST", `${REST}/rpc/${fn}`, args);
const del = (path) => curl("DELETE", `${REST}/${path}`);

async function notify(userId, type, body, link = "") {
  await post("ex_notifications", { user_id: userId, type, body, link, created_at: nowSec() });
}
async function queueMail(kind, user, payload) {
  await post("ex_outbox", { kind, to_email: user.email, to_name: user.name || null, subject: null, payload, created_at: nowSec() });
}
async function walletOf(userId) {
  const rows = await get(`ex_wallets?user_id=eq.${userId}&select=balance_cents,held_cents`);
  return rows && rows[0] ? rows[0] : null;
}
// GUARANTEE POOL: 10% of the platform fee (1% of the price) is earmarked
// on every completion. Prefer the backend's atomic ex_pool_adjust RPC;
// while it is not deployed yet (404), fall back to read + PATCH of
// ex_settings (loosely racy, logged so the drift is visible).
async function fundPool(feeCents) {
  const cut = Math.round((feeCents || 0) * 0.10);
  if (cut <= 0) return;
  try {
    await rpc("ex_pool_adjust", { p_delta: cut });
    return;
  } catch (e) {
    if (!/404|PGRST202|not found/i.test(e.message)) throw e;
    console.log("pool: ex_pool_adjust not available yet, using ex_settings read+PATCH fallback");
  }
  const row = (await get("ex_settings?key=eq.guarantee_pool_cents&select=value"))[0];
  const cur = parseInt(row?.value || "0") || 0;
  await patch("ex_settings?key=eq.guarantee_pool_cents", { value: String(cur + cut) });
}

async function deadlineRefunds() {
  const t = nowSec();
  const jobs = await get(`ex_jobs?status=eq.awarded&work_deadline=lt.${t}&work_deadline=not.is.null&select=*&limit=50`);
  // SCHEDULED CONTRACTS (Phase D) are exempt: their work deadline is
  // the bid's ETA, not the run's clock - the schedule-expiry duty
  // settles them at schedule_end + 48h instead.
  const contractIds = (jobs || []).filter((j) => j.job_kind === "contract").map((j) => j.id);
  const scheduledIds = new Set();
  if (contractIds.length) {
    const cjs = await get(`ex_contract_jobs?job_id=in.(${contractIds.join(",")})&task_count=not.is.null&select=job_id`).catch(() => []);
    for (const c of cjs || []) scheduledIds.add(c.job_id);
  }
  for (const job of jobs || []) {
   if (scheduledIds.has(job.id)) continue;
   try {
    const claimed = await patch(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { status: "cancelled", updated_at: t }, "return=representation");
    if (!claimed || !claimed.length) continue; // someone else handled it
    // MILESTONE ESCROW: only the UNRELEASED remainder refunds - released
    // milestones stay paid. Computed before the try so the notifications
    // after the refund can name the real amount.
    const relMs = await get(`ex_milestones?job_id=eq.${job.id}&status=eq.released&select=amount_cents`).catch(() => []);
    const refundAmt = job.agreed_cents - (relMs || []).reduce((a, m) => a + (m.amount_cents || 0), 0);
    try {
      if (refundAmt > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refundAmt, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed - unreleased escrow automatically refunded (released milestones stay paid)", p_now: t });
    } catch (e) {
      await patch(`ex_jobs?id=eq.${job.id}`, { status: "awarded", updated_at: t }).catch(() => {});
      console.error(`deadline refund FAILED for job ${job.id} (status reverted, will retry):`, e.message);
      continue;
    }
    const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
    const wallet = (await get(`ex_wallets?user_id=eq.${job.poster_user_id}&select=balance_cents`))[0];
    await notify(job.poster_user_id, "payment", `"${job.title}" was cancelled automatically - the delivery deadline passed with no delivery, and your unreleased escrow (${money(refundAmt)}) was refunded to your wallet`, `#/job/${job.id}`);
    if (poster) await queueMail("job_auto_refunded", poster, { name: poster.name || "", title: job.title, amount: money(refundAmt), wallet_after: wallet ? money(wallet.balance_cents) : "", link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("poster mail failed", e.message));
    if (job.awarded_agent_id) {
      const agent = (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id`))[0];
      if (agent) {
        await notify(agent.owner_id, "delivery", `"${job.title}" was cancelled automatically - the delivery deadline passed with no delivery, and the escrow was refunded to the poster`, `#/job/${job.id}`);
        const owner = (await get(`ex_users?id=eq.${agent.owner_id}&select=id,email,name`))[0];
        if (owner) await queueMail("job_auto_refunded", owner, { name: owner.name || "", title: job.title, worker: true, agent_name: agent.name, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("worker mail failed", e.message));
      }
    }
    console.log(`deadline: job ${job.id} auto-cancelled, ${money(job.agreed_cents)} refunded to poster ${job.poster_user_id}`);
   } catch (e) {
    // One bad job must not stop the rest of the cycle's refunds.
    console.error(`deadlineRefunds: job ${job.id} failed:`, e.message);
   }
  }
}

async function deadListings() {
  const t = nowSec();
  const cutoff = t - 14 * 86400;
  const agents = await get(`ex_agents?status=eq.active&is_human=eq.false&select=id,name,owner_id,created_at,last_active_at&limit=200`);
  for (const a of agents || []) {
   try {
    const lastActive = Math.max(Number(a.last_active_at || 0), Number(a.created_at || 0));
    if (lastActive > cutoff) continue;
    const bids = await get(`ex_bids?agent_id=eq.${a.id}&created_at=gt.${cutoff}&select=id&limit=1`);
    if (bids && bids.length) continue;
    const won = await get(`ex_jobs?awarded_agent_id=eq.${a.id}&updated_at=gt.${cutoff}&select=id&limit=1`);
    if (won && won.length) continue;
    const msgs = await get(`ex_messages?sender_user_id=eq.${a.owner_id}&created_at=gt.${cutoff}&select=id&limit=1`);
    if (msgs && msgs.length) continue;
    let alive = false;
    try {
      const pres = await get(`ex_agent_status?agent_id=eq.${a.id}&select=*&limit=1`);
      if (pres && pres.length) alive = Object.values(pres[0]).some((v) => typeof v === "number" && v > cutoff);
    } catch { /* no presence table signal - fall through */ }
    if (alive) continue;
    await patch(`ex_agents?id=eq.${a.id}&status=eq.active`, { status: "suspended", suspension_reason: "inactivity" });
    await notify(a.owner_id, "security", `${a.name} was suspended after 14 days without activity. Reactivate it from your dashboard - a $5 fine is taken from your wallet when you do.`, `#/dashboard`);
    console.log(`inactivity: agent ${a.id} (${a.name}) auto-suspended (14 days silent)`);
   } catch (e) {
    // One agent's failed checks must not stop the remaining agents.
    console.error(`deadListings: agent ${a.id} check failed:`, e.message);
   }
  }
}

async function altScan() {
  const t = nowSec();
  const bannedUsers = await get("ex_users?suspended=eq.true&select=id,signup_ip,last_ip");
  const bannedRows = await get("ex_banned_ips?select=ip").catch(() => []);
  const bannedIps = new Set((bannedRows || []).map((r) => r.ip));
  for (const u of bannedUsers || []) {
    if (u.signup_ip) bannedIps.add(u.signup_ip);
    if (u.last_ip) bannedIps.add(u.last_ip);
  }
  bannedIps.delete("");
  if (!bannedIps.size) return;
  const admins = await get("ex_users?role=eq.admin&select=id");
  const users = await get("ex_users?suspended=eq.false&role=neq.admin&select=id,name,signup_ip,last_ip&limit=500");
  for (const u of users || []) {
   try {
    const hit = [u.signup_ip, u.last_ip].find((ip) => ip && bannedIps.has(ip));
    if (!hit) continue;
    await patch(`ex_users?id=eq.${u.id}`, { suspended: true });
    for (const ip of [u.signup_ip, u.last_ip]) {
      if (ip) await post("ex_banned_ips", { ip, reason: `alt account of a banned user (matched ${hit})`, source_user_id: u.id, created_at: t }, "resolution=ignore-duplicates").catch(() => {});
    }
    for (const a of admins || []) await notify(a.id, "security", `Account ${u.id} (${u.name || ""}) was auto-suspended: it shares an IP address with a banned account`, "#/admin");
    console.log(`alt-scan: user ${u.id} auto-suspended (shared banned IP ${hit})`);
   } catch (e) {
    // One bad account must not stop the scan of the remaining accounts.
    console.error(`altScan: user ${u.id} failed:`, e.message);
   }
  }
}

// POSTER REMINDER (7 days): ONE in-app nudge while the poster can still
// approve or dispute. Deduped against the notifications table itself:
// a reminder for the same job inside the last 14 days suppresses a new
// one. In-app only - no email for the reminder.
async function posterReminder(job, t) {
  const link = `#/job/${job.id}`;
  const existing = await get(`ex_notifications?user_id=eq.${job.poster_user_id}&link=eq.${encodeURIComponent(link)}&body=like.*delivered%207%20days%20ago*&created_at=gt.${t - 14 * 86400}&select=id&limit=1`);
  if (existing && existing.length) return;
  await notify(job.poster_user_id, "delivery", `Your job "${job.title}" was delivered 7 days ago. Approve it, or dispute within 7 more days — after 14 days the escrow releases to the worker automatically.`, link);
  console.log(`reminder: job ${job.id} poster reminded (delivered 7+ days ago, still unapproved)`);
}

async function feePctSetting() {
  const row = (await get("ex_settings?key=eq.fee_pct&select=value").catch(() => []))[0];
  const v = parseInt(row?.value || "10", 10);
  return Number.isFinite(v) ? v : 10;
}

// CONTRACT SETTLEMENT (Phase D): mirrors the backend's
// completeContractJob money math exactly - outcome mode pays
// pay_rule[outcome]% of the agreed price; SCHEDULED contracts split
// the price into per-entry shares (equal, last entry absorbs the
// rounding remainder) and pay each entry's outcome percentage of its
// share; per-minute mode pays the answered minutes on the attempt log.
// The fee is taken on the amount actually paid (the stored fee_cents
// on a full-price settlement), the remainder refunds, the guarantee
// pool is funded and the exact settlement lands in pay_breakdown.
// The CALLER owns the job's status claim flip; this moves the money.
async function settleContractJob(job, cj, t, origin) {
  const agent = (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=id,name,owner_id`))[0];
  if (!agent) throw new Error("awarded agent not found");
  const workerOwner = agent.owner_id;
  const rule = cj.pay_rule || {};
  const agreed = Number(job.agreed_cents || 0);
  const feePct = await feePctSetting();
  const scheduled = cj.task_count !== null && cj.task_count !== undefined;
  let due = 0, fee = 0, breakdown;
  if (rule.mode === "per_minute") {
    const attempts = await get(`ex_contract_attempts?job_id=eq.${job.id}&select=*&order=started_at.asc`);
    const counted = [];
    let billableSeconds = 0;
    for (const a of attempts || []) {
      if (!a.ended_at) continue;
      if (a.outcome !== "answered_completed" && a.outcome !== "answered_partial") continue;
      const elapsed = Number(a.ended_at) - Number(a.started_at);
      const secs = Math.max(0, Math.min(Number(a.duration_sec || 0), elapsed + 30));
      counted.push({ id: Number(a.id), outcome: a.outcome, seconds_counted: secs });
      billableSeconds += secs;
    }
    const billableMinutes = Math.ceil(billableSeconds / 60);
    const paidMinutes = Math.min(billableMinutes, Number(rule.max_paid_minutes || 0));
    due = Math.min(paidMinutes * Number(rule.rate_cents_per_min || 0), agreed);
    fee = due <= 0 ? 0 : (due >= agreed && agreed > 0 ? Number(job.fee_cents || 0) : Math.round((due * feePct) / 100));
    breakdown = { mode: "per_minute", attempts: counted, billable_seconds: billableSeconds, billable_minutes: billableMinutes, paid_minutes: paidMinutes, rate_cents_per_min: Number(rule.rate_cents_per_min || 0), max_paid_minutes: Number(rule.max_paid_minutes || 0), worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due, auto_settled: origin, ...(scheduled ? { scheduled: true, task_count: Number(cj.task_count) } : {}) };
  } else if (scheduled) {
    const tasks = await get(`ex_contract_tasks?job_id=eq.${job.id}&select=*&order=entry_index.asc`);
    const n = (tasks || []).length;
    let assigned = 0;
    const entries = (tasks || []).map((x, i) => {
      const share = i === n - 1 ? agreed - assigned : Math.round(agreed / n);
      assigned += share;
      const epct = Math.max(0, Math.min(100, Number(rule[String(x.outcome || "")] ?? 0)));
      const edue = Math.round((share * epct) / 100);
      return { entry_index: Number(x.entry_index), status: x.status, outcome: x.outcome || "", share_cents: share, pct: epct, due_cents: edue };
    });
    due = entries.reduce((a, e) => a + e.due_cents, 0);
    fee = due <= 0 ? 0 : (due >= agreed && agreed > 0 ? Number(job.fee_cents || 0) : Math.round((due * feePct) / 100));
    breakdown = { mode: "outcome", scheduled: true, auto_settled: origin, task_count: n, entries, worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due };
    for (const x of tasks || []) {
      if (x.status !== "proved" && x.status !== "failed") await patch(`ex_contract_tasks?id=eq.${x.id}`, { status: "failed", resolved_at: t, updated_at: t }).catch(() => {});
    }
  } else {
    const outcome = cj.final_outcome || "";
    const pct = Math.max(0, Math.min(100, Number(rule[outcome] ?? 0)));
    due = Math.round((agreed * pct) / 100);
    fee = due <= 0 ? 0 : (pct === 100 ? Number(job.fee_cents || 0) : Math.round((due * feePct) / 100));
    breakdown = { mode: "outcome", outcome, pct, worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due, auto_settled: origin };
  }
  if (due > 0) await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: workerOwner, p_price: due, p_fee: fee, p_ref: `job:${job.id}`, p_now: t });
  const refund = agreed - due;
  if (refund > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refund, p_ref: `job:${job.id}`, p_note: `Contract auto-settlement (${origin}): ${due} of the ${agreed} held was earned under the pay rule - the remainder returns to the poster`, p_now: t });
  await patch(`ex_contract_jobs?job_id=eq.${job.id}`, { pay_breakdown: breakdown });
  await fundPool(fee).catch((e) => console.error(`contract settle: pool fund failed for job ${job.id}:`, e.message));
  return { due, fee, breakdown, agent, workerOwner };
}

// AUTO-RELEASE (14 days): settle one delivered job exactly like a
// completion. The status flip delivered -> completed is the claim; any
// money failure after it reverts the flip so the next cycle retries
// (the same pattern deadlineRefunds uses).
async function autoReleaseJob(job, t) {
  const agent = job.awarded_agent_id
    ? (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=id,name,owner_id`))[0]
    : null;
  if (!agent) { console.error(`auto-release: job ${job.id} has no awarded agent on record; skipped`); return; }
  const workerOwner = agent.owner_id;
  const milestones = await get(`ex_milestones?job_id=eq.${job.id}&select=*&order=idx.asc`);
  const isMs = !!(milestones && milestones.length);
  const claimed = await patch(`ex_jobs?id=eq.${job.id}&status=eq.delivered`, { status: "completed", updated_at: t }, "return=representation");
  if (!claimed || !claimed.length) return; // someone else handled it
  // CONTRACT JOBS settle by their PAY RULE (Phase D) - outcome,
  // per-entry or per-minute math - never the flat full-price release
  // the standard path below performs.
  if (job.job_kind === "contract") {
    const cj = (await get(`ex_contract_jobs?job_id=eq.${job.id}&select=*`))[0];
    if (cj) {
      try {
        const s = await settleContractJob(job, cj, t, "delivered_auto_release");
        const freshAgent = (await get(`ex_agents?id=eq.${agent.id}&select=jobs_completed,earnings_cents`))[0];
        if (freshAgent) await patch(`ex_agents?id=eq.${agent.id}`, { jobs_completed: (freshAgent.jobs_completed || 0) + 1, earnings_cents: (freshAgent.earnings_cents || 0) + (s.due - s.fee) });
        const net = s.due - s.fee;
        const sellerWallet = await walletOf(workerOwner).catch(() => null);
        const posterWallet = await walletOf(job.poster_user_id).catch(() => null);
        await notify(job.poster_user_id, "payment", `"${job.title}" auto-completed - the delivery sat unapproved for 14 days, so the contract settled by its pay rule: ${money(s.due)} was due, ${money(net)} paid to the worker after the fee, ${money((job.agreed_cents || 0) - s.due)} refunded to you`, `#/job/${job.id}`);
        await notify(workerOwner, "payment", `"${job.title}" auto-completed after the 14-day window - the contract settled by its pay rule and ${money(net)} landed in your wallet`, `#/job/${job.id}`);
        const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
        const owner = (await get(`ex_users?id=eq.${workerOwner}&select=id,email,name`))[0];
        if (owner && s.due > 0) await queueMail("payment_received", owner, { name: owner.name || "", title: job.title, amount: money(net), wallet_before: money((sellerWallet?.balance_cents || 0) - net), wallet_after: money(sellerWallet?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("auto-release worker mail failed", e.message));
        if (poster) await queueMail("payment_sent", poster, { name: poster.name || "", title: job.title, agent_name: agent.name || "The worker", amount: money(s.due), wallet_balance: money(posterWallet?.balance_cents || 0), escrow_held: money(posterWallet?.held_cents || 0), wallet_total: money((posterWallet?.balance_cents || 0) + (posterWallet?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("auto-release poster mail failed", e.message));
        console.log(`auto-release: contract job ${job.id} settled by pay rule after 14 days unapproved, ${money(net)} released to worker owner ${workerOwner}`);
      } catch (e) {
        await patch(`ex_jobs?id=eq.${job.id}`, { status: "delivered", updated_at: t }).catch(() => {});
        console.error(`auto-release FAILED for contract job ${job.id} (status reverted to delivered, will retry):`, e.message);
      }
      return;
    }
  }
  try {
    if (!isMs) {
      await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: workerOwner, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${job.id}`, p_now: t });
    } else {
      // Milestone jobs: release ONLY the unreleased remainder, one
      // ex_release_escrow per unreleased milestone (mirrors the
      // backend's releaseMilestone). Each fee is its share of the job's
      // fee_cents; the last unreleased milestone absorbs the rounding
      // remainder so the job's total fee stays exactly fee_cents.
      const agreed = Number(job.agreed_cents || 0);
      const share = (amt) => (agreed > 0 ? Math.round((Number(job.fee_cents || 0) * Number(amt || 0)) / agreed) : 0);
      let feesTaken = milestones.filter((m) => m.status === "released").reduce((a, m) => a + share(m.amount_cents), 0);
      const unreleased = milestones.filter((m) => m.status !== "released");
      for (let i = 0; i < unreleased.length; i++) {
        const m = unreleased[i];
        const feeM = i === unreleased.length - 1
          ? Math.max(0, Number(job.fee_cents || 0) - feesTaken)
          : share(m.amount_cents);
        feesTaken += feeM;
        const upd = await patch(`ex_milestones?id=eq.${m.id}&status=eq.${m.status}`, { status: "released", released_at: t }, "return=representation");
        if (!upd || !upd.length) continue; // raced - not ours to pay
        if (Number(m.amount_cents || 0) > 0) {
          await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: workerOwner, p_price: m.amount_cents, p_fee: feeM, p_ref: `job:${job.id}:m${m.idx + 1}`, p_now: t });
        }
      }
    }
  } catch (e) {
    await patch(`ex_jobs?id=eq.${job.id}`, { status: "delivered", updated_at: t }).catch(() => {});
    console.error(`auto-release FAILED for job ${job.id} (status reverted to delivered, will retry):`, e.message);
    return;
  }
  // Pool + stats land ONLY at this final completion - partial milestone
  // releases never touched either.
  await fundPool(job.fee_cents).catch((e) => console.error(`auto-release: pool fund failed for job ${job.id}:`, e.message));
  const freshAgent = (await get(`ex_agents?id=eq.${agent.id}&select=jobs_completed,earnings_cents`))[0];
  if (freshAgent) {
    await patch(`ex_agents?id=eq.${agent.id}`, {
      jobs_completed: (freshAgent.jobs_completed || 0) + 1,
      earnings_cents: (freshAgent.earnings_cents || 0) + (job.agreed_cents - job.fee_cents),
    });
  }
  const net = job.agreed_cents - job.fee_cents;
  const sellerWallet = await walletOf(workerOwner).catch(() => null);
  const posterWallet = await walletOf(job.poster_user_id).catch(() => null);
  await notify(job.poster_user_id, "payment", `"${job.title}" auto-completed — escrow released after the 14-day window. ${money(net)} was paid to the worker (agreed price minus the platform fee).`, `#/job/${job.id}`);
  await notify(workerOwner, "payment", `"${job.title}" payment released — ${money(net)} landed in your wallet (auto-completed after the 14-day window).`, `#/job/${job.id}`);
  const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
  const owner = (await get(`ex_users?id=eq.${workerOwner}&select=id,email,name`))[0];
  if (owner) await queueMail("payment_received", owner, { name: owner.name || "", title: job.title, amount: money(net), wallet_before: money((sellerWallet?.balance_cents || 0) - net), wallet_after: money(sellerWallet?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("auto-release worker mail failed", e.message));
  if (poster) await queueMail("payment_sent", poster, { name: poster.name || "", title: job.title, agent_name: agent.name || "The worker", amount: money(job.agreed_cents), wallet_balance: money(posterWallet?.balance_cents || 0), escrow_held: money(posterWallet?.held_cents || 0), wallet_total: money((posterWallet?.balance_cents || 0) + (posterWallet?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("auto-release poster mail failed", e.message));
  console.log(`auto-release: job ${job.id} completed after 14 days unapproved, ${money(net)} released to worker owner ${workerOwner}`);
}

async function deliveredAutoRelease() {
  const t = nowSec();
  // Reminders first: delivered more than 7 days ago, still inside the
  // 14-day window (older than that, the release below owns the job).
  const remJobs = await get(`ex_jobs?status=eq.delivered&delivered_at=gt.${t - 14 * 86400}&delivered_at=lt.${t - 7 * 86400}&select=id,title,poster_user_id&limit=50`);
  for (const job of remJobs || []) {
    try { await posterReminder(job, t); } catch (e) { console.error(`reminder: job ${job.id} failed:`, e.message); }
  }
  const jobs = await get(`ex_jobs?status=eq.delivered&delivered_at=gt.0&delivered_at=lt.${t - 14 * 86400}&select=*&limit=50`);
  for (const job of jobs || []) {
    try { await autoReleaseJob(job, t); } catch (e) { console.error(`auto-release: job ${job.id} failed:`, e.message); }
  }
}

// CONTRACT JOBS (2026-10-26): two time-based duties.
//  a) WINDOW OPENING: when an awarded contract job's call window opens
//     within the next 60 minutes, the winning agent's owner is notified
//     in-app and the agent's webhook gets contract_attempt_window_opening
//     - exactly once per job (the window_notified flag is the claim).
//  b) WINDOW REFUND: an awarded contract job whose call window ended
//     more than 24h ago with NO delivery is auto-cancelled and its full
//     held escrow refunds to the poster (contract jobs have no
//     milestones, so the held amount is the agreed price). The status
//     flip is the claim; a failed refund reverts it for the next cycle.
//     Both sides are notified in-app and emailed (job_cancelled kind).
//     Delivered contract jobs are NOT touched here - the delivered
//     auto-release above settles them by their pay rule instead.
async function contractWindowOpening() {
  const t = nowSec();
  const rows = await get(`ex_contract_jobs?window_notified=eq.false&window_start=gt.${t}&window_start=lt.${t + 3600}&select=*&limit=50`).catch(() => []);
  for (const cj of rows || []) {
    try {
      const job = (await get(`ex_jobs?id=eq.${cj.job_id}&select=id,title,status,awarded_agent_id,poster_user_id`))[0];
      if (!job || job.status !== "awarded" || !job.awarded_agent_id) continue;
      const claimed = await patch(`ex_contract_jobs?job_id=eq.${cj.job_id}&window_notified=eq.false`, { window_notified: true }, "return=representation");
      if (!claimed || !claimed.length) continue;
      const agent = (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id,webhook_url`))[0];
      if (agent) {
        const capWord = cj.capability === "email_send" ? "Send" : "Call";
        await notify(agent.owner_id, "award", `${capWord} window opening soon: "${job.title}" - the window opens ${new Date(Number(cj.window_start) * 1000).toISOString()} (${cj.window_tz}). Open an attempt inside the window before ${cj.capability === "email_send" ? "sending" : "dialling"}.`, `#/job/${job.id}`);
        if (agent.webhook_url) {
          try {
            await fetch(agent.webhook_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "contract_attempt_window_opening", job_id: job.id, title: job.title, window_start: cj.window_start, window_end: cj.window_end, window_tz: cj.window_tz }), signal: AbortSignal.timeout(5000) });
          } catch { /* best effort, like the backend's fireWebhook */ }
        }
      }
      console.log(`contract: window-opening notice sent for job ${job.id}`);
    } catch (e) {
      console.error(`contractWindowOpening: job ${cj.job_id} failed:`, e.message);
    }
  }
}

async function contractWindowRefunds() {
  const t = nowSec();
  const rows = await get(`ex_contract_jobs?window_end=lt.${t - 24 * 3600}&select=job_id,task_count&limit=50`).catch(() => []);
  for (const cj of rows || []) {
    try {
      // SCHEDULED CONTRACTS (Phase D) are EXEMPT from the +24h refund:
      // they run on the schedule clock and settle per entry via
      // contractScheduleExpiry at schedule_end + 48h.
      if (cj.task_count !== null && cj.task_count !== undefined) continue;
      const job = (await get(`ex_jobs?id=eq.${cj.job_id}&status=eq.awarded&select=*`))[0];
      if (!job) continue;
      const claimed = await patch(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { status: "cancelled", updated_at: t }, "return=representation");
      if (!claimed || !claimed.length) continue;
      try {
        if (Number(job.agreed_cents || 0) > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${job.id}`, p_note: "Contract call window passed with no delivery - escrow refunded in full", p_now: t });
      } catch (e) {
        await patch(`ex_jobs?id=eq.${job.id}`, { status: "awarded", updated_at: t }).catch(() => {});
        console.error(`contract refund FAILED for job ${job.id} (status reverted, will retry):`, e.message);
        continue;
      }
      await notify(job.poster_user_id, "payment", `"${job.title}" was cancelled automatically - the call window closed over a day ago with no delivery, and your escrow (${money(job.agreed_cents)}) was refunded in full`, `#/job/${job.id}`);
      const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
      if (poster) await queueMail("job_cancelled", poster, { name: poster.name || "", title: job.title, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("contract poster mail failed", e.message));
      if (job.awarded_agent_id) {
        const agent = (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id`))[0];
        if (agent) {
          await notify(agent.owner_id, "delivery", `"${job.title}" was cancelled automatically - the call window closed with no delivery, and the escrow was refunded to the poster`, `#/job/${job.id}`);
          const owner = (await get(`ex_users?id=eq.${agent.owner_id}&select=id,email,name`))[0];
          if (owner) await queueMail("job_cancelled", owner, { name: owner.name || "", title: job.title, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("contract worker mail failed", e.message));
        }
      }
      console.log(`contract: job ${job.id} auto-cancelled (window passed, no delivery), ${money(job.agreed_cents)} refunded to poster ${job.poster_user_id}`);
    } catch (e) {
      console.error(`contractWindowRefunds: job ${cj.job_id} failed:`, e.message);
    }
  }
}

// SCHEDULED CONTRACT EXPIRY (Phase D): a scheduled contract still
// 'awarded' 48 hours after its schedule window ended auto-settles -
// proved entries pay their outcome share of the agreed price through
// the same settlement path as a completion, unproved entries resolve
// as failed and their shares refund. The claim flip (awarded ->
// completed) comes first; a money failure reverts it for the next
// cycle. When nothing was earned the job ends CANCELLED instead (the
// settlement already refunded the full escrow).
async function contractScheduleExpiry() {
  const t = nowSec();
  const rows = await get(`ex_contract_jobs?task_count=not.is.null&window_end=lt.${t - 48 * 3600}&select=*&limit=50`).catch(() => []);
  for (const cj of rows || []) {
    try {
      const job = (await get(`ex_jobs?id=eq.${cj.job_id}&status=eq.awarded&select=*`))[0];
      if (!job) continue;
      const claimed = await patch(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { status: "completed", updated_at: t }, "return=representation");
      if (!claimed || !claimed.length) continue;
      let s;
      try {
        s = await settleContractJob(job, cj, t, "schedule_expired");
      } catch (e) {
        await patch(`ex_jobs?id=eq.${job.id}`, { status: "awarded", updated_at: t }).catch(() => {});
        console.error(`schedule-expiry settle FAILED for job ${job.id} (status reverted, will retry):`, e.message);
        continue;
      }
      const { due, fee, agent, workerOwner } = s;
      const net = due - fee;
      if (due <= 0) {
        await patch(`ex_jobs?id=eq.${job.id}&status=eq.completed`, { status: "cancelled", updated_at: t }).catch(() => {});
      } else {
        const freshAgent = (await get(`ex_agents?id=eq.${agent.id}&select=jobs_completed,earnings_cents`))[0];
        if (freshAgent) await patch(`ex_agents?id=eq.${agent.id}`, { jobs_completed: (freshAgent.jobs_completed || 0) + 1, earnings_cents: (freshAgent.earnings_cents || 0) + net });
      }
      await notify(job.poster_user_id, "payment", due > 0
        ? `"${job.title}" settled automatically - the schedule window ended 48 hours ago. Proved entries earned ${money(due)} under the pay rule; ${money((job.agreed_cents || 0) - due)} of the escrow refunded to your wallet`
        : `"${job.title}" was cancelled automatically - the schedule window ended 48 hours ago with no proved entries, and your escrow (${money(job.agreed_cents)}) was refunded in full`, `#/job/${job.id}`);
      const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
      if (agent) {
        await notify(workerOwner, "payment", due > 0
          ? `"${job.title}" settled automatically after the schedule window - proved entries earned ${money(net)} for ${agent.name}, now in your wallet`
          : `"${job.title}" was cancelled automatically - the schedule window ended with no proved entries, and the escrow refunded to the poster`, `#/job/${job.id}`);
        const owner = (await get(`ex_users?id=eq.${workerOwner}&select=id,email,name`))[0];
        if (due > 0) {
          const sellerWallet = await walletOf(workerOwner).catch(() => null);
          const posterWallet = await walletOf(job.poster_user_id).catch(() => null);
          if (owner) await queueMail("payment_received", owner, { name: owner.name || "", title: job.title, amount: money(net), wallet_before: money((sellerWallet?.balance_cents || 0) - net), wallet_after: money(sellerWallet?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("schedule-expiry worker mail failed", e.message));
          if (poster) await queueMail("payment_sent", poster, { name: poster.name || "", title: job.title, agent_name: agent.name || "The worker", amount: money(due), wallet_balance: money(posterWallet?.balance_cents || 0), escrow_held: money(posterWallet?.held_cents || 0), wallet_total: money((posterWallet?.balance_cents || 0) + (posterWallet?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("schedule-expiry poster mail failed", e.message));
        } else {
          if (poster) await queueMail("job_cancelled", poster, { name: poster.name || "", title: job.title, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("schedule-expiry poster mail failed", e.message));
          if (owner) await queueMail("job_cancelled", owner, { name: owner.name || "", title: job.title, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("schedule-expiry worker mail failed", e.message));
        }
      }
      console.log(`contract: scheduled job ${job.id} auto-settled (schedule_end + 48h), due ${money(due)}, refunded ${money((job.agreed_cents || 0) - due)}`);
    } catch (e) {
      console.error(`contractScheduleExpiry: job ${cj.job_id} failed:`, e.message);
    }
  }
}

async function cycle() {
  try { await deadlineRefunds(); } catch (e) { console.error("deadlineRefunds:", e.message); }
  try { await deliveredAutoRelease(); } catch (e) { console.error("deliveredAutoRelease:", e.message); }
  try { await contractWindowOpening(); } catch (e) { console.error("contractWindowOpening:", e.message); }
  try { await contractWindowRefunds(); } catch (e) { console.error("contractWindowRefunds:", e.message); }
  try { await contractScheduleExpiry(); } catch (e) { console.error("contractScheduleExpiry:", e.message); }
  try { await deadListings(); } catch (e) { console.error("deadListings:", e.message); }
  try { await altScan(); } catch (e) { console.error("altScan:", e.message); }
  try { await del(`ex_rate_counters?window_start=lt.${nowSec() - 86400}`); } catch { /* housekeeping only */ }
}

console.log("exchange-sweeper started (60s cycle)");
await cycle();
setInterval(cycle, 60_000);
