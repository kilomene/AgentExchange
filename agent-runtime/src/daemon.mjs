#!/usr/bin/env node
// exchange-agentd — the Agent Exchange runtime.
//
// One daemon per machine. It hosts the machine's agents as a live server
// on the mesh, holds a permanent realtime connection to the Exchange, and
// beats a heartbeat every 3 seconds. Events arrive the instant they
// happen; the daemon bids instantly under the hardcoded charter, and any
// work that needs the agent's brain is queued in the vault as a wake item
// that survives crashes and reboots — on boot the daemon replays its
// journal and catch-up sync and continues exactly where it stopped.
//
// Usage:
//   node daemon.mjs [--config <path>]            run the daemon
//   node daemon.mjs status [--config <path>]     print heartbeat + state
//   node daemon.mjs vault-list                   list vaulted files
//   node daemon.mjs vault-restore <name> <dest>  restore a vaulted file
//   node daemon.mjs apply-settings               apply owner-signed staged settings
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHARTER, RUNTIME_VERSION, charterHash } from "./charter.mjs";
import { Vault } from "./vault.mjs";
import { Realtime } from "./realtime.mjs";
import { Mesh } from "./mesh.mjs";
import { Updater } from "./update.mjs";
import { newIdentity } from "./sign.mjs";
import { verifyConfigSignature } from "./ownerkey.mjs";
import { bootGuard, markHealthy, HEALTHY_AFTER_MS } from "./bootguard.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const cmd = ["status", "vault-list", "vault-restore", "apply-settings"].includes(args[0]) ? args[0] : "run";
const cfgIdx = args.indexOf("--config");
const CONFIG_PATH = cfgIdx >= 0 ? args[cfgIdx + 1] : join(process.env.HOME, ".exchange-agent", "config.json");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function loadConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  // The owner trust anchor is per install (ownerkey.mjs): the install's
  // own owner's key — pinned in the config, a sibling config.owner_pubkey
  // file, or EXCHANGE_OWNER_PUBKEY — with the compiled-in fleet key only
  // as the default. Signature verification is mandatory: an unsigned
  // config never boots.
  const v = verifyConfigSignature(cfg, CONFIG_PATH);
  if (!v.ok) {
    console.error(`FATAL: ${v.reason} — refusing to start`);
    process.exit(1);
  }
  cfg.ownerPubkeyB64 = v.pubkey;   // resolved anchor, reused by mesh + updater
  cfg.ownerPubkeySource = v.source;
  return cfg;
}

const config = loadConfig();
const VAULT_DIR = config.vaultDir || join(dirname(CONFIG_PATH), "vault");
const vault = new Vault(VAULT_DIR);

// ---------- one-shot commands ----------
if (cmd === "status") {
  const hb = existsSync(join(VAULT_DIR, "heartbeat.json")) ? JSON.parse(readFileSync(join(VAULT_DIR, "heartbeat.json"), "utf8")) : null;
  console.log(JSON.stringify({ heartbeat: hb, state: vault.state, vault: vault.size(), pendingWake: vault.pendingWake().map((w) => w.job_id) }, null, 1));
  process.exit(0);
}
if (cmd === "vault-list") { console.log(JSON.stringify(vault.listManifest(), null, 1)); process.exit(0); }
if (cmd === "vault-restore") { vault.restore(args[1], args[2]); console.log(`restored ${args[1]} -> ${args[2]}`); process.exit(0); }
if (cmd === "apply-settings") {
  const p = join(VAULT_DIR, "pending-settings.json");
  if (!existsSync(p)) { console.log("no staged settings"); process.exit(0); }
  const staged = JSON.parse(readFileSync(p, "utf8"));
  const current = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const merged = { ...current, ...staged };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 1));
  unlinkSync(p);
  vault.journal("settings_applied", {});
  console.log("owner settings applied — restart the daemon to pick them up");
  process.exit(0);
}

// ---------- identity ----------
const ID_PATH = join(VAULT_DIR, "identity.json");
let identity;
if (existsSync(ID_PATH)) identity = JSON.parse(readFileSync(ID_PATH, "utf8"));
else { identity = newIdentity(); writeFileSync(ID_PATH, JSON.stringify(identity, null, 1), { mode: 0o600 }); vault.journal("identity_created", {}); }

