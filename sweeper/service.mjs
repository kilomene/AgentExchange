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
// Zero dependencies; talks to PostgREST with the service key via curl
// (which honors the host's egress proxy, like every other host service).
import { execFile } from "node:child_process";

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

function curl(method, url, body, prefer) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-w", "\n%{http_code}", "-X", method, url,
      "-H", `apikey: ${SERVICE_KEY}`, "-H", `Authorization: Bearer ${SERVICE_KEY}`,
      "-H", "Content-Type: application/json"];
    if (prefer) args.push("-H", `Prefer: ${prefer}`);
    if (body !== undefined) args.push("--data-binary", JSON.stringify(body));
    execFile("curl", args, { maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
      if (e) return reject(e);
      const cut = stdout.lastIndexOf("\n");
      const text = stdout.slice(0, cut);
      const code = parseInt(stdout.slice(cut + 1), 10);
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (code >= 400) return reject(new Error(`${method} ${url.split("?")[0]} -> ${code}: ${text.slice(0, 200)}`));
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

async function deadlineRefunds() {
  const t = nowSec();
  const jobs = await get(`ex_jobs?status=eq.awarded&work_deadline=lt.${t}&work_deadline=not.is.null&select=*&limit=50`);
  for (const job of jobs || []) {
    const claimed = await patch(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { status: "cancelled", updated_at: t }, "return=representation");
    if (!claimed || !claimed.length) continue; // someone else handled it
    try {
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${job.id}`, p_note: "Delivery deadline passed with no delivery - escrow automatically refunded", p_now: t });
    } catch (e) {
      await patch(`ex_jobs?id=eq.${job.id}`, { status: "awarded", updated_at: t }).catch(() => {});
      console.error(`deadline refund FAILED for job ${job.id} (status reverted, will retry):`, e.message);
      continue;
    }
    const poster = (await get(`ex_users?id=eq.${job.poster_user_id}&select=id,email,name`))[0];
    const wallet = (await get(`ex_wallets?user_id=eq.${job.poster_user_id}&select=balance_cents`))[0];
    await notify(job.poster_user_id, "payment", `"${job.title}" was cancelled automatically - the delivery deadline passed with no delivery, and your escrow (${money(job.agreed_cents)}) was refunded to your wallet`, `#/job/${job.id}`);
    if (poster) await queueMail("job_auto_refunded", poster, { name: poster.name || "", title: job.title, amount: money(job.agreed_cents), wallet_after: wallet ? money(wallet.balance_cents) : "", link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("poster mail failed", e.message));
    if (job.awarded_agent_id) {
      const agent = (await get(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id`))[0];
      if (agent) {
        await notify(agent.owner_id, "delivery", `"${job.title}" was cancelled automatically - the delivery deadline passed with no delivery, and the escrow was refunded to the poster`, `#/job/${job.id}`);
        const owner = (await get(`ex_users?id=eq.${agent.owner_id}&select=id,email,name`))[0];
        if (owner) await queueMail("job_auto_refunded", owner, { name: owner.name || "", title: job.title, worker: true, agent_name: agent.name, link: `${SITE_URL}/#/job/${job.id}` }).catch((e) => console.error("worker mail failed", e.message));
      }
    }
    console.log(`deadline: job ${job.id} auto-cancelled, ${money(job.agreed_cents)} refunded to poster ${job.poster_user_id}`);
  }
}

async function deadListings() {
  const t = nowSec();
  const cutoff = t - 14 * 86400;
  const agents = await get(`ex_agents?status=eq.active&is_human=eq.false&select=id,name,owner_id,created_at,last_active_at&limit=200`);
  for (const a of agents || []) {
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
  }
}

async function altScan() {
  const t = nowSec();
  const bannedUsers = await get("ex_users?suspended=eq.true&select=id,signup_ip,last_ip");
  const bannedRows = await get("ex_banned_ips?select=ip");
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
    const hit = [u.signup_ip, u.last_ip].find((ip) => ip && bannedIps.has(ip));
    if (!hit) continue;
    await patch(`ex_users?id=eq.${u.id}`, { suspended: true });
    for (const ip of [u.signup_ip, u.last_ip]) {
      if (ip) await post("ex_banned_ips", { ip, reason: `alt account of a banned user (matched ${hit})`, source_user_id: u.id, created_at: t }, "resolution=ignore-duplicates").catch(() => {});
    }
    for (const a of admins || []) await notify(a.id, "security", `Account ${u.id} (${u.name || ""}) was auto-suspended: it shares an IP address with a banned account`, "#/admin");
    console.log(`alt-scan: user ${u.id} auto-suspended (shared banned IP ${hit})`);
  }
}

async function cycle() {
  try { await deadlineRefunds(); } catch (e) { console.error("deadlineRefunds:", e.message); }
  try { await deadListings(); } catch (e) { console.error("deadListings:", e.message); }
  try { await altScan(); } catch (e) { console.error("altScan:", e.message); }
  try { await del(`ex_rate_counters?window_start=lt.${nowSec() - 86400}`); } catch { /* housekeeping only */ }
}

console.log("exchange-sweeper started (60s cycle)");
await cycle();
setInterval(cycle, 60_000);
