// Agent Exchange — API (Supabase Edge Function, Deno)
// Everything runs on Supabase: Postgres (ex_* tables + plpgsql money
// functions) is the store; this function is the only door. Money moves
// happen exclusively through the transactional RPC functions.

// Shared wallet core: per-user BIP39 wallets (BTC BIP84 + one EVM address),
// seeds AES-256-GCM-encrypted with WALLET_MASTER_KEY before they touch the DB.
// @ts-ignore: plain ESM module shared with the Node wallet service
import { createEncryptedWallet, isValidBtcAddress, isValidEvmAddress } from "../_shared/wallet.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("EXCHANGE_JWT_SECRET") ?? SB_KEY;

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const cents = (n: unknown) => Math.round(Number(n) || 0);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-agent-key",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
}
const err = (msg: string, status = 400) => json({ error: msg }, status);

// ---------- PostgREST ----------
async function pg(path: string, opts: RequestInit & { prefer?: string } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json",
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw Object.assign(new Error(data?.message || `db error ${res.status}`), { status: 502 });
  return data;
}
const one = async (path: string) => {
  const rows = await pg(path, { headers: { accept: "application/vnd.pgrst.object+json" } }).catch(() => null);
  return rows;
};
async function rpc(fn: string, args: Record<string, unknown>) {
  return pg(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}
const q = (s: string) => encodeURIComponent(s);

// ---------- crypto ----------
async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes: Uint8Array) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
async function pbkdf2(password: string, saltHex: string) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password: string) {
  const saltHex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${saltHex}$${await pbkdf2(password, saltHex)}`;
}
async function verifyPassword(password: string, stored: string) {
  const parts = String(stored).split("$");
  if (parts.length !== 3) return false;
  return (await pbkdf2(password, parts[1])) === parts[2];
}
async function signJwt(payload: Record<string, unknown>) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${head}.${body}.${b64url(await hmac(JWT_SECRET, `${head}.${body}`))}`;
}
async function verifyJwt(token: string) {
  try {
    const [head, body, sig] = token.split(".");
    if (b64url(await hmac(JWT_SECRET, `${head}.${body}`)) !== sig) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch { return null; }
}
function randomToken(n = 24) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- domain helpers ----------
type User = { id: number; email: string; name: string; role: string; avatar: string; bio: string; suspended: boolean; created_at: number };
async function authUser(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(h.slice(7));
  if (!payload) return null;
  const user = await one(`ex_users?id=eq.${payload.sub}&select=id,email,name,role,avatar,bio,suspended,created_at`);
  if (!user || user.suspended) return null;
  return user;
}
async function requireUser(req: Request): Promise<User> {
  const u = await authUser(req);
  if (!u) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return u;
}
async function walletOf(userId: number) {
  let w = await one(`ex_wallets?user_id=eq.${userId}&select=*`);
  if (!w) {
    await pg("ex_wallets", { method: "POST", body: JSON.stringify({ user_id: userId }), prefer: "return=representation" });
    w = { user_id: userId, balance_cents: 0, held_cents: 0 };
  }
  return w;
}
// The user's real mainnet chain wallet (public addresses only — the encrypted
// seed never leaves the database through this API). Created lazily on first
// need so every account, old or new, ends up with exactly one wallet.
async function chainWalletOf(userId: number) {
  const existing = await one(`ex_user_wallets?user_id=eq.${userId}&select=btc_address,evm_address,created_at`);
  if (existing) return existing;
  const created = createEncryptedWallet(Deno.env.get("WALLET_MASTER_KEY") || "");
  const t = now();
  const rows = await pg("ex_user_wallets", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: userId, seed_ciphertext: created.seed_ciphertext, seed_nonce: created.seed_nonce, btc_address: created.btc_address, evm_address: created.evm_address, created_at: t, updated_at: t }) }).catch(() => null);
  if (rows?.[0]) return { btc_address: rows[0].btc_address, evm_address: rows[0].evm_address, created_at: rows[0].created_at };
  return await one(`ex_user_wallets?user_id=eq.${userId}&select=btc_address,evm_address,created_at`);
}
function cryptoAddressesOf(cw: any) {
  if (!cw) return {};
  return { BTC: cw.btc_address, ETH: cw.evm_address, USDT: cw.evm_address, USDC: cw.evm_address };
}
async function notify(userId: number, type: string, bodyText: string, link = "") {
  await pg("ex_notifications", { method: "POST", body: JSON.stringify({ user_id: userId, type, body: bodyText, link, created_at: now() }) });
}
async function feed(kind: string, bodyText: string, jobId?: number) {
  await pg("ex_feed", { method: "POST", body: JSON.stringify({ kind, body: bodyText, job_id: jobId ?? null, created_at: now() }) });
}
async function feePct() {
  const row = await one(`ex_settings?key=eq.fee_pct&select=value`);
  return Math.min(50, Math.max(0, Number(row?.value ?? 10)));
}
function publicAgent(a: any) {
  if (!a) return null;
  const { api_key_hash, ...rest } = a;
  const trust = Math.round(((Number(a.rating_avg) || 0) * 20) * 0.6 + Math.min(40, (a.jobs_completed || 0) * 2));
  return { ...rest, has_api: !!api_key_hash, skills: a.skills ? a.skills.split(",").map((t: string) => t.trim()).filter(Boolean) : [], trust_score: Math.min(100, trust) };
}
function seedHash(str: string) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rngFrom(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Generative avatar engine: a seeded emblem generator with millions of unique
// combinations (gradient hues x background pattern x symbol x rotation x
// initials variants). Deterministic: the same seed always yields the same
// avatar, for any agent or human, anywhere. No two seeds need ever collide
// in practice across thousands of registrations.
const AV_SYMBOLS = [
  "M48 10l7.5 30.5L86 48l-30.5 7.5L48 86l-7.5-30.5L10 48l30.5-7.5z",
  "M50 8L24 54h18l-6 34L64 40H45z",
  "M48 12l26 36-26 36L22 48z",
  "M48 10l33 19v38L48 86L15 67V29z",
  "M48 16l30 58H18z",
  "M48 14v50M28 44l20-20 20 20",
  "M30 22h36v14H30zM30 46h36v14H30zM30 70h24v14H30z",
  "M60 12a34 34 0 1 0 24 44A40 40 0 0 1 60 12z",
  "M48 20a28 28 0 1 1 0 56 28 28 0 0 1 0-56zM48 34a14 14 0 1 1 0 28 14 14 0 0 1 0-28z",
  "M24 30l24-14 24 14v36L48 80 24 66z",
  "M48 12c14 16 22 26 22 40a22 22 0 1 1-44 0c0-14 8-24 22-40z",
  "M22 74V40l26-18 26 18v34H58V52H38v22z",
  "M48 18a30 30 0 1 1-21 51l8-8a20 20 0 1 0 13-27z",
  "M18 66l14-30 16 20 16-20 14 30zM18 74h60v8H18z",
  "M34 14h28v20H34zM24 42h48v40H24z",
  "M20 62c9-18 19-18 28 0s19 18 28 0l-6 12c-7-10-15-10-22 0s-15 10-22 0z",
];
function avPattern(kind: number, color: string) {
  switch (kind % 6) {
    case 0: return `<circle cx='48' cy='48' r='31' fill='none' stroke='${color}' stroke-width='2'/><circle cx='48' cy='48' r='20' fill='none' stroke='${color}' stroke-width='2'/>`;
    case 1: { let d = ""; for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) d += `<circle cx='${14 + i * 17}' cy='${14 + j * 17}' r='2.2' fill='${color}'/>`; return d; }
    case 2: return `<path d='M0 30Q24 18 48 30T96 30M0 52Q24 40 48 52T96 52M0 74Q24 62 48 74T96 74' fill='none' stroke='${color}' stroke-width='2'/>`;
    case 3: return `<path d='M14 0v96M38 0v96M62 0v96M86 0v96M0 14h96M0 38h96M0 62h96M0 86h96' stroke='${color}' stroke-width='1.6'/>`;
    case 4: return `<circle cx='15' cy='15' r='12' fill='none' stroke='${color}' stroke-width='2'/><circle cx='85' cy='81' r='16' fill='none' stroke='${color}' stroke-width='2'/><circle cx='83' cy='13' r='7' fill='none' stroke='${color}' stroke-width='2'/>`;
    default: return "";
  }
}
function genAvatar(seedStr: string, name = "") {
  const r = rngFrom(seedHash(String(seedStr)));
  const h1 = Math.floor(r() * 360), h2 = (h1 + 30 + Math.floor(r() * 90)) % 360;
  const pat = Math.floor(r() * 6);
  const sym = Math.floor(r() * AV_SYMBOLS.length);
  const rot = Math.floor(r() * 4) * 90;
  const symFill = r() > 0.22 ? "#ffffff" : "rgba(10,12,24,.88)";
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  const ini = (((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase()).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const center = (ini && r() > 0.62)
    ? `<text x='48' y='63' font-family='Arial,sans-serif' font-size='32' font-weight='700' fill='${symFill}' text-anchor='middle'>${ini}</text>`
    : `<g transform='rotate(${rot} 48 48)'><path d='${AV_SYMBOLS[sym]}' fill='${symFill}'/></g>`;
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h1},85%,56%)'/><stop offset='1' stop-color='hsl(${h2},85%,40%)'/></linearGradient></defs><rect width='96' height='96' rx='22' fill='url(#g)'/><g opacity='.28'>${avPattern(pat, "#ffffff")}</g>${center}</svg>`;
}
const avatarDataUri = (seedStr: string, name = "") => `data:image/svg+xml;utf8,${encodeURIComponent(genAvatar(seedStr, name))}`;
function autoAvatar(name: string) {
  return avatarDataUri("agent:" + String(name || "").toLowerCase(), name);
}
async function createHumanProfile(user: any, work: any) {
  const cat = await one(`ex_categories?slug=eq.${q(String(work?.category || ""))}&select=slug`);
  if (!cat) return null;
  const fields = {
    name: user.name, tagline: String(work.tagline || "Human worker — hire me directly").slice(0, 140),
    description: String(work.description || "").slice(0, 4000), category: cat.slug,
    skills: String(work.skills || "").slice(0, 300), rate_cents: cents(Number(work.rate || 25) * 100),
  };
  const existing = await one(`ex_agents?owner_id=eq.${user.id}&is_human=eq.true&select=id`);
  if (existing) { await pg(`ex_agents?id=eq.${existing.id}`, { method: "PATCH", body: JSON.stringify(fields) }); return existing.id; }
  const rows = await pg("ex_agents", { method: "POST", prefer: "return=representation", body: JSON.stringify({
    owner_id: user.id, ...fields, avatar: avatarDataUri(`human:${user.id}:${user.name}`, user.name),
    api_key_hash: null, webhook_url: "", is_human: true, created_at: now(),
  }) });
  return rows[0].id;
}
async function fireWebhook(url: string, payload: Record<string, unknown>) {
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
  } catch { /* best effort */ }
}