// ---------- agent API ----------
const API = config.apiBase; // https://<ref>.supabase.co/functions/v1/exchange-api
async function api(agent, path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "x-agent-key": agent.apiKey, "content-type": "application/json" },
    ...opts, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${res.status}: ${data.error || res.statusText}`);
  return data;
}
async function publicGet(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15000) });
  return res.json().catch(() => ({}));
}

// ---------- brain (the charter, executed) ----------
const S = vault.state;
S.agents = S.agents || {};
for (const a of config.agents) {
  S.agents[a.name] = S.agents[a.name] || { id: null, category: null, rate_cents: 0, skills: [], bids: {}, contracts: {}, delivered: [] };
}
const localAgentIds = () => new Set(Object.values(S.agents).map((a) => a.id).filter(Boolean));
const agentById = (id) => config.agents.find((a) => S.agents[a.name]?.id === id);
let ready = false;
let apiConfirmed = (config.agents || []).length === 0; // set on first successful agent API call (boot guard)
const eventBuffer = [];

function skillHit(agent, job) {
  const text = `${job.title || ""} ${job.description || ""}`.toLowerCase();
  return (S.agents[agent.name]?.skills || []).some((s) => s && text.includes(String(s).toLowerCase()));
}
function matches(agent, job) {
  const st = S.agents[agent.name];
  return job.category === st.category || skillHit(agent, job);
}
function priceFor(agent, job) {
  const rate = S.agents[agent.name].rate_cents || 0;
  if (job.budget_cents >= rate && rate > 0) return rate / 100;
  return Math.max(1, Math.floor((job.budget_cents * CHARTER.bidFractionOfBudget) / 100));
}
function activeBidCount(name) {
  return Object.values(S.agents[name].bids).filter((b) => b.open).length;
}
function activeContractCount(name) {
  return Object.values(S.agents[name].contracts).filter((c) => c === "awarded").length;
}

async function considerJob(job, source) {
  if (!job || job.status !== "open") return;
  if (job.poster_user_id === config.ownerId) return;                    // never our own jobs
  if (job.poster_agent_id && localAgentIds().has(job.poster_agent_id)) return; // never fleet jobs
  if (job.budget_cents < CHARTER.minBudgetCents) return;
  let bidsThisWake = 0;
  for (const agent of config.agents) {
    const st = S.agents[agent.name];
    if (!st.id) continue;
    if (st.bids[job.id]?.open) continue;
    if (!matches(agent, job)) continue;
    if (activeBidCount(agent.name) >= CHARTER.maxActiveBids) continue;
    if (activeContractCount(agent.name) >= CHARTER.maxActiveContracts) continue;
    if (bidsThisWake >= CHARTER.maxBidsPerWake) break;
    try {
      if (job.mode === "fixed") {
        const minClaim = Math.max(CHARTER.fixedClaimMinCents, (st.rate_cents || 0) * CHARTER.fixedClaimRateFraction);
        if (job.budget_cents < minClaim) continue;
        await api(agent, `/agent/jobs/${job.id}/claim`, { method: "POST", body: "{}" });
        st.contracts[job.id] = "awarded";
        vault.journal("claimed", { agent: agent.name, job_id: job.id, amount_cents: job.budget_cents, source });
        enqueueWorkWake(agent, { ...job, agreed_cents: job.budget_cents });
      } else {
        const amount = priceFor(agent, job);
        const eta = job.budget_cents <= CHARTER.etaThresholdCents ? CHARTER.etaSmallJobHours : CHARTER.etaLargeJobHours;
        const pitch = `I will deliver exactly what this brief asks for, complete and ready to use. My work is tested before it reaches you — no drafts, no placeholders. (${agent.name}, via the Exchange runtime)`;
        const r = await api(agent, `/agent/jobs/${job.id}/bid`, { method: "POST", body: JSON.stringify({ amount, eta_hours: eta, pitch }) });
        st.bids[job.id] = { amount_cents: r.amount_cents, open: true };
        vault.journal("bid_placed", { agent: agent.name, job_id: job.id, amount_cents: r.amount_cents, source });
        log(`bid: ${agent.name} $${(r.amount_cents / 100).toFixed(2)} on job ${job.id} "${job.title}" (${source})`);
      }
      bidsThisWake++;
    } catch (e) {
      vault.journal("bid_error", { agent: agent.name, job_id: job.id, error: e.message });
      log(`bid error (${agent.name}, job ${job.id}): ${e.message}`);
    }
  }
  vault.saveState();
}

function enqueueWorkWake(agent, job) {
  vault.enqueueWake({
    kind: "work", job_id: job.id, agent: agent.name,
    title: job.title, description: job.description || "",
    agreed_cents: job.agreed_cents || job.budget_cents,
    work_deadline: job.work_deadline || null,
    deliver_to: join(VAULT_DIR, CHARTER.workDirName, `${job.id}.md`),
    enqueued_at: Math.floor(Date.now() / 1000),
  });
  touchWakeSignal();
}

function onJobInsert(job) { considerJob(job, "realtime").catch((e) => log(`considerJob: ${e.message}`)); }

function onJobUpdate(job, oldJob) {
  const agent = job.awarded_agent_id ? agentById(job.awarded_agent_id) : null;
  if (agent) {
    const st = S.agents[agent.name];
    if (job.status === "awarded" && !st.delivered.includes(job.id)) {
      st.contracts[job.id] = "awarded";
      vault.journal("awarded", { agent: agent.name, job_id: job.id, agreed_cents: job.agreed_cents });
      log(`AWARDED: ${agent.name} won job ${job.id} "${job.title}" — waking the agent`);
      enqueueWorkWake(agent, job);
    }
    if (job.status === "delivered") { st.contracts[job.id] = "delivered"; vault.journal("delivered", { agent: agent.name, job_id: job.id }); }
    if (job.status === "completed") {
      st.contracts[job.id] = "completed";
      const mem = (vault.memory.agents[agent.name] = vault.memory.agents[agent.name] || { jobsDone: 0, earnings_cents: 0, bidsPlaced: 0 });
      mem.jobsDone++; mem.earnings_cents += (job.agreed_cents || 0) - (job.fee_cents || 0);
      vault.journal("completed", { agent: agent.name, job_id: job.id, paid_cents: (job.agreed_cents || 0) - (job.fee_cents || 0) });
      log(`PAID: ${agent.name} completed job ${job.id}`);
      vault.saveMemory();
    }
    if (job.status === "disputed") {
      vault.enqueueWake({ kind: "dispute", job_id: job.id, agent: agent.name, title: job.title, enqueued_at: Math.floor(Date.now() / 1000) });
      vault.journal("disputed", { agent: agent.name, job_id: job.id });
      touchWakeSignal();
    }
    vault.saveState();
  }
  // a job we posted (as an agent) just got awarded to someone: journal only
  if (job.poster_agent_id && localAgentIds().has(job.poster_agent_id) && job.status === "awarded") {
    vault.journal("our_job_awarded", { job_id: job.id, to_agent: job.awarded_agent_id });
  }
  // new open job appearing via update path (rare) — still consider it
  if (job.status === "open" && oldJob?.status !== "open") considerJob(job, "realtime-update").catch(() => {});
}

function onBidInsert(bid) {
  const agent = bid.agent_id ? agentById(bid.agent_id) : null;
  if (agent) {
    const st = S.agents[agent.name];
    st.bids[bid.job_id] = { amount_cents: bid.amount_cents, open: bid.status === "active" };
    const mem = (vault.memory.agents[agent.name] = vault.memory.agents[agent.name] || { jobsDone: 0, earnings_cents: 0, bidsPlaced: 0 });
    mem.bidsPlaced++;
    vault.saveState(); vault.saveMemory();
  }
  vault.journal("bid_seen", { job_id: bid.job_id, agent_id: bid.agent_id, amount_cents: bid.amount_cents });
}

function onNotification(n) {
  vault.journal("notification", { type: n.type, body: String(n.body || "").slice(0, 200) });
  const m = String(n.link || "").match(/job\/(\d+)/);
  if (m && (n.type === "message" || n.type === "dispute")) {
    vault.enqueueWake({ kind: n.type, job_id: Number(m[1]), agent: null, title: n.body, enqueued_at: Math.floor(Date.now() / 1000) });
    touchWakeSignal();
  }
}

async function onMessage(msg) {
  // Wake the working agent when a buyer writes on one of its contracts.
  const jobId = msg.job_id;
  for (const agent of config.agents) {
    const st = S.agents[agent.name];
    if (st.contracts[jobId] === "awarded" && msg.sender_user_id !== config.ownerId) {
      vault.enqueueWake({ kind: "buyer_message", job_id: jobId, agent: agent.name, title: `Buyer message on job ${jobId}`, enqueued_at: Math.floor(Date.now() / 1000) });
      touchWakeSignal();
      vault.journal("buyer_message_wake", { agent: agent.name, job_id: jobId });
    }
  }
}

function dispatch(binding, record, oldRecord, type) {
  if (!ready) { eventBuffer.push([binding, record, oldRecord, type]); return; }
  route(binding, record, oldRecord, type);
}
function route(binding, record, oldRecord, type) {
  S.lastEventAt = Math.floor(Date.now() / 1000);
  if (binding.table === "ex_jobs" && type === "INSERT") onJobInsert(record);
  else if (binding.table === "ex_jobs" && type === "UPDATE") onJobUpdate(record, oldRecord);
  else if (binding.table === "ex_bids" && type === "INSERT") onBidInsert(record);
  else if (binding.table === "ex_notifications" && type === "INSERT") onNotification(record);
  else if (binding.table === "ex_messages" && type === "INSERT") onMessage(record).catch(() => {});
}

// ---------- catch-up sync (runs on every subscribe: nothing is missed) ----------
async function catchUpSync() {
  for (const agent of config.agents) {
    const st = S.agents[agent.name];
    try {
      const me = await api(agent, "/agent/me");
      apiConfirmed = true;   // the Exchange API answered us — boot-guard proof
      st.id = me.agent.id; st.category = me.agent.category;
      st.rate_cents = me.agent.rate_cents; st.skills = me.agent.skills || [];
      const bids = await api(agent, "/agent/my-bids");
      st.bids = {};   // rebuild from the API every sync — the floor is truth
      for (const b of bids.bids) st.bids[b.job_id] = { amount_cents: b.amount_cents, open: b.job_status === "open" && b.status === "active" };
      const contracts = await api(agent, "/agent/contracts");
      for (const c of contracts.contracts) {
        st.contracts[c.id] = c.status;
        if (c.status === "awarded" && !st.delivered.includes(c.id)) enqueueWorkWake(agent, c);
        if (c.status === "disputed") vault.enqueueWake({ kind: "dispute", job_id: c.id, agent: agent.name, title: c.title, enqueued_at: Math.floor(Date.now() / 1000) });
      }
      const floor = await api(agent, "/agent/jobs?all=1");
      for (const job of floor.jobs) await considerJob(job, "catchup");
    } catch (e) {
      log(`catchup (${agent.name}): ${e.message}`);
      vault.journal("catchup_error", { agent: agent.name, error: e.message });
    }
  }
  vault.saveState();
  vault.journal("catchup_done", {});
  log("catch-up sync complete");
}

// ---------- presence (the Exchange shows who is live) ----------
async function pushPresence() {
  const nowS = Math.floor(Date.now() / 1000);
  for (const agent of config.agents) {
    const st = S.agents[agent.name];
    if (!st.id) continue;
    try {
      if (config.serviceKey) {
        // Fleet path: direct upsert with the service-role key.
        await fetch(`${config.supabaseUrl}/rest/v1/ex_agent_status?on_conflict=agent_id`, {
          method: "POST",
          headers: {
            apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`,
            "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify({ agent_id: st.id, name: agent.name, last_heartbeat: nowS, version: RUNTIME_VERSION, online: true, updated_at: nowS }),
          signal: AbortSignal.timeout(8000),
        });
      } else {
        // Third-party path: the backend's agent-key presence endpoint —
        // no service-role key exists on these installs.
        await api(agent, "/agent/presence", {
          method: "POST",
          body: JSON.stringify({ version: RUNTIME_VERSION, online: true }),
        });
      }
    } catch { /* presence is best-effort; the mesh still knows */ }
  }
}

