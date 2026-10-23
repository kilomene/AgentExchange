#!/usr/bin/env node
// Fleet worker CLI for the Agent Exchange — used by the fleet watchdog.
// Authenticates as the named agent (default Phoenix) with its API key from fleet-keys.json.
// The key is never printed. Amounts in bid are DOLLARS (API converts).
import { readFileSync } from "node:fs";

const KEYS = JSON.parse(readFileSync(new URL("./fleet-keys.json", import.meta.url), "utf8"));
const COMMANDS = ["me", "floor", "job", "bids", "contracts", "bid", "claim", "deliver", "earnings"];
let agentName = "Phoenix";
let argv = process.argv.slice(2);
if (argv.length && !COMMANDS.includes(argv[0])) { agentName = argv[0]; argv = argv.slice(1); }
const entry = (KEYS.agents || []).find((a) => a.name === agentName);
if (!entry) { console.error(`agent key not found in fleet-keys.json for "${agentName}"`); process.exit(1); }
const BASE = KEYS.base;
const HEADERS = { "x-agent-key": entry.api_key, "content-type": "application/json" };

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`API ${res.status}: ${data.error || res.statusText}`); process.exit(1); }
  return data;
}
const dollars = (c) => `$${((c || 0) / 100).toFixed(2)}`;
const trim = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

const [cmd, ...args] = argv;

if (cmd === "me") {
  const d = await api("/agent/me");
  console.log(JSON.stringify(d, null, 1));
} else if (cmd === "floor") {
  const all = args.includes("--all");
  const d = await api(`/agent/jobs${all ? "?all=1" : ""}`);
  for (const j of d.jobs) {
    console.log(JSON.stringify({
      id: j.id, title: j.title, category: j.category, mode: j.mode,
      budget: dollars(j.budget_cents), budget_cents: j.budget_cents,
      bids: j.bid_count, lowest_bid: j.lowest_bid_cents != null ? dollars(j.lowest_bid_cents) : null,
      poster_user_id: j.poster_user_id, poster_agent_id: j.poster_agent_id,
      created_at: j.created_at, description: trim(j.description, 500),
    }));
  }
  if (!d.jobs.length) console.log("(no open jobs)");
} else if (cmd === "job") {
  const d = await api(`/jobs/${parseInt(args[0])}`);
  console.log(JSON.stringify(d.job, null, 1));
} else if (cmd === "bids") {
  const d = await api("/agent/my-bids");
  for (const b of d.bids) {
    console.log(JSON.stringify({
      bid_id: b.id, job_id: b.job_id, job_title: b.job_title, job_status: b.job_status,
      job_budget: dollars(b.job ? b.job.budget_cents : 0), my_amount: dollars(b.amount_cents),
      bid_status: b.status, eta_hours: b.eta_hours,
    }));
  }
  if (!d.bids.length) console.log("(no bids)");
} else if (cmd === "contracts") {
  const d = await api("/agent/contracts");
  for (const c of d.contracts) {
    console.log(JSON.stringify({
      job_id: c.id, title: c.title, status: c.status,
      agreed: dollars(c.agreed_cents), agreed_cents: c.agreed_cents, fee_cents: c.fee_cents,
      work_deadline: c.work_deadline, description: c.description,
      deliverable_so_far: c.deliverable || null,
    }, null, 1));
  }
  if (!d.contracts.length) console.log("(no contracts)");
} else if (cmd === "bid") {
  const [jobId, amount, eta, ...pitchParts] = args;
  const d = await api(`/agent/jobs/${parseInt(jobId)}/bid`, {
    method: "POST",
    body: JSON.stringify({ amount: Number(amount), eta_hours: parseInt(eta || "24"), pitch: pitchParts.join(" ") }),
  });
  console.log(JSON.stringify({ ok: true, bid_id: d.id, amount: dollars(d.amount_cents) }));
} else if (cmd === "claim") {
  const d = await api(`/agent/jobs/${parseInt(args[0])}/claim`, { method: "POST", body: "{}" });
  console.log(JSON.stringify(d));
} else if (cmd === "deliver") {
  const [jobId, file] = args;
  const text = readFileSync(file, "utf8");
  if (text.length > 7900) { console.error(`deliverable is ${text.length} chars — over the 7,900 limit; shorten it first`); process.exit(1); }
  const d = await api(`/agent/jobs/${parseInt(jobId)}/deliver`, { method: "POST", body: JSON.stringify({ deliverable: text }) });
  console.log(JSON.stringify({ ok: true, job_id: d.job && d.job.id, status: d.job && d.job.status }));
} else if (cmd === "earnings") {
  const d = await api("/agent/earnings");
  console.log(JSON.stringify({ wallet: d.wallet, recent_ledger: (d.ledger || []).slice(0, 10) }, null, 1));
} else {
  console.error("usage: fleet-worker.mjs [AgentName] me | floor [--all] | job <id> | bids | contracts | bid <jobId> <amount$> <etaHours> <pitch> | claim <jobId> | deliver <jobId> <file> | earnings");
  process.exit(1);
}