// ---------- router ----------
async function handle(req: Request) {
  const url = new URL(req.url);
  // Path normalization: depending on the gateway hop, the handler may receive
  // /functions/v1/exchange-api/<route>, /exchange-api/<route>, or just /<route>.
  // Strip whichever prefix is present so route matching always sees /<route>.
  let path = url.pathname
    .replace(/^\/functions\/v1\/exchange-api(?=\/|$)/, "")
    .replace(/^\/exchange-api(?=\/|$)/, "") || "/";
  if (!path.startsWith("/")) path = "/" + path;
  const method = req.method;
  const seg = path.split("/").filter(Boolean);
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  // ===== public floor =====
  if (path === "/categories" && method === "GET") {
    const cats = await pg("ex_categories?select=*,open_jobs:ex_jobs(count)&order=name");
    const counts = await pg("ex_jobs?status=eq.open&select=category");
    const byCat: Record<string, number> = {};
    for (const r of counts) byCat[r.category] = (byCat[r.category] || 0) + 1;
    return json({ categories: cats.map((c: any) => ({ slug: c.slug, name: c.name, icon: c.icon, blurb: c.blurb, open_jobs: byCat[c.slug] || 0 })) });
  }
  if (path === "/feed" && method === "GET") {
    const rows = await pg(`ex_feed?select=*&order=created_at.desc&limit=40`);
    return json({ feed: rows });
  }
  if (path.startsWith("/avatar/") && method === "GET" && seg.length === 2) {
    // Public generative avatar for ANY seed (user id, agent name, email...).
    const seed = decodeURIComponent(seg[1]).slice(0, 120);
    return new Response(genAvatar(seed, seed), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", ...CORS } });
  }
  if (path === "/stats" && method === "GET") {
    const [agents, completed, users, vol] = await Promise.all([
      pg("ex_agents?status=eq.active&select=id", { headers: { prefer: "count=exact" } }).catch(() => []),
      pg("ex_jobs?status=eq.completed&select=id,agreed_cents"),
      pg("ex_users?select=id", { headers: { prefer: "count=exact" } }).catch(() => []),
      pg("ex_jobs?status=in.(open,awarded,delivered)&select=id"),
    ]);
    const agentsCount = (await pg("ex_agents?status=eq.active&select=id&limit=1", { headers: { prefer: "count=exact", range: "0-0" } }).catch(() => null));
    return json({
      agents: Array.isArray(agents) ? agents.length : 0,
      jobs_completed: completed.length,
      open_jobs: vol.length,
      users: Array.isArray(users) ? users.length : 0,
      volume_cents: completed.reduce((s: number, j: any) => s + (j.agreed_cents || 0), 0),
    });
  }
  if (path === "/agents" && method === "GET") {
    const sort = url.searchParams.get("sort") || "trust";
    const cat = url.searchParams.get("category") || "";
    const search = (url.searchParams.get("q") || "").trim();
    let filter = "status=eq.active";
    if (cat) filter += `&category=eq.${q(cat)}`;
    if (search) filter += `&or=(name.ilike.*${q(search)}*,tagline.ilike.*${q(search)}*,skills.ilike.*${q(search)}*)`;
    const order = { trust: "jobs_completed.desc,rating_avg.desc", rating: "rating_avg.desc,rating_count.desc", earnings: "earnings_cents.desc", newest: "created_at.desc" }[sort] || "jobs_completed.desc";
    const rows = await pg(`ex_agents?select=*,owner:ex_users!ex_agents_owner_id_fkey(name)&${filter}&order=${order}&limit=60`);
    return json({ agents: rows.map((a: any) => ({ ...publicAgent(a), owner_name: a.owner?.name })) });
  }
  if (path.startsWith("/agents/") && method === "GET" && seg.length === 2) {
    const id = parseInt(seg[1]);
    const a = await one(`ex_agents?id=eq.${id}&select=*,owner:ex_users!ex_agents_owner_id_fkey(name,avatar,created_at)`);
    if (!a || a.status === "suspended") return err("agent not found", 404);
    const reviews = await pg(`ex_reviews?agent_id=eq.${id}&select=*,reviewer:ex_users!ex_reviews_reviewer_user_id_fkey(name,avatar)&order=created_at.desc&limit=30`);
    const recent = await pg(`ex_jobs?awarded_agent_id=eq.${id}&status=eq.completed&select=id,title,agreed_cents,created_at&order=created_at.desc&limit=10`);
    return json({ agent: { ...publicAgent(a), owner_name: a.owner?.name }, reviews, recent_jobs: recent });
  }
  if (path === "/jobs" && method === "GET") {
    const status = url.searchParams.get("status") || "open";
    const cat = url.searchParams.get("category") || "";
    const search = (url.searchParams.get("q") || "").trim();
    const sort = url.searchParams.get("sort") || "newest";
    let filter = `status=eq.${q(status)}`;
    if (cat) filter += `&category=eq.${q(cat)}`;
    if (search) filter += `&or=(title.ilike.*${q(search)}*,description.ilike.*${q(search)}*)`;
    const order = { newest: "created_at.desc", budget_high: "budget_cents.desc", budget_low: "budget_cents.asc" }[sort] || "created_at.desc";
    const rows = await pg(`ex_jobs?select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name,avatar),bids:ex_bids(count)&${filter}&order=${order}&limit=60`);
    const out = [];
    for (const j of rows) {
      const bidRows = await pg(`ex_bids?job_id=eq.${j.id}&select=amount_cents&status=eq.active`);
      out.push({ ...j, poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, bid_count: bidRows.length, lowest_bid_cents: bidRows.length ? Math.min(...bidRows.map((b: any) => b.amount_cents)) : null });
    }
    return json({ jobs: out });
  }
  if (path.startsWith("/jobs/") && method === "GET" && seg.length === 2) {
    const id = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${id}&select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name,avatar),agent:ex_agents!ex_jobs_awarded_agent_id_fkey(name,avatar,is_human)`);
    if (!j) return err("job not found", 404);
    const bids = await pg(`ex_bids?job_id=eq.${id}&select=*,agent:ex_agents!ex_bids_agent_id_fkey(name,avatar,rating_avg,rating_count,jobs_completed,is_human)&order=amount_cents.asc`);
    const viewer = await authUser(req);
    let messages: any[] = [];
    if (viewer && (viewer.id === j.poster_user_id || viewer.role === "admin" || (j.awarded_agent_id && (await one(`ex_agents?id=eq.${j.awarded_agent_id}&owner_id=eq.${viewer.id}&select=id`))))) {
      messages = await pg(`ex_messages?job_id=eq.${id}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar)&order=created_at.asc&limit=500`);
    }
    const review = await one(`ex_reviews?job_id=eq.${id}&select=*`);
    return json({ job: { ...j, poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, awarded_agent_name: j.agent?.name, awarded_agent_avatar: j.agent?.avatar, awarded_agent_is_human: !!j.agent?.is_human }, bids: bids.map((b: any) => ({ ...b, agent_name: b.agent?.name, agent_avatar: b.agent?.avatar, agent_rating: b.agent?.rating_avg, agent_jobs: b.agent?.jobs_completed, agent_is_human: !!b.agent?.is_human })), messages, review });
  }

  // ===== auth =====
  if (path === "/auth/register" && method === "POST") {
    const b = await body();
    const email = String(b.email || "").toLowerCase().trim();
    const name = String(b.name || "").trim();
    const password = String(b.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("valid email required");
    if (name.length < 2) return err("name required");
    if (password.length < 8) return err("password must be at least 8 characters");
    const exists = await one(`ex_users?email=eq.${q(email)}&select=id`);
    if (exists) return err("email already registered", 409);
    const rows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(password), name, avatar: b.avatar || avatarDataUri("user:" + email, name), created_at: now() }) });
    const user = rows[0];
    await walletOf(user.id);
    try { await chainWalletOf(user.id); } catch (e) { console.error("chain wallet creation failed for user", user.id, e); }
    if (b.work) { try { await createHumanProfile(user, b.work); } catch { /* profile can be created later via /my/worker-profile */ } }
    const token = await signJwt({ sub: user.id, exp: now() + 60 * 60 * 24 * 30 });
    return json({ token, user: { id: user.id, email, name, role: user.role, avatar: user.avatar } }, 201);
  }
  if (path === "/auth/login" && method === "POST") {
    const b = await body();
    const email = String(b.email || "").toLowerCase().trim();
    const user = await one(`ex_users?email=eq.${q(email)}&select=*`);
    if (!user || !(await verifyPassword(String(b.password || ""), user.password_hash))) return err("invalid email or password", 401);
    if (user.suspended) return err("account suspended", 403);
    const token = await signJwt({ sub: user.id, exp: now() + 60 * 60 * 24 * 30 });
    return json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, bio: user.bio } });
  }
  if (path === "/auth/me" && method === "GET") {
    const u = await requireUser(req);
    const w = await walletOf(u.id);
    let cw: any = null;
    try { cw = await chainWalletOf(u.id); } catch (e) { console.error("chain wallet load failed for user", u.id, e); }
    const unreadRows = await pg(`ex_notifications?user_id=eq.${u.id}&is_read=eq.false&select=id`);
    return json({ user: u, wallet: w, crypto_wallet: cw ? { btc_address: cw.btc_address, evm_address: cw.evm_address } : null, unread_notifications: unreadRows.length });
  }
  if (path === "/auth/profile" && method === "PUT") {
    const u = await requireUser(req);
    const b = await body();
    await pg(`ex_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ name: String(b.name || u.name).slice(0, 80), avatar: String(b.avatar || u.avatar).slice(0, 2000), bio: String(b.bio || "").slice(0, 500) }) });
    return json({ ok: true });
  }
  if (path === "/auth/password" && method === "PUT") {
    const u = await requireUser(req);
    const b = await body();
    const full = await one(`ex_users?id=eq.${u.id}&select=password_hash`);
    if (!(await verifyPassword(String(b.current_password || ""), full.password_hash))) return err("current password wrong", 401);
    if (String(b.new_password || "").length < 8) return err("new password must be at least 8 characters");
    await pg(`ex_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ password_hash: await hashPassword(b.new_password) }) });
    return json({ ok: true });
  }

  // ===== jobs lifecycle =====
  async function postJob(posterUserId: number, posterAgentId: number | null, b: any) {
    const title = String(b.title || "").trim();
    if (title.length < 4) throw Object.assign(new Error("describe the job in the title"), { status: 400 });
    const cat = await one(`ex_categories?slug=eq.${q(String(b.category || ""))}&select=slug`);
    if (!cat) throw Object.assign(new Error("invalid category"), { status: 400 });
    const budget = cents(Number(b.budget || 0) * 100);
    if (budget < 100) throw Object.assign(new Error("minimum budget is $1"), { status: 400 });
    const mode = b.mode === "fixed" ? "fixed" : "bidding";
    const t = now();
    await rpc("ex_hold_escrow", { p_user: posterUserId, p_amount: budget, p_ref: "job:new", p_note: `Escrow for job: ${title}`, p_now: t });
    try {
      const rows = await pg("ex_jobs", { method: "POST", prefer: "return=representation", body: JSON.stringify({
        poster_user_id: posterUserId, poster_agent_id: posterAgentId, title: title.slice(0, 160),
        description: String(b.description || "").slice(0, 6000), category: cat.slug, budget_cents: budget,
        mode, status: "open", bid_deadline: b.deadline_hours ? t + Math.max(1, parseInt(b.deadline_hours)) * 3600 : null,
        created_at: t, updated_at: t,
      }) });
      const job = rows[0];
      await pg(`ex_ledger?user_id=eq.${posterUserId}&type=eq.escrow_hold&ref=eq.job:new&order=created_at.desc&limit=1`, { method: "PATCH", body: JSON.stringify({ ref: `job:${job.id}` }) });
      await feed("job_posted", `📋 New job: "${job.title}" — budget $${(budget / 100).toFixed(2)} (${mode})`, job.id);
      return job;
    } catch (e) {
      await rpc("ex_refund_escrow", { p_poster: posterUserId, p_price: budget, p_ref: "job:failed", p_note: "Escrow returned — job creation failed", p_now: now() });
      throw e;
    }
  }
  if (path === "/jobs" && method === "POST") {
    const u = await requireUser(req);
    const b = await body();
    let posterAgentId: number | null = null;
    if (b.poster_agent_id) {
      const own = await one(`ex_agents?id=eq.${parseInt(b.poster_agent_id)}&owner_id=eq.${u.id}&select=id`);
      if (own) posterAgentId = own.id;
    }
    const job = await postJob(u.id, posterAgentId, b);
    return json({ id: job.id, status: "open", budget_cents: job.budget_cents }, 201);
  }
  async function placeBid(agent: any, job: any, b: any) {
    if (job.status !== "open") throw Object.assign(new Error("job is not open for bids"), { status: 400 });
    if (job.mode !== "bidding") throw Object.assign(new Error("this is a fixed-price job — claim it instead"), { status: 400 });
    if (job.poster_user_id === agent.owner_id) throw Object.assign(new Error("you cannot bid on your own job"), { status: 400 });
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 50) throw Object.assign(new Error("minimum bid is $0.50"), { status: 400 });
    const existing = await one(`ex_bids?job_id=eq.${job.id}&agent_id=eq.${agent.id}&select=id`);
    const rows = await pg("ex_bids?on_conflict=job_id,agent_id", { method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: JSON.stringify({
      job_id: job.id, agent_id: agent.id, bidder_user_id: agent.owner_id, amount_cents: amount,
      eta_hours: Math.max(1, parseInt(b.eta_hours || 24)), pitch: String(b.pitch || "").slice(0, 1000), status: "active", created_at: now(),
    }) });
    if (!existing) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ bids_placed: (agent.bids_placed || 0) + 1 }) });
    await pg(`ex_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ updated_at: now() }) });
    await notify(job.poster_user_id, "bid", `New bid on "${job.title}": ${agent.name} bid $${(amount / 100).toFixed(2)}`, `#/job/${job.id}`);
    if (job.poster_agent_id) { const pa = await one(`ex_agents?id=eq.${job.poster_agent_id}&select=webhook_url`); if (pa?.webhook_url) await fireWebhook(pa.webhook_url, { event: "bid_received", job_id: job.id, title: job.title, amount_cents: amount, bidder: agent.name }); }
    await feed("bid_placed", `💰 ${agent.name} bid $${(amount / 100).toFixed(2)} on "${job.title}"`, job.id);
    return rows[0];
  }
  if (path.match(/^\/jobs\/\d+\/bid$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const b = await body();
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const agent = await one(`ex_agents?id=eq.${parseInt(b.agent_id)}&owner_id=eq.${u.id}&status=eq.active&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    const bid = await placeBid(agent, job, b);
    return json({ id: bid.id, amount_cents: bid.amount_cents }, 201);
  }
  async function awardJob(job: any, bid: any) {
    const fee = Math.round((bid.amount_cents * (await feePct())) / 100);
    const t = now();
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.open`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({
      status: "awarded", awarded_bid_id: bid.id, awarded_agent_id: bid.agent_id, agreed_cents: bid.amount_cents,
      fee_cents: fee, work_deadline: t + (bid.eta_hours || 24) * 3600, updated_at: t,
    }) });
    if (!updated.length) throw Object.assign(new Error("job was already awarded"), { status: 409 });
    if (bid.amount_cents < job.budget_cents) {
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${job.id}`, p_note: "Escrow reset at award — re-holding agreed price", p_now: t });
      await rpc("ex_hold_escrow", { p_user: job.poster_user_id, p_amount: bid.amount_cents, p_ref: `job:${job.id}`, p_note: `Escrow held at agreed price for job #${job.id}`, p_now: t });
    }
    await pg(`ex_bids?id=eq.${bid.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });
    await pg(`ex_bids?job_id=eq.${job.id}&id=neq.${bid.id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
    const agent = await one(`ex_agents?id=eq.${bid.agent_id}&select=*`);
    await notify(bid.bidder_user_id, "award", `🏆 Your agent ${agent?.name} won "${job.title}" — $${(bid.amount_cents / 100).toFixed(2)} is in escrow. Deliver by the deadline.`, `#/job/${job.id}`);
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_awarded", job_id: job.id, title: job.title, agreed_cents: bid.amount_cents, deliver_via: `/agent/jobs/${job.id}/deliver` });
    await feed("awarded", `🏆 "${job.title}" awarded to ${agent?.name} for $${(bid.amount_cents / 100).toFixed(2)}`, job.id);
    return updated[0];
  }
  if (path.match(/^\/jobs\/\d+\/award$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const b = await body();
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job || job.poster_user_id !== u.id) return err("job not found", 404);
    if (job.status !== "open") return err("job is not open");
    const bid = await one(`ex_bids?id=eq.${parseInt(b.bid_id)}&job_id=eq.${jobId}&status=eq.active&select=*`);
    if (!bid) return err("bid not found", 404);
    const updated = await awardJob(job, bid);
    return json({ job: updated });
  }
  if (path.match(/^\/jobs\/\d+\/claim$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const b = await body();
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    if (job.mode !== "fixed") return err("this job takes bids — place a bid instead");
    const agent = await one(`ex_agents?id=eq.${parseInt(b.agent_id)}&owner_id=eq.${u.id}&status=eq.active&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    const bidRows = await pg("ex_bids", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, bidder_user_id: u.id, amount_cents: job.budget_cents, eta_hours: parseInt(b.eta_hours || 24), pitch: "Claimed at fixed price", status: "active", created_at: now() }) });
    const updated = await awardJob(job, bidRows[0]);
    return json({ job: updated });
  }
  async function deliverJob(job: any, deliverable: string) {
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "delivered", deliverable: deliverable.slice(0, 8000), updated_at: now() }) });
    if (!updated.length) throw Object.assign(new Error(`cannot deliver a job in status ${job.status}`), { status: 400 });
    await notify(job.poster_user_id, "delivery", `📦 "${job.title}" has been delivered — review and release payment`, `#/job/${job.id}`);
    await feed("delivered", `📦 "${job.title}" delivered`, job.id);
    return updated[0];
  }
  if (path.match(/^\/jobs\/\d+\/action$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const b = await body();
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const isPoster = job.poster_user_id === u.id;
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    const isWorker = awardedOwner === u.id;
    const action = String(b.action || "");
    const t = now();
    if (action === "deliver" && isWorker && job.status === "awarded") {
      const deliverable = String(b.deliverable || "").trim();
      if (deliverable.length < 2) return err("include the delivered work or a link to it");
      return json({ job: await deliverJob(job, deliverable) });
    }
    if (action === "complete" && isPoster && job.status === "delivered") {
      const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.delivered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed", updated_at: t }) });
      if (!updated.length) return err("job already settled");
      await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${job.id}`, p_now: t });
      const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
      if (agent) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (job.agreed_cents - job.fee_cents) }) });
      await notify(awardedOwner, "payment", `✅ "${job.title}" completed — $${((job.agreed_cents - job.fee_cents) / 100).toFixed(2)} landed in your wallet`, `#/job/${job.id}`);
      if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_completed", job_id: job.id, title: job.title, paid_cents: job.agreed_cents - job.fee_cents });
      await feed("completed", `✅ "${job.title}" completed — $${(job.agreed_cents / 100).toFixed(2)} paid out`, job.id);
      return json({ job: updated[0] });
    }
    if (action === "cancel" && isPoster && job.status === "open") {
      await pg(`ex_jobs?id=eq.${job.id}&status=eq.open`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: t }) });
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${job.id}`, p_note: "Escrow refunded — job cancelled", p_now: t });
      await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
      return json({ ok: true });
    }
    if (action === "dispute" && isPoster && ["awarded", "delivered"].includes(job.status)) {
      await pg(`ex_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ status: "disputed", dispute_reason: String(b.reason || "").slice(0, 1000), updated_at: t }) });
      await notify(awardedOwner, "dispute", `⚠️ "${job.title}" is under dispute — an admin will review`, `#/job/${job.id}`);
      { const dAgent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=webhook_url`); if (dAgent?.webhook_url) await fireWebhook(dAgent.webhook_url, { event: "job_disputed", job_id: job.id, title: job.title }); }
      const admins = await pg("ex_users?role=eq.admin&select=id");
      for (const a of admins) await notify(a.id, "dispute", `Dispute opened on job #${job.id}`, "#/admin");
      return json({ ok: true });
    }
    return err(`action '${action}' not allowed in status '${job.status}' for your role`);
  }
  if (path.match(/^\/jobs\/\d+\/messages$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (job.poster_user_id !== u.id && awardedOwner !== u.id && u.role !== "admin") return err("not a party to this job", 403);
    const b = await body();
    const text = String(b.body || "").trim();
    if (!text) return err("message is empty");
    const rows = await pg("ex_messages", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: jobId, sender_user_id: u.id, body: text.slice(0, 2000), created_at: now() }) });
    const other = job.poster_user_id === u.id ? awardedOwner : job.poster_user_id;
    if (other) await notify(other, "message", `New message on "${job.title}"`, `#/job/${jobId}`);
    return json({ id: rows[0].id }, 201);
  }
  if (path.match(/^\/jobs\/\d+\/review$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job || job.poster_user_id !== u.id) return err("only the job poster can review", 403);
    if (job.status !== "completed") return err("reviews open after completion");
    const b = await body();
    const stars = Math.min(5, Math.max(1, parseInt(b.stars) || 0));
    if (!stars) return err("stars required");
    const existing = await one(`ex_reviews?job_id=eq.${jobId}&select=id`);
    if (existing) return err("already reviewed", 409);
    await pg("ex_reviews", { method: "POST", body: JSON.stringify({ job_id: jobId, agent_id: job.awarded_agent_id, reviewer_user_id: u.id, stars, body: String(b.body || "").slice(0, 1000), created_at: now() }) });
    const all = await pg(`ex_reviews?agent_id=eq.${job.awarded_agent_id}&select=stars`);
    const avg = Math.round((all.reduce((s: number, r: any) => s + r.stars, 0) / all.length) * 10) / 10;
    await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify({ rating_avg: avg, rating_count: all.length }) });
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id`);
    await notify(agent.owner_id, "review", `⭐ ${agent.name} got a ${stars}-star review on "${job.title}"`, `#/agent/${job.awarded_agent_id}`);
    await feed("review", `⭐ ${agent.name} earned ${stars} stars on "${job.title}"`, job.id);
    return json({ ok: true, rating_avg: avg, rating_count: all.length }, 201);
  }

  // ===== wallet =====
  if (path === "/wallet" && method === "GET") {
    const u = await requireUser(req);
    const w = await walletOf(u.id);
    const ledger = await pg(`ex_ledger?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=100`);
    let cw: any = null;
    try { cw = await chainWalletOf(u.id); } catch (e) { console.error("chain wallet load failed for user", u.id, e); }
    const addresses = cryptoAddressesOf(cw);
    const chainDeposits = await pg(`ex_chain_deposits?user_id=eq.${u.id}&select=asset,address,tx_hash,amount_cents,confirmations,status,created_at&order=created_at.desc&limit=50`).catch(() => []);
    return json({ wallet: w, ledger, deposit_addresses: addresses, crypto_addresses: addresses, crypto_wallet: cw ? { btc_address: cw.btc_address, evm_address: cw.evm_address } : null, chain_deposits: chainDeposits });
  }
  if (path === "/wallet/deposit" && method === "POST") {
    const u = await requireUser(req);
    const b = await body();
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 100) return err("minimum deposit is $1");
    const rows = await pg("ex_deposits", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: u.id, amount_cents: amount, method: b.method === "card" ? "card" : "crypto", asset: String(b.asset || "USDT").slice(0, 10), tx_ref: String(b.tx_ref || "").slice(0, 120), created_at: now() }) });
    return json({ id: rows[0].id, status: "pending", note: "Deposit recorded. Your balance is credited once the transfer is confirmed." }, 201);
  }
  if (path === "/wallet/payout" && method === "POST") {
    const u = await requireUser(req);
    const b = await body();
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 500) return err("minimum payout is $5");
    const method = b.method === "bank" ? "bank" : "crypto";
    const asset = ["BTC", "ETH", "USDT", "USDC"].includes(String(b.asset || "").toUpperCase()) ? String(b.asset).toUpperCase() : "USDT";
    const destination = String(b.destination || "").slice(0, 200).trim();
    if (method === "crypto") {
      const valid = asset === "BTC" ? isValidBtcAddress(destination) : isValidEvmAddress(destination);
      if (!valid) return err(`destination is not a valid ${asset} address`);
    } else if (!destination) return err("destination required");
    await rpc("ex_move_balance", { p_user: u.id, p_amount: -amount, p_type: "payout", p_ref: "", p_note: `Payout request to ${destination.slice(0, 60)}`, p_now: now() });
    const rows = await pg("ex_payouts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: u.id, amount_cents: amount, method, asset, destination, created_at: now() }) });
    return json({ id: rows[0].id, status: "pending" }, 201);
  }
  if (path === "/wallet/payouts" && method === "GET") {
    const u = await requireUser(req);
    const payouts = await pg(`ex_payouts?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=50`);
    const deposits = await pg(`ex_deposits?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=50`);
    return json({ payouts, deposits });
  }

  // ===== my agents =====
  if (path === "/my/worker-profile" && method === "POST") {
    const u = await requireUser(req);
    const id = await createHumanProfile(u, await body());
    if (!id) return err("invalid category");
    return json({ id, is_human: true });
  }
  if (path === "/my/worker-profile" && method === "GET") {
    const u = await requireUser(req);
    const row = await one(`ex_agents?owner_id=eq.${u.id}&is_human=eq.true&select=*`);
    return json({ profile: row ? publicAgent(row) : null });
  }
  if (path === "/my/agents" && method === "GET") {
    const u = await requireUser(req);
    const rows = await pg(`ex_agents?owner_id=eq.${u.id}&select=*&order=created_at.desc`);
    return json({ agents: rows.map((a: any) => ({ ...publicAgent(a), webhook_url: a.webhook_url || "" })) });
  }
  if (path === "/my/agents" && method === "POST") {
    const u = await requireUser(req);
    const b = await body();
    const name = String(b.name || "").trim();
    if (name.length < 2) return err("agent name required");
    const cat = await one(`ex_categories?slug=eq.${q(String(b.category || ""))}&select=slug`);
    if (!cat) return err("invalid category");
    const apiKey = randomToken(20);
    const rows = await pg("ex_agents", { method: "POST", prefer: "return=representation", body: JSON.stringify({
      owner_id: u.id, name: name.slice(0, 80), tagline: String(b.tagline || "").slice(0, 140), description: String(b.description || "").slice(0, 4000),
      category: cat.slug, avatar: b.avatar ? String(b.avatar).slice(0, 2000) : autoAvatar(name), skills: String(b.skills || "").slice(0, 300),
      rate_cents: cents(Number(b.rate || 0) * 100), api_key_hash: await sha256hex(apiKey), webhook_url: String(b.webhook_url || "").slice(0, 300), created_at: now(),
    }) });
    return json({ id: rows[0].id, api_key: apiKey, note: "Save this API key — shown once. Your agent uses it on /agent/* to find jobs, bid and deliver on its own." }, 201);
  }
  if (path.match(/^\/my\/agents\/\d+$/) && (method === "PUT" || method === "DELETE")) {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    if (method === "DELETE") {
      await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) });
      return json({ ok: true });
    }
    const b = await body();
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({
      name: String(b.name || a.name).slice(0, 80), tagline: String(b.tagline ?? a.tagline).slice(0, 140), description: String(b.description ?? a.description).slice(0, 4000),
      category: String(b.category || a.category), avatar: String(b.avatar || a.avatar).slice(0, 2000), skills: String(b.skills ?? a.skills).slice(0, 300),
      rate_cents: b.rate !== undefined ? cents(Number(b.rate) * 100) : a.rate_cents,
      status: ["active", "paused"].includes(b.status) ? b.status : a.status, webhook_url: String(b.webhook_url ?? a.webhook_url ?? "").slice(0, 300),
    }) });
    return json({ ok: true });
  }
  if (path.match(/^\/my\/agents\/\d+\/rotate-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id`);
    if (!a) return err("agent not found", 404);
    const apiKey = randomToken(20);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(apiKey) }) });
    return json({ api_key: apiKey });
  }
  if (path === "/my/jobs" && method === "GET") {
    const u = await requireUser(req);
    const posted = await pg(`ex_jobs?poster_user_id=eq.${u.id}&select=*&order=created_at.desc&limit=100`);
    const myAgents = await pg(`ex_agents?owner_id=eq.${u.id}&select=id`);
    let working: any[] = [];
    if (myAgents.length) {
      const ids = myAgents.map((a: any) => a.id).join(",");
      working = await pg(`ex_jobs?awarded_agent_id=in.(${ids})&select=*&order=created_at.desc&limit=100`);
    }
    const myBids = await pg(`ex_bids?bidder_user_id=eq.${u.id}&select=*,job:ex_jobs!ex_bids_job_id_fkey(title,status,budget_cents)&order=created_at.desc&limit=100`);
    return json({ posted, working, bids: myBids.map((b: any) => ({ ...b, job_title: b.job?.title, job_status: b.job?.status })) });
  }
  if (path === "/notifications" && method === "GET") {
    const u = await requireUser(req);
    const rows = await pg(`ex_notifications?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=50`);
    return json({ notifications: rows });
  }
  if (path === "/notifications/read" && method === "POST") {
    const u = await requireUser(req);
    await pg(`ex_notifications?user_id=eq.${u.id}&is_read=eq.false`, { method: "PATCH", body: JSON.stringify({ is_read: true }) });
    return json({ ok: true });
  }

  // ===== agent API (X-Agent-Key) — agents work fully on their own =====
  if (path.startsWith("/agent/")) {
    const key = req.headers.get("x-agent-key") || (req.headers.get("authorization") || "").replace(/^AgentKey\s+/i, "");
    if (!key) return err("missing X-Agent-Key", 401);
    const agent = await one(`ex_agents?api_key_hash=eq.${await sha256hex(key)}&select=*`);
    if (!agent) return err("invalid API key", 401);
    if (agent.status !== "active") return err("agent is not active", 403);
    if (path === "/agent/me" && method === "GET") {
      const w = await walletOf(agent.owner_id);
      return json({ agent: publicAgent(agent), owner_wallet: w });
    }
    if (path === "/agent/jobs" && method === "GET") {
      // open jobs this agent can take: its category first, but the whole floor is visible
      const cat = url.searchParams.get("category") || agent.category;
      const all = url.searchParams.get("all") === "1";
      const filter = all ? "" : `&category=eq.${q(cat)}`;
      const rows = await pg(`ex_jobs?status=eq.open&poster_user_id=neq.${agent.owner_id}&select=*${filter}&order=created_at.desc&limit=60`);
      const out = [];
      for (const j of rows) {
        const bids = await pg(`ex_bids?job_id=eq.${j.id}&status=eq.active&select=amount_cents`);
        out.push({ ...j, bid_count: bids.length, lowest_bid_cents: bids.length ? Math.min(...bids.map((x: any) => x.amount_cents)) : null });
      }
      return json({ jobs: out });
    }
    if (path === "/agent/contracts" && method === "GET") {
      const rows = await pg(`ex_jobs?awarded_agent_id=eq.${agent.id}&status=in.(awarded,delivered,disputed)&select=*&order=updated_at.desc`);
      return json({ contracts: rows });
    }
    if (path === "/agent/my-bids" && method === "GET") {
      const rows = await pg(`ex_bids?agent_id=eq.${agent.id}&select=*,job:ex_jobs!ex_bids_job_id_fkey(title,status,budget_cents)&order=created_at.desc&limit=100`);
      return json({ bids: rows.map((b: any) => ({ ...b, job_title: b.job?.title, job_status: b.job?.status })) });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/bid$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const bid = await placeBid(agent, job, await body());
      return json({ id: bid.id, amount_cents: bid.amount_cents }, 201);
    }
    if (path.match(/^\/agent\/jobs\/\d+\/claim$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      if (job.mode !== "fixed") return err("this job takes bids");
      if (job.poster_user_id === agent.owner_id) return err("you cannot claim your own job");
      const bidRows = await pg("ex_bids", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, bidder_user_id: agent.owner_id, amount_cents: job.budget_cents, eta_hours: 24, pitch: "Claimed at fixed price (API)", status: "active", created_at: now() }) });
      await awardJob(job, bidRows[0]);
      return json({ ok: true, job_id: job.id, agreed_cents: job.budget_cents });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/deliver$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&awarded_agent_id=eq.${agent.id}&select=*`);
      if (!job) return err("contract not found for this agent", 404);
      const b = await body();
      if (!b.deliverable) return err("deliverable required");
      const updated = await deliverJob(job, String(b.deliverable));
      return json({ ok: true, job: updated });
    }
    if (path === "/agent/post-job" && method === "POST") {
      // agents hire other agents: funds are held from the owner's wallet
      const job = await postJob(agent.owner_id, agent.id, await body());
      return json({ id: job.id, status: "open", budget_cents: job.budget_cents }, 201);
    }
    if (path === "/agent/earnings" && method === "GET") {
      const w = await walletOf(agent.owner_id);
      const ledger = await pg(`ex_ledger?user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=50`);
      return json({ agent: publicAgent(agent), wallet: w, ledger });
    }
    return err("unknown agent route", 404);
  }

  // ===== admin =====
  if (path.startsWith("/admin/")) {
    const u = await requireUser(req);
    if (u.role !== "admin") return err("admin only", 403);
    if (path === "/admin/overview" && method === "GET") {
      const [users, agents, jobs, disputes, pdep, ppay] = await Promise.all([
        pg("ex_users?select=id"), pg("ex_agents?select=id"),
        pg("ex_jobs?select=status,agreed_cents,fee_cents"), pg("ex_jobs?status=eq.disputed&select=id"),
        pg("ex_deposits?status=eq.pending&select=id"), pg("ex_payouts?status=eq.pending&select=id"),
      ]);
      const completed = jobs.filter((j: any) => j.status === "completed");
      return json({
        users: users.length, agents: agents.length, jobs: jobs.length,
        volume_cents: completed.reduce((s: number, j: any) => s + j.agreed_cents, 0),
        fees_cents: completed.reduce((s: number, j: any) => s + j.fee_cents, 0),
        open_disputes: disputes.length, pending_deposits: pdep.length, pending_payouts: ppay.length,
      });
    }
    if (path === "/admin/users" && method === "GET") {
      const rows = await pg("ex_users?select=*,wallet:ex_wallets(balance_cents,held_cents)&order=created_at.desc&limit=200");
      return json({ users: rows.map(({ password_hash, ...r }: any) => ({ ...r, balance_cents: r.wallet?.balance_cents ?? 0, held_cents: r.wallet?.held_cents ?? 0 })) });
    }
    if (path.match(/^\/admin\/users\/\d+$/) && method === "PUT") {
      const id = parseInt(seg[2]);
      const b = await body();
      const patch: Record<string, unknown> = {};
      if (b.role && ["owner", "admin"].includes(b.role)) patch.role = b.role;
      if (b.suspended !== undefined) patch.suspended = !!b.suspended;
      if (Object.keys(patch).length) await pg(`ex_users?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (b.credit !== undefined) await rpc("ex_move_balance", { p_user: id, p_amount: cents(Number(b.credit) * 100), p_type: "admin_credit", p_ref: "", p_note: "Admin credit", p_now: now() });
      return json({ ok: true });
    }
    if (path === "/admin/agents" && method === "GET") {
      const rows = await pg("ex_agents?select=*,owner:ex_users!ex_agents_owner_id_fkey(name,email)&order=created_at.desc&limit=200");
      return json({ agents: rows.map((a: any) => ({ ...publicAgent(a), owner_name: a.owner?.name, owner_email: a.owner?.email })) });
    }
    if (path.match(/^\/admin\/agents\/\d+$/) && method === "PUT") {
      const id = parseInt(seg[2]);
      const b = await body();
      if (b.status && ["active", "paused", "suspended"].includes(b.status)) await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: b.status }) });
      return json({ ok: true });
    }
    if (path === "/admin/disputes" && method === "GET") {
      const rows = await pg("ex_jobs?status=eq.disputed&select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name),agent:ex_agents!ex_jobs_awarded_agent_id_fkey(name,owner_id)&order=created_at.desc");
      return json({ disputes: rows.map((j: any) => ({ ...j, poster_name: j.poster?.name, agent_name: j.agent?.name })) });
    }
    if (path.match(/^\/admin\/jobs\/\d+\/resolve$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const job = await one(`ex_jobs?id=eq.${id}&status=eq.disputed&select=*`);
      if (!job) return err("disputed job not found", 404);
      const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id,jobs_completed,earnings_cents`);
      const t = now();
      if (b.resolution === "poster") {
        await pg(`ex_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "refunded", updated_at: t }) });
        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents, p_ref: `job:${id}`, p_note: "Dispute resolved for poster — escrow refunded", p_now: t });
        await notify(job.poster_user_id, "dispute", `Dispute on "${job.title}" resolved in your favor — escrow refunded`, `#/job/${id}`);
        if (agent) await notify(agent.owner_id, "dispute", `Dispute on "${job.title}" resolved for the poster`, `#/job/${id}`);
      } else if (b.resolution === "agent") {
        await pg(`ex_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "completed", updated_at: t }) });
        await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: agent.owner_id, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${id}`, p_now: t });
        await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (job.agreed_cents - job.fee_cents) }) });
        await notify(agent.owner_id, "dispute", `Dispute on "${job.title}" resolved in your favor — payment released`, `#/job/${id}`);
        await notify(job.poster_user_id, "dispute", `Dispute on "${job.title}" resolved for the agent`, `#/job/${id}`);
      } else return err("resolution must be 'poster' or 'agent'");
      return json({ ok: true });
    }
    if (path === "/admin/deposits" && method === "GET") {
      const rows = await pg("ex_deposits?select=*,user:ex_users!ex_deposits_user_id_fkey(name,email)&order=created_at.desc&limit=100");
      return json({ deposits: rows.map((d: any) => ({ ...d, name: d.user?.name, email: d.user?.email })) });
    }
    if (path.match(/^\/admin\/deposits\/\d+$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const d = await one(`ex_deposits?id=eq.${id}&status=eq.pending&select=*`);
      if (!d) return err("pending deposit not found", 404);
      if (b.action === "credit") {
        await rpc("ex_move_balance", { p_user: d.user_id, p_amount: d.amount_cents, p_type: "deposit", p_ref: `deposit:${id}`, p_note: `${d.asset} deposit confirmed`, p_now: now() });
        await pg(`ex_deposits?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "credited", resolved_at: now() }) });
        await notify(d.user_id, "wallet", `Deposit of $${(d.amount_cents / 100).toFixed(2)} credited`, "#/wallet");
      } else if (b.action === "reject") {
        await pg(`ex_deposits?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected", resolved_at: now() }) });
        await notify(d.user_id, "wallet", `Deposit #${id} could not be verified`, "#/wallet");
      } else return err("action must be credit or reject");
      return json({ ok: true });
    }
    if (path === "/admin/payouts" && method === "GET") {
      const rows = await pg("ex_payouts?select=*,user:ex_users!ex_payouts_user_id_fkey(name,email)&order=created_at.desc&limit=100");
      return json({ payouts: rows.map((p: any) => ({ ...p, name: p.user?.name, email: p.user?.email })) });
    }
    if (path.match(/^\/admin\/payouts\/\d+$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const p = await one(`ex_payouts?id=eq.${id}&status=eq.pending&select=*`);
      if (!p) return err("pending payout not found", 404);
      if (b.action === "paid") {
        if (p.method === "crypto") {
          // Real on-chain execution: the wallet service picks the payout up,
          // broadcasts from the treasury wallet, and marks it paid with the
          // transaction hash once the send confirms. Never faked here.
          await pg(`ex_payouts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ execution_status: "approved", failure_reason: "" }) });
          await notify(p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} approved — being sent on-chain`, "#/wallet");
          return json({ ok: true, execution: "approved" });
        }
        await pg(`ex_payouts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "paid", resolved_at: now() }) });
        await notify(p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} sent`, "#/wallet");
      } else if (b.action === "reject") {
        await rpc("ex_move_balance", { p_user: p.user_id, p_amount: p.amount_cents, p_type: "refund", p_ref: `payout:${id}`, p_note: "Payout rejected — balance restored", p_now: now() });
        await pg(`ex_payouts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected", resolved_at: now() }) });
        await notify(p.user_id, "wallet", `Payout #${id} rejected — balance restored`, "#/wallet");
      } else return err("action must be paid or reject");
      return json({ ok: true });
    }
    if (path === "/admin/settings" && method === "GET") {
      const rows = await pg("ex_settings?select=*");
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return json({ settings: out });
    }
    if (path === "/admin/settings" && method === "PUT") {
      const b = await body();
      for (const [k, v] of Object.entries(b)) {
        if (["fee_pct"].includes(k)) {
          await pg("ex_settings?on_conflict=key", { method: "POST", prefer: "resolution=merge-duplicates", body: JSON.stringify({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) }) });
        }
      }
      return json({ ok: true });
    }
    return err("unknown admin route", 404);
  }

  return err("not found", 404);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    return await handle(req);
  } catch (e: any) {
    return err(e.message || "server error", e.status || 500);
  }
});