// ---------- polling wakes (only when there is no service key) ----------
// The realtime bindings for ex_notifications / ex_messages need a
// service-role key; without one, buyer messages and disputes would never
// wake the agent. Poll the agent API instead and feed the SAME handlers
// the realtime events feed. Notifications are deduped by a per-agent id
// cursor persisted in state; contract transitions mirror the catch-up
// sync's handling. With a service key configured, none of this runs —
// realtime covers it, exactly as before.
const POLL_WAKES_MS = 30000;
async function pollWakes() {
  for (const agent of config.agents) {
    const st = S.agents[agent.name];
    try {
      const res = await api(agent, "/agent/notifications");
      const list = res.notifications || res.items || (Array.isArray(res) ? res : []);
      let cursor = st.lastNotifId || 0;
      for (const n of list) {
        const id = Number(n.id) || 0;
        if (id > cursor) cursor = id;
        if (id && id <= (st.lastNotifId || 0)) continue;   // already fed
        onNotification({ type: n.type, body: n.body, link: n.link });
      }
      st.lastNotifId = cursor;
    } catch (e) { log(`poll notifications (${agent.name}): ${e.message}`); }
    try {
      const res = await api(agent, "/agent/contracts");
      for (const c of res.contracts || []) {
        const prevStatus = st.contracts[c.id];
        st.contracts[c.id] = c.status;
        if (c.status === "awarded" && prevStatus !== "awarded" && !st.delivered.includes(c.id)) {
          vault.journal("awarded", { agent: agent.name, job_id: c.id, agreed_cents: c.agreed_cents, source: "poll" });
          enqueueWorkWake(agent, c);
        }
        if (c.status === "disputed" && prevStatus !== "disputed") {
          vault.enqueueWake({ kind: "dispute", job_id: c.id, agent: agent.name, title: c.title, enqueued_at: Math.floor(Date.now() / 1000) });
          touchWakeSignal();
        }
      }
    } catch (e) { log(`poll contracts (${agent.name}): ${e.message}`); }
  }
  vault.saveState();
}

