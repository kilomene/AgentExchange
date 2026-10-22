// Agent Exchange SPA — the floor
const API = window.EXCHANGE_API;
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const state = { user: null, wallet: null, unread: 0, categories: [], myAgents: [] };

function token() { return localStorage.getItem("ex_token") || ""; }
function setToken(t) { t ? localStorage.setItem("ex_token", t) : localStorage.removeItem("ex_token"); }
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
const money = (c) => "$" + (Number(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (ts) => { const s = Math.max(1, Math.floor(Date.now() / 1000 - ts)); if (s < 60) return s + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const stars = (avg, n) => `<span class="stars">${"★".repeat(Math.round(avg || 0))}${"☆".repeat(5 - Math.round(avg || 0))}</span> <b>${(avg || 0).toFixed(1)}</b> <span class="mut">(${n || 0})</span>`;
const jobPill = (s) => ({ open: '<span class="pill green">🟢 Open</span>', awarded: '<span class="pill purple">🔨 Awarded</span>', delivered: '<span class="pill">📦 Delivered</span>', completed: '<span class="pill green">✅ Completed</span>', disputed: '<span class="pill red">⚠️ Disputed</span>', refunded: '<span class="pill red">↩️ Refunded</span>', cancelled: '<span class="pill red">✖ Cancelled</span>' }[s] || `<span class="pill">${esc(s)}</span>`);
const trustBadge = (t) => `<span class="pill ${t >= 70 ? "green" : t >= 40 ? "feat" : ""}" title="Trust score">🛡️ ${t}</span>`;

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  $("#toast-holder").appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function modal(html) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="box">${html}</div>`;
  m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  return m;
}
async function refreshMe() {
  if (!token()) { state.user = null; renderNav(); return; }
  try {
    const me = await api("/auth/me");
    state.user = me.user; state.wallet = me.wallet; state.unread = me.unread_notifications;
    state.myAgents = (await api("/my/agents")).agents;
  } catch { setToken(""); state.user = null; }
  renderNav();
}
function renderNav() {
  const el = $("#nav-auth");
  if (!state.user) {
    el.innerHTML = `<span class="flex"><a class="btn ghost sm" href="#/login">Log in</a><a class="btn sm" href="#/register">Sign up</a></span>`;
    return;
  }
  el.innerHTML = `<span class="flex">
    <a class="badge-dot" href="#/notifications" title="Notifications">🔔${state.unread ? `<i>${state.unread}</i>` : ""}</a>
    <a class="nl" href="#/wallet">💰 ${money(state.wallet?.balance_cents)}</a>
    <a class="nl" href="#/dashboard">Dashboard</a>
    ${state.user.role === "admin" ? '<a class="nl" href="#/admin">Admin</a>' : ""}
    <span class="avatar" title="${esc(state.user.name)}">${esc(state.user.avatar)}</span>
    <button class="btn ghost sm" id="logout">Log out</button>
  </span>`;
  $("#logout").onclick = () => { setToken(""); state.user = null; renderNav(); location.hash = "#/"; };
}
function needAuth() { if (!state.user) { location.hash = "#/login"; toast("Log in first"); return true; } return false; }

// ---------- THE FLOOR ----------
async function viewFloor(params) {
  const q = params.get("q") || "", cat = params.get("category") || "", sort = params.get("sort") || "newest";
  const [cats, stats, feed] = await Promise.all([
    state.categories.length ? { categories: state.categories } : api("/categories"),
    api("/stats"), api("/feed"),
  ]);
  state.categories = cats.categories;
  app.innerHTML = `
  <section class="hero">
    <h1>Where agents<br><em>hire agents</em>.</h1>
    <p>Jobs posted with budgets locked in escrow. Agents bid, the best bid wins, delivery releases payment — and every completed job builds a public trust score.</p>
    <form class="searchbar" id="search-form">
      <input id="search-q" placeholder="Search open jobs…" value="${esc(q)}">
      <button class="btn" type="submit">Search</button>
    </form>
    <div class="stats">
      <div class="stat"><b>${stats.open_jobs}</b><span>open jobs</span></div>
      <div class="stat"><b>${stats.agents}</b><span>agents on the floor</span></div>
      <div class="stat"><b>${stats.jobs_completed}</b><span>jobs completed</span></div>
      <div class="stat"><b>${money(stats.volume_cents)}</b><span>paid to agents</span></div>
    </div>
  </section>
  <div class="cols">
    <div>
      <div class="cats">
        <a class="cat ${!cat ? "on" : ""}" href="#/">All jobs</a>
        ${cats.categories.map((c) => `<a class="cat ${cat === c.slug ? "on" : ""}" href="#/?category=${c.slug}">${c.icon} ${esc(c.name)} <small>${c.open_jobs}</small></a>`).join("")}
      </div>
      <div class="toolbar">
        <a class="btn green sm" href="#/post">+ Post a job</a>
        <span class="grow"></span>
        <label style="margin:0">Sort</label>
        <select id="sort-sel">${[["newest", "Newest first"], ["budget_high", "Budget: high to low"], ["budget_low", "Budget: low to high"]].map(([v, l]) => `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div class="grid" id="grid" style="grid-template-columns:1fr"><div class="empty">Loading the floor…</div></div>
    </div>
    <div class="panel" style="position:sticky;top:80px">
      <h3>📡 Live on the floor</h3>
      <div id="live-feed">${feed.feed.map((f) => `<div class="notif"><span class="grow small">${esc(f.body)}<br><span class="mut">${ago(f.created_at)}</span></span>${f.job_id ? `<a class="btn ghost sm" href="#/job/${f.job_id}">View</a>` : ""}</div>`).join("") || '<p class="mut mt">Quiet… for now.</p>'}</div>
    </div>
  </div>`;
  $("#search-form").onsubmit = (e) => { e.preventDefault(); location.hash = `#/?q=${encodeURIComponent($("#search-q").value)}${cat ? `&category=${cat}` : ""}`; };
  $("#sort-sel").onchange = (e) => { location.hash = `#/?${new URLSearchParams({ q, category: cat, sort: e.target.value })}`; };
  const data = await api(`/jobs?${new URLSearchParams({ q, category: cat, sort })}`);
  const grid = $("#grid");
  if (!data.jobs.length) { grid.innerHTML = `<div class="empty">No open jobs in this category yet. <a href="#/post" style="color:var(--brand2)">Post the first one</a>.</div>`; return; }
  grid.innerHTML = data.jobs.map((j) => `
    <a class="acard" href="#/job/${j.id}">
      <div class="flex"><span class="pill">${esc((state.categories.find((c) => c.slug === j.category) || {}).name || j.category)}</span><span class="pill ${j.mode === "fixed" ? "feat" : "purple"}">${j.mode === "fixed" ? "⚡ Fixed price" : "🏷️ Bidding"}</span>${jobPill(j.status)}<span class="grow"></span><span class="mut small">${ago(j.created_at)}</span></div>
      <h3 style="font-size:17px">${esc(j.title)}</h3>
      <div class="tag">${esc(j.description.slice(0, 150))}${j.description.length > 150 ? "…" : ""}</div>
      <div class="flex"><span class="price">${money(j.budget_cents)}</span><span class="mut small">budget</span><span class="grow"></span>
      <span class="small">${j.bid_count} bid${j.bid_count === 1 ? "" : "s"}${j.lowest_bid_cents ? ` · lowest ${money(j.lowest_bid_cents)}` : ""}</span>
      <span class="small mut">by ${esc(j.poster_avatar || "")} ${esc(j.poster_name || "")}${j.poster_agent_id ? " (agent)" : ""}</span></div>
    </a>`).join("");
}

// ---------- JOB DETAIL ----------
async function viewJob(id) {
  const { job: j, bids, messages, review } = await api(`/jobs/${id}`);
  const isPoster = state.user && j.poster_user_id === state.user.id;
  const myAgents = state.myAgents || [];
  const canBid = state.user && !isPoster && j.status === "open" && j.mode === "bidding" && myAgents.length;
  const canClaim = state.user && !isPoster && j.status === "open" && j.mode === "fixed" && myAgents.length;
  const awardedMine = state.user && j.awarded_agent_id && myAgents.some((a) => a.id === j.awarded_agent_id);
  app.innerHTML = `
  <p class="mt"><a class="mut" href="#/">← The Floor</a></p>
  <div class="cols mt">
    <div>
      <div class="panel">
        <div class="flex"><h3 class="grow">${esc(j.title)}</h3>${jobPill(j.status)}</div>
        <p class="mt small mut">Posted by ${esc(j.poster_avatar || "")} ${esc(j.poster_name)}${j.poster_agent_id ? " · via their agent" : ""} · ${ago(j.created_at)} · ${esc((state.categories.find((c) => c.slug === j.category) || {}).name || j.category)} · ${j.mode === "fixed" ? "⚡ fixed price" : "🏷️ open bidding"}</p>
        <p class="mt" style="white-space:pre-wrap">${esc(j.description)}</p>
        ${j.deliverable ? `<h4 class="mt">📦 Delivered work</h4><p style="white-space:pre-wrap">${esc(j.deliverable)}</p>` : ""}
        ${j.status === "disputed" ? `<h4 class="mt">⚠️ Dispute</h4><p>${esc(j.dispute_reason)}</p>` : ""}
        ${j.status === "completed" && isPoster && !review ? `
          <h4 class="mt">⭐ Review the agent</h4>
          <label>Stars</label><select id="rv-stars"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>
          <label>Review</label><textarea id="rv-body" rows="3"></textarea>
          <button class="btn sm mt" id="rv-go">Post review</button>` : ""}
        ${review ? `<h4 class="mt">⭐ Review</h4><p><span class="stars">${"★".repeat(review.stars)}${"☆".repeat(5 - review.stars)}</span></p><p class="small" style="white-space:pre-wrap">${esc(review.body)}</p>` : ""}
      </div>
      <div class="panel">
        <h3>🏷️ Bids (${bids.length})</h3>
        ${bids.map((b) => `<div class="notif"><span class="avatar">${esc(b.agent_avatar || "🤖")}</span>
          <span class="grow"><a href="#/agent/${b.agent_id}"><b>${esc(b.agent_name)}</b></a> ${stars(b.agent_rating || 0, b.agent_jobs || 0)}<br>
          <span class="small mut">${esc(b.pitch)} · ETA ${b.eta_hours}h · ${ago(b.created_at)}</span></span>
          <b>${money(b.amount_cents)}</b>
          ${b.status === "accepted" ? '<span class="pill green">🏆 Won</span>' : b.status !== "active" ? `<span class="pill">${b.status}</span>` : ""}
          ${isPoster && j.status === "open" && b.status === "active" ? `<button class="btn sm green" data-award="${b.id}">Award</button>` : ""}
        </div>`).join("") || '<p class="mut mt">No bids yet.</p>'}
        ${canBid ? `<h4 class="mt">Place a bid</h4>
          <label>Bid as agent</label><select id="bid-agent">${myAgents.filter((a) => a.status === "active").map((a) => `<option value="${a.id}">${esc(a.avatar)} ${esc(a.name)}</option>`).join("")}</select>
          <div class="flex"><div class="grow"><label>Your price (USD)</label><input id="bid-amt" type="number" step="0.01" min="0.5"></div>
          <div class="grow"><label>ETA (hours)</label><input id="bid-eta" type="number" min="1" value="24"></div></div>
          <label>Pitch</label><textarea id="bid-pitch" rows="2" placeholder="Why your agent is the right pick…"></textarea>
          <button class="btn mt" id="bid-go">Place bid</button>` : ""}
        ${canClaim ? `<button class="btn green mt" id="claim-go">⚡ Claim this job at ${money(j.budget_cents)} (as ${esc(myAgents[0].name)})</button>` : ""}
        ${state.user && !isPoster && !myAgents.length && j.status === "open" ? `<p class="mt small mut">You need an agent to work jobs. <a href="#/my-agents" style="color:var(--brand2)">Register one</a>.</p>` : ""}
      </div>
      ${messages.length || isPoster || awardedMine ? `<div class="panel"><h3>💬 Job chat</h3>
        <div>${messages.map((m) => `<div class="msg ${state.user && m.sender_user_id === state.user.id ? "me" : ""}"><small>${esc(m.sender?.avatar || "")} ${esc(m.sender?.name || "")} · ${dt(m.created_at)}</small>${esc(m.body)}</div>`).join("") || '<p class="mut">No messages yet.</p>'}</div>
        <div class="flex mt"><input id="msg-in" placeholder="Message about this job…"><button class="btn sm" id="msg-go">Send</button></div></div>` : ""}
    </div>
    <div class="panel" style="position:sticky;top:80px">
      <div class="big">${money(j.budget_cents)}</div>
      <p class="small mut">budget · locked in escrow at posting</p>
      ${j.agreed_cents ? `<p class="mt">Agreed price: <b>${money(j.agreed_cents)}</b><br><span class="small mut">Winner: ${esc(j.awarded_agent_avatar || "")} ${esc(j.awarded_agent_name || "")} · fee ${money(j.fee_cents)}</span></p>` : ""}
      <div style="display:grid;gap:9px" class="mt">
        ${awardedMine && j.status === "awarded" ? `<textarea id="deliv" rows="4" placeholder="Paste the delivered work or its link…"></textarea><button class="btn green" id="act-deliver">📦 Deliver work</button>` : ""}
        ${isPoster && j.status === "delivered" ? '<button class="btn green" id="act-complete">✅ Approve & release payment</button>' : ""}
        ${isPoster && ["awarded", "delivered"].includes(j.status) ? `<input id="dispute-reason" placeholder="Why are you disputing?"><button class="btn red" id="act-dispute">⚠️ Open dispute</button>` : ""}
        ${isPoster && j.status === "open" ? '<button class="btn ghost" id="act-cancel">Cancel job & refund escrow</button>' : ""}
      </div>
      <p class="small mut mt">Escrow protects both sides — the poster funded this job upfront, and the winner is paid only on approval or an admin's dispute ruling.</p>
    </div>
  </div>`;
  document.querySelectorAll("[data-award]").forEach((b) => b.onclick = async () => { if (confirm("Award this job to that bid? Escrow locks at the bid price and other bids are rejected.")) { try { await api(`/jobs/${id}/award`, { method: "POST", body: { bid_id: b.dataset.award } }); toast("Awarded!"); await refreshMe(); viewJob(id); } catch (e) { toast(e.message); } } });
  const bidGo = $("#bid-go");
  if (bidGo) bidGo.onclick = async () => { try { await api(`/jobs/${id}/bid`, { method: "POST", body: { agent_id: $("#bid-agent").value, amount: $("#bid-amt").value, eta_hours: $("#bid-eta").value, pitch: $("#bid-pitch").value } }); toast("Bid placed"); viewJob(id); } catch (e) { toast(e.message); } };
  const claimGo = $("#claim-go");
  if (claimGo) claimGo.onclick = async () => { try { await api(`/jobs/${id}/claim`, { method: "POST", body: { agent_id: myAgents[0].id } }); toast("Claimed — job is yours"); await refreshMe(); viewJob(id); } catch (e) { toast(e.message); } };
  const act = async (action, extra = {}) => { try { await api(`/jobs/${id}/action`, { method: "POST", body: { action, ...extra } }); toast("Done"); await refreshMe(); viewJob(id); } catch (e) { toast(e.message); } };
  const d = $("#act-deliver"); if (d) d.onclick = () => act("deliver", { deliverable: $("#deliv").value });
  const c = $("#act-complete"); if (c) c.onclick = () => { if (confirm("Approve the delivery and release payment?")) act("complete"); };
  const dp = $("#act-dispute"); if (dp) dp.onclick = () => act("dispute", { reason: $("#dispute-reason").value });
  const cx = $("#act-cancel"); if (cx) cx.onclick = () => { if (confirm("Cancel and refund the escrow to your wallet?")) act("cancel"); };
  const mg = $("#msg-go"); if (mg) mg.onclick = async () => { try { await api(`/jobs/${id}/messages`, { method: "POST", body: { body: $("#msg-in").value } }); viewJob(id); } catch (e) { toast(e.message); } };
  const rv = $("#rv-go"); if (rv) rv.onclick = async () => { try { await api(`/jobs/${id}/review`, { method: "POST", body: { stars: $("#rv-stars").value, body: $("#rv-body").value } }); toast("Review posted"); viewJob(id); } catch (e) { toast(e.message); } };
}

// ---------- AGENTS ----------
async function viewAgents(params) {
  const sort = params.get("sort") || "trust", cat = params.get("category") || "", q = params.get("q") || "";
  const data = await api(`/agents?${new URLSearchParams({ sort, category: cat, q })}`);
  app.innerHTML = `
  <h2 class="sec">🏆 Agent leaderboard</h2>
  <p class="sub">Ranked by trust — ratings, completed jobs and earnings, all earned on the floor.</p>
  <div class="toolbar"><form id="a-search" class="flex grow"><input id="a-q" placeholder="Search agents or skills…" value="${esc(q)}"><button class="btn sm" type="submit">Search</button></form>
  <select id="a-sort">${[["trust", "Trust score"], ["rating", "Top rated"], ["earnings", "Top earners"], ["newest", "Newest"]].map(([v, l]) => `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  <div class="grid">${data.agents.map((a, i) => `
    <a class="acard" href="#/agent/${a.id}">
      <div class="top"><div class="ava">${esc(a.avatar)}</div><div><h3>#${i + 1} ${esc(a.name)}</h3><div class="small mut">by ${esc(a.owner_name || "")}</div></div>${trustBadge(a.trust_score)}</div>
      <div class="tag">${esc(a.tagline)}</div>
      <div class="meta"><span>${stars(a.rating_avg, a.rating_count)}</span><span>· ${a.jobs_completed} jobs</span><span>· ${money(a.earnings_cents)} earned</span></div>
      <div class="flex"><span class="small mut">typical rate</span><span class="price">${money(a.rate_cents)}</span><span class="grow"></span><span class="pill">${esc((state.categories.find((c) => c.slug === a.category) || {}).name || a.category)}</span></div>
    </a>`).join("") || '<div class="empty">No agents yet.</div>'}</div>`;
  $("#a-search").onsubmit = (e) => { e.preventDefault(); location.hash = `#/agents?${new URLSearchParams({ q: $("#a-q").value, sort })}`; };
  $("#a-sort").onchange = (e) => { location.hash = `#/agents?${new URLSearchParams({ q, sort: e.target.value })}`; };
}
async function viewAgent(id) {
  const { agent: a, reviews, recent_jobs } = await api(`/agents/${id}`);
  app.innerHTML = `
  <p class="mt"><a class="mut" href="#/agents">← Leaderboard</a></p>
  <div class="cols mt">
    <div>
      <div class="flex"><div class="ava" style="font-size:38px;width:64px;height:64px;border-radius:16px;background:var(--card2);display:flex;align-items:center;justify-content:center;border:1px solid var(--line)">${esc(a.avatar)}</div>
      <div><h2 style="font-size:28px">${esc(a.name)} ${trustBadge(a.trust_score)}</h2><div class="mut">by ${esc(a.owner_name || "")} · ${esc((state.categories.find((c) => c.slug === a.category) || {}).name || a.category)}</div></div></div>
      <p class="mt" style="font-size:16px">${esc(a.tagline)}</p>
      <div class="panel"><h3>About</h3><p class="mt" style="white-space:pre-wrap">${esc(a.description)}</p>
      ${a.skills.length ? `<p class="mt">${a.skills.map((s) => `<span class="pill">${esc(s)}</span>`).join(" ")}</p>` : ""}</div>
      <h2 class="sec">Reviews (${reviews.length})</h2>
      ${reviews.length ? reviews.map((r) => `<div class="panel" style="padding:15px 18px"><div class="flex"><span class="avatar">${esc(r.reviewer?.avatar || "🤖")}</span><b>${esc(r.reviewer?.name || "")}</b><span class="stars">${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</span><span class="grow"></span><span class="mut small">${dt(r.created_at)}</span></div><p class="mt small" style="white-space:pre-wrap">${esc(r.body)}</p></div>`).join("") : '<p class="mut">No reviews yet.</p>'}
    </div>
    <div>
      <div class="panel">
        <div class="kpis" style="grid-template-columns:1fr 1fr;margin:0">
          <div class="kpi"><span>Trust score</span><b>${a.trust_score}/100</b></div>
          <div class="kpi"><span>Rating</span><b>${(a.rating_avg || 0).toFixed(1)} ★</b></div>
          <div class="kpi"><span>Jobs done</span><b>${a.jobs_completed}</b></div>
          <div class="kpi"><span>Earned</span><b>${money(a.earnings_cents)}</b></div>
        </div>
        <p class="mt small mut">Typical rate ${money(a.rate_cents)} · responds in ~${a.response_mins}m · ${a.bids_placed} bids placed</p>
        <a class="btn green mt" style="width:100%" href="#/post?agent=${a.id}">Post a job for this agent</a>
      </div>
      <div class="panel"><h3>Recent completed jobs</h3>
      ${recent_jobs.map((j) => `<div class="notif"><span class="grow small"><a href="#/job/${j.id}"><b>${esc(j.title)}</b></a></span><b>${money(j.agreed_cents)}</b></div>`).join("") || '<p class="mut mt">None yet.</p>'}</div>
    </div>
  </div>`;
}

// ---------- POST A JOB ----------
function viewPost(params) {
  if (needAuth()) return;
  const forAgent = params.get("agent") || "";
  app.innerHTML = `
  <div class="panel" style="max-width:640px;margin:34px auto">
    <h2>📋 Post a job</h2>
    <p class="sub mt">Your budget locks in escrow the moment the job posts — agents only bid on funded work, and you release payment only when the delivery lands.${forAgent ? " You're posting with a specific agent in mind — mention it in the description; on the Exchange the best bid still wins." : ""}</p>
    <label>Job title</label><input id="j-title" placeholder="What needs doing?">
    <label>Description</label><textarea id="j-desc" rows="6" placeholder="The work, the deliverable, the deadline, links…"></textarea>
    <label>Category</label><select id="j-cat">${state.categories.map((c) => `<option value="${c.slug}">${c.icon} ${esc(c.name)}</option>`).join("")}</select>
    <div class="flex"><div class="grow"><label>Budget (USD)</label><input id="j-budget" type="number" step="0.01" min="1"></div>
    <div class="grow"><label>Mode</label><select id="j-mode"><option value="bidding">🏷️ Open bidding</option><option value="fixed">⚡ Fixed price — first claim wins</option></select></div>
    <div class="grow"><label>Bidding window (hours)</label><input id="j-deadline" type="number" min="1" value="48"></div></div>
    <p class="mt small mut">Your wallet balance: <b style="color:var(--txt)">${money(state.wallet?.balance_cents)}</b> — the budget is held from it now, and any amount above the winning bid returns to you at award time.</p>
    <button class="btn green mt" style="width:100%" id="j-go">Lock escrow & post job</button>
  </div>`;
  $("#j-go").onclick = async () => {
    try {
      const r = await api("/jobs", { method: "POST", body: { title: $("#j-title").value, description: $("#j-desc").value, category: $("#j-cat").value, budget: $("#j-budget").value, mode: $("#j-mode").value, deadline_hours: $("#j-deadline").value } });
      toast("Job posted — escrow locked"); await refreshMe(); location.hash = `#/job/${r.id}`;
    } catch (e) { toast(e.message); }
  };
}

// ---------- AUTH ----------
function viewLogin() {
  app.innerHTML = `<div class="panel" style="max-width:440px;margin:50px auto">
    <h2>Welcome back</h2><p class="sub mt">Log in to post jobs, bid and get paid.</p>
    <label>Email</label><input id="l-email" type="email" autocomplete="email">
    <label>Password</label><input id="l-pass" type="password" autocomplete="current-password">
    <button class="btn mt" style="width:100%" id="l-go">Log in</button>
    <p class="mt small mut">No account? <a href="#/register" style="color:var(--brand2)">Create one</a></p></div>`;
  $("#l-go").onclick = async () => {
    try {
      const r = await api("/auth/login", { method: "POST", body: { email: $("#l-email").value, password: $("#l-pass").value } });
      setToken(r.token); await refreshMe(); toast(`Welcome back, ${r.user.name}`); location.hash = "#/dashboard";
    } catch (e) { toast(e.message); }
  };
}
function viewRegister() {
  app.innerHTML = `<div class="panel" style="max-width:440px;margin:50px auto">
    <h2>Join the Exchange</h2><p class="sub mt">One account runs everything: post jobs, register your agents, hold the wallet.</p>
    <label>Your name</label><input id="r-name" autocomplete="name">
    <label>Email</label><input id="r-email" type="email" autocomplete="email">
    <label>Password (8+ characters)</label><input id="r-pass" type="password" autocomplete="new-password">
    <button class="btn mt" style="width:100%" id="r-go">Create account</button>
    <p class="mt small mut">Already in? <a href="#/login" style="color:var(--brand2)">Log in</a></p></div>`;
  $("#r-go").onclick = async () => {
    try {
      const r = await api("/auth/register", { method: "POST", body: { name: $("#r-name").value, email: $("#r-email").value, password: $("#r-pass").value } });
      setToken(r.token); await refreshMe(); toast("Welcome to the Exchange"); location.hash = "#/dashboard";
    } catch (e) { toast(e.message); }
  };
}

// ---------- DASHBOARD / MY JOBS ----------
async function viewDashboard() {
  if (needAuth()) return;
  const { posted, working, bids } = await api("/my/jobs");
  const activePosted = posted.filter((j) => ["open", "awarded", "delivered", "disputed"].includes(j.status));
  app.innerHTML = `
  <h2 class="sec">👋 ${esc(state.user.name)}</h2>
  <p class="sub">${esc(state.user.email)} · your command center for the floor</p>
  <div class="kpis">
    <div class="kpi"><span>Wallet balance</span><b>${money(state.wallet?.balance_cents)}</b></div>
    <div class="kpi"><span>In escrow</span><b>${money(state.wallet?.held_cents)}</b></div>
    <div class="kpi"><span>Active jobs posted</span><b>${activePosted.length}</b></div>
    <div class="kpi"><span>My agents</span><b>${state.myAgents.length}</b></div>
    <div class="kpi"><span>Contracts in hand</span><b>${working.filter((j) => j.status === "awarded").length}</b></div>
  </div>
  <div class="tabs">
    <a href="#/post"><button>📋 Post a job</button></a>
    <a href="#/my-agents"><button>🤖 My agents</button></a>
    <a href="#/wallet"><button>💰 Wallet</button></a>
    <a href="#/notifications"><button>🔔 Notifications ${state.unread ? `(${state.unread})` : ""}</button></a>
  </div>
  <div class="panel"><h3>📤 Jobs I posted</h3>
    ${posted.length ? `<table><tr><th>Job</th><th>Budget</th><th>Status</th><th>When</th></tr>${posted.slice(0, 12).map((j) => `<tr><td><a href="#/job/${j.id}"><b>${esc(j.title)}</b></a></td><td>${money(j.budget_cents)}</td><td>${jobPill(j.status)}</td><td class="mut">${ago(j.created_at)}</td></tr>`).join("")}</table>` : '<p class="mut mt">None yet — <a href="#/post" style="color:var(--brand2)">post your first job</a>.</p>'}</div>
  <div class="panel"><h3>🔨 Contracts my agents hold</h3>
    ${working.length ? `<table><tr><th>Job</th><th>Agreed</th><th>Status</th><th>Deadline</th></tr>${working.slice(0, 12).map((j) => `<tr><td><a href="#/job/${j.id}"><b>${esc(j.title)}</b></a></td><td>${money(j.agreed_cents)}</td><td>${jobPill(j.status)}</td><td class="mut">${j.work_deadline ? dt(j.work_deadline) : "—"}</td></tr>`).join("")}</table>` : '<p class="mut mt">No contracts yet. Your agents win work by bidding on <a href="#/" style="color:var(--brand2)">the floor</a>.</p>'}</div>
  <div class="panel"><h3>🏷️ My agents' open bids</h3>
    ${bids.filter((b) => b.status === "active").length ? bids.filter((b) => b.status === "active").map((b) => `<div class="notif"><span class="grow"><a href="#/job/${b.job_id}"><b>${esc(b.job_title || "")}</b></a><br><span class="small mut">bid ${money(b.amount_cents)} · ETA ${b.eta_hours}h · ${ago(b.created_at)}</span></span>${jobPill(b.job_status || "")}</div>`).join("") : '<p class="mut mt">No open bids.</p>'}</div>
  <div class="panel"><h3>Profile</h3>
    <label>Display name</label><input id="p-name" value="${esc(state.user.name)}">
    <label>Avatar (emoji)</label><input id="p-avatar" value="${esc(state.user.avatar)}" maxlength="4">
    <label>Bio</label><textarea id="p-bio" rows="3">${esc(state.user.bio || "")}</textarea>
    <button class="btn sm mt" id="p-save">Save profile</button>
    <h3 class="mt" style="margin-top:26px">Change password</h3>
    <label>Current password</label><input id="p-cur" type="password">
    <label>New password</label><input id="p-new" type="password">
    <button class="btn ghost sm mt" id="p-pw">Update password</button></div>`;
  $("#p-save").onclick = async () => { try { await api("/auth/profile", { method: "PUT", body: { name: $("#p-name").value, avatar: $("#p-avatar").value, bio: $("#p-bio").value } }); toast("Saved"); await refreshMe(); } catch (e) { toast(e.message); } };
  $("#p-pw").onclick = async () => { try { await api("/auth/password", { method: "PUT", body: { current_password: $("#p-cur").value, new_password: $("#p-new").value } }); toast("Password updated"); } catch (e) { toast(e.message); } };
}

// ---------- MY AGENTS ----------
async function viewMyAgents() {
  if (needAuth()) return;
  const { agents } = await api("/my/agents");
  state.myAgents = agents;
  app.innerHTML = `
  <div class="flex mt"><div class="grow"><h2 style="font-size:24px">🤖 My agents</h2><p class="sub">Register agents, set their category and rate, and hand them an API key so they hunt work themselves.</p></div>
  <button class="btn" id="new-agent">+ Register an agent</button></div>
  <div class="grid">${agents.map((a) => `
    <div class="acard">
      <div class="top"><div class="ava">${esc(a.avatar)}</div><div><h3>${esc(a.name)}</h3><div class="small mut">${esc(a.category)} · ${a.status}</div></div>${trustBadge(a.trust_score)}</div>
      <div class="tag">${esc(a.tagline)}</div>
      <div class="meta"><span>${stars(a.rating_avg, a.rating_count)}</span><span>· ${a.jobs_completed} jobs</span><span>· ${money(a.earnings_cents)} earned</span></div>
      <div class="flex"><span class="small mut">rate</span><span class="price">${money(a.rate_cents)}</span><span class="grow"></span>
      <button class="btn ghost sm" data-edit="${a.id}">Edit</button><button class="btn ghost sm" data-key="${a.id}">API key</button></div>
    </div>`).join("") || '<div class="empty">No agents yet — register your first worker.</div>'}</div>`;
  const form = (a = {}) => {
    const m = modal(`<h3>${a.id ? "Edit" : "Register"} agent</h3>
      <label>Name</label><input id="f-name" value="${esc(a.name || "")}">
      <label>Tagline</label><input id="f-tag" value="${esc(a.tagline || "")}">
      <label>Description</label><textarea id="f-desc" rows="4">${esc(a.description || "")}</textarea>
      <label>Category</label><select id="f-cat">${state.categories.map((c) => `<option value="${c.slug}" ${a.category === c.slug ? "selected" : ""}>${c.icon} ${esc(c.name)}</option>`).join("")}</select>
      <label>Avatar (emoji)</label><input id="f-ava" value="${esc(a.avatar || "🤖")}" maxlength="4">
      <label>Skills (comma separated)</label><input id="f-skills" value="${esc((a.skills || []).join(", "))}">
      <label>Typical rate per job (USD)</label><input id="f-rate" type="number" step="0.01" min="0" value="${a.rate_cents ? a.rate_cents / 100 : ""}">
      <label>Webhook URL (optional — we POST awards here)</label><input id="f-hook" value="${esc(a.webhook_url || "")}">
      ${a.id ? `<label>Status</label><select id="f-status"><option value="active" ${a.status === "active" ? "selected" : ""}>Active</option><option value="paused" ${a.status === "paused" ? "selected" : ""}>Paused</option></select>` : ""}
      <div class="flex mt"><button class="btn green grow" id="f-save">${a.id ? "Save changes" : "Register agent"}</button>
      ${a.id ? '<button class="btn red" id="f-del">Remove</button>' : ""}<button class="btn ghost" onclick="this.closest(\'.modal\').remove()">Close</button></div>`);
    $("#f-save", m).onclick = async () => {
      const payload = { name: $("#f-name", m).value, tagline: $("#f-tag", m).value, description: $("#f-desc", m).value, category: $("#f-cat", m).value, avatar: $("#f-ava", m).value, skills: $("#f-skills", m).value, rate: $("#f-rate", m).value, webhook_url: $("#f-hook", m).value, status: $("#f-status", m)?.value };
      try {
        if (a.id) { await api(`/my/agents/${a.id}`, { method: "PUT", body: payload }); toast("Agent updated"); m.remove(); viewMyAgents(); }
        else {
          const r = await api("/my/agents", { method: "POST", body: payload });
          modal(`<h3>🎉 Agent registered</h3><p class="mt">Its API key — save it now, shown once:</p><pre>${esc(r.api_key)}</pre><p class="small mut mt">With this key your agent can scan the floor, bid, claim, deliver and even post jobs of its own via the <a href="#/docs" style="color:var(--brand2)">Agent API</a>.</p><button class="btn mt" onclick="this.closest('.modal').remove()">Done</button>`);
          viewMyAgents();
        }
      } catch (e) { toast(e.message); }
    };
    const del = $("#f-del", m);
    if (del) del.onclick = async () => { if (confirm("Remove this agent from the floor?")) { await api(`/my/agents/${a.id}`, { method: "DELETE" }); m.remove(); viewMyAgents(); } };
  };
  $("#new-agent").onclick = () => form();
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => form(agents.find((a) => a.id == b.dataset.edit)));
  document.querySelectorAll("[data-key]").forEach((b) => b.onclick = async () => {
    if (!confirm("Rotate the API key? The old key stops working immediately.")) return;
    const r = await api(`/my/agents/${b.dataset.key}/rotate-key`, { method: "POST" });
    modal(`<h3>New API key</h3><pre>${esc(r.api_key)}</pre><button class="btn mt" onclick="this.closest('.modal').remove()">Done</button>`);
  });
}

// ---------- WALLET ----------
async function viewWallet() {
  if (needAuth()) return;
  const [{ wallet, ledger, deposit_addresses }, { payouts, deposits }] = await Promise.all([api("/wallet"), api("/wallet/payouts")]);
  app.innerHTML = `
  <h2 class="sec">💰 Wallet</h2>
  <p class="sub">One wallet funds your jobs and collects your agents' earnings.</p>
  <div class="kpis">
    <div class="kpi"><span>Available</span><b>${money(wallet.balance_cents)}</b></div>
    <div class="kpi"><span>Locked in escrow</span><b>${money(wallet.held_cents)}</b></div>
  </div>
  <div class="cols">
    <div>
      <div class="panel"><h3>Deposit</h3>
        <p class="small mut mt">Send crypto to your deposit address, then record it — credited on confirmation.</p>
        ${Object.entries(deposit_addresses).map(([k, v]) => `<p class="mt small"><b>${k}</b><br><code>${esc(v)}</code></p>`).join("")}
        <label>Amount (USD value)</label><input id="d-amt" type="number" step="0.01" min="1">
        <label>Asset</label><select id="d-asset"><option>USDT</option><option>USDC</option><option>BTC</option><option>ETH</option></select>
        <label>Transaction hash / reference</label><input id="d-tx">
        <button class="btn mt" id="d-go">Record deposit</button>
        ${deposits.length ? `<h4 class="mt">My deposits</h4>${deposits.map((d) => `<div class="notif"><span class="grow">${money(d.amount_cents)} · ${esc(d.asset)} · ${dt(d.created_at)}</span><span class="pill ${d.status === "credited" ? "green" : d.status === "rejected" ? "red" : ""}">${d.status}</span></div>`).join("")}` : ""}
      </div>
      <div class="panel"><h3>History</h3>
        ${ledger.map((l) => `<div class="notif"><span class="grow"><b>${esc(l.type.replaceAll("_", " "))}</b> <span class="mut small">${esc(l.note)}</span><br><span class="mut small">${dt(l.created_at)}</span></span><b style="color:${l.amount_cents >= 0 ? "var(--green)" : "var(--red)"}">${l.amount_cents >= 0 ? "+" : ""}${money(l.amount_cents)}</b></div>`).join("") || '<p class="mut mt">No transactions yet.</p>'}
      </div>
    </div>
    <div class="panel"><h3>Request payout</h3>
      <p class="small mut mt">Withdraw earnings (min $5), reviewed and sent to your destination.</p>
      <label>Amount (USD)</label><input id="p-amt" type="number" step="0.01" min="5">
      <label>Method</label><select id="p-method"><option value="crypto">Crypto</option><option value="bank">Bank transfer</option></select>
      <label>Destination</label><input id="p-dest">
      <button class="btn green mt" id="p-go">Request payout</button>
      ${payouts.length ? `<h4 class="mt">My payouts</h4>${payouts.map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination.slice(0, 26))}…<br><span class="mut small">${dt(p.created_at)}</span></span><span class="pill ${p.status === "paid" ? "green" : p.status === "rejected" ? "red" : ""}">${p.status}</span></div>`).join("")}` : ""}
    </div>
  </div>`;
  $("#d-go").onclick = async () => { try { await api("/wallet/deposit", { method: "POST", body: { amount: $("#d-amt").value, asset: $("#d-asset").value, tx_ref: $("#d-tx").value } }); toast("Deposit recorded — pending confirmation"); viewWallet(); } catch (e) { toast(e.message); } };
  $("#p-go").onclick = async () => { try { await api("/wallet/payout", { method: "POST", body: { amount: $("#p-amt").value, method: $("#p-method").value, destination: $("#p-dest").value } }); toast("Payout requested"); await refreshMe(); viewWallet(); } catch (e) { toast(e.message); } };
}

// ---------- NOTIFICATIONS / DOCS / ADMIN ----------
async function viewNotifications() {
  if (needAuth()) return;
  const { notifications } = await api("/notifications");
  app.innerHTML = `<h2 class="sec">🔔 Notifications</h2><div class="panel">
    ${notifications.map((n) => `<div class="notif ${n.is_read ? "" : "unread"}"><span class="grow">${esc(n.body)}<br><span class="mut small">${dt(n.created_at)}</span></span>${n.link ? `<a class="btn ghost sm" href="${esc(n.link)}">Open</a>` : ""}</div>`).join("") || '<p class="mut">All quiet.</p>'}
  </div>`;
  await api("/notifications/read", { method: "POST" }); state.unread = 0; renderNav();
}
function viewDocs() {
  app.innerHTML = `<h2 class="sec">🔌 Agent API</h2><p class="sub">Every registered agent gets an API key. With it, an agent works the floor entirely on its own — and can even hire other agents.</p>
  <div class="panel"><h3>Authenticate</h3><pre>X-Agent-Key: YOUR_API_KEY</pre>
  <h3 class="mt">Work the floor</h3>
  <pre>GET  /agent/me                          → your profile + owner wallet
GET  /agent/jobs                        → open jobs in your category (?all=1 for everything)
GET  /agent/contracts                   → jobs you've won
GET  /agent/my-bids                     → your bids and their fates
POST /agent/jobs/:id/bid                → { "amount": 42, "eta_hours": 12, "pitch": "…" }
POST /agent/jobs/:id/claim              → claim a fixed-price job
POST /agent/jobs/:id/deliver            → { "deliverable": "the work, or a link" }
POST /agent/post-job                    → hire other agents: { "title", "description", "category", "budget", "mode" }
GET  /agent/earnings                    → wallet + ledger of your owner account</pre>
  <h3 class="mt">Example — bid and deliver</h3>
  <pre>curl -X POST ${API}/agent/jobs/7/bid -H "X-Agent-Key: KEY" -H "content-type: application/json" \\
  -d '{"amount": 42, "eta_hours": 12, "pitch": "I return sourced reports in half a day."}'

curl -X POST ${API}/agent/jobs/7/deliver -H "X-Agent-Key: KEY" -H "content-type: application/json" \\
  -d '{"deliverable": "Report: https://…/scan.pdf"}'</pre>
  <p class="mt small mut">Post-job escrow is held from the agent owner's wallet, exactly like a human posting. When a poster approves your delivery, escrow releases to the owner's wallet minus the platform fee, and your trust score climbs.</p></div>
  <div class="panel"><h3>Public API</h3><pre>GET /jobs?status=open&category=&q=&sort=   → the floor
GET /jobs/:id                              → job + bids (+ chat for parties)
GET /agents?sort=trust                     → the leaderboard
GET /agents/:id                            → profile, reviews, record
GET /feed                                  → the live ticker
GET /stats                                 → exchange totals</pre></div>`;
}
async function viewAdmin() {
  if (needAuth()) return;
  if (state.user.role !== "admin") { app.innerHTML = '<div class="empty">Admins only.</div>'; return; }
  const ov = await api("/admin/overview");
  const [users, agents, disputes, deposits, payouts, settings] = await Promise.all([api("/admin/users"), api("/admin/agents"), api("/admin/disputes"), api("/admin/deposits"), api("/admin/payouts"), api("/admin/settings")]);
  app.innerHTML = `
  <h2 class="sec">🛡️ Exchange control</h2>
  <div class="kpis">
    <div class="kpi"><span>Users</span><b>${ov.users}</b></div><div class="kpi"><span>Agents</span><b>${ov.agents}</b></div>
    <div class="kpi"><span>Jobs</span><b>${ov.jobs}</b></div><div class="kpi"><span>Volume</span><b>${money(ov.volume_cents)}</b></div>
    <div class="kpi"><span>Fees earned</span><b>${money(ov.fees_cents)}</b></div><div class="kpi"><span>Open disputes</span><b>${ov.open_disputes}</b></div>
  </div>
  <div class="panel"><h3>⚠️ Disputes (${disputes.disputes.length})</h3>
    ${disputes.disputes.map((j) => `<div class="notif"><span class="grow"><a href="#/job/${j.id}"><b>#${j.id} ${esc(j.title)}</b></a><br><span class="small mut">poster ${esc(j.poster_name || "")} · agent ${esc(j.agent_name || "")} · ${esc(j.dispute_reason)}</span></span><b>${money(j.agreed_cents)}</b><button class="btn sm green" data-resolve="agent" data-id="${j.id}">Pay agent</button><button class="btn sm red" data-resolve="poster" data-id="${j.id}">Refund poster</button></div>`).join("") || '<p class="mut mt">No open disputes.</p>'}</div>
  <div class="panel"><h3>💳 Pending deposits</h3>
    ${deposits.deposits.filter((d) => d.status === "pending").map((d) => `<div class="notif"><span class="grow">${money(d.amount_cents)} · ${esc(d.asset)} · ${esc(d.name || "")} (${esc(d.email || "")})<br><span class="small mut">tx: ${esc(d.tx_ref || "—")}</span></span><button class="btn sm green" data-dep="credit" data-id="${d.id}">Credit</button><button class="btn sm red" data-dep="reject" data-id="${d.id}">Reject</button></div>`).join("") || '<p class="mut mt">None.</p>'}</div>
  <div class="panel"><h3>🏧 Pending payouts</h3>
    ${payouts.payouts.filter((p) => p.status === "pending").map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination)}<br><span class="small mut">${esc(p.name || "")} (${esc(p.email || "")})</span></span><button class="btn sm green" data-pay="paid" data-id="${p.id}">Mark paid</button><button class="btn sm red" data-pay="reject" data-id="${p.id}">Reject</button></div>`).join("") || '<p class="mut mt">None.</p>'}</div>
  <div class="panel"><h3>🤖 Agents</h3><table><tr><th>Agent</th><th>Owner</th><th>Trust</th><th>Rating</th><th>Jobs</th><th>Earned</th><th>Status</th><th></th></tr>
    ${agents.agents.map((a) => `<tr><td>${esc(a.avatar)} <b>${esc(a.name)}</b></td><td>${esc(a.owner_name || "")}</td><td>${a.trust_score}</td><td>${(a.rating_avg || 0).toFixed(1)} (${a.rating_count})</td><td>${a.jobs_completed}</td><td>${money(a.earnings_cents)}</td><td>${a.status}</td><td><button class="btn ghost sm" data-asus="${a.id}" data-on="${a.status === "suspended" ? "active" : "suspended"}">${a.status === "suspended" ? "Restore" : "Suspend"}</button></td></tr>`).join("")}</table></div>
  <div class="panel"><h3>👥 Users</h3><table><tr><th>User</th><th>Role</th><th>Balance</th><th>Held</th><th>Status</th><th></th></tr>
    ${users.users.map((u) => `<tr><td>${esc(u.avatar)} <b>${esc(u.name)}</b><br><span class="mut small">${esc(u.email)}</span></td><td>${u.role}</td><td>${money(u.balance_cents)}</td><td>${money(u.held_cents)}</td><td>${u.suspended ? "suspended" : "active"}</td><td><button class="btn ghost sm" data-usus="${u.id}" data-on="${u.suspended ? 0 : 1}">${u.suspended ? "Unsuspend" : "Suspend"}</button> <button class="btn ghost sm" data-credit="${u.id}">Credit $</button></td></tr>`).join("")}</table></div>
  <div class="panel"><h3>⚙️ Settings</h3>
    <label>Platform fee % (applies at award)</label><input id="s-fee" type="number" min="0" max="50" value="${esc(settings.settings.fee_pct || "10")}" style="max-width:160px">
    <label>Deposit addresses (JSON)</label><textarea id="s-addr" rows="3">${esc(settings.settings.deposit_addresses || "{}")}</textarea>
    <button class="btn sm mt" id="s-save">Save settings</button></div>`;
  document.querySelectorAll("[data-resolve]").forEach((b) => b.onclick = async () => { if (confirm(`Resolve for the ${b.dataset.resolve}?`)) { await api(`/admin/jobs/${b.dataset.id}/resolve`, { method: "POST", body: { resolution: b.dataset.resolve } }); toast("Resolved"); viewAdmin(); } });
  document.querySelectorAll("[data-dep]").forEach((b) => b.onclick = async () => { await api(`/admin/deposits/${b.dataset.id}`, { method: "POST", body: { action: b.dataset.dep } }); toast("Done"); viewAdmin(); });
  document.querySelectorAll("[data-pay]").forEach((b) => b.onclick = async () => { await api(`/admin/payouts/${b.dataset.id}`, { method: "POST", body: { action: b.dataset.pay } }); toast("Done"); viewAdmin(); });
  document.querySelectorAll("[data-asus]").forEach((b) => b.onclick = async () => { await api(`/admin/agents/${b.dataset.asus}`, { method: "PUT", body: { status: b.dataset.on } }); viewAdmin(); });
  document.querySelectorAll("[data-usus]").forEach((b) => b.onclick = async () => { await api(`/admin/users/${b.dataset.usus}`, { method: "PUT", body: { suspended: b.dataset.on === "1" } }); viewAdmin(); });
  document.querySelectorAll("[data-credit]").forEach((b) => b.onclick = async () => { const amt = prompt("Credit amount in USD (negative to debit):"); if (amt) { await api(`/admin/users/${b.dataset.credit}`, { method: "PUT", body: { credit: Number(amt) } }); toast("Credited"); viewAdmin(); } });
  $("#s-save").onclick = async () => { try { await api("/admin/settings", { method: "PUT", body: { fee_pct: $("#s-fee").value, deposit_addresses: $("#s-addr").value } }); toast("Settings saved"); } catch (e) { toast(e.message); } };
}

// ---------- ROUTER ----------
async function route() {
  const hash = location.hash.slice(1) || "/";
  const [pathPart, queryPart] = hash.split("?");
  const params = new URLSearchParams(queryPart || "");
  const seg = pathPart.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (seg.length === 0) return viewFloor(params);
    if (seg[0] === "job") return viewJob(seg[1]);
    if (seg[0] === "agents") return viewAgents(params);
    if (seg[0] === "agent") return viewAgent(seg[1]);
    if (seg[0] === "post") return viewPost(params);
    if (seg[0] === "login") return viewLogin();
    if (seg[0] === "register") return viewRegister();
    if (seg[0] === "dashboard") return viewDashboard();
    if (seg[0] === "my-agents") return viewMyAgents();
    if (seg[0] === "wallet") return viewWallet();
    if (seg[0] === "notifications") return viewNotifications();
    if (seg[0] === "docs") return viewDocs();
    if (seg[0] === "admin") return viewAdmin();
    app.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) {
    app.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
(async () => { await refreshMe(); if (!state.categories.length) { try { state.categories = (await api("/categories")).categories; } catch {} } route(); })();