// ---------- wake signal (the file the agent-wake hook watches) ----------
function touchWakeSignal() {
  writeFileSync(join(VAULT_DIR, "wake.signal"), JSON.stringify({ ts: Math.floor(Date.now() / 1000), pending: vault.pendingWake().length }));
}

// ---------- work-dir vaulting + done markers (every heartbeat) ----------
const workHashes = new Map();
function scanWorkDir() {
  const dir = join(VAULT_DIR, CHARTER.workDirName);
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f.endsWith(".done")) {
      const jobId = Number(f.replace(".done", ""));
      if (jobId) { vault.clearWake(jobId); for (const a of config.agents) { const st = S.agents[a.name]; if (st.contracts[jobId]) st.contracts[jobId] = "delivered"; if (!st.delivered.includes(jobId)) st.delivered.push(jobId); } vault.saveState(); }
      unlinkSync(p);
      continue;
    }
    const buf = readFileSync(p);
    const prev = workHashes.get(f);
    const hash = vault.putBuffer(buf, `work/${f}`, { quiet: true });
    if (prev !== hash) { workHashes.set(f, hash); vault.journal("work_file_vaulted", { file: f, hash }); }
  }
}

// ---------- mesh + updater ----------
const mesh = new Mesh({
  vault, config, identity,
  agents: config.agents.map((a) => ({ id: S.agents[a.name]?.id || 0, name: a.name })),
  onRelayedEvent: (event, payload) => {
    vault.journal("mesh_event_applied", { event });
    if (event === "job_open" && payload?.job) considerJob(payload.job, "mesh").catch(() => {});
    if (event === "wake" && payload?.job) {
      const agent = agentById(payload.job.awarded_agent_id);
      if (agent) enqueueWorkWake(agent, payload.job);
    }
  },
  onPeerNewerVersion: () => { updater.checkAndApply().then((applied) => { if (applied) shutdown(75); }).catch(() => {}); },
  log,
});
const updater = new Updater({ vault, config, appDir: APP_DIR, log });

// ---------- main ----------
let tick = 0;
let heartbeatTimer = null;
function shutdown(code = 0) {
  vault.journal("shutdown", { code });
  vault.saveState();
  try { realtime.stop(); } catch { /* ignore */ }
  try { mesh.stop(); } catch { /* ignore */ }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

vault.journal("boot", { version: RUNTIME_VERSION, agents: config.agents.map((a) => a.name) });
log(`exchange-agentd v${RUNTIME_VERSION} booting — ${config.agents.length} agents, vault ${VAULT_DIR}`);
log(`owner trust anchor: ${config.ownerPubkeySource}`);

// Boot guard: if this version has already failed to prove healthy on
// repeated boots, restore the previous version and exit so the service
// restarts into it (bootguard.mjs). Runs before anything else starts.
const guard = bootGuard(VAULT_DIR, APP_DIR, RUNTIME_VERSION, log);
if (guard.rolledBack) {
  vault.journal("boot_rollback", { from: guard.from, to: guard.to });
  log(`boot: rolled back v${guard.from} -> v${guard.to} — exiting for restart into the restored version`);
  process.exit(75);
}
vault.journal("boot_guard", { decision: guard.decision.reason, attempts: guard.state.attempts });
// Prove this version healthy: 60s up AND the Exchange API confirmed
// reachable (catch-up sync sets apiConfirmed) — then it is known-good
// and can never be rolled back.
const bootStartedAt = Date.now();
const healthyTimer = setInterval(() => {
  if (Date.now() - bootStartedAt < HEALTHY_AFTER_MS || !apiConfirmed) return;
  clearInterval(healthyTimer);
  markHealthy(VAULT_DIR, RUNTIME_VERSION);
  vault.journal("boot_proven", { version: RUNTIME_VERSION });
  log(`boot: v${RUNTIME_VERSION} proven healthy — recorded as known-good`);
}, 5000);
healthyTimer.unref?.();

mesh.start();

const bindings = [
  { event: "INSERT", schema: "public", table: "ex_jobs" },
  { event: "UPDATE", schema: "public", table: "ex_jobs" },
  { event: "INSERT", schema: "public", table: "ex_bids" },
  ...(config.serviceKey ? [
    { event: "INSERT", schema: "public", table: "ex_notifications", filter: `user_id=eq.${config.ownerId}` },
    { event: "INSERT", schema: "public", table: "ex_messages" },
  ] : []),
];
const realtime = new Realtime({
  url: config.supabaseUrl.replace("https://", "wss://") + "/realtime/v1",
  key: config.serviceKey || config.anonKey,
  bindings,
  onEvent: dispatch,
  onSubscribed: async () => {
    await catchUpSync();
    if (!ready) { ready = true; for (const [b, r, o, t] of eventBuffer.splice(0)) route(b, r, o, t); }
    updater.checkAndApply().then((applied) => { if (applied) shutdown(75); }).catch(() => {});
  },
  log,
});
realtime.start();

if (!config.serviceKey) {
  // No service key → no realtime notification/message bindings. Poll for
  // wakes instead so third-party installs still react to buyers.
  setInterval(() => { pollWakes().catch(() => {}); }, POLL_WAKES_MS);
  log(`polling wakes every ${POLL_WAKES_MS / 1000}s (no service key configured)`);
}

heartbeatTimer = setInterval(() => {
  tick++;
  try {
    scanWorkDir();
    vault.heartbeat({
      version: RUNTIME_VERSION, charter: charterHash(),
      ws_connected: realtime.connected, last_event_at: S.lastEventAt || null,
      queue: vault.pendingWake().length,
      agents: Object.fromEntries(config.agents.map((a) => [a.name, {
        id: S.agents[a.name].id, open_bids: activeBidCount(a.name), contracts: activeContractCount(a.name),
      }])),
      peers: Object.fromEntries([...mesh.peersState.entries()].map(([u, p]) => [u, { online: p.online, version: p.version }])),
      vault: vault.size(),
    });
    mesh.tick().catch(() => {});   // self-throttles to ~every 10 ticks (30s)
    if (tick % CHARTER.presencePushEveryTicks === 0) { pushPresence().catch(() => {}); }
    if (tick % 100 === 0) updater.checkAndApply().then((applied) => { if (applied) shutdown(75); }).catch(() => {});
    if (vault.pendingWake().length) touchWakeSignal();
  } catch (e) { log(`heartbeat error: ${e.message}`); }
}, CHARTER.heartbeatMs);
log(`heartbeat beating every ${CHARTER.heartbeatMs}ms`);
