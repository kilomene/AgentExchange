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
const JWT_SECRET = Deno.env.get("EXCHANGE_JWT_SECRET");
if (!JWT_SECRET) throw new Error("EXCHANGE_JWT_SECRET is not set - refusing to start (no fallback to the service key)");

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const cents = (n: unknown) => Math.round(Number(n) || 0);
const CHAT_HIDDEN = "[hidden]";
// JOB CHAT SAFETY (owner's order, 2026-10-26): the job chat is fully
// secured - links, email addresses, phone numbers, social-media handles
// or profiles and foul language are automatically hidden. Applied at
// write time (nothing unsafe is ever stored) and again at read time
// (older messages are covered too).
function sanitizeChat(input: unknown): string {
  const s = String(input ?? "");
  // Owner's stricter rule (2026-10-26, after the plain-word fix): ANY
  // mention of a social-media platform hides the WHOLE message - the
  // text does not stay partly visible ("My Instagram is [hidden]" still
  // showed a social mention; the whole text must be just "[hidden]").
  if (/\b(?:instagram|insta|ig|tiktok|tik\s?tok|snapchat|snap|facebook|fb|twitter|telegram|whatsapp|discord|youtube|linkedin|reddit|pinterest|threads|messenger|wechat|viber|skype|twitch|onlyfans)\b/i.test(s)
    || /\b(?:my|on|via|follow|find|add|message|dm|contact)\s+x\b|\bx\s*(?:is|:|handle|username|profile)|\bx\.com\b/i.test(s)) return CHAT_HIDDEN;
  return maskText(s);
}
// Partial screening for every OTHER public text surface (bid pitches, job
// titles/descriptions, agent profiles, bios, reviews, briefs, dispute
// reasons): links, domains, emails, phones, @handles and profanity are
// masked to [hidden] - but there is NO whole-message social rule here.
function sanitizeText(input: unknown): string {
  return maskText(String(input ?? ""));
}
function maskText(s0: string): string {
  let s = s0;
  s = s.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi, CHAT_HIDDEN);
  s = s.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, CHAT_HIDDEN);
  s = s.replace(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|net|org|io|co|app|dev|me|info|xyz|site|online|store|gg|tv|ai|tech|pro|biz|us|uk|ng|ca|de|fr|au|jp|br|mx|es|it|nl|za|ke|gh|ph|sg|ae)(?:\/\S*)?/gi, CHAT_HIDDEN);
  s = s.replace(/@[a-z0-9_.]{2,}/gi, CHAT_HIDDEN);
  s = s.replace(/@ ([a-z0-9_.]{2,})/gi, (m: string, tok: string) => /[0-9._]/.test(tok) ? CHAT_HIDDEN : m);
  // Social-share masking: a platform name used to hand over a handle is
  // masked WHATEVER the handle looks like - a plain word ("zenas") is a
  // handle too. (The owner's live test "My Instagram is zenas" slipped
  // past the first version of this rule, which only masked tokens that
  // contained @, a digit, a dot or "_", 2026-10-26.) Only clear
  // status/function words survive, so ordinary talk such as
  // "my whatsapp is broken" or "instagram is down today" stays readable.
  const CHAT_SAFE = new Set(["the", "a", "an", "this", "that", "it", "its", "is", "was", "has", "had", "been", "being", "not", "no", "yes", "now", "today", "yesterday", "tomorrow", "tonight", "later", "again", "very", "really", "just", "also", "too", "got", "here", "there", "well", "much", "soon", "broken", "down", "up", "working", "slow", "fast", "offline", "online", "unavailable", "available", "deleted", "suspended", "banned", "deactivated", "hacked", "closed", "open", "live", "new", "old", "good", "bad", "great", "best", "back", "free", "full", "private", "public", "verified", "official", "real", "fake", "app", "group", "groups", "channel", "account", "profile", "page", "post", "posts", "story", "stories", "login", "daily", "ready", "done", "active", "mine", "ours", "yours", "theirs"]);
  const platHide = (m: string, pre: string, tok: string) => CHAT_SAFE.has(tok.toLowerCase()) ? m : pre + CHAT_HIDDEN;
  const PLAT = "(?:instagram|insta|tiktok|snapchat|snap|telegram|whatsapp|facebook|discord|twitter|ig|fb)";
  s = s.replace(new RegExp("\\b(" + PLAT + "\\s*(?:is\\s+|:|=|\\u2014|-)\\s*)([a-z0-9@][a-z0-9._-]*)", "gi"),
    (m: string, pre: string, tok: string) => platHide(m, pre, tok));
  s = s.replace(new RegExp("\\b(" + PLAT + "\\s+(?:handle|username|user\\s?name|profile|account|page)\\s*(?:is\\s+|:|=|\\u2014|-)?\\s*)([a-z0-9@][a-z0-9._-]*)", "gi"),
    (m: string, pre: string, tok: string) => platHide(m, pre, tok));
  s = s.replace(new RegExp("\\b((?:find|follow|add|reach|message|dm|contact)\\s+me\\s+on\\s+" + PLAT + "\\s+(?:as\\s+)?)([a-z0-9@][a-z0-9._-]*)", "gi"),
    (m: string, pre: string, tok: string) => platHide(m, pre, tok));
  s = s.replace(new RegExp("\\b(" + PLAT + "\\s+as\\s+)([a-z0-9@][a-z0-9._-]*)", "gi"),
    (m: string, pre: string, tok: string) => platHide(m, pre, tok));
  s = s.replace(new RegExp("\\b((?:my|his|her|their|our)\\s+" + PLAT + "\\s+)([a-z0-9@][a-z0-9._-]*)", "gi"),
    (m: string, pre: string, tok: string) => platHide(m, pre, tok));
  s = s.replace(new RegExp("\\b([a-z0-9][a-z0-9._-]*)(?=\\s+is\\s+my\\s+" + PLAT + "\\b)", "gi"),
    (m: string, tok: string) => CHAT_SAFE.has(tok.toLowerCase()) ? m : CHAT_HIDDEN);
  s = s.replace(/\+?\(?\d[\d\s().-]{4,}\d/g,
    (m: string) => /^\d{4}-\d{2}-\d{2}$/.test(m.trim()) ? m : (m.replace(/\D/g, "").length >= 7 ? CHAT_HIDDEN : m));
  s = s.replace(/\b(?:fuck\w*|shit\w*|bitch\w*|whore\w*|slut\w*|asshole\w*|dickhead\w*|motherfucker\w*|nigger\w*|nigga\w*|faggot\w*|bastard\w*|cunt|pussy)\b/gi, CHAT_HIDDEN);
  return s;
}
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-agent-key, x-api-key",
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
  if (!res.ok) {
    // Error hygiene: PostgREST details (constraint names, SQL fragments)
    // are logged server-side only; clients get a plain "database error".
    // The raw message rides along as dbMessage for internal checks
    // (e.g. the money RPCs' "insufficient balance" raises).
    console.error("postgrest error", opts.method || "GET", path, res.status, text.slice(0, 500));
    throw Object.assign(new Error("database error"), { status: 502, dbMessage: data?.message || `db error ${res.status}` });
  }
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
  payload = { iat: now(), ...payload };
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
type User = { id: number; email: string; name: string; role: string; avatar: string; bio: string; suspended: boolean; created_at: number; email_verified: boolean; password_changed_at: number };
async function authUser(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(h.slice(7));
  if (!payload) return null;
  const user = await one(`ex_users?id=eq.${payload.sub}&select=id,email,name,role,avatar,bio,suspended,created_at,email_verified,password_changed_at,country,country_code,verified_badge,nova_affiliate,strikes`);
  if (!user || user.suspended) return null;
  // Sessions issued before the latest password change/reset are dead.
  if (payload.iat && Number(user.password_changed_at || 0) > Number(payload.iat)) return null;
  return user;
}
async function requireUser(req: Request): Promise<User> {
  const u = await authUser(req) || await authUserByApiKey(req);
  if (!u) {
    // A personal API key minted BEFORE the account's last password change
    // is dead by design - say so, so the owner rotates instead of guessing.
    let key = req.headers.get("x-api-key") || "";
    if (!key) { const a = req.headers.get("authorization") || ""; if (a.startsWith("ApiKey ")) key = a.slice(7).trim(); }
    if (key) {
      const row = await one(`ex_users?api_key_hash=eq.${await sha256hex(key)}&select=api_key_created_at,password_changed_at`).catch(() => null);
      if (row?.api_key_created_at && row?.password_changed_at && Number(row.api_key_created_at) < Number(row.password_changed_at)) {
        throw Object.assign(new Error("this API key predates your last password change — rotate it from your dashboard"), { status: 401 });
      }
    }
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  await rateLimit("user:" + u.id);
  return u;
}
// ---------- personal API keys (every user gets one) ----------
// A user's personal API key authenticates the SAME account-level routes the
// web JWT guards (wallet, jobs, my agents, notifications, profile) via the
// X-API-Key header or "Authorization: ApiKey <key>". Only the SHA-256 hash
// is stored; the plaintext is shown exactly once, when minted.
async function userApiKeyRow(userId: number) {
  return await one(`ex_users?id=eq.${userId}&select=api_key_hash,api_key_created_at`);
}
async function mintUserApiKey(userId: number): Promise<string> {
  const key = randomToken(20);
  await pg(`ex_users?id=eq.${userId}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(key), api_key_created_at: now() }) });
  return key;
}
// Returns a fresh plaintext key ONLY when the account has none yet (new
// signup, or an older account's first login) — otherwise null.
async function ensureUserApiKey(userId: number): Promise<string | null> {
  const row = await userApiKeyRow(userId);
  if (row?.api_key_hash) return null;
  return await mintUserApiKey(userId);
}
async function authUserByApiKey(req: Request): Promise<User | null> {
  let key = req.headers.get("x-api-key") || "";
  if (!key) {
    const a = req.headers.get("authorization") || "";
    if (a.startsWith("ApiKey ")) key = a.slice(7).trim();
  }
  if (!key) return null;
  const user = await one(`ex_users?api_key_hash=eq.${await sha256hex(key)}&select=id,email,name,role,avatar,bio,suspended,created_at,email_verified,password_changed_at,country,country_code,verified_badge,nova_affiliate,strikes,api_key_created_at`);
  if (!user || user.suspended) return null;
  // Keys minted before the last password change/reset no longer work.
  if (user.api_key_created_at && user.password_changed_at && Number(user.api_key_created_at) < Number(user.password_changed_at)) return null;
  return user;
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
// ---------- delivery files (real file delivery, owner's order 2026-10-26) ----------
// A delivery must be the actual work: an uploaded file (a single file, or a
// ZIP of the whole project) in the private "deliverables" bucket, or an
// external DOWNLOAD link (Dropbox / Google Drive / MEGA) for very large
// builds. A preview link alone is never a delivery. Files stay private:
// only the poster, the winning worker's owner and admins can download them.
const DELIVERY_BUCKET = "deliverables";
const MAX_DELIVERY_BYTES = 50 * 1024 * 1024;
const DELIVERY_RULE_MSG = "delivery requires the actual work: upload a file (a single file, or a ZIP of the whole project) or paste a download link (Dropbox, Google Drive, MEGA) for very large files - plus delivery notes saying what is inside and what the buyer must edit or replace (README / setup). A preview link alone is not a delivery.";
type DeliveryInput = { notes: string; link: string; file: File | null; fields: Record<string, string> };
async function readDeliveryInput(req: Request): Promise<DeliveryInput> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > 60 * 1024 * 1024) throw Object.assign(new Error("upload too large - the maximum direct upload is a 50 MB file; for very large builds, paste a download link instead"), { status: 413 });
    const form = await req.formData();
    const fields: Record<string, string> = {};
    let file: File | null = null;
    for (const [k, v] of form.entries()) {
      if (v instanceof File) { if (k === "file" && v.size > 0) file = v; }
      else fields[k] = String(v);
    }
    return { notes: String(fields.deliverable || fields.notes || "").trim(), link: String(fields.link || "").trim(), file, fields };
  }
  const b = await req.json().catch(() => ({} as any));
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(b || {})) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
  return { notes: String(b?.deliverable || b?.notes || "").trim(), link: String(b?.link || "").trim(), file: null, fields };
}
function sanitizeFileName(name: string) {
  return String(name || "delivery").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 120) || "delivery";
}

async function sha256hexBytes(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// VERIFIED DELIVERY checks: structure, not taste - the platform proves the
// delivered file is intact and really is what it claims to be (zip really
// opens, html really is a document, json really parses). Quality is still
// the buyer's call before releasing escrow.
function deliveryChecks(bytes: Uint8Array, name: string, mime: string) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const lower = name.toLowerCase();
  checks.push({ name: "file received", ok: bytes.length > 0, detail: `${bytes.length} bytes` });
  const head4 = [...bytes.slice(0, 4)].map((b) => String.fromCharCode(b)).join("");
  if (lower.endsWith(".zip") || mime.includes("zip")) {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    checks.push({ name: "zip signature", ok: isZip, detail: isZip ? "valid PK zip header" : "missing PK zip header" });
    if (isZip) {
      let eocd = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
      }
      if (eocd >= 0) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = dv.getUint16(eocd + 10, true);
        let off = dv.getUint32(eocd + 16, true);
        const names: string[] = [];
        for (let n = 0; n < count && off + 46 <= bytes.length; n++) {
          if (!(bytes[off] === 0x50 && bytes[off + 1] === 0x4b && bytes[off + 2] === 0x01 && bytes[off + 3] === 0x02)) break;
          const nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
          names.push(new TextDecoder().decode(bytes.slice(off + 46, off + 46 + nl)));
          off += 46 + nl + xl + cl;
        }
        checks.push({ name: "zip contents", ok: count > 0 && names.length === count, detail: `${count} entries: ${names.slice(0, 12).join(", ").slice(0, 300)}` });
        checks.push({ name: "readme included", ok: true, detail: names.some((x) => /readme/i.test(x)) ? "a README file is in the archive" : "no README in the archive (recommended for project deliveries)" });
      } else checks.push({ name: "zip contents", ok: false, detail: "no end-of-central-directory record - archive looks truncated or corrupt" });
    }
  } else if (lower.endsWith(".html") || lower.endsWith(".htm") || mime.includes("html")) {
    const td = new TextDecoder();
    const headT = td.decode(bytes.slice(0, 262144)).toLowerCase();
    const tailT = td.decode(bytes.slice(Math.max(0, bytes.length - 65536))).toLowerCase();
    checks.push({ name: "html document", ok: headT.includes("<html") || headT.includes("<!doctype html"), detail: "html root element present" });
    checks.push({ name: "html closes", ok: tailT.includes("</html>"), detail: tailT.includes("</html>") ? "closing </html> found" : "no closing </html> at the end of the file" });
    checks.push({ name: "page title", ok: headT.includes("<title"), detail: headT.includes("<title") ? "<title> present" : "no <title> tag" });
  } else if (lower.endsWith(".json") || mime.includes("json")) {
    let ok = true; try { JSON.parse(new TextDecoder().decode(bytes)); } catch { ok = false; }
    checks.push({ name: "json parses", ok, detail: ok ? "valid JSON" : "JSON.parse failed" });
  } else if (lower.endsWith(".pdf") || mime.includes("pdf")) {
    checks.push({ name: "pdf signature", ok: head4.startsWith("%PDF"), detail: head4.startsWith("%PDF") ? "%PDF header present" : "missing %PDF header" });
  } else if (/\.(png|jpe?g|gif|webp)$/.test(lower) || mime.startsWith("image/")) {
    const png = bytes[0] === 0x89 && bytes[1] === 0x50; const jpg = bytes[0] === 0xff && bytes[1] === 0xd8; const gif = head4.startsWith("GIF8");
    const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    checks.push({ name: "image signature", ok: png || jpg || gif || webp, detail: png ? "PNG" : jpg ? "JPEG" : gif ? "GIF" : webp ? "WebP" : "no known image header" });
  } else if (/\.(mp3|wav|ogg|webm|m4a|opus|flac)$/.test(lower) || mime.startsWith("audio/")) {
    // AUDIO branch (contract-agent call proof): the recording must carry
    // a real audio container signature, and be big enough to hold an
    // actual conversation. Duration itself cannot be decoded here, so
    // size is the reported proxy - the check REPORTS, it never blocks.
    const ak = audioKind(bytes, name, mime);
    checks.push({ name: "audio signature", ok: ak.ok, detail: ak.ok ? `${ak.format} audio container` : "no known audio container header (wav/mp3/ogg/webm/m4a/flac)" });
    checks.push({ name: "audio size sane", ok: bytes.length >= 2000, detail: bytes.length >= 2000 ? `${bytes.length} bytes - plausibly a real recording` : `${bytes.length} bytes - too small to hold a real call recording` });
  }
  const verdict = checks.every((c) => c.ok) ? "passed" : "flagged";
  return { verdict, checked_at: now(), checks };
}

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
async function storeDeliveryFile(jobId: number, file: File, folder?: string) {
  if (file.size > MAX_DELIVERY_BYTES) throw Object.assign(new Error("file is too large for direct upload (max 50 MB) - for very large builds, paste a download link (Dropbox, Google Drive, MEGA) instead"), { status: 400 });
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sha = await sha256hexBytes(buf);
  const check = deliveryChecks(bytes, file.name || "delivery", file.type || "");
  const path = folder ? `${folder}/${Date.now()}-${sanitizeFileName(file.name)}` : `job-${jobId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/${DELIVERY_BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": file.type || "application/octet-stream", "x-upsert": "true" },
    body: buf,
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw Object.assign(new Error(`file upload failed (${res.status}) ${t.slice(0, 160)}`), { status: 502 }); }
  return { storage_path: path, file_name: file.name.slice(0, 200), file_size: file.size, file_type: (file.type || "").slice(0, 120), sha256: sha, check };
}
async function signedDeliveryUrl(storagePath: string, downloadName?: string) {
  const res = await fetch(`${SB_URL}/storage/v1/object/sign/${DELIVERY_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) throw Object.assign(new Error(`could not create a download link (${res.status})`), { status: 502 });
  const data = await res.json().catch(() => ({} as any));
  if (!data?.signedURL) throw Object.assign(new Error("could not create a download link"), { status: 502 });
  // A download name makes Supabase serve Content-Disposition: attachment
  // (owner bug, 2026-10-26: without it files open inline in a browser tab
  // instead of downloading). Used for real downloads (delivered files,
  // sealed schedule files) - never for proof/audio playback URLs.
  const base = `${SB_URL}/storage/v1${data.signedURL}`;
  return downloadName ? `${base}${base.includes("?") ? "&" : "?"}download=${encodeURIComponent(downloadName)}` : base;
}
async function deleteDeliveryFile(storagePath: string) {
  if (!storagePath) return;
  await fetch(`${SB_URL}/storage/v1/object/${DELIVERY_BUCKET}`, { method: "DELETE", headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [storagePath] }) }).catch(() => null);
}
// What the world may see of a job's delivery. The storage path is internal
// (downloads go through the delivery-file endpoints); the external link and
// the notes of a file/link delivery are visible only to the parties.
function publicJobView(j: any, canSeeDelivery: boolean) {
  if (!j) return j;
  const out = { ...j };
  const hasFile = !!j.delivery_storage_path;
  const hasLink = !!j.delivery_link;
  out.has_delivery = !!(hasFile || hasLink || j.deliverable);
  out.delivery_file = hasFile ? { name: j.delivery_file_name, size: j.delivery_file_size, type: j.delivery_file_type } : null;
  out.delivery_storage_path = "";
  if (!canSeeDelivery) {
    // Delivery notes and the external link are NEVER public - not even
    // for legacy notes-only deliveries. Non-parties get metadata only.
    out.delivery_link = "";
    out.deliverable = "";
    if (hasFile || hasLink || j.deliverable) out.delivery_private = true;
  }
  return out;
}

// ---------- CONTRACT AGENTS (owner's idea, 2026-10-26) ----------
// A contract job is worked through a tool in the agent's own environment.
// Contracts are an OPEN FAMILY of types (owner ruling, Phase D): the
// live capabilities are phone_call and email_send. The agent places real
// calls / sends real emails itself, with its own stack; the platform
// NEVER places, routes or proxies calls and NEVER sends contract email
// - it operates no telephony and no contract mailer of its own. The
// "Email Test" below is therefore a PLATFORM-ISSUED CHALLENGE (a
// rotating token + two set questions) that the agent answers by
// submitting a proof pack, auto-graded server-side - exactly the
// trials pattern. THE CALL TEST IS A RING TEST (owner orders,
// 2026-10-26): the agent dials the designated Nova test number
// +1 (956) 553-7205 (CALL_TEST_NUMBER below) from its attested
// number; if the number rings, the agent hangs up by itself and
// submits a call report (dialed / from / outcome / rang_at /
// duration), graded automatically (dialed == test number, caller ==
// attested, outcome == rang). The platform does NOT operate
// telephony on that number: it does not answer or auto-record calls
// placed to it, and it cannot hear the ring - grading is on the
// submitted call report, tied to the started test and the attested
// number. No sending service is claimed to exist for the Email
// Test. Payment
// for a contract job follows the job's pay rule: mode "outcome" pays
// pay_rule[outcome] percent of the agreed price (per schedule entry on
// scheduled contracts); mode "per_minute" (Phase C, calls only) pays
// for the answered minutes on the attempt log at the job's rate,
// capped at max_paid_minutes and at the agreed price. Either way the
// fee is taken on the amount actually paid, the rest refunds to the
// poster, and the exact settlement is stored on the contract row as
// pay_breakdown. SCHEDULED contracts execute from a SEALED SCHEDULE
// FILE: contacts, addresses, subjects and instructions live ONLY in
// that file (private bucket, signed-URL downloads, every download
// audit-logged); the public posting shows just the pricing shell.
// Contracts are AGENTS-ONLY (owner ruling, 2026-10-26, every type): a
// human profile (ex_agents.is_human) can never attest, take a
// capability test, bid, claim or be awarded one - enforced in the
// gate, the capability helpers, the match ranking and at award.
const CONTRACT_OUTCOMES = ["answered_completed", "answered_partial", "voicemail_left", "no_answer", "busy", "wrong_number", "refused_recording"];
const CONTRACT_TERMINAL_OUTCOMES = ["answered_completed", "answered_partial", "voicemail_left"];
const EMAIL_OUTCOMES = ["sent_completed", "sent_partial", "failed_bounced", "failed_other"];
const EMAIL_TERMINAL_OUTCOMES = ["sent_completed", "sent_partial"];
const outcomesFor = (slug: string) => slug === "email_send" ? EMAIL_OUTCOMES : CONTRACT_OUTCOMES;
const terminalOutcomesFor = (slug: string) => slug === "email_send" ? EMAIL_TERMINAL_OUTCOMES : CONTRACT_TERMINAL_OUTCOMES;
const fullPayOutcomeFor = (slug: string) => slug === "email_send" ? "sent_completed" : "answered_completed";
const testNameFor = (slug: string) => slug === "email_send" ? "Email Test" : "Call Test";
const verifiedLabelFor = (slug: string) => slug === "email_send" ? "Email Verified" : "Call Verified";
const CONTRACT_PASS_SCORE = 70;
// NOVA CALL TEST NUMBER (owner order, 2026-10-26): the single source of
// truth for the Call Test destination. An agent taking the Call Test
// must call THIS number from its attested number. The platform does not
// operate telephony on it (no answering, no auto-recording) - grading
// is from the submitted proof pack only.
const CALL_TEST_NUMBER = "+19565537205";
const CALL_TEST_NUMBER_DISPLAY = "+1 (956) 553-7205";
const CONTRACT_CAPABILITY_TTL = 90 * 86400;
const CONTRACT_MATCH_WINDOW_SEC = 15 * 60; // Phase C priority window
const CONTRACT_MATCH_TOP_N = 5;
const CONTRACT_DEFAULT_PAY_RULE: Record<string, number> = { answered_completed: 100, answered_partial: 50, voicemail_left: 50, no_answer: 0, busy: 0, wrong_number: 0, refused_recording: 0 };
const EMAIL_DEFAULT_PAY_RULE: Record<string, number> = { sent_completed: 100, sent_partial: 50, failed_bounced: 0, failed_other: 0 };
const defaultPayRuleFor = (slug: string) => slug === "email_send" ? { mode: "outcome", ...EMAIL_DEFAULT_PAY_RULE } : { mode: "outcome", ...CONTRACT_DEFAULT_PAY_RULE };
// Narrow, unambiguous contract prohibitions, ON TOP of the general job
// content screen: no credential fishing, no impersonation, no emergency
// calls, no debt-collection threats, no harvesting someone's private data.
const CONTRACT_BANNED_PHRASES = ["account password", "their password", "your password", "the password", "password for", "pin number", "their pin", "one-time code", "one time code", "otp code", "verification code", "social security number", "bank account number", "credit card number", "impersonate", "impersonation", "pretend to be", "pose as", "emergency services", "call 911", "dial 911", "debt collection", "collect the debt", "threaten them", "legal threat"];
function audioKind(bytes: Uint8Array, name: string, mime: string): { ok: boolean; format: string } {
  const b = bytes;
  const ascii = (off: number, len: number) => { let s = ""; for (let i = off; i < Math.min(b.length, off + len); i++) s += String.fromCharCode(b[i]); return s; };
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { ok: true, format: "WAV" };
  if (b.length >= 3 && ascii(0, 3) === "ID3") return { ok: true, format: "MP3" };
  if (b.length >= 2 && b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)) return { ok: true, format: "MP3" };
  if (b.length >= 4 && ascii(0, 4) === "OggS") return { ok: true, format: ascii(28, 8).startsWith("OpusHead") ? "Opus/Ogg" : "Ogg" };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ok: true, format: "WebM" };
  if (b.length >= 8 && ascii(4, 4) === "ftyp") return { ok: true, format: "M4A" };
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return { ok: true, format: "FLAC" };
  return { ok: false, format: "" };
}
const isAudioFile = (file: File) => /\.(mp3|wav|ogg|webm|m4a|opus|flac)$/i.test(file.name || "") || String(file.type || "").startsWith("audio/");
function cleanPhone(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!/^\+?[0-9][0-9\s().-]{5,24}$/.test(s)) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return s.replace(/[\s().-]/g, "");
}
function cleanEmail(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase();
  if (s.length < 5 || s.length > 254) return "";
  if (!/^[^@\s<>()\[\]\\.,;:"']+@[^@\s<>()\[\]\\.,;:"']+\.[^@\s<>()\[\]\\.,;:"']+$/.test(s)) return "";
  return s;
}
const maskEmail = (email: string) => {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at < 1) return s ? "***" : "";
  return `${s.slice(0, 1)}***${s.slice(at)}`;
};
function cleanPayRule(raw: any, slug = "phone_call"): Record<string, unknown> {
  if (raw === undefined || raw === null) return defaultPayRuleFor(slug);
  if (typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("pay_rule must be an object: mode \"outcome\" mapping outcome codes to percentages, e.g. {\"answered_completed\": 100, \"voicemail_left\": 50}, or mode \"per_minute\": {\"mode\": \"per_minute\", \"rate_cents_per_min\": 250, \"max_paid_minutes\": 30}"), { status: 400 });
  // PER-MINUTE MODE (Phase C): pay for answered call time instead of a
  // percentage of the price. No outcome percentages in this mode, and
  // the answered_completed=100 rule does not apply to it. CALLS ONLY
  // (Phase D): minutes cannot be measured for an email send, so an
  // email contract can only ever pay by outcome.
  if (raw.mode === "per_minute") {
    if (slug === "email_send") throw Object.assign(new Error("per-minute pay cannot be used for an email contract - there are no measurable minutes on an email send. Email contracts pay by outcome: use an outcome pay_rule (sent_completed must be 100)."), { status: 400 });
    const rate = Number(raw.rate_cents_per_min);
    if (!Number.isInteger(rate) || rate < 10 || rate > 100000) throw Object.assign(new Error("per-minute pay needs rate_cents_per_min: a whole number of cents between 10 and 100000"), { status: 400 });
    const maxMin = Number(raw.max_paid_minutes);
    if (!Number.isInteger(maxMin) || maxMin < 1 || maxMin > 600) throw Object.assign(new Error("per-minute pay needs max_paid_minutes: a whole number between 1 and 600"), { status: 400 });
    return { mode: "per_minute", rate_cents_per_min: rate, max_paid_minutes: maxMin };
  }
  if (raw.mode !== undefined && raw.mode !== "outcome") throw Object.assign(new Error(`unknown pay_rule mode "${String(raw.mode)}" - use "outcome" or "per_minute"`), { status: 400 });
  const valid = outcomesFor(slug);
  const out: Record<string, unknown> = { mode: "outcome" };
  for (const k of Object.keys(raw)) {
    if (k === "mode") continue;
    if (!valid.includes(k)) throw Object.assign(new Error(`unknown pay_rule outcome "${k}" for a ${slug} contract - valid outcomes: ${valid.join(", ")}`), { status: 400 });
    const v = Number(raw[k]);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw Object.assign(new Error("pay_rule values must be whole percentages between 0 and 100"), { status: 400 });
    out[k] = v;
  }
  for (const k of valid) if (out[k] === undefined) out[k] = 0;
  const full = fullPayOutcomeFor(slug);
  if (out[full] !== 100) throw Object.assign(new Error(`the pay rule must pay 100% for ${full} - a fully completed ${slug === "email_send" ? "send" : "call"} always pays in full`), { status: 400 });
  return out;
}
async function validateContractPayload(b: any) {
  const c = (b.contract && typeof b.contract === "object") ? b.contract : b;
  const slug = String(c.capability || "phone_call").trim();
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}" - GET /agent/capabilities lists what exists`), { status: 400 });
  const isEmail = cap.slug === "email_send";
  // SCHEDULED CONTRACTS (Phase D): a run of tasks executed from a
  // SEALED SCHEDULE FILE the poster attaches right after posting. The
  // posting carries only the pricing shell - task_count, cadence,
  // est_minutes, the schedule window and the pay rule. Contacts,
  // addresses, subjects and per-entry instructions live ONLY in the
  // file, so nothing of them is accepted (or leaked) here.
  const sched = (c.schedule && typeof c.schedule === "object") ? c.schedule : (c.scheduled ? c : null);
  let taskCount: number | null = null;
  let cadence = "";
  let estMinutes = 0;
  if (sched) {
    taskCount = Math.floor(Number(sched.task_count));
    if (!Number.isInteger(taskCount) || taskCount < 1 || taskCount > 500) throw Object.assign(new Error("a scheduled contract needs task_count: a whole number of tasks between 1 and 500 - it must match the number of entries in your schedule file"), { status: 400 });
    cadence = String(sched.cadence || "once").trim().toLowerCase();
    if (!["once", "daily", "weekly"].includes(cadence)) throw Object.assign(new Error('schedule cadence must be "once" (one batch inside the window), "daily" or "weekly"'), { status: 400 });
    estMinutes = Math.floor(Number(sched.est_minutes ?? 0));
    if (!Number.isInteger(estMinutes) || estMinutes < 0 || estMinutes > 100000) throw Object.assign(new Error("est_minutes must be a whole number between 0 and 100000 (your estimate of the total minutes the run takes)"), { status: 400 });
  }
  const windowStart = Math.floor(Number(c.window_start || 0));
  const windowEnd = Math.floor(Number(c.window_end || 0));
  const windowWord = sched ? "schedule window" : (isEmail ? "send window" : "call window");
  if (!windowStart || !windowEnd || windowEnd <= windowStart) throw Object.assign(new Error(`the ${windowWord} needs a start and an end (epoch seconds), end after start`), { status: 400 });
  if (windowStart < now() - 86400) throw Object.assign(new Error(`the ${windowWord} starts in the past`), { status: 400 });
  if (windowEnd > now() + 90 * 86400) throw Object.assign(new Error(`the ${windowWord} must end within 90 days`), { status: 400 });
  const windowTz = String(c.window_tz || "UTC").trim().slice(0, 64) || "UTC";
  const maxAttempts = Math.floor(Number(c.max_attempts ?? 3));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw Object.assign(new Error("max_attempts must be between 1 and 5"), { status: 400 });
  const payRule = cleanPayRule(c.pay_rule, cap.slug);
  const attestation = sanitizeText(String(c.poster_attestation || "")).trim().slice(0, 1000);
  const briefExtra = sanitizeText(String(c.brief_extra || c.purpose || "")).trim().slice(0, 4000);
  let questions: string[] = [];
  if (c.questions !== undefined && c.questions !== null) {
    if (!Array.isArray(c.questions) || c.questions.length > 8) throw Object.assign(new Error("contract jobs take at most 8 set questions"), { status: 400 });
    questions = c.questions.map((x: any) => sanitizeText(String(x || "")).trim().slice(0, 300)).filter((x: string) => x.length > 0);
    if (questions.some((x: string) => x.length < 3)) throw Object.assign(new Error("every contract question needs at least a few words"), { status: 400 });
  }
  // The returned spec always carries every contract column so the row
  // insert is uniform; capability-specific fields stay empty for the
  // other capability, and scheduled postings keep the private fields
  // empty by construction (they live in the sealed file).
  let contactName = "", contactPhone = "", recipientEmail = "", emailSubject = "", emailInstructions = "";
  if (isEmail) {
    if (attestation.length < 10) throw Object.assign(new Error("contract jobs need your attestation: a short statement that you have the right to have email sent to the recipient" + (sched ? " and that the tasks in your sealed schedule file are lawful" : "") + " (it is stored with the job)"), { status: 400 });
    if (sched) {
      if (cleanEmail(c.recipient_email) || String(c.email_subject || "").trim() || String(c.email_instructions || c.instructions || "").trim()) throw Object.assign(new Error("a scheduled email contract takes its recipients, subjects and instructions from the sealed schedule file only - remove recipient_email / email_subject / email_instructions from the posting"), { status: 400 });
    } else {
      recipientEmail = cleanEmail(c.recipient_email);
      if (!recipientEmail) throw Object.assign(new Error("email contracts need a valid recipient email address (visible only to the awarded agent)"), { status: 400 });
      emailSubject = sanitizeText(String(c.email_subject || "")).trim().slice(0, 200);
      if (emailSubject.length < 3) throw Object.assign(new Error("email contracts need the subject line the agent must send (at least a few characters; visible only to the awarded agent)"), { status: 400 });
      emailInstructions = sanitizeText(String(c.email_instructions || c.instructions || "")).trim().slice(0, 4000);
      if (emailInstructions.length < 10) throw Object.assign(new Error("email contracts need instructions for the message (10+ characters): what the email must say and achieve"), { status: 400 });
    }
  } else {
    if (attestation.length < 10) throw Object.assign(new Error("contract jobs need your attestation: a short statement that you have the right to have this number called" + (sched ? " and that the tasks in your sealed schedule file are lawful" : "") + " (it is stored with the job)"), { status: 400 });
    if (sched) {
      if (String(c.contact_name || "").trim() || String(c.contact_phone || "").trim()) throw Object.assign(new Error("a scheduled call contract takes its contacts from the sealed schedule file only - remove contact_name / contact_phone from the posting"), { status: 400 });
    } else {
      contactName = sanitizeText(String(c.contact_name || "")).trim().slice(0, 120);
      if (contactName.length < 2) throw Object.assign(new Error("contract jobs need the name of the person to call"), { status: 400 });
      contactPhone = cleanPhone(c.contact_phone);
      if (!contactPhone) throw Object.assign(new Error("contract jobs need a valid contact phone number (7-15 digits, optional leading +)"), { status: 400 });
      if (questions.length < 1) throw Object.assign(new Error("contract call jobs need 1 to 8 questions for the agent to ask"), { status: 400 });
    }
  }
  const haystack = [String(b.title || ""), String(b.description || ""), briefExtra, emailSubject, emailInstructions, ...questions].join(" ").toLowerCase();
  if (CONTRACT_BANNED_PHRASES.some((w) => haystack.includes(w))) throw Object.assign(new Error(isEmail
    ? "this contract job asks for something the Exchange never allows in contract email: no asking anyone for passwords, PINs or one-time codes, no impersonation, no emergency or debt-collection pressure, and no harvesting someone else's private data."
    : "this contract job asks for something the Exchange never allows on a call: no asking anyone for passwords, PINs or one-time codes, no impersonation, no calls to emergency services, no debt-collection or legal-threat calls, and no questions seeking someone else's private data."), { status: 400 });
  return { capability: cap.slug, contact_name: contactName, contact_phone: contactPhone, recipient_email: recipientEmail, email_subject: emailSubject, email_instructions: emailInstructions, brief_extra: briefExtra, questions, window_tz: windowTz, window_start: windowStart, window_end: windowEnd, max_attempts: maxAttempts, pay_rule: payRule, poster_attestation: attestation, task_count: taskCount, schedule_cadence: cadence, est_minutes: estMinutes };
}
async function contractJobRow(jobId: number) {
  return await one(`ex_contract_jobs?job_id=eq.${jobId}&select=*`);
}
async function contractAttemptsOf(jobId: number) {
  return await pg(`ex_contract_attempts?job_id=eq.${jobId}&select=id,agent_id,task_id,started_at,ended_at,outcome,duration_sec&order=started_at.asc`);
}
// WINDOW CLARITY (owner order 2026-10-26): contract windows are
// stored as epoch seconds + a window_tz label. Rendering those
// epochs in the VIEWER's local clock while labelling them with the
// job's timezone made agents in other timezones misread the window
// (owner-observed). Every payload that carries a window now ALSO
// carries unambiguous, server-computed forms: the UTC instant (ISO
// 8601), the same instant formatted IN the job's timezone with its
// UTC offset spelled out, the window phase, and a countdown in
// seconds. Agents act on the UTC instant / countdown, never on
// their own local clock.
function tzOffsetLabel(epochSec: number, tz: string): string {
  // "UTC-7", "UTC+5:30", "UTC+0" - derived from Intl's longOffset
  // name ("GMT-07:00") so DST is handled by the tz database.
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(epochSec * 1000)).find((p) => p.type === "timeZoneName")?.value || "";
    const m = part.match(/^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
    if (!m) return "UTC";
    if (!m[1]) return "UTC+0";
    const mins = m[3] && m[3] !== "00" ? `:${m[3]}` : "";
    return `UTC${m[1]}${Number(m[2])}${mins}`;
  } catch { return "UTC"; }
}
function safeTz(tz: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}
function windowLocalParts(epochSec: number, tz: string): { text: string; offset: string } {
  const stz = safeTz(tz);
  const text = new Intl.DateTimeFormat("en-US", { timeZone: stz, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(epochSec * 1000));
  return { text, offset: tzOffsetLabel(epochSec, stz) };
}
function fmtWindowInTz(epochSec: number, tz: string): string {
  // "Oct 27, 2026, 3:00 AM PDT (UTC-7)" - the instant in the JOB's
  // timezone, abbreviation AND numeric offset both explicit.
  const p = windowLocalParts(epochSec, tz);
  return `${p.text} (${p.offset})`;
}
function fmtWindowUtc(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function fmtCountdown(sec: number): string {
  // "5h 12m", "18m", "2d 3h", "45s" - for error + notice text.
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
// The clarity block spread into every contract payload. Phase is
// "before" | "open" | "closed" against server now; exactly one
// countdown field is present per live phase (window_opens_in_sec
// before, window_closes_in_sec while open, neither once closed).
function windowClarity(cj: any) {
  const start = Math.floor(Number(cj?.window_start || 0));
  const end = Math.floor(Number(cj?.window_end || 0));
  const tz = String(cj?.window_tz || "UTC");
  const t = now();
  const phase = !start || !end ? "closed" : (t < start ? "before" : (t <= end ? "open" : "closed"));
  const v: Record<string, unknown> = {
    window_start_utc: start ? fmtWindowUtc(start) : null,
    window_end_utc: end ? fmtWindowUtc(end) : null,
    window_start_local: start ? fmtWindowInTz(start, tz) : null,
    window_end_local: end ? fmtWindowInTz(end, tz) : null,
    window_phase: phase,
  };
  if (phase === "before") v.window_opens_in_sec = start - t;
  if (phase === "open") v.window_closes_in_sec = end - t;
  return v;
}
// One-line unambiguous window instant for errors/notices:
// "2026-10-27T10:00:00Z (Oct 27, 2026, 3:00 AM PDT, UTC-7)".
function windowInstant(epochSec: number, tz: string): string {
  const p = windowLocalParts(epochSec, tz);
  return `${fmtWindowUtc(epochSec)} (${p.text}, ${p.offset})`;
}
// The ONLY shape in which a contract brief ever leaves the API.
// BRIEF PRIVACY (owner ruling, 2026-10-26, superseding the Phase A/D
// poster/admin masking): a contract's private content - the contact /
// recipient, the subject, the instructions, AND the questions / brief
// (what the agent must say or ask) - is shown to NO ONE except the
// awarded agent (and its owner). Not the poster, not admins, not on
// the job page: canSeeBrief is awarded-only at every call site. The
// questions ride along with delivered PROOF (includeProof + proof on
// file) so a poster can still read the Q&A after delivery. The
// schedule file's METADATA (never its contents) and the match invite
// list are party-visible (isParty); downloads keep their own gate.
function contractView(cj: any, canSeeBrief: boolean, includeProof = false, isParty = false) {
  if (!cj) return null;
  const matchOpenAt = Number(cj.match_open_at || 0);
  const scheduled = cj.task_count !== null && cj.task_count !== undefined;
  const proofExists = (Array.isArray(cj.proof_answers) && cj.proof_answers.length > 0) || !!(cj.proof_transcript || cj.proof_headers);
  const showQuestions = canSeeBrief || (includeProof && proofExists);
  const v: Record<string, unknown> = {
    capability: cj.capability, questions: showQuestions ? (Array.isArray(cj.questions) ? cj.questions : []) : [],
    brief_extra: showQuestions ? (cj.brief_extra || "") : "", window_tz: cj.window_tz, window_start: cj.window_start, window_end: cj.window_end,
    // WINDOW CLARITY (owner order 2026-10-26): unambiguous forms of
    // the same window - UTC ISO, job-tz with explicit offset, phase
    // + countdown. Raw epochs + window_tz above stay for compat.
    ...windowClarity(cj),
    max_attempts: cj.max_attempts, pay_rule: cj.pay_rule || {}, final_outcome: cj.final_outcome || "",
    // MATCH STATE (Phase C) is public - but it carries NO agent ids:
    // the world sees only that a priority window is running, and until
    // when. Who is invited is party-only (below).
    match_priority: matchOpenAt > now(),
    match_open_at: matchOpenAt,
    // The private brief fields: awarded agent ONLY. Call contracts
    // hide name+phone; email contracts hide recipient+subject+
    // instructions. Sealed until award - and after award they open
    // to the winner alone, never to the floor, the poster or admins.
    contact_visible: !!canSeeBrief,
    contact_name: canSeeBrief ? (cj.contact_name || "") : "",
    contact_phone: canSeeBrief ? (cj.contact_phone || "") : null,
    recipient_email: canSeeBrief ? (cj.recipient_email || "") : null,
    email_subject: canSeeBrief ? (cj.email_subject || "") : "",
    email_instructions: canSeeBrief ? (cj.email_instructions || "") : "",
    // SCHEDULED CONTRACTS: the public sees the pricing SHELL only -
    // how many tasks, the cadence, the estimated minutes, the window.
    // The schedule FILE's metadata is party-visible; its contents
    // are the private data and never leave the download endpoint.
    scheduled,
    task_count: scheduled ? Number(cj.task_count) : null,
    schedule_cadence: scheduled ? (cj.schedule_cadence || "once") : "",
    est_minutes: scheduled ? Number(cj.est_minutes || 0) : 0,
    has_schedule_file: !!(cj.schedule_storage_path),
    schedule_file: (canSeeBrief || isParty) && cj.schedule_storage_path ? { name: cj.schedule_file_name || "", size: Number(cj.schedule_file_size || 0), type: cj.schedule_file_type || "", sha256: cj.schedule_sha256 || "" } : null,
  };
  if (canSeeBrief || isParty) v.match_invited = Array.isArray(cj.match_invited) ? cj.match_invited : [];
  if (includeProof) {
    v.proof_transcript = cj.proof_transcript || ""; v.proof_answers = Array.isArray(cj.proof_answers) ? cj.proof_answers : [];
    v.proof_headers = cj.proof_headers || ""; v.proof_body = cj.proof_body || "";
    v.pay_breakdown = cj.pay_breakdown || null;
  }
  return v;
}
async function contractTasksOf(jobId: number) {
  return await pg(`ex_contract_tasks?job_id=eq.${jobId}&select=*&order=entry_index.asc`);
}
// The shell view of schedule entries for non-parties: statuses and
// outcomes only - an entry's proof (recording, transcript, headers,
// body) is delivery content, parties only, like delivery notes.
function contractTaskView(task: any, includeProof = false) {
  const v: Record<string, unknown> = {
    id: task.id, entry_index: Number(task.entry_index), status: task.status, outcome: task.outcome || "",
    resolved_at: task.resolved_at || null,
  };
  if (includeProof) {
    v.proof_file_name = task.proof_file_name || ""; v.proof_file_type = task.proof_file_type || "";
    v.proof_sha256 = task.proof_sha256 || ""; v.proof_check = task.proof_check || {};
    v.proof_transcript = task.proof_transcript || ""; v.proof_answers = Array.isArray(task.proof_answers) ? task.proof_answers : [];
    v.proof_headers = task.proof_headers || ""; v.proof_body = task.proof_body || "";
  }
  return v;
}
// Parse a raw message header block (name: value lines, folded).
function parseHeaders(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  let cur = "";
  for (const line of String(raw || "").replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && cur) { map.set(cur, `${map.get(cur)} ${line.trim()}`); continue; }
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) { cur = m[1].toLowerCase(); if (!map.has(cur)) map.set(cur, m[2].trim()); }
    else cur = "";
  }
  return map;
}
// EMAIL PROOF CHECKS (deliveryChecks' email branch, Phase D): report-
// only, like every other delivery check - they grade the sent-message
// evidence an agent submits: the From must be the agent's attested
// sending address, a Message-ID must be present whose domain matches
// the From domain, and the subject must match the declared subject
// where the job declared one (sealed-file entries declare none here).
function emailProofChecks(headersRaw: string, opts: { expectedFrom?: string; expectedSubject?: string } = {}) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const headers = parseHeaders(headersRaw);
  const fromRaw = headers.get("from") || "";
  const fromAddr = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).trim().toLowerCase();
  const mid = headers.get("message-id") || "";
  const midDomain = (mid.match(/@([^>\s]+)>/)?.[1] || "").toLowerCase();
  const fromDomain = fromAddr.includes("@") ? fromAddr.split("@")[1] : "";
  const subject = headers.get("subject") || "";
  if (opts.expectedFrom) checks.push({ name: "from is the attested sending address", ok: !!fromAddr && fromAddr === opts.expectedFrom.toLowerCase(), detail: fromAddr ? `From: ${fromAddr}` : "no From header" });
  else checks.push({ name: "from header present", ok: !!fromAddr, detail: fromAddr ? `From: ${fromAddr}` : "no From header" });
  checks.push({ name: "message-id present, domain matches from", ok: !!mid && !!midDomain && !!fromDomain && midDomain === fromDomain, detail: mid ? `Message-ID domain ${midDomain || "?"} vs From domain ${fromDomain || "?"}` : "no Message-ID header" });
  if (opts.expectedSubject) checks.push({ name: "subject matches the declared subject", ok: subject === opts.expectedSubject, detail: subject ? `Subject: ${subject.slice(0, 120)}` : "no Subject header" });
  return { verdict: checks.every((c) => c.ok) ? "passed" : "flagged", checked_at: new Date().toISOString(), checks };
}
async function capabilitiesOf(agentIds: number[]) {
  const map = new Map<number, any[]>();
  if (!agentIds.length) return map;
  const rows = await pg(`ex_agent_capabilities?agent_id=in.(${agentIds.join(",")})&select=*`);
  const t = now();
  for (const r of rows) {
    const effective = r.status === "verified" && Number(r.expires_at || 0) <= t ? "expired" : r.status;
    const entry = {
      capability: r.capability, status: effective,
      attested_last4: r.attested_phone ? String(r.attested_phone).replace(/\D/g, "").slice(-4) : "",
      attested_email_masked: r.attested_email ? maskEmail(String(r.attested_email)) : "",
      verified_at: r.verified_at || null, expires_at: r.expires_at || null,
    };
    if (!map.has(r.agent_id)) map.set(r.agent_id, []);
    map.get(r.agent_id)!.push(entry);
  }
  return map;
}
async function assertContractGate(agent: any, job: any) {
  // CONTRACT GATE: a contract job can only be bid on / claimed by an
  // agent holding a VERIFIED, unexpired capability for the JOB's
  // capability - proven by that capability's test (the Call Test for
  // phone_call, the Email Test for email_send), never declared.
  if (!job || job.job_kind !== "contract") return;
  // AGENTS-ONLY (owner ruling, 2026-10-26, EVERY contract type): a
  // contract is for agents, never human profiles - this refusal
  // stands even if a capability row somehow exists for the profile.
  if (agent.is_human) {
    throw Object.assign(new Error("contracts are for verified agents only — human profiles cannot take contracts of any type"), { status: 400 });
  }
  const cj = await contractJobRow(job.id);
  const slug = cj?.capability || "phone_call";
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  if (!row || row.status !== "verified" || !row.expires_at || Number(row.expires_at) <= now()) {
    const attestHint = slug === "email_send" ? "attest your sending email address" : "attest your caller number";
    const sealedHint = slug === "email_send" ? "Unproven agents cannot bid on contract jobs, and never see the recipient." : "Unproven agents cannot bid on contract jobs, and never see the contact number.";
    throw Object.assign(new Error(`contract gate: this job needs a verified ${slug} capability - pass the ${testNameFor(slug)} first (${attestHint}, take the platform-issued challenge, submit the test result: GET /agent/capabilities). ${sealedHint}`), { status: 400 });
  }
  // SEALED SCHEDULE FILE: a scheduled contract cannot be worked until
  // the poster has attached its schedule file - the entries live in
  // that file and nowhere else, so there is nothing to bid on yet.
  if (cj && cj.task_count !== null && cj.task_count !== undefined && !cj.schedule_storage_path) {
    throw Object.assign(new Error("this scheduled contract is waiting on its poster: the sealed schedule file has not been attached yet, so bids and claims are closed until it is in."), { status: 400 });
  }
  // MATCH PRIORITY WINDOW (Phase C): for the first 15 minutes after
  // posting, only the invited agents (top-ranked verified agents for
  // the job's capability, computed at posting) may bid or claim. After
  // match_open_at the job opens to every verified agent for that
  // capability. Poster-side actions never come through this gate.
  const openAt = Number(cj?.match_open_at || 0);
  const invited: any[] = Array.isArray(cj?.match_invited) ? cj.match_invited : [];
  if (openAt > now() && invited.length && !invited.some((x: any) => Number(x?.agent_id) === Number(agent.id))) {
    throw Object.assign(new Error(`match priority window: this contract job is in its 15-minute priority window - only the invited ${verifiedLabelFor(slug)} agents can bid or claim until ${new Date(openAt * 1000).toISOString()}. After that it opens to every ${verifiedLabelFor(slug)} agent.`), { status: 403 });
  }
}
// MATCH ROUTING (Phase C, contract jobs only): at posting, rank the
// eligible agents for the job's capability - active, capability
// verified and unexpired, AGENTS ONLY (human profiles are excluded by
// the owner's agents-only ruling), and never the poster's own agents.
// Order: online first (presence heartbeat fresh within 120s), then
// rating/trust (the leaderboard fields), then jobs completed, then
// listed rate closest to the budget. The top 5 are invited.
async function computeContractMatches(job: any, contractSpec: any, posterUserId: number) {
  const t = now();
  const capRows = await pg(`ex_agent_capabilities?capability=eq.${q(contractSpec.capability)}&status=eq.verified&expires_at=gt.${t}&select=agent_id`);
  const ids = [...new Set(capRows.map((r: any) => Number(r.agent_id)))];
  if (!ids.length) return { invited: [] as { agent_id: number; invited_at: number }[], openAt: 0, agentsById: new Map<number, any>() };
  const agents = await pg(`ex_agents?id=in.(${ids.join(",")})&status=eq.active&is_human=eq.false&owner_id=neq.${posterUserId}&select=id,name,owner_id,rating_avg,rating_count,jobs_completed,rate_cents,webhook_url`);
  if (!agents.length) return { invited: [] as { agent_id: number; invited_at: number }[], openAt: 0, agentsById: new Map<number, any>() };
  const statusRows = await pg(`ex_agent_status?agent_id=in.(${ids.join(",")})&select=agent_id,last_heartbeat`);
  const hb = new Map<number, number>(statusRows.map((s: any) => [Number(s.agent_id), Number(s.last_heartbeat || 0)]));
  const budget = Number(job.budget_cents || 0);
  const ranked = agents.slice().sort((a: any, b: any) => {
    const onA = (hb.get(Number(a.id)) || 0) >= t - 120 ? 1 : 0;
    const onB = (hb.get(Number(b.id)) || 0) >= t - 120 ? 1 : 0;
    if (onA !== onB) return onB - onA;
    if (Number(b.rating_avg || 0) !== Number(a.rating_avg || 0)) return Number(b.rating_avg || 0) - Number(a.rating_avg || 0);
    if (Number(b.rating_count || 0) !== Number(a.rating_count || 0)) return Number(b.rating_count || 0) - Number(a.rating_count || 0);
    if (Number(b.jobs_completed || 0) !== Number(a.jobs_completed || 0)) return Number(b.jobs_completed || 0) - Number(a.jobs_completed || 0);
    const ra = a.rate_cents ? Math.abs(Number(a.rate_cents) - budget) : Number.MAX_SAFE_INTEGER;
    const rb = b.rate_cents ? Math.abs(Number(b.rate_cents) - budget) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
  const top = ranked.slice(0, CONTRACT_MATCH_TOP_N);
  return {
    invited: top.map((a: any) => ({ agent_id: Number(a.id), invited_at: t })),
    openAt: t + CONTRACT_MATCH_WINDOW_SEC,
    agentsById: new Map<number, any>(top.map((a: any) => [Number(a.id), a])),
  };
}
async function attestCapability(agent: any, slug: string, idRaw: unknown) {
  // AGENTS-ONLY (owner ruling, 2026-10-26, EVERY contract type): a
  // human profile cannot attest an identifier at all - contracts are
  // for agents, and a human profile can never hold a verification.
  if (agent.is_human) throw Object.assign(new Error(slug === "email_send"
    ? "human profiles cannot attest a sending address — email contracts are for verified agents only, and a human profile can never be Email Verified"
    : "human profiles cannot attest a caller number — call contracts are for verified agents only, and a human profile can never be Call Verified"), { status: 400 });
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}"`), { status: 404 });
  const isEmail = slug === "email_send";
  const ident = isEmail ? cleanEmail(idRaw) : cleanPhone(idRaw);
  if (!ident) throw Object.assign(new Error(isEmail
    ? "a valid sending email address is required - this is the address your proofs must be sent from"
    : "a valid caller number is required (7-15 digits, optional leading +) - this is the number your proofs must come from"), { status: 400 });
  const column = isEmail ? "attested_email" : "attested_phone";
  const existing = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  const t = now();
  if (existing) {
    // Changing the attested identifier invalidates a verification:
    // proofs must come from the attested identifier, so a new one
    // re-tests.
    const patch: Record<string, unknown> = { [column]: ident, updated_at: t };
    if (existing[column] !== ident && existing.status === "verified") { patch.status = "unverified"; patch.verified_at = null; patch.expires_at = null; }
    const rows = await pg(`ex_agent_capabilities?id=eq.${existing.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    return rows[0];
  }
  const rows = await pg("ex_agent_capabilities", { method: "POST", prefer: "return=representation", body: JSON.stringify({ agent_id: agent.id, capability: slug, [column]: ident, status: "unverified", test_ref: {}, created_at: t, updated_at: t }) });
  return rows[0];
}
const CHALLENGE_WORDS_A = ["amber", "brisk", "cobalt", "delta", "ember", "fable", "glacier", "harbor", "ivory", "juniper", "kestrel", "lumen", "meadow", "nickel", "onyx", "prairie", "quartz", "raven", "sable", "tundra"];
const CHALLENGE_WORDS_B = ["anvil", "birch", "cinder", "drizzle", "elm", "flint", "grove", "hazel", "ink", "jasper", "kraken", "lotus", "maple", "north", "opal", "pepper", "quill", "ridge", "sorrel", "timber"];
const CHALLENGE_WORDS_C = ["anchor", "beacon", "compass", "dagger", "engine", "falcon", "granite", "helmet", "island", "jacket", "kernel", "lantern", "magnet", "needle", "orchard", "pistol", "quiver", "rocket", "saddle", "temple"];
function challengePhrase(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(CHALLENGE_WORDS_A)} ${pick(CHALLENGE_WORDS_B)} ${pick(CHALLENGE_WORDS_C)}`;
}
const EMAIL_TEST_QUESTIONS = [
  "State your agent name exactly as it is listed on the Exchange.",
  "In one sentence, what is a contract email job on the Exchange?",
];
async function startCallTest(agent: any, slug: string) {
  // AGENTS-ONLY (owner ruling, 2026-10-26, EVERY contract type): a
  // human profile cannot take a capability test - contracts are for
  // agents, and a human profile can never hold a verification.
  if (agent.is_human) throw Object.assign(new Error(slug === "email_send"
    ? "human profiles cannot take the Email Test — email contracts are for verified agents only, and a human profile can never be Email Verified"
    : "human profiles cannot take the Call Test — call contracts are for verified agents only, and a human profile can never be Call Verified"), { status: 400 });
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}"`), { status: 404 });
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  const t = now();
  if (slug === "email_send") {
    if (!row?.attested_email) throw Object.assign(new Error("attest your sending email address first - proofs are only accepted from the address you register"), { status: 400 });
    await pg(`ex_capability_tests?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&status=eq.started`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
    // The challenge token rides in the test row's phrase column: the
    // graded artefact is the subject line carrying this exact token.
    const token = `${challengePhrase()} ${1000 + Math.floor(Math.random() * 9000)}`;
    const rows = await pg("ex_capability_tests", { method: "POST", prefer: "return=representation", body: JSON.stringify({ agent_id: agent.id, capability: slug, phrase: token, questions: EMAIL_TEST_QUESTIONS, status: "started", created_at: t, expires_at: t + 3600 }) });
    return {
      test_id: rows[0].id, capability: slug, attested_email: row.attested_email,
      challenge_token: token, questions: EMAIL_TEST_QUESTIONS, expires_at: t + 3600, pass_score: CONTRACT_PASS_SCORE,
      instructions: "This is a platform-issued challenge - the Exchange never sends email itself and claims no sending service. Using YOUR OWN mail stack, compose and send a real test message FROM your attested address (to any address you control): the subject line must contain the challenge token exactly; the body must identify you as an AI assistant acting on behalf of your owner and answer both questions. Then submit the proof pack here (JSON or multipart): the message's FULL headers (field: headers - including From, Subject, Message-ID and your DKIM-Signature), the full body (field: body), and your two answers (field: answers, a JSON list). Grading is automatic: token in the subject 35, AI-assistant disclosure + required content 25, answers 20, header authenticity (From is your attested address, Message-ID present with a domain matching the From domain, DKIM-Signature present) 20 - pass at 70.",
    };
  }
  if (!row?.attested_phone) throw Object.assign(new Error("attest your caller number first - proofs are only accepted from the number you register"), { status: 400 });
  await pg(`ex_capability_tests?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&status=eq.started`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
  // THE CALL TEST IS A RING TEST (owner clarification, 2026-10-26
  // 18:41 PDT): the agent dials the Nova test number from its attested
  // number; if the number RINGS, the agent hangs up by itself - no
  // answer is waited for, no conversation is held, nothing is spoken.
  // The ring itself is the proof of reachability + a working calling
  // stack. The agent then submits a call report and grading checks the
  // report (dialed == test number, caller == attested, outcome ==
  // rang). The phrase column carries an internal ring-test reference
  // only - it is never spoken and never graded.
  const phrase = `ring-test-${100000 + Math.floor(Math.random() * 900000)}`;
  const rows = await pg("ex_capability_tests", { method: "POST", prefer: "return=representation", body: JSON.stringify({ agent_id: agent.id, capability: slug, phrase, questions: [], status: "started", created_at: t, expires_at: t + 3600 }) });
  return {
    test_id: rows[0].id, capability: slug, attested_phone: row.attested_phone,
    test_number: CALL_TEST_NUMBER, call_test_number: CALL_TEST_NUMBER, test_number_display: CALL_TEST_NUMBER_DISPLAY,
    test_type: "ring", expires_at: t + 3600, pass_score: CONTRACT_PASS_SCORE,
    instructions: `This is the Call Test - a RING TEST. Using YOUR OWN calling stack, dial the Nova test number ${CALL_TEST_NUMBER_DISPLAY} (${CALL_TEST_NUMBER}) FROM your attested number. If the number RINGS, hang up (cut the call) by yourself - do NOT wait for an answer and do NOT hold a conversation; the ring itself proves the number is reachable and that your stack can place a real call. Then submit the call report for this test (POST /agent/capabilities/tests/:testId/submit, JSON): { dialed_number: "${CALL_TEST_NUMBER}", from_number: your attested number, outcome: "rang", rang_at: the ring timestamp (epoch seconds), duration_sec: how long it rang before you cut }. Grading is automatic and simple: pass requires dialed_number == the Nova test number, from_number == your attested number, and outcome == "rang". The platform does not operate telephony and cannot hear the ring itself - grading is on your submitted call report, tied to this test and your attested number. Pass and you are Call Verified for 90 days: you may then BID on call contracts, WAIT for the job poster's approval (the award), and only after award place the real call to the job's contact and deliver the job's proof pack (recording + transcript + answers).`,
  };
}
async function submitCallTest(agent: any, testId: number, input: DeliveryInput) {
  const test = await one(`ex_capability_tests?id=eq.${testId}&agent_id=eq.${agent.id}&select=*`);
  if (!test) throw Object.assign(new Error("capability test not found"), { status: 404 });
  // AGENTS-ONLY (owner ruling, 2026-10-26, EVERY contract type): as
  // startCallTest - a human profile can never submit a test proof.
  if (agent.is_human) throw Object.assign(new Error(test.capability === "email_send"
    ? "human profiles cannot take the Email Test — email contracts are for verified agents only, and a human profile can never be Email Verified"
    : "human profiles cannot take the Call Test — call contracts are for verified agents only, and a human profile can never be Call Verified"), { status: 400 });
  if (test.status !== "started") throw Object.assign(new Error(`this ${testNameFor(test.capability)} is ${test.status} - start a fresh one`), { status: 400 });
  if (Number(test.expires_at) < now()) { await pg(`ex_capability_tests?id=eq.${test.id}`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) }); throw Object.assign(new Error(`this ${testNameFor(test.capability)} challenge has expired (1 hour) - start a fresh one`), { status: 400 }); }
  if (test.capability === "email_send") return await submitEmailTest(agent, test, input);
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(test.capability)}&select=*`);
  if (!row?.attested_phone) throw Object.assign(new Error("no attested caller number on file for this agent"), { status: 400 });
  // THE RING-TEST CALL REPORT (owner clarification, 2026-10-26 18:41
  // PDT): the Call Test submission is a call report, NOT a proof pack -
  // no recording, no transcript, no phrase, no answers. Fields (JSON or
  // form): dialed_number, from_number, outcome, rang_at, duration_sec.
  // Anti-abuse: the report is bound to THIS started test row and to the
  // attested number on file - a report naming any other destination or
  // any other caller fails, as does any outcome other than "rang".
  // HONESTY: the platform cannot hear the ring; grading is on the
  // submitted report, exactly as the copy states.
  const f = input.fields || {};
  const dialedRaw = String(f.dialed_number || f.dialed || f.to_number || "").trim();
  const fromRaw = String(f.from_number || f.from || f.caller_number || "").trim();
  const outcome = String(f.outcome || "").trim().toLowerCase();
  if (!dialedRaw || !fromRaw || !outcome) throw Object.assign(new Error("the Call Test submission is a call report: { dialed_number, from_number, outcome, rang_at, duration_sec } - no recording or transcript is needed for the test"), { status: 400 });
  const digitsOf = (x: string) => String(x || "").replace(/\D/g, "");
  const dialedDigits = digitsOf(dialedRaw);
  const dialedOk = dialedDigits === digitsOf(CALL_TEST_NUMBER) || dialedDigits === digitsOf(CALL_TEST_NUMBER).slice(1);
  const fromOk = digitsOf(fromRaw) === digitsOf(row.attested_phone) || digitsOf(fromRaw) === digitsOf(row.attested_phone).replace(/^1/, "");
  const rangOk = outcome === "rang" || outcome === "ringing" || outcome === "ring_detected";
  let rangAt = Number(f.rang_at || f.rangAt || f.timestamp || 0);
  if (!Number.isFinite(rangAt) || rangAt <= 0) { const parsed = Date.parse(String(f.rang_at || "")); rangAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0; }
  const durationSec = Math.max(0, Math.min(3600, Number(f.duration_sec || f.duration || 0) || 0));
  const callReport = { dialed_number: dialedRaw, from_number: fromRaw, outcome, rang_at: rangAt || null, duration_sec: durationSec, test_id: test.id, attested_phone: row.attested_phone, submitted_via: "call_report" };
  const report: { label: string; ok: boolean; points: number; earned: number }[] = [];
  const grade = (label: string, ok: boolean, points: number) => { report.push({ label, ok, points, earned: ok ? points : 0 }); return ok ? points : 0; };
  let score = 0;
  score += grade("dialed number is the Nova test number", dialedOk, 40);
  score += grade("call placed from the attested number", fromOk, 30);
  score += grade("outcome is rang (ring detected, agent cut the call itself)", rangOk, 30);
  const passed = dialedOk && fromOk && rangOk && score >= CONTRACT_PASS_SCORE;
  const t = now();
  const reportSha = await sha256hex(JSON.stringify(callReport));
  await pg(`ex_capability_tests?id=eq.${test.id}`, { method: "PATCH", body: JSON.stringify({ status: passed ? "passed" : "failed", score, report: { checks: report, call_report: callReport }, recording_sha256: reportSha, submitted_at: t }) });
  if (passed) {
    const capPatch = { status: "verified", verified_at: t, expires_at: t + CONTRACT_CAPABILITY_TTL, test_ref: { last_test_id: test.id, score, call_report_sha256: reportSha, graded_at: t }, updated_at: t };
    if (row.id) await pg(`ex_agent_capabilities?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(capPatch) });
    await feed("review", `${agent.name} passed the ${test.capability} Call Test (${score}/100) - Call Verified`, null);
  }
  return { test_id: test.id, score, passed, pass_score: CONTRACT_PASS_SCORE, report, call_report: callReport, capability_status: passed ? "verified" : row.status, expires_at: passed ? t + CONTRACT_CAPABILITY_TTL : null, report_sha256: reportSha };
}
// THE EMAIL TEST (Phase D): the mirror of the Call Test for email_send.
// The platform issues a challenge (a rotating token + two set
// questions); the agent composes and sends a real test message with
// its OWN mail stack from its attested address, then submits the proof
// pack: the message's full headers + full body + the two answers. The
// platform never sends the test message - it only issues and grades.
// Grading: token in the subject 35 / disclosure + required content 25
// / answers 20 / header authenticity 20 - pass at 70, verified 90 days.
async function submitEmailTest(agent: any, test: any, input: DeliveryInput) {
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.email_send&select=*`);
  if (!row?.attested_email) throw Object.assign(new Error("no attested sending address on file for this agent"), { status: 400 });
  const headers = String(input.fields.headers || "").trim();
  if (headers.length < 40) throw Object.assign(new Error("the proof pack needs the test message's FULL headers (field: headers) - From, Subject, Message-ID and DKIM-Signature included"), { status: 400 });
  const body = String(input.fields.body || input.fields.message || "").trim();
  if (body.length < 20) throw Object.assign(new Error("the proof pack needs the test message's full body (field: body)"), { status: 400 });
  let answers: any[] = [];
  const answersRaw = String(input.fields.answers || "").trim();
  if (answersRaw) { try { answers = JSON.parse(answersRaw); } catch { throw Object.assign(new Error("answers must be a JSON list of strings, one per test question"), { status: 400 }); } }
  if (!Array.isArray(answers)) throw Object.assign(new Error("answers must be a JSON list of strings, one per test question"), { status: 400 });
  const parsed = parseHeaders(headers);
  const subject = parsed.get("subject") || "";
  const report: { label: string; ok: boolean; points: number; earned: number }[] = [];
  const grade = (label: string, ok: boolean, points: number) => { report.push({ label, ok, points, earned: ok ? points : 0 }); return ok ? points : 0; };
  let score = 0;
  score += grade("challenge token in the subject line", !!String(test.phrase) && subject.includes(String(test.phrase)), 35);
  score += grade("body identifies the sender as an AI assistant acting for its owner, with the required content", /ai assistant/i.test(body) && /(on behalf of|acting for|for my owner|my principal|sent by)/i.test(body), 25);
  score += grade("both challenge questions answered", Array.isArray(test.questions) && answers.length === test.questions.length && answers.every((a: any) => String(a || "").trim().length >= 2), 20);
  const auth = emailProofChecks(headers, { expectedFrom: row.attested_email });
  const fromOk = auth.checks.find((x) => x.name.startsWith("from is"))?.ok === true;
  const midOk = auth.checks.find((x) => x.name.startsWith("message-id"))?.ok === true;
  const dkimOk = parsed.has("dkim-signature");
  score += grade("header authenticity: From is the attested address, Message-ID domain matches, DKIM-Signature present", fromOk && midOk && dkimOk, 20);
  const passed = score >= CONTRACT_PASS_SCORE;
  const t = now();
  const packSha = await sha256hex(`${headers}\n\n${body}`);
  await pg(`ex_capability_tests?id=eq.${test.id}`, { method: "PATCH", body: JSON.stringify({ status: passed ? "passed" : "failed", score, report: { checks: report, attested_email: row.attested_email, header_checks: auth.checks }, recording_sha256: packSha, submitted_at: t }) });
  if (passed) {
    const capPatch = { status: "verified", verified_at: t, expires_at: t + CONTRACT_CAPABILITY_TTL, test_ref: { last_test_id: test.id, score, proof_sha256: packSha, graded_at: t }, updated_at: t };
    if (row.id) await pg(`ex_agent_capabilities?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(capPatch) });
    await feed("review", `${agent.name} passed the email_send Email Test (${score}/100) - Email Verified`, null);
  }
  return { test_id: test.id, score, passed, pass_score: CONTRACT_PASS_SCORE, report, capability_status: passed ? "verified" : row.status, expires_at: passed ? t + CONTRACT_CAPABILITY_TTL : null, proof_sha256: packSha };
}
async function openContractAttempt(job: any, agent: any, entryIndex?: number) {
  const cj = await contractJobRow(job.id);
  if (!cj) throw Object.assign(new Error("this job has no contract record"), { status: 400 });
  if (job.awarded_agent_id !== agent.id) throw Object.assign(new Error("only the awarded agent can open attempts on this job"), { status: 403 });
  if (job.status !== "awarded") throw Object.assign(new Error(`attempts can only be opened while the job is awarded (it is ${job.status})`), { status: 400 });
  const t = now();
  const slug = cj.capability || "phone_call";
  const scheduled = cj.task_count !== null && cj.task_count !== undefined;
  // The window is STRICT: no early opening, no late opening. For a
  // scheduled contract this window is the schedule window.
  if (t < Number(cj.window_start)) throw Object.assign(new Error(`the ${scheduled ? "schedule" : (slug === "email_send" ? "send" : "call")} window has not opened yet - it opens ${windowInstant(Number(cj.window_start), cj.window_tz)} - in ${fmtCountdown(Number(cj.window_start) - t)}. Act on the UTC instant and the countdown, never on your own local clock.`), { status: 400 });
  if (t > Number(cj.window_end)) throw Object.assign(new Error(`the ${scheduled ? "schedule" : (slug === "email_send" ? "send" : "call")} window has closed - it ended ${windowInstant(Number(cj.window_end), cj.window_tz)}. Act on the UTC instant, never on your own local clock.`), { status: 400 });
  const attempts = await contractAttemptsOf(job.id);
  if (scheduled) {
    // PER-ENTRY attempts (Phase D): each schedule entry carries its
    // own attempt budget and its own open-attempt slot; entries work
    // independently of each other.
    const idx = Math.floor(Number(entryIndex || 0));
    if (!idx || idx < 1 || idx > Number(cj.task_count)) throw Object.assign(new Error(`a scheduled contract attempt needs entry_index: the schedule entry being worked (1..${cj.task_count}) - pass it in the request body`), { status: 400 });
    const task = await one(`ex_contract_tasks?job_id=eq.${job.id}&entry_index=eq.${idx}&select=*`);
    if (!task) throw Object.assign(new Error(`schedule entry ${idx} does not exist on this job`), { status: 404 });
    if (task.status === "proved" || task.status === "failed") throw Object.assign(new Error(`schedule entry ${idx} is already resolved (${task.status})`), { status: 400 });
    const mine = attempts.filter((a: any) => Number(a.task_id) === Number(task.id));
    if (mine.length >= Number(cj.max_attempts)) throw Object.assign(new Error(`attempt budget spent on entry ${idx}: this job allows at most ${cj.max_attempts} attempts per entry`), { status: 400 });
    if (mine.some((a: any) => !a.ended_at)) throw Object.assign(new Error(`an attempt is already open on entry ${idx} - close it with its outcome first`), { status: 400 });
    const rows = await pg("ex_contract_attempts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, task_id: task.id, started_at: t, created_at: t }) });
    if (task.status === "pending") await pg(`ex_contract_tasks?id=eq.${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "attempted", updated_at: t }) });
    return rows[0];
  }
  if (attempts.length >= Number(cj.max_attempts)) throw Object.assign(new Error(`attempt budget spent: this job allows at most ${cj.max_attempts} attempts`), { status: 400 });
  if (attempts.some((a: any) => !a.ended_at)) throw Object.assign(new Error("an attempt is already open on this job - close it with its outcome first (one attempt at a time)"), { status: 400 });
  const rows = await pg("ex_contract_attempts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, started_at: t, created_at: t }) });
  return rows[0];
}
async function closeContractAttempt(job: any, agent: any, attemptId: number, b: any) {
  const cj = await contractJobRow(job.id);
  if (!cj) throw Object.assign(new Error("this job has no contract record"), { status: 400 });
  const attempt = await one(`ex_contract_attempts?id=eq.${attemptId}&job_id=eq.${job.id}&select=*`);
  if (!attempt) throw Object.assign(new Error("attempt not found"), { status: 404 });
  if (attempt.agent_id !== agent.id) throw Object.assign(new Error("this attempt belongs to another agent"), { status: 403 });
  if (attempt.ended_at) throw Object.assign(new Error("this attempt is already closed"), { status: 400 });
  const slug = cj.capability || "phone_call";
  const valid = outcomesFor(slug);
  const outcome = String(b.outcome || "");
  if (!valid.includes(outcome)) throw Object.assign(new Error(`outcome must be one of: ${valid.join(", ")}`), { status: 400 });
  const duration = Math.max(0, Math.min(86400, Math.floor(Number(b.duration_sec || 0))));
  const t = now();
  const rows = await pg(`ex_contract_attempts?id=eq.${attempt.id}&ended_at=is.null`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ ended_at: t, outcome, duration_sec: duration }) });
  if (!rows.length) throw Object.assign(new Error("attempt was already closed"), { status: 409 });
  if (attempt.task_id) {
    // PER-ENTRY close (Phase D): the entry records the outcome; a
    // terminal outcome leaves it ready for its per-entry proof, and a
    // non-terminal outcome with the entry's budget spent resolves it
    // as failed (it settles at its outcome's percentage - 0 by rule).
    const patch: Record<string, unknown> = { outcome, updated_at: t };
    const entryAttempts = (await contractAttemptsOf(job.id)).filter((a: any) => Number(a.task_id) === Number(attempt.task_id));
    if (!terminalOutcomesFor(slug).includes(outcome) && entryAttempts.length >= Number(cj.max_attempts)) { patch.status = "failed"; patch.resolved_at = t; }
    await pg(`ex_contract_tasks?id=eq.${attempt.task_id}`, { method: "PATCH", body: JSON.stringify(patch) });
    return { attempt: rows[0], entry_outcome: outcome };
  }
  // The job's final outcome: a terminal outcome settles it; otherwise,
  // when the attempt budget is exhausted, the last outcome settles it.
  let finalOutcome = cj.final_outcome || "";
  if (!finalOutcome) {
    const attempts = await contractAttemptsOf(job.id);
    if (terminalOutcomesFor(slug).includes(outcome) || attempts.length >= Number(cj.max_attempts)) {
      finalOutcome = outcome;
      await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ final_outcome: outcome }) });
    }
  }
  return { attempt: rows[0], final_outcome: finalOutcome };
}
// ---------- SEALED SCHEDULE FILE (Phase D) ----------
// The schedule file is the ONLY place a scheduled contract's private
// data exists. It is stored in the private deliverables bucket under
// the contract/schedules prefix, its SHA-256 is pinned on the contract
// row at upload, its bytes never appear in any API JSON, and every
// download is audit-logged in ex_schedule_file_access.
const SCHEDULE_FILE_EXTS = ["txt", "csv", "md", "pdf", "json", "docx", "xlsx", "zip"];
function scheduleFileKind(file: File, bytes: Uint8Array): { ok: boolean; detail: string } {
  const name = String(file.name || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (!SCHEDULE_FILE_EXTS.includes(ext)) return { ok: false, detail: `file type .${ext || "?"} is not allowed - schedule files must be one of: ${SCHEDULE_FILE_EXTS.join(", ")}` };
  const head = bytes.slice(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (ext === "pdf") return { ok: bytes.length >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === "%PDF", detail: "pdf signature check" };
  if (ext === "zip" || ext === "docx" || ext === "xlsx") return { ok: isZip, detail: "zip container signature check" };
  // Text family: must decode as UTF-8 with no NUL bytes in the sample.
  const sample = bytes.slice(0, 8192);
  if (sample.some((x) => x === 0)) return { ok: false, detail: "file looks binary, not text" };
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample); } catch { return { ok: false, detail: "file is not valid UTF-8 text" }; }
  if (ext === "json") { try { JSON.parse(new TextDecoder().decode(bytes)); } catch { return { ok: false, detail: "file does not parse as JSON" }; } }
  return { ok: true, detail: "text file" };
}
async function uploadScheduleFile(job: any, actorUserId: number, isAdmin: boolean, input: DeliveryInput) {
  const cj = await contractJobRow(job.id);
  if (!cj) throw Object.assign(new Error("this job has no contract record"), { status: 400 });
  if (cj.task_count === null || cj.task_count === undefined) throw Object.assign(new Error("this is not a scheduled contract - only scheduled contracts carry a sealed schedule file"), { status: 400 });
  if (!isAdmin && job.poster_user_id !== actorUserId) throw Object.assign(new Error("only the poster can attach the schedule file"), { status: 403 });
  if (job.status !== "open") throw Object.assign(new Error(`the schedule file can only be attached while the job is open (it is ${job.status})`), { status: 400 });
  if (!input.file) throw Object.assign(new Error("attach the schedule file as multipart field: file"), { status: 400 });
  const buf = await input.file.arrayBuffer();
  const kind = scheduleFileKind(input.file, new Uint8Array(buf));
  if (!kind.ok) throw Object.assign(new Error(`schedule file rejected: ${kind.detail}`), { status: 400 });
  const stored = await storeDeliveryFile(job.id, input.file, "contract/schedules");
  if (cj.schedule_storage_path && cj.schedule_storage_path !== stored.storage_path) await deleteDeliveryFile(cj.schedule_storage_path).catch(() => null);
  await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ schedule_file_name: stored.file_name, schedule_file_size: stored.file_size, schedule_file_type: stored.file_type, schedule_storage_path: stored.storage_path, schedule_sha256: stored.sha256 }) });
  return { file_name: stored.file_name, file_size: stored.file_size, file_type: stored.file_type, sha256: stored.sha256, task_count: Number(cj.task_count), note: "Sealed. The file's contents are visible to no one through the API - the awarded agent downloads it over a short-lived signed link after award, and every download is logged." };
}
// actor: who is asking, already authorized by the route. role is what
// gets written into the audit log.
async function downloadScheduleFile(job: any, actor: { userId: number; agentId: number | null; role: string }) {
  const cj = await contractJobRow(job.id);
  if (!cj?.schedule_storage_path) throw Object.assign(new Error("this contract has no schedule file attached"), { status: 404 });
  const t = now();
  await pg("ex_schedule_file_access", { method: "POST", body: JSON.stringify({ job_id: job.id, actor_user_id: actor.userId || null, actor_agent_id: actor.agentId || null, actor_role: actor.role, created_at: t }) });
  const url = await signedDeliveryUrl(cj.schedule_storage_path, cj.schedule_file_name || undefined);
  return { url, file_name: cj.schedule_file_name || "", file_size: Number(cj.schedule_file_size || 0), sha256: cj.schedule_sha256 || "", expires_in: 600 };
}
async function scheduleAccessOf(jobId: number) {
  return await pg(`ex_schedule_file_access?job_id=eq.${jobId}&select=id,actor_user_id,actor_agent_id,actor_role,created_at&order=created_at.asc`);
}
// PER-ENTRY PROOF (Phase D): the awarded agent proves ONE schedule
// entry. Call entries: recording + transcript + answers (the Phase A
// proof rules). Email entries: the sent message's headers + body,
// graded by emailProofChecks against the agent's attested address
// (and the declared subject, where the job itself declared one).
async function submitTaskProof(job: any, agent: any, entryIndex: number, input: DeliveryInput) {
  const cj = await contractJobRow(job.id);
  if (!cj) throw Object.assign(new Error("this job has no contract record"), { status: 400 });
  if (job.awarded_agent_id !== agent.id) throw Object.assign(new Error("only the awarded agent can submit entry proof on this job"), { status: 403 });
  if (job.status !== "awarded") throw Object.assign(new Error(`entry proof can only be submitted while the job is awarded (it is ${job.status})`), { status: 400 });
  const idx = Math.floor(Number(entryIndex || 0));
  const task = await one(`ex_contract_tasks?job_id=eq.${job.id}&entry_index=eq.${idx}&select=*`);
  if (!task) throw Object.assign(new Error(`schedule entry ${idx} does not exist on this job`), { status: 404 });
  if (task.status === "proved" || task.status === "failed") throw Object.assign(new Error(`schedule entry ${idx} is already resolved (${task.status})`), { status: 400 });
  const slug = cj.capability || "phone_call";
  if (!terminalOutcomesFor(slug).includes(String(task.outcome || ""))) throw Object.assign(new Error(`entry ${idx} has no completed attempt yet - log an attempt and close it with a terminal outcome (${terminalOutcomesFor(slug).join(", ")}) before submitting its proof`), { status: 400 });
  const t = now();
  if (slug === "email_send") {
    const headers = String(input.fields.headers || "").trim();
    if (headers.length < 40) throw Object.assign(new Error("email entry proof needs the sent message's full headers (field: headers), Message-ID included"), { status: 400 });
    const bodyText = String(input.fields.body || input.fields.message || "").trim();
    if (bodyText.length < 10) throw Object.assign(new Error("email entry proof needs a copy of the sent message body (field: body)"), { status: 400 });
    const capRow = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.email_send&select=*`);
    const check = emailProofChecks(headers, { expectedFrom: capRow?.attested_email || "", expectedSubject: cj.task_count === null || cj.task_count === undefined ? (cj.email_subject || "") : "" });
    await pg(`ex_contract_tasks?id=eq.${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "proved", resolved_at: t, proof_headers: headers.slice(0, 20000), proof_body: bodyText.slice(0, 20000), proof_check: check, updated_at: t }) });
    return { entry_index: idx, status: "proved", proof_check: check };
  }
  const transcript = String(input.fields.transcript || "").trim();
  if (transcript.length < 10) throw Object.assign(new Error("call entry proof needs the call transcript (field: transcript)"), { status: 400 });
  let answers: any[] = [];
  const answersRaw = String(input.fields.answers || "").trim();
  if (answersRaw) { try { answers = JSON.parse(answersRaw); } catch { throw Object.assign(new Error("answers must be a JSON list of strings, one per job question"), { status: 400 }); } }
  const questions = Array.isArray(cj.questions) ? cj.questions : [];
  if (!Array.isArray(answers) || answers.length !== questions.length) throw Object.assign(new Error(`call entry proof needs exactly ${questions.length} answers (field: answers, a JSON list) - one per question on this job`), { status: 400 });
  if (!input.file) throw Object.assign(new Error("call entry proof needs the call recording (multipart field: file) - a link is not proof"), { status: 400 });
  if (!isAudioFile(input.file)) throw Object.assign(new Error("the entry recording must be an audio file (mp3, wav, ogg, webm, m4a, opus or flac)"), { status: 400 });
  const stored = await storeDeliveryFile(job.id, input.file, "contract");
  await pg(`ex_contract_tasks?id=eq.${task.id}`, { method: "PATCH", body: JSON.stringify({ status: "proved", resolved_at: t, proof_storage_path: stored.storage_path, proof_file_name: stored.file_name, proof_file_type: stored.file_type, proof_sha256: stored.sha256, proof_check: stored.check, proof_transcript: transcript, proof_answers: answers, updated_at: t }) });
  return { entry_index: idx, status: "proved", proof_sha256: stored.sha256, proof_check: stored.check };
}
async function revokeCapability(agentId: number, slug: string, reason: string) {
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agentId}&capability=eq.${q(slug)}&select=*`);
  if (!row) throw Object.assign(new Error("that agent holds no such capability record"), { status: 404 });
  const rows = await pg(`ex_agent_capabilities?id=eq.${row.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "revoked", test_ref: { ...(row.test_ref || {}), revoked_at: now(), revoke_reason: String(reason || "").slice(0, 300) }, updated_at: now() }) });
  const agent = await one(`ex_agents?id=eq.${agentId}&select=name,owner_id`);
  if (agent) await notify(agent.owner_id, "security", `${agent.name}'s ${slug} capability was revoked by an admin${reason ? `: ${String(reason).slice(0, 200)}` : ""}. The agent must pass the ${testNameFor(slug)} again before it can bid on contract jobs.`, `#/agent/${agentId}`);
  return rows[0];
}

// ---------- email system (verification, password reset, broadcasts) ----------
// Mail itself is sent by the exchange-mailerd service from ex_outbox rows;
// this function only mints single-use hashed tokens and queues the mail.
const SITE_URL = "https://exchange.novamail.store";
async function mintEmailToken(userId: number, kind: "verify" | "reset", ttlSec: number) {
  await pg(`ex_email_tokens?user_id=eq.${userId}&kind=eq.${kind}&used_at=is.null`, { method: "PATCH", body: JSON.stringify({ used_at: now() }) });
  const raw = randomToken(32);
  await pg("ex_email_tokens", { method: "POST", body: JSON.stringify({ user_id: userId, kind, token_hash: await sha256hex(raw), expires_at: now() + ttlSec, created_at: now() }) });
  return raw;
}
async function queueMail(kind: string, toEmail: string, toName: string, payload: Record<string, unknown>, subject?: string) {
  await pg("ex_outbox", { method: "POST", body: JSON.stringify({ kind, to_email: toEmail, to_name: toName || null, subject: subject || null, payload, created_at: now() }) });
}
async function queueVerifyMail(user: { id: number; email: string; name: string }) {
  const raw = await mintEmailToken(user.id, "verify", 60 * 60 * 24);
  await queueMail("verify", user.email, user.name, { name: user.name, link: `${SITE_URL}/#/verify-email?token=${raw}` });
}
// Every password change notifies the account owner: a security email from
// no-reply@novamail.store (via ex_outbox -> exchange-mailerd) AND an in-app
// notification, so a hijacked session can never silently rotate the password.
async function queuePasswordChangedMail(user: { id: number; email: string; name: string }, source: "settings" | "reset", req: Request): Promise<boolean> {
  let when = new Date().toISOString();
  try { when = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "long", timeZone: "UTC" }); } catch { /* ISO fallback */ }
  const ip = clientIp(req);
  const payload: Record<string, unknown> = {
    name: user.name,
    when,
    source_label: source === "reset" ? "Changed using a password reset link" : "Changed in your account settings",
    reset_link: `${SITE_URL}/#/forgot`,
  };
  if (ip) payload.ip = ip;
  // Mail and in-app notification are independent: one failing must not eat the other.
  let mailed = false;
  try { await queueMail("password_changed", user.email, user.name, payload); mailed = true; } catch (e) { console.error("password-changed mail queue failed for user", user.id, e); }
  try { await notify(user.id, "security", "Your password was changed — we emailed you the details. If this wasn't you, reset your password right away.", "#/forgot"); } catch (e) { console.error("password-changed notification failed for user", user.id, e); }
  return mailed;
}
// ---------- job-lifecycle emails (owner's order, 2026-10-26) ----------
// Every lifecycle step also sends a real email via ex_outbox ->
// exchange-mailerd (no-reply@novamail.store, Nova Inc). Queueing is
// best-effort: a mail failure must never break the job or the money.
async function userContact(userId: number) {
  return await one(`ex_users?id=eq.${userId}&select=email,name`);
}
const fmtMoney = (c: number) => "$" + (Number(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDeadline(ts: number) {
  try { return new Date(ts * 1000).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }) + " UTC"; } catch { return new Date(ts * 1000).toISOString(); }
}
async function queueLifecycleMail(kind: string, userId: number, payload: Record<string, unknown>) {
  try {
    const c = await userContact(userId);
    if (c?.email) await queueMail(kind, c.email, c.name || "", { name: c.name || "", ...payload });
  } catch (e) { console.error("lifecycle mail queue failed", kind, "for user", userId, e); }
}
// AGENT CAP (owner's pick, 2026-10-26): one account can have at most 3
// agents. Suspended agents (deleted listings) do not count - suspending one
// frees its slot. The owner's single human worker profile is separate and
// never counts toward the cap.
const MAX_AGENTS_PER_ACCOUNT = 3;
async function assertAgentSlot(ownerId: number) {
  const rows = await pg(`ex_agents?owner_id=eq.${ownerId}&status=neq.suspended&select=id,is_human,api_revoked`);
  const count = rows.filter((r: any) => !r.is_human && !r.api_revoked).length;
  if (count >= MAX_AGENTS_PER_ACCOUNT) throw Object.assign(new Error(`agent limit reached: one account can have at most ${MAX_AGENTS_PER_ACCOUNT} agents. Revoke an existing agent's API key (or an admin suspension) frees a slot - agents themselves are permanent and cannot be deleted.`), { status: 400 });
}
// RATE LIMIT (owner's rule #1, 2026-10-26): at most 120 authenticated API
// calls per minute per key - per user account on the web surface, per agent
// on the agent surface. Counted by the atomic ex_rate_hit() RPC over a
// fixed 60-second window per identity (row-locked upsert, so the cap is
// exact even under parallel hammering); going over returns 429. Every call
// counts, including rejected ones. The limiter fails OPEN on
// infrastructure errors (a broken counter must never take the site down)
// and CLOSED only on a real breach.
const RATE_LIMIT_PER_MIN = 120;
const MAX_JOB_POSTS_PER_DAY = 3;
const POSTING_FEE_CENTS = 200;
async function rateLimit(identity: string) {
  try {
    const res: any = await rpc("ex_rate_hit", { p_identity: identity, p_now: now() });
    const hits = typeof res === "number" ? res : Number(res?.ex_rate_hit ?? (Array.isArray(res) ? res[0]?.ex_rate_hit : 0) ?? 0);
    if (hits > RATE_LIMIT_PER_MIN) throw Object.assign(new Error(`rate limit reached: at most ${RATE_LIMIT_PER_MIN} API calls per minute per key. Slow down and retry in a few seconds.`), { status: 429 });
  } catch (e: any) {
    if (e && e.status === 429) throw e;
    console.error("rate limiter error (failing open)", identity, e);
  }
}
// AUTH RATE LIMITS: the unauthenticated auth routes get their own, much
// tighter per-IP / per-email counters (same atomic ex_rate_hit RPC, same
// fail-open-on-infra-error policy as the main limiter).
async function rateLimitAuth(identity: string, limit: number) {
  try {
    const res: any = await rpc("ex_rate_hit", { p_identity: identity, p_now: now() });
    const hits = typeof res === "number" ? res : Number(res?.ex_rate_hit ?? (Array.isArray(res) ? res[0]?.ex_rate_hit : 0) ?? 0);
    if (hits > limit) throw Object.assign(new Error("too many attempts — wait a minute"), { status: 429 });
  } catch (e: any) {
    if (e && e.status === 429) throw e;
    console.error("auth rate limiter error (failing open)", identity, e);
  }
}
// WEBHOOK SAFETY: a webhook URL is fetched by the platform, so it must be
// a public http(s) address - never loopback, private, link-local or
// internal names (SSRF guard). Empty means "no webhook" and is allowed.
function isSafeWebhookUrl(raw: string): boolean {
  const s = String(raw || "").trim();
  if (!s) return true;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  if (host.includes(":")) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1" || /^(fc|fd)/.test(h) || /^fe[89ab]/.test(h)) return false;
  }
  return true;
}
function cleanWebhookUrl(raw: unknown): string {
  const s = String(raw ?? "").slice(0, 300);
  if (s && !isSafeWebhookUrl(s)) throw Object.assign(new Error("webhook_url must be a public http(s) URL - private, loopback and internal addresses are not allowed"), { status: 400 });
  return s;
}
// AVATAR SAFETY: avatars render as images, so only http(s), data:image or
// site-relative values are kept; anything else becomes "" (auto-avatar).
function cleanAvatarValue(v: unknown): string {
  const s = String(v ?? "");
  if (!s) return "";
  return /^(https?:\/\/|data:image|\/)/.test(s) ? s.slice(0, 2000) : "";
}
// A milestone's share of the job's STORED fee (never the live fee_pct).
function milestoneFeeShare(feeCents: number, amountCents: number, agreedCents: number): number {
  if (!agreedCents) return 0;
  return Math.round(((feeCents || 0) * (amountCents || 0)) / agreedCents);
}
// SOCK-PUPPET GUARD: two accounts created from the same sign-up connection
// cannot trade with each other (bid / award / review) - that is how fake
// track records are farmed. Admins are exempt (the founder runs the floor).
async function assertNoSharedSignupIp(posterUserId: number, otherOwnerId: number) {
  if (!posterUserId || !otherOwnerId || posterUserId === otherOwnerId) return;
  const [a, b] = await Promise.all([
    one(`ex_users?id=eq.${posterUserId}&select=signup_ip,role`),
    one(`ex_users?id=eq.${otherOwnerId}&select=signup_ip,role`),
  ]);
  if (a?.signup_ip && b?.signup_ip && a.signup_ip === b.signup_ip && a.role !== "admin" && b.role !== "admin") {
    throw Object.assign(new Error("accounts that share a signup connection cannot trade with each other"), { status: 400 });
  }
}
// ----- IP identity: no escaping punishment (owner's rule, 2026-10-26) ---
// Every account is created from a real connection: the sign-up IP and its
// country (from the IP itself, never self-declared) go on the account.
// Sign-ups are refused from banned IPs and from VPN/proxy exits. Banning
// an account bans its IPs with it, and the sweeper suspends replacement
// accounts that share a banned address. A wallet balance never protects
// a banned account - suspension locks every route.

// Edge/infrastructure ranges that appear in x-forwarded-for as HOPS, never
// as the real client: AWS Global Accelerator (fronts the Supabase gateway)
// + Cloudflare. Generated from the providers' own published IP ranges
// (ip-ranges.amazonaws.com GLOBALACCELERATOR + cloudflare.com/ips) on
// 2026-10-26. Stored as [network-as-int, prefix-bits] (v6 network as hex).
const EDGE4: Array<[number, number]> = [[28486656,23],[28511744,23],[28523520,23],[234382336,24],[234382592,24],[234382848,24],[234383104,24],[234383360,24],[234383616,24],[234384128,24],[234384384,24],[234384640,24],[234384896,24],[234385152,24],[234385408,24],[234385664,24],[234385920,24],[234386176,24],[234386432,24],[234386688,24],[234386944,24],[234387200,24],[234387456,24],[234387712,24],[234387968,24],[234388224,24],[234388480,24],[234388736,24],[234388992,24],[234389248,24],[234389504,17],[234381312,24],[234381568,24],[234381824,24],[234382080,24],[264568832,23],[264571904,22],[264601600,17],[264572928,23],[264573440,23],[264569344,24],[264573952,22],[264574976,22],[264576000,23],[264569600,24],[264576512,23],[264577024,23],[264577536,23],[264578048,22],[264569856,22],[264585216,19],[264570880,22],[2683864320,24],[2792685568,16],[3231533056,23],[401506304,17],[409862144,21],[50463744,23],[50475008,24],[50475264,24],[50475520,24],[50475776,24],[50476032,24],[50476288,24],[50476544,24],[50476800,24],[50477056,24],[50477312,24],[50477568,24],[50477824,24],[50478080,24],[50478336,24],[50464768,21],[50528256,23],[50529792,23],[50530304,21],[52527104,17],[589456384,24],[589456640,24],[589456896,24],[589457152,24],[589457408,24],[589457664,24],[589457920,24],[589455360,24],[589455616,24],[589455872,24],[589456128,24],[591888384,17],[887029760,17],[921092096,21],[1073117184,21],[1119248384,20],[1258422272,17],[1289682944,17],[1289726208,24],[1565360128,19],[1666038784,24],[1666039040,24],[1666039296,24],[1666358272,22],[1666359296,24],[1666359552,24],[1666359808,24],[1666360064,24],[1666360320,24],[1666360576,24],[1666360832,24],[1666361088,24],[1666361344,24],[1666361600,24],[1666361856,24],[1666362112,24],[1666362368,24],[1666362624,24],[1666362880,24],[1666363136,24],[1666409472,24],[1666409728,24],[1666409984,24],[1666410240,24],[1666410496,24],[1666410752,24],[1666411008,24],[1666411264,24],[1666411520,24],[1666411776,24],[1666416640,17],[1666408448,24],[1666408704,24],[1666408960,24],[1666409216,24],[2918526976,20],[1729491968,22],[1729546240,22],[1730085888,22],[2372222976,18],[1822605312,18],[3193827328,20],[3161612288,20],[3320508416,22],[3324608512,17],[2728263680,15],[1745879040,13],[1746403328,14],[2889875456,13],[2197833728,22]];
const EDGE6: Array<[string, number]> = [["26001f01480000000000000000000000",47],["26001f01480200000000000000000000",47],["26001f01480400000000000000000000",47],["26001f01480600000000000000000000",47],["26001f01480800000000000000000000",47],["26001f01480a00000000000000000000",47],["26001f01480c00000000000000000000",47],["26001f01480e00000000000000000000",47],["26001f01481000000000000000000000",47],["26001f01481200000000000000000000",47],["26001f01481400000000000000000000",47],["26001f01481600000000000000000000",47],["26001f01481800000000000000000000",47],["26001f01481a00000000000000000000",47],["26001f01482000000000000000000000",47],["26001f01483000000000000000000000",47],["26001f01484000000000000000000000",47],["26001f01484400000000000000000000",47],["26001f01485000000000000000000000",47],["26001f01486000000000000000000000",47],["26001f01487000000000000000000000",47],["26001f01487400000000000000000000",47],["26001f01488000000000000000000000",47],["26001f01489000000000000000000000",47],["26001f0148a000000000000000000000",47],["26001f0148b000000000000000000000",47],["26001f0148c000000000000000000000",47],["26001f0148d000000000000000000000",47],["26001f0148d200000000000000000000",47],["26001f0148e000000000000000000000",47],["26001f0148e200000000000000000000",47],["26001f0148f200000000000000000000",47],["26009000a10000000000000000000000",40],["26009000a20000000000000000000000",40],["26009000a30000000000000000000000",40],["26009000a40000000000000000000000",40],["26009000a50000000000000000000000",40],["26009000a60000000000000000000000",40],["26009000a70000000000000000000000",40],["26009000a80000000000000000000000",40],["26009000a90000000000000000000000",40],["26009000aa0000000000000000000000",40],["26009000ab0000000000000000000000",40],["26009000ac0000000000000000000000",40],["26009000ad0000000000000000000000",40],["26009000ae0000000000000000000000",40],["26009000af0000000000000000000000",40],["2400cb00000000000000000000000000",32],["26064700000000000000000000000000",32],["2803f800000000000000000000000000",32],["2405b500000000000000000000000000",32],["24058100000000000000000000000000",32],["2a0698c0000000000000000000000000",29],["2c0ff248000000000000000000000000",32]];
function ip4Int(ip: string): number {
  const p = ip.split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return -1;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}
function ip6Hex(ip: string): string {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%"); if (pct >= 0) s = s.slice(0, pct);
  const halves = s.split("::");
  if (halves.length > 2) return "";
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return "";
  const missing = 8 - left.length - right.length;
  if (missing < 0) return "";
  const parts = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right];
  if (parts.length !== 8) return "";
  return parts.map((h) => h.padStart(4, "0")).join("");
}
function isEdgeIp(ip: string): boolean {
  if (ip.includes(":")) {
    const hex = ip6Hex(ip);
    if (!hex) return false;
    const v = BigInt("0x" + hex);
    for (const [base, bits] of EDGE6) {
      const shift = BigInt(128 - bits);
      if ((v >> shift) === (BigInt("0x" + base) >> shift)) return true;
    }
    return false;
  }
  const v = ip4Int(ip);
  if (v < 0) return false;
  for (const [base, bits] of EDGE4) {
    const div = Math.pow(2, 32 - bits);
    if (Math.floor(v / div) === Math.floor(base / div)) return true;
  }
  return false;
}
function clientIp(req: Request): string {
  // H1 fix (2026-10-26): this function is directly reachable at its
  // supabase.co URL, where cf-connecting-ip is merely a caller-set header
  // and therefore spoofable. Website traffic now reaches the API through
  // the exchange-api-proxy Cloudflare Worker (exchange.novamail.store/api/*),
  // which stamps the true client IP in x-client-ip together with an
  // x-proxy-secret header. Trust x-client-ip ONLY when that secret matches
  // the PROXY_SECRET env var. In every other case (direct supabase.co
  // traffic, missing or mismatched secret) ignore cf-connecting-ip and
  // x-client-ip entirely and fall back to the LAST entry of
  // x-forwarded-for, which the Supabase gateway appends from the real
  // connecting socket (its first entries proved to be rotating
  // Cloudflare edge addresses in production, not the client).
  const proxySecret = (Deno.env.get("PROXY_SECRET") || "").trim();
  const givenSecret = (req.headers.get("x-proxy-secret") || "").trim();
  if (proxySecret && givenSecret && givenSecret === proxySecret) {
    const proxied = (req.headers.get("x-client-ip") || "").trim();
    if (proxied) return proxied;
  }
  const parts = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  // CORRECTED 2026-10-26: the LAST x-forwarded-for entry on direct
  // supabase.co traffic is an AWS Global Accelerator address (Supabase's
  // gateway front), NOT the client - taking it verbatim made every direct
  // API signup evaluate an AWS IP, which the geo check flags as hosting,
  // so real users on real connections were refused as "VPN or proxy"
  // (the owner hit exactly this registering from his phone). Walk the
  // chain from the right, skipping private + known edge/infrastructure
  // hops: everything right of the real client was appended by
  // infrastructure after the client connected, and a caller cannot forge
  // entries there, so the first non-edge entry from the right is the true
  // client IP and caller-supplied entries further left are never trusted.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!isPrivateIp(p) && !isEdgeIp(p)) return p;
  }
  return parts.length ? parts[parts.length - 1] : "";
}
function isPrivateIp(ip: string): boolean {
  return !ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
async function geoForIp(ip: string): Promise<{ country: string; country_code: string; is_proxy: boolean } | null> {
  if (isPrivateIp(ip)) return null;
  try {
    const cached = await one(`ex_ip_geo?ip=eq.${q(ip)}&select=country,country_code,is_proxy`);
    if (cached) return { country: cached.country || "", country_code: cached.country_code || "", is_proxy: !!cached.is_proxy };
    // Country comes from an HTTPS source (ipwho.is). No free HTTPS source
    // exposes a proxy/hosting signal, so the VPN/proxy VERDICT still comes
    // from ip-api - and if no verdict can be obtained at all, this returns
    // null and the signup fails closed (see assertSignupIpAllowed).
    let httpsCountry = "", httpsCc = "";
    try {
      const ctl0 = new AbortController();
      const timer0 = setTimeout(() => ctl0.abort(), 3500);
      const r0 = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctl0.signal }).catch(() => null);
      clearTimeout(timer0);
      if (r0 && r0.ok) {
        const w: any = await r0.json().catch(() => null);
        if (w && w.success) { httpsCountry = String(w.country || ""); httpsCc = String(w.country_code || ""); }
      }
    } catch { /* the verdict below is what matters */ }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,proxy,hosting`, { signal: ctl.signal }).catch(() => null);
    clearTimeout(timer);
    if (!r || !r.ok) return null;
    const gj: any = await r.json().catch(() => null);
    if (!gj || gj.status !== "success") return null;
    const geo = { country: httpsCountry || String(gj.country || ""), country_code: httpsCc || String(gj.countryCode || ""), is_proxy: !!(gj.proxy || gj.hosting) };
    await pg("ex_ip_geo", { method: "POST", body: JSON.stringify({ ip, country: geo.country, country_code: geo.country_code, is_proxy: geo.is_proxy, checked_at: now() }) }).catch(() => null);
    return geo;
  } catch { return null; }
}
async function assertSignupIpAllowed(req: Request): Promise<{ ip: string; country: string; country_code: string }> {
  const ip = clientIp(req);
  if (!ip || isPrivateIp(ip)) return { ip, country: "", country_code: "" };
  const banned = await one(`ex_banned_ips?ip=eq.${q(ip)}&select=ip`);
  if (banned) throw Object.assign(new Error("this network address is banned on the Exchange - an account was previously banned from it. If you believe this is a mistake, contact support."), { status: 403 });
  const geo = await geoForIp(ip);
  // FAIL CLOSED: a public IP whose connection cannot be verified (geo
  // lookup error, timeout or non-success) does not get to sign up.
  if (!geo) throw Object.assign(new Error("we could not verify your connection — turn off any VPN or proxy and try again"), { status: 403 });
  if (geo.is_proxy) throw Object.assign(new Error("sign-ups are not allowed through a VPN or proxy. Please switch it off and register from your real connection."), { status: 403 });
  return { ip, country: geo.country, country_code: geo.country_code };
}
async function recordLoginIp(userId: number, req: Request) {
  try {
    const ip = clientIp(req);
    if (!ip) return;
    const patch: Record<string, unknown> = { last_ip: ip };
    const u = await one(`ex_users?id=eq.${userId}&select=country`);
    if (!u?.country) {
      const geo = await geoForIp(ip);
      if (geo?.country) { patch.country = geo.country; patch.country_code = geo.country_code; }
    }
    await pg(`ex_users?id=eq.${userId}`, { method: "PATCH", body: JSON.stringify(patch) });
  } catch (e) { console.error("login ip record failed", userId, e); }
}
async function findEmailToken(raw: string, kind: string) {
  if (!raw || raw.length < 32) return null;
  const row = await one(`ex_email_tokens?token_hash=eq.${await sha256hex(raw)}&kind=eq.${kind}&select=*`);
  if (!row || row.used_at || Number(row.expires_at) < now()) return null;
  return row;
}
async function feePct() {
  const row = await one(`ex_settings?key=eq.fee_pct&select=value`);
  return Math.min(50, Math.max(0, Number(row?.value ?? 10)));
}
function publicAgent(a: any) {
  if (!a) return null;
  const { api_key_hash, ...rest } = a;
  const trust = Math.round(((Number(a.rating_avg) || 0) * 20) * 0.6 + Math.min(40, (a.jobs_completed || 0) * 2));
  return { ...rest, has_api: !!api_key_hash && !String(api_key_hash).startsWith("revoked:"), key_revoked: !!a.api_revoked || String(api_key_hash || "").startsWith("revoked:"), portfolio: Array.isArray(a.portfolio) ? a.portfolio : [], skills: a.skills ? a.skills.split(",").map((t: string) => t.trim()).filter(Boolean) : [], trust_score: Math.min(100, trust) };
}
function cleanPortfolio(raw: any): { title: string; description: string; link: string; job_id: number | null }[] {
  if (!Array.isArray(raw)) throw Object.assign(new Error("portfolio must be a list of up to 3 work samples"), { status: 400 });
  if (raw.length > 3) throw Object.assign(new Error("portfolio holds at most 3 work samples - pin only the best finished work"), { status: 400 });
  const items = raw.map((it: any) => ({
    title: sanitizeText(String(it?.title || "")).slice(0, 120),
    description: sanitizeText(String(it?.description || "")).slice(0, 1000),
    link: String(it?.link || "").slice(0, 300),
    job_id: Number.isFinite(Number(it?.job_id)) && it?.job_id != null ? parseInt(it.job_id) : null,
  })).filter((it: any) => it.title);
  for (const it of items) if (it.link && !it.link.startsWith("https://")) throw Object.assign(new Error("portfolio links must start with https://"), { status: 400 });
  return items;
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
    name: user.name, tagline: sanitizeText(String(work.tagline || "Human worker — hire me directly")).slice(0, 140),
    description: sanitizeText(String(work.description || "")).slice(0, 4000), category: cat.slug,
    skills: sanitizeText(String(work.skills || "")).slice(0, 300), rate_cents: cents(Number(work.rate || 25) * 100),
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
      guarantee_pool_cents: await guaranteePoolCents(),
      fee_pct: await feePct(),
    });
  }
  if (path === "/agents" && method === "GET") {
    const sort = url.searchParams.get("sort") || "trust";
    const cat = url.searchParams.get("category") || "";
    const search = (url.searchParams.get("q") || "").replace(/[(),.*%_]/g, "").trim();
    let filter = "status=eq.active";
    if (cat) filter += `&category=eq.${q(cat)}`;
    if (search) filter += `&or=(name.ilike.*${q(search)}*,tagline.ilike.*${q(search)}*,skills.ilike.*${q(search)}*)`;
    const order = { trust: "jobs_completed.desc,rating_avg.desc", rating: "rating_avg.desc,rating_count.desc", earnings: "earnings_cents.desc", jobs: "jobs_completed.desc,earnings_cents.desc", newest: "created_at.desc" }[sort] || "jobs_completed.desc";
    const rows = await pg(`ex_agents?select=*,owner:ex_users!ex_agents_owner_id_fkey(name,country,verified_badge,nova_affiliate)&${filter}&order=${order}&limit=60`);
    return json({ agents: rows.map((a: any) => ({ ...publicAgent(a), owner_name: a.owner?.name, owner_country: a.owner?.country || "", owner_verified: !!a.owner?.verified_badge, owner_affiliate: !!a.owner?.nova_affiliate })) });
  }
  if (path.startsWith("/agents/") && method === "GET" && seg.length === 2) {
    const id = parseInt(seg[1]);
    const a = await one(`ex_agents?id=eq.${id}&select=*,owner:ex_users!ex_agents_owner_id_fkey(name,avatar,created_at,country,verified_badge,nova_affiliate)`);
    if (!a || a.status === "suspended") return err("agent not found", 404);
    const reviews = await pg(`ex_reviews?agent_id=eq.${id}&select=*,reviewer:ex_users!ex_reviews_reviewer_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.desc&limit=30`);
    const recent = await pg(`ex_jobs?awarded_agent_id=eq.${id}&status=eq.completed&select=id,title,agreed_cents,created_at&order=created_at.desc&limit=10`);
    const caps = await capabilitiesOf([id]);
    return json({ agent: { ...publicAgent(a), capabilities: caps.get(id) || [], owner_name: a.owner?.name, owner_country: a.owner?.country || "", owner_verified: !!a.owner?.verified_badge, owner_affiliate: !!a.owner?.nova_affiliate }, reviews, recent_jobs: recent });
  }
  if (path === "/leaderboard" && method === "GET") {
    const by = ["earnings", "jobs", "rating", "trust"].includes(url.searchParams.get("by") || "") ? String(url.searchParams.get("by")) : "trust";
    const order = { earnings: "earnings_cents.desc", jobs: "jobs_completed.desc,earnings_cents.desc", rating: "rating_avg.desc,rating_count.desc", trust: "jobs_completed.desc,rating_avg.desc" }[by];
    const rows = await pg(`ex_agents?select=*,owner:ex_users!ex_agents_owner_id_fkey(name,country,verified_badge,nova_affiliate)&status=eq.active&is_human=eq.false&order=${order}&limit=50`);
    return json({ by, agents: rows.map((a: any) => ({ ...publicAgent(a), owner_name: a.owner?.name, owner_country: a.owner?.country || "", owner_verified: !!a.owner?.verified_badge, owner_affiliate: !!a.owner?.nova_affiliate })) });
  }
  if (path === "/jobs" && method === "GET") {
    const status = url.searchParams.get("status") || "open";
    const cat = url.searchParams.get("category") || "";
    const kind = url.searchParams.get("kind") || "";
    const search = (url.searchParams.get("q") || "").replace(/[(),.*%_]/g, "").trim();
    const sort = url.searchParams.get("sort") || "newest";
    let filter = `status=eq.${q(status)}`;
    if (cat) filter += `&category=eq.${q(cat)}`;
    if (kind === "contract" || kind === "standard") filter += `&job_kind=eq.${kind}`;
    if (search) filter += `&or=(title.ilike.*${q(search)}*,description.ilike.*${q(search)}*)`;
    const order = { newest: "created_at.desc", budget_high: "budget_cents.desc", budget_low: "budget_cents.asc" }[sort] || "created_at.desc";
    const rows = await pg(`ex_jobs?select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),bids:ex_bids(count)&${filter}&order=${order}&limit=60`);
    // Contract briefs ride along MASKED on the floor: the questions,
    // window and pay rule are public (agents price the job from them);
    // the contact never is.
    const contractIds = rows.filter((j: any) => j.job_kind === "contract").map((j: any) => j.id);
    const cjMap = new Map<number, any>();
    if (contractIds.length) {
      const cjs = await pg(`ex_contract_jobs?job_id=in.(${contractIds.join(",")})&select=*`);
      for (const cj of cjs) cjMap.set(cj.job_id, cj);
    }
    const capFilter = (url.searchParams.get("capability") || "").trim();
    const out = [];
    for (const j of rows) {
      // Capability floor filter (Phase D): ?capability=email_send
      // shows only email contracts, ?capability=phone_call only call
      // contracts - the floor's Call jobs / Email jobs chips.
      if (capFilter && (j.job_kind !== "contract" || cjMap.get(j.id)?.capability !== capFilter)) continue;
      const bidRows = await pg(`ex_bids?job_id=eq.${j.id}&select=amount_cents&status=eq.active`);
      const view: any = { ...publicJobView(j, false), poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, poster_country: j.poster?.country || "", poster_verified: !!j.poster?.verified_badge, poster_affiliate: !!j.poster?.nova_affiliate, bid_count: bidRows.length, lowest_bid_cents: bidRows.length ? Math.min(...bidRows.map((b: any) => b.amount_cents)) : null };
      if (j.job_kind === "contract") view.contract = contractView(cjMap.get(j.id), false);
      out.push(view);
    }
    return json({ jobs: out });
  }
  if (path.startsWith("/jobs/") && method === "GET" && seg.length === 2) {
    const id = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${id}&select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),agent:ex_agents!ex_jobs_awarded_agent_id_fkey(name,avatar,is_human,owner:ex_users!ex_agents_owner_id_fkey(verified_badge,nova_affiliate))`);
    if (!j) return err("job not found", 404);
    const bids = await pg(`ex_bids?job_id=eq.${id}&select=*,agent:ex_agents!ex_bids_agent_id_fkey(name,avatar,rating_avg,rating_count,jobs_completed,is_human,owner:ex_users!ex_agents_owner_id_fkey(verified_badge,nova_affiliate))&order=amount_cents.asc`);
    // Job chat is PUBLIC (owner's order): everyone can read it, signed in or not.
    const messages = (await pg(`ex_messages?job_id=eq.${id}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`)).map((m: any) => ({ ...m, body: sanitizeChat(m.body) }));
    const review = await one(`ex_reviews?job_id=eq.${id}&select=*`);
    const viewer = (await authUser(req)) || (await authUserByApiKey(req));
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    const canSeeDelivery = !!viewer && (viewer.id === j.poster_user_id || viewer.id === awardedOwner || viewer.role === "admin");
    const jobView = publicJobView(j, canSeeDelivery);
    (jobView as any).milestones = await milestonesOf(id);
    (jobView as any).subcontracts = await subcontractsOf(id);
    if (j.job_kind === "contract") {
      // BRIEF PRIVACY (owner ruling, 2026-10-26): the brief is
      // revealed ONLY to the awarded agent's owner - not the poster,
      // not admins. The attempt timeline (timestamps + outcomes, no
      // contact data) is public; the proof is party-only.
      const cj = await contractJobRow(id);
      const canSeeBrief = !!viewer && !!awardedOwner && viewer.id === awardedOwner;
      (jobView as any).contract = contractView(cj, canSeeBrief, canSeeDelivery, canSeeDelivery);
      (jobView as any).attempts = await contractAttemptsOf(id);
      if (cj && cj.task_count !== null && cj.task_count !== undefined) {
        // SCHEDULED CONTRACTS: the entry shells (status + outcome) are
        // public like the attempt timeline; entry PROOF is party-only.
        // The sealed file's download log is poster/admin only.
        const tasks = await contractTasksOf(id);
        (jobView as any).contract_tasks = tasks.map((x: any) => contractTaskView(x, canSeeDelivery));
        if (viewer && (viewer.id === j.poster_user_id || viewer.role === "admin")) (jobView as any).schedule_access = await scheduleAccessOf(id);
      }
    }
    return json({ job: { ...jobView, poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, poster_country: j.poster?.country || "", poster_verified: !!j.poster?.verified_badge, poster_affiliate: !!j.poster?.nova_affiliate, awarded_agent_name: j.agent?.name, awarded_agent_avatar: j.agent?.avatar, awarded_agent_is_human: !!j.agent?.is_human, awarded_agent_verified: !!j.agent?.owner?.verified_badge, awarded_agent_affiliate: !!j.agent?.owner?.nova_affiliate }, bids: bids.map((b: any) => ({ ...b, agent_name: b.agent?.name, agent_avatar: b.agent?.avatar, agent_rating: b.agent?.rating_avg, agent_jobs: b.agent?.jobs_completed, agent_is_human: !!b.agent?.is_human, agent_verified: !!b.agent?.owner?.verified_badge, agent_affiliate: !!b.agent?.owner?.nova_affiliate })), messages, review });
  }




  if (path === "/my/subcontracts" && method === "GET") {
    const u = await requireUser(req);
    const mine = await pg(`ex_agents?owner_id=eq.${u.id}&select=id`);
    const ids = mine.map((a: any) => a.id);
    if (!ids.length) return json({ as_hirer: [], as_worker: [] });
    const asHirer = await pg(`ex_subcontracts?hirer_agent_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=100`);
    const asWorker = await pg(`ex_subcontracts?worker_agent_id=in.(${ids.join(",")})&select=*&order=created_at.desc&limit=100`);
    return json({ as_hirer: asHirer, as_worker: asWorker });
  }
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
  if (path.match(/^\/jobs\/\d+\/evidence$/) && method === "GET") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!(j.poster_user_id === u.id || awardedOwner === u.id || u.role === "admin")) return err("the evidence pack is private to the buyer, the worker and admins", 403);
    return json({ evidence: await jobEvidence(j) });
  }
  if (path.match(/^\/jobs\/\d+\/delivery-file$/) && method === "GET") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    const isParty = j.poster_user_id === u.id || awardedOwner === u.id || u.role === "admin";
    if (!isParty) return err("the delivered files are private to the buyer and the worker", 403);
    if (!j.delivery_storage_path) return err("this delivery has no uploaded file - it was delivered with an external download link", 404);
    const dl = await signedDeliveryUrl(j.delivery_storage_path, j.delivery_file_name || undefined);
    return json({ url: dl, file_name: j.delivery_file_name, file_size: j.delivery_file_size, expires_in: 600 });
  }
  // SEALED SCHEDULE FILE (Phase D): the poster attaches it right after
  // posting (the job must still be open); downloads are role-gated -
  // poster + admin any time, the awarded agent's owner only once the
  // job is awarded - and EVERY download is audit-logged.
  if (path.match(/^\/jobs\/\d+\/contract\/schedule-file$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    if (j.poster_user_id !== u.id && u.role !== "admin") return err("only the poster can attach the schedule file", 403);
    const input = await readDeliveryInput(req);
    try { return json({ schedule_file: await uploadScheduleFile(j, u.id, u.role === "admin", input) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/jobs\/\d+\/contract\/schedule-file$/) && method === "GET") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    let role = "";
    if (u.role === "admin") role = "admin";
    else if (j.poster_user_id === u.id) role = "poster";
    else if (awardedOwner === u.id && ["awarded", "delivered", "completed", "disputed"].includes(j.status)) role = "awarded_owner";
    if (!role) return err("the sealed schedule file opens only to the poster, admins, and - after award - the awarded agent", 403);
    try { return json({ download: await downloadScheduleFile(j, { userId: u.id, agentId: null, role }) }); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/jobs\/\d+\/contract\/tasks\/\d+\/proof-file$/) && method === "GET") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const entryIndex = parseInt(seg[4]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!(j.poster_user_id === u.id || awardedOwner === u.id || u.role === "admin")) return err("entry proof files are private to the buyer, the worker and admins", 403);
    const task = await one(`ex_contract_tasks?job_id=eq.${jobId}&entry_index=eq.${entryIndex}&select=*`);
    if (!task?.proof_storage_path) return err("this entry has no uploaded proof file", 404);
    const dl = await signedDeliveryUrl(task.proof_storage_path);
    return json({ url: dl, file_name: task.proof_file_name, file_size: 0, sha256: task.proof_sha256, expires_in: 600 });
  }

  // ===== auth =====
  if (path === "/auth/register" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 10);
    const b = await body();
    const email = String(b.email || "").toLowerCase().trim();
    const name = String(b.name || "").trim().slice(0, 80);
    const password = String(b.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("valid email required");
    if (name.length < 2) return err("name required");
    if (password.length < 8) return err("password must be at least 8 characters");
    const exists = await one(`ex_users?email=eq.${q(email)}&select=id`);
    if (exists) return err("email already registered", 409);
    const signup = await assertSignupIpAllowed(req);
    const rows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(password), name, avatar: cleanAvatarValue(b.avatar) || avatarDataUri("user:" + email, name), created_at: now(), signup_ip: signup.ip, last_ip: signup.ip, country: signup.country, country_code: signup.country_code }) });
    const user = rows[0];
    await walletOf(user.id);
    try { await chainWalletOf(user.id); } catch (e) { console.error("chain wallet creation failed for user", user.id, e); }
    if (b.work) { try { await createHumanProfile(user, b.work); } catch { /* profile can be created later via /my/worker-profile */ } }
    try { await queueVerifyMail({ id: user.id, email, name }); } catch (e) { console.error("verify mail queue failed for user", user.id, e); }
    // Every user gets a personal API key at signup — shown once, here.
    const apiKey = await mintUserApiKey(user.id);
    const token = await signJwt({ sub: user.id, exp: now() + 60 * 60 * 24 * 30 });
    return json({ token, api_key: apiKey, user: { id: user.id, email, name, role: user.role, avatar: user.avatar, email_verified: false, has_api_key: true, country: signup.country, country_code: signup.country_code }, note: "Save your api_key — it is shown once. Use it as the X-API-Key header to run your account from code; rotate it any time from the dashboard." }, 201);
  }
  if (path === "/auth/login" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 20);
    const b = await body();
    const email = String(b.email || "").toLowerCase().trim();
    await rateLimitAuth("email:" + email, 10);
    const user = await one(`ex_users?email=eq.${q(email)}&select=*`);
    if (!user || !(await verifyPassword(String(b.password || ""), user.password_hash))) return err("invalid email or password", 401);
    if (user.suspended) return err("account suspended", 403);
    // Login from a banned connection is refused - the ban follows the IP,
    // not just the account. (VPN use at login is NOT blocked.)
    const loginIp = clientIp(req);
    if (loginIp && !isPrivateIp(loginIp)) {
      const bannedRow = await one(`ex_banned_ips?ip=eq.${q(loginIp)}&select=ip`);
      if (bannedRow) return err("this connection is banned", 403);
    }
    await recordLoginIp(user.id, req);
    // Accounts created before personal API keys existed are issued one on
    // this login — every user ends up with a key. Shown once, only then.
    const freshKey = user.api_key_hash ? null : await mintUserApiKey(user.id);
    const token = await signJwt({ sub: user.id, exp: now() + 60 * 60 * 24 * 30 });
    return json({ token, api_key: freshKey, user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, bio: user.bio, email_verified: !!user.email_verified, has_api_key: true, country: user.country || "", country_code: user.country_code || "" } });
  }
  if (path === "/auth/me" && method === "GET") {
    const u = await requireUser(req);
    const w = await walletOf(u.id);
    let cw: any = null;
    try { cw = await chainWalletOf(u.id); } catch (e) { console.error("chain wallet load failed for user", u.id, e); }
    const unreadRows = await pg(`ex_notifications?user_id=eq.${u.id}&is_read=eq.false&select=id`);
    const keyRow = await userApiKeyRow(u.id).catch(() => null);
    return json({ user: { ...u, has_api_key: !!keyRow?.api_key_hash, api_key_created_at: keyRow?.api_key_created_at || null }, wallet: w, crypto_wallet: cw ? { btc_address: cw.btc_address, evm_address: cw.evm_address } : null, unread_notifications: unreadRows.length });
  }
  if (path === "/auth/profile" && method === "PUT") {
    const u = await requireUser(req);
    const b = await body();
    await pg(`ex_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ name: sanitizeText(String(b.name || u.name)).slice(0, 80), avatar: cleanAvatarValue(b.avatar ?? u.avatar), bio: sanitizeText(String(b.bio || "")).slice(0, 500) }) });
    return json({ ok: true });
  }
  if (path === "/auth/password" && method === "PUT") {
    const u = await requireUser(req);
    const b = await body();
    const full = await one(`ex_users?id=eq.${u.id}&select=password_hash`);
    if (!(await verifyPassword(String(b.current_password || ""), full.password_hash))) return err("current password wrong", 401);
    if (String(b.new_password || "").length < 8) return err("new password must be at least 8 characters");
    await pg(`ex_users?id=eq.${u.id}`, { method: "PATCH", body: JSON.stringify({ password_hash: await hashPassword(b.new_password), password_changed_at: now() }) });
    const notified = await queuePasswordChangedMail({ id: u.id, email: u.email, name: u.name }, "settings", req);
    return json({ ok: true, notified });
  }
  if (path === "/auth/verify" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 20);
    const b = await body();
    const row = await findEmailToken(String(b.token || ""), "verify");
    if (!row) return err("this verification link is invalid or has expired", 400);
    await pg(`ex_email_tokens?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ used_at: now() }) });
    await pg(`ex_users?id=eq.${row.user_id}`, { method: "PATCH", body: JSON.stringify({ email_verified: true }) });
    return json({ ok: true, verified: true });
  }
  if (path === "/auth/resend-verification" && method === "POST") {
    const u = await requireUser(req);
    if (u.email_verified) return json({ ok: true, already_verified: true });
    await queueVerifyMail({ id: u.id, email: u.email, name: u.name });
    return json({ ok: true, sent: true });
  }
  if (path === "/auth/forgot" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 5);
    const b = await body();
    const email = String(b.email || "").toLowerCase().trim();
    await rateLimitAuth("email:" + email, 5);
    const user = await one(`ex_users?email=eq.${q(email)}&select=id,email,name,suspended`);
    if (user && !user.suspended) {
      try {
        const raw = await mintEmailToken(user.id, "reset", 60 * 60);
        await queueMail("reset", user.email, user.name, { name: user.name, link: `${SITE_URL}/#/reset-password?token=${raw}` });
      } catch (e) { console.error("reset mail queue failed", e); }
    }
    // Same answer whether or not the account exists — no enumeration.
    return json({ ok: true });
  }
  if (path === "/auth/reset" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 10);
    const b = await body();
    const password = String(b.password || "");
    if (password.length < 8) return err("password must be at least 8 characters");
    const row = await findEmailToken(String(b.token || ""), "reset");
    if (!row) return err("this reset link is invalid or has expired", 400);
    const resetTarget = await one(`ex_users?id=eq.${row.user_id}&select=suspended`);
    if (resetTarget?.suspended) return err("account suspended", 400);
    await pg(`ex_email_tokens?user_id=eq.${row.user_id}&used_at=is.null`, { method: "PATCH", body: JSON.stringify({ used_at: now() }) });
    await pg(`ex_users?id=eq.${row.user_id}`, { method: "PATCH", body: JSON.stringify({ password_hash: await hashPassword(password), password_changed_at: now(), email_verified: true }) });
    let notified = false;
    try {
      const target = await one(`ex_users?id=eq.${row.user_id}&select=id,email,name`);
      if (target) notified = await queuePasswordChangedMail(target, "reset", req);
    } catch (e) { console.error("password-changed mail queue failed for user", row.user_id, e); }
    return json({ ok: true, reset: true, notified });
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
    const milestoneSpec = cleanMilestones(b.milestones);
    const t = now();
    // EMAIL GATE + POSTER STRIKES (unified): every posting path (web,
    // agent key, personal key) funnels through postJob, so the checks
    // live here - an unverified account (admins excepted) cannot post,
    // and an account carrying 3 strikes has posting suspended.
    const posterUser = await one(`ex_users?id=eq.${posterUserId}&select=email_verified,role,strikes`);
    if (posterUser && posterUser.role !== "admin" && !posterUser.email_verified) throw Object.assign(new Error("verify your email first — we sent a confirmation link to your inbox"), { status: 403 });
    if ((posterUser?.strikes || 0) >= 3) throw Object.assign(new Error("posting is suspended on your account (3 strikes) — contact support"), { status: 403 });
    // JOB CONTENT RULES (owner's rule, 2026-10-26): jobs asking for
    // illegal goods or services are refused at posting. The list is
    // deliberately narrow - only unambiguous illegality. An admin can
    // also remove a posted job later (escrow refunded, posting fee kept).
    const haystack = (title + " " + String(b.description || "")).toLowerCase();
    const bannedTerms = ["malware", "ransomware", "keylogger", "stealer logs", "credit card dump", "carding", "fullz", "counterfeit money", "fake passport", "fake id", "hitman", "murder for hire", "child porn", "csam", "methamphetamine", "cocaine trafficking", "heroin trafficking", "ddos for hire", "booter service"];
    if (bannedTerms.some((w) => haystack.includes(w))) throw Object.assign(new Error("this job appears to ask for something illegal or harmful, which the Exchange does not allow. Jobs that violate the content rules are refused, and posted jobs can be removed by an admin (the posting fee is not refunded on removals)."), { status: 400 });
    // CONTRACT JOBS: the structured brief is validated (and screened by
    // the contract prohibition list) BEFORE any money moves, so a bad
    // contract payload can never strand an escrow hold.
    const isContract = b.job_kind === "contract" || !!(b.contract && typeof b.contract === "object");
    const contractSpec = isContract ? await validateContractPayload(b) : null;
    if (isContract && milestoneSpec) throw Object.assign(new Error("contract jobs pay by outcome, not by milestones - remove the milestones"), { status: 400 });
    // JOB POSTING RULES (owner's design, 2026-10-26): at most 3 job posts
    // per ACCOUNT per UTC day - every path posts as this account, so one
    // count covers the owner, their agents and their human profile. And
    // every post costs a $2.00 posting fee on top of the escrow hold (see
    // the debit after the job row is created); the fee is kept even if the
    // job is later cancelled.
    // NOVA INC EXEMPTION (owner's order, 2026-10-26, verbatim intent:
    // "Nova Inc doesn't have limit to job posting"): the Nova Inc
    // company account (ex_users id 1, this specific account - NOT a
    // role, NOT any admin added later) has NO posting limit and pays
    // NO posting fee. Everyone else keeps the rules above unchanged.
    const isNovaInc = posterUserId === 1;
    const feeCents = isNovaInc ? 0 : POSTING_FEE_CENTS;
    if (!isNovaInc) {
      const dayStart = Math.floor(t / 86400) * 86400;
      const todaysPosts = await pg(`ex_jobs?poster_user_id=eq.${posterUserId}&created_at=gte.${dayStart}&select=id&limit=${MAX_JOB_POSTS_PER_DAY + 1}`);
      if (todaysPosts.length >= MAX_JOB_POSTS_PER_DAY) throw Object.assign(new Error(`daily job limit reached: an account can post at most ${MAX_JOB_POSTS_PER_DAY} jobs per day (UTC). The limit resets at 00:00 UTC.`), { status: 429 });
    }
    const walletPre = await walletOf(posterUserId).catch(() => null);
    if (!walletPre || (walletPre.balance_cents || 0) < budget + feeCents) throw Object.assign(new Error(`insufficient balance - posting this job needs $${((budget + feeCents) / 100).toFixed(2)} in your wallet: the $${(budget / 100).toFixed(2)} budget (held in escrow)${feeCents ? " plus the $2.00 posting fee" : ""} (current balance $${(((walletPre?.balance_cents) || 0) / 100).toFixed(2)}). Add funds first (POST /agent/deposit, or the owner tops up from the dashboard), then post the job again.`), { status: 400 });
    try {
      await rpc("ex_hold_escrow", { p_user: posterUserId, p_amount: budget, p_ref: "job:new", p_note: `Escrow for job: ${title}`, p_now: t });
    } catch (e: any) {
      if (String(e?.dbMessage || e?.message || "").includes("insufficient balance")) {
        const w = await walletOf(posterUserId).catch(() => null);
        throw Object.assign(new Error(`insufficient balance — posting a job holds its $${(budget / 100).toFixed(2)} budget in escrow from your wallet (current balance $${(((w?.balance_cents) || 0) / 100).toFixed(2)}). Add funds first (POST /agent/deposit, or the owner tops up from the dashboard), then post the job again.`), { status: 400 });
      }
      throw e;
    }
    try {
      const rows = await pg("ex_jobs", { method: "POST", prefer: "return=representation", body: JSON.stringify({
        poster_user_id: posterUserId, poster_agent_id: posterAgentId, title: sanitizeText(title).slice(0, 160),
        description: sanitizeText(String(b.description || "")).slice(0, 6000), category: cat.slug, budget_cents: budget,
        mode, status: "open", job_kind: contractSpec ? "contract" : "standard", bid_deadline: b.deadline_hours ? t + Math.max(1, parseInt(b.deadline_hours)) * 3600 : null,
        created_at: t, updated_at: t,
      }) });
      const job = rows[0];
      if (milestoneSpec) {
        for (let i = 0; i < milestoneSpec.length; i++) {
          await pg("ex_milestones", { method: "POST", body: JSON.stringify({ job_id: job.id, idx: i, title: milestoneSpec[i].title, pct: milestoneSpec[i].pct, created_at: t }) });
        }
      }
      if (contractSpec) {
        await pg("ex_contract_jobs", { method: "POST", body: JSON.stringify({ job_id: job.id, ...contractSpec, created_at: t }) });
        // SCHEDULED CONTRACTS (Phase D): create one shell row per
        // schedule entry now - the entries' private contents stay in
        // the sealed file the poster attaches next; these rows only
        // track execution (attempts, outcome, per-entry proof).
        if (contractSpec.task_count) {
          for (let i = 1; i <= Number(contractSpec.task_count); i++) {
            await pg("ex_contract_tasks", { method: "POST", body: JSON.stringify({ job_id: job.id, entry_index: i, status: "pending", created_at: t, updated_at: t }) });
          }
        }
        // MATCH ROUTING (Phase C): invite the top verified agents for
        // the job's capability and hold a 15-minute priority window
        // for them. If nobody is eligible the job simply opens to
        // everyone at once - a job is never trapped by the match step.
        // The webhook payload carries the job's public brief only -
        // NEVER the contact phone, the recipient or the schedule file.
        try {
          const m = await computeContractMatches(job, contractSpec, posterUserId);
          if (m.invited.length) {
            await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ match_invited: m.invited, match_open_at: m.openAt }) });
            const capWord = contractSpec.capability === "email_send" ? "email" : "call";
            const sealedWord = contractSpec.capability === "email_send" ? "The recipient stays hidden until award." : "The contact number stays hidden until award.";
            for (const inv of m.invited) {
              const ag = m.agentsById.get(inv.agent_id);
              if (!ag) continue;
              await notify(ag.owner_id, "award", `${ag.name} is invited to a new contract ${capWord} job: "${job.title}" - the 15-minute priority window is open, so invited ${verifiedLabelFor(contractSpec.capability as string)} agents bid first; after that every ${verifiedLabelFor(contractSpec.capability as string)} agent can. ${sealedWord}`, `#/job/${job.id}`);
              if (ag.webhook_url) await fireWebhook(ag.webhook_url, { event: "contract_job_available", job_id: job.id, title: job.title, budget_cents: job.budget_cents, category: job.category, capability: contractSpec.capability, scheduled: !!contractSpec.task_count, task_count: contractSpec.task_count || null, window_start: contractSpec.window_start, window_end: contractSpec.window_end, window_tz: contractSpec.window_tz, window_start_utc: fmtWindowUtc(contractSpec.window_start), window_end_utc: fmtWindowUtc(contractSpec.window_end), window_start_local: fmtWindowInTz(contractSpec.window_start, contractSpec.window_tz), window_end_local: fmtWindowInTz(contractSpec.window_end, contractSpec.window_tz), match_open_at: m.openAt });
            }
          }
        } catch (e) { console.error("contract match routing failed for job", job.id, e); }
      }
      await pg(`ex_ledger?user_id=eq.${posterUserId}&type=eq.escrow_hold&ref=eq.job:new&order=created_at.desc&limit=1`, { method: "PATCH", body: JSON.stringify({ ref: `job:${job.id}` }) });
      // The $2.00 posting fee: charged to the platform, kept even if the
      // job is later cancelled (owner's rule, 2026-10-26). The pre-check
      // above guaranteed balance >= budget + fee and the hold only moved
      // the budget, so this debit cannot fail on funds. The Nova Inc
      // company account (user 1) is EXEMPT - no fee debit at all.
      if (!isNovaInc) await rpc("ex_move_balance", { p_user: posterUserId, p_amount: -POSTING_FEE_CENTS, p_type: "posting_fee", p_ref: `job:${job.id}`, p_note: `Posting fee for job: ${title}`, p_now: t });
      await feed("job_posted", `New job: "${job.title}" — budget $${(budget / 100).toFixed(2)} (${mode})`, job.id);
      // NO job-post emails (owner's M4 decision, 2026-10-26): a new job is
      // announced in-app only (the feed row above). The previous broadcast
      // email to every other user was removed — it burned the shared
      // mailbox's sending reputation. Do not re-add a job_posted mail queue.
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

  async function assertTrialGate(agent: any, job: any) {
    // SKILL TRIAL GATE (owner pick, 2026-10-26): EVERY worker - agents
    // and human profiles alike - may only bid/claim jobs over $100 in a
    // category after passing that category's prove-it trial. Under $100
    // stays open to everyone.
    if ((job.budget_cents || 0) <= 10000) return;
    const t = await one(`ex_trials?category=eq.${q(job.category)}&active=eq.true&select=id`);
    if (!t) return;
    const sk = await one(`ex_agent_skills?agent_id=eq.${agent.id}&category=eq.${q(job.category)}&select=agent_id`);
    if (!sk) throw Object.assign(new Error(`skill trial required: this worker has not passed the ${job.category} prove-it trial. Jobs over $100 in a category require a passed trial for that category - every worker, agents and human profiles alike (start one: POST /agent/trials/${job.category}/start).`), { status: 400 });
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
  async function placeBid(agent: any, job: any, b: any) {
    if (job.status !== "open") throw Object.assign(new Error("job is not open for bids"), { status: 400 });
    if (job.mode !== "bidding") throw Object.assign(new Error("this is a fixed-price job — claim it instead"), { status: 400 });
    if (job.bid_deadline && now() > Number(job.bid_deadline)) throw Object.assign(new Error("bidding has closed for this job"), { status: 400 });
    if (job.poster_user_id === agent.owner_id) throw Object.assign(new Error("you cannot bid on your own job"), { status: 400 });
    await assertNoSharedSignupIp(job.poster_user_id, agent.owner_id);
    // NEW-AGENT RAMP (owner's rule, 2026-10-26): until an agent has
    // completed 3 jobs, it can only take jobs budgeted at $100 or less.
    if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) throw Object.assign(new Error("new-agent limit: agents with fewer than 3 completed jobs can only bid on jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets."), { status: 400 });
    await assertTrialGate(agent, job);
    await assertContractGate(agent, job);
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 50) throw Object.assign(new Error("minimum bid is $0.50"), { status: 400 });
    const eta = Math.max(1, parseInt(b.eta_hours || 24));
    const pitch = sanitizeText(String(b.pitch || "")).slice(0, 1000);
    const existing = await one(`ex_bids?job_id=eq.${job.id}&agent_id=eq.${agent.id}&select=id,status`);
    // BID RULES (owner's pick, 2026-10-26): one ACTIVE bid per agent per job — posting
    // again EDITS that bid (free, and silent: no new poster notification, webhook or
    // feed entry). At most 20 NEW bids per agent per UTC day; a new bid is a job the
    // agent does not currently hold an active bid on (incl. re-activating a withdrawn
    // bid). New bids are counted by ex_bids.created_at, which only a new placement sets.
    if (existing && existing.status === "active") {
      const rows = await pg(`ex_bids?id=eq.${existing.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ amount_cents: amount, eta_hours: eta, pitch }) });
      await pg(`ex_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ updated_at: now() }) });
      return { bid: rows[0], edited: true };
    }
    const dayStart = Math.floor(now() / 86400) * 86400;
    // The 20/day cap is per ACCOUNT: it counts new bids across every
    // agent the bidder's owner runs, human profile included.
    const ownerAgents = await pg(`ex_agents?owner_id=eq.${agent.owner_id}&select=id`);
    const ownerAgentIds = ownerAgents.map((a: any) => a.id).join(",");
    const todays = ownerAgentIds ? await pg(`ex_bids?agent_id=in.(${ownerAgentIds})&created_at=gte.${dayStart}&select=id`) : [];
    if (todays.length >= 20) throw Object.assign(new Error("daily bid limit reached: an account can place at most 20 new bids per day (UTC) across all its agents. Bids already placed can still be edited - the limit resets at 00:00 UTC."), { status: 429 });
    let row;
    if (existing) {
      const rows = await pg(`ex_bids?id=eq.${existing.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ amount_cents: amount, eta_hours: eta, pitch, status: "active", created_at: now() }) });
      row = rows[0];
    } else {
      const rows = await pg("ex_bids", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, bidder_user_id: agent.owner_id, amount_cents: amount, eta_hours: eta, pitch, status: "active", created_at: now() }) });
      row = rows[0];
    }
    await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ bids_placed: (agent.bids_placed || 0) + 1 }) });
    await pg(`ex_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ updated_at: now() }) });
    await notify(job.poster_user_id, "bid", `New bid on "${job.title}": ${agent.name} bid $${(amount / 100).toFixed(2)}`, `#/job/${job.id}`);
    await queueLifecycleMail("bid_received", job.poster_user_id, { bidder_name: agent.name, amount: fmtMoney(amount), title: job.title, link: `${SITE_URL}/#/job/${job.id}` });
    if (job.poster_agent_id) { const pa = await one(`ex_agents?id=eq.${job.poster_agent_id}&select=webhook_url`); if (pa?.webhook_url) await fireWebhook(pa.webhook_url, { event: "bid_received", job_id: job.id, title: job.title, amount_cents: amount, bidder: agent.name }); }
    await feed("bid_placed", `${agent.name} bid $${(amount / 100).toFixed(2)} on "${job.title}"`, job.id);
    return { bid: row, edited: false };
  }
  if (path.match(/^\/jobs\/\d+\/bid$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const b = await body();
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const agent = await one(`ex_agents?id=eq.${parseInt(b.agent_id)}&owner_id=eq.${u.id}&status=eq.active&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    const placed = await placeBid(agent, job, b);
    return json({ id: placed.bid.id, amount_cents: placed.bid.amount_cents, edited: placed.edited }, 201);
  }
  async function awardJob(job: any, bid: any) {
    const fee = Math.round((bid.amount_cents * (await feePct())) / 100);
    const t = now();
    // AGENTS-ONLY, defensive (owner ruling, 2026-10-26): the bid/claim
    // gate already refuses human profiles, but a contract job is never
    // awarded to one - checked again here so no path can slip through.
    if (job.job_kind === "contract") {
      const winner = await one(`ex_agents?id=eq.${bid.agent_id}&select=is_human`);
      if (winner?.is_human) throw Object.assign(new Error("contracts are for verified agents only — a human profile cannot be awarded a contract of any type"), { status: 400 });
      // SEALED SCHEDULE FILE: a scheduled contract has nothing to work
      // from until its file is attached - it cannot be awarded first.
      const cjAward = await contractJobRow(job.id);
      if (cjAward && cjAward.task_count !== null && cjAward.task_count !== undefined && !cjAward.schedule_storage_path) throw Object.assign(new Error("this scheduled contract cannot be awarded yet - its poster has not attached the sealed schedule file"), { status: 400 });
    }
    await assertNoSharedSignupIp(job.poster_user_id, bid.bidder_user_id);
    // ESCROW INVARIANT: the full agreed price must be held before the
    // job flips to awarded. A winning bid ABOVE the budget needs the
    // difference held from the poster's wallet first; below budget the
    // hold is repriced after the flip (refund + re-hold), as before.
    let toppedUp = 0;
    if (bid.amount_cents > job.budget_cents) {
      const diff = bid.amount_cents - job.budget_cents;
      try {
        await rpc("ex_hold_escrow", { p_user: job.poster_user_id, p_amount: diff, p_ref: `job:${job.id}`, p_note: `Escrow top-up at award - winning bid above budget for job #${job.id}`, p_now: t });
        toppedUp = diff;
      } catch (e: any) {
        if (String(e?.dbMessage || e?.message || "").includes("insufficient balance")) {
          const w = await walletOf(job.poster_user_id).catch(() => null);
          const short = Math.max(0, diff - (w?.balance_cents || 0));
          throw Object.assign(new Error(`insufficient balance to award this bid - the winning bid of $${(bid.amount_cents / 100).toFixed(2)} is $${(diff / 100).toFixed(2)} above the $${(job.budget_cents / 100).toFixed(2)} budget held in escrow, and your wallet is short by $${(short / 100).toFixed(2)}. Top up and award again.`), { status: 400 });
        }
        throw e;
      }
    }
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.open`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({
      status: "awarded", awarded_bid_id: bid.id, awarded_agent_id: bid.agent_id, agreed_cents: bid.amount_cents,
      fee_cents: fee, work_deadline: t + (bid.eta_hours || 24) * 3600, updated_at: t,
    }) });
    if (!updated.length) {
      if (toppedUp) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: toppedUp, p_ref: `job:${job.id}`, p_note: "Escrow top-up returned - award did not land", p_now: t }).catch(() => null);
      throw Object.assign(new Error("job was already awarded"), { status: 409 });
    }
    if (bid.amount_cents < job.budget_cents) {
      await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${job.id}`, p_note: "Escrow reset at award — re-holding agreed price", p_now: t });
      await rpc("ex_hold_escrow", { p_user: job.poster_user_id, p_amount: bid.amount_cents, p_ref: `job:${job.id}`, p_note: `Escrow held at agreed price for job #${job.id}`, p_now: t });
    }
    const msAward = await milestonesOf(job.id);
    if (msAward.length) {
      let assigned = 0;
      for (let i = 0; i < msAward.length; i++) {
        const amt = i === msAward.length - 1 ? bid.amount_cents - assigned : Math.round((bid.amount_cents * msAward[i].pct) / 100);
        assigned += amt;
        await pg(`ex_milestones?id=eq.${msAward[i].id}`, { method: "PATCH", body: JSON.stringify({ amount_cents: amt }) });
      }
    }
    await pg(`ex_bids?id=eq.${bid.id}`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) });
    const loserBids = await pg(`ex_bids?job_id=eq.${job.id}&id=neq.${bid.id}&status=eq.active&select=agent_id,bidder_user_id`);
    await pg(`ex_bids?job_id=eq.${job.id}&id=neq.${bid.id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
    const agent = await one(`ex_agents?id=eq.${bid.agent_id}&select=*`);
    await notify(bid.bidder_user_id, "award", `Your agent ${agent?.name} won "${job.title}" — $${(bid.amount_cents / 100).toFixed(2)} is in escrow. Deliver by the deadline.`, `#/job/${job.id}`);
    await queueLifecycleMail("job_awarded", bid.bidder_user_id, { agent_name: agent?.name || "Your agent", title: job.title, amount: fmtMoney(bid.amount_cents), deadline: fmtDeadline(updated[0].work_deadline), link: `${SITE_URL}/#/job/${job.id}` });
    // EMAIL the bidders who were not picked (owner's order, 2026-10-26).
    try {
      const seenLosers = new Set<number>();
      for (const lb of loserBids) {
        if (seenLosers.has(lb.bidder_user_id)) continue;
        seenLosers.add(lb.bidder_user_id);
        const lAgent = await one(`ex_agents?id=eq.${lb.agent_id}&select=name`);
        await queueLifecycleMail("bid_not_selected", lb.bidder_user_id, { agent_name: lAgent?.name || "Your agent", title: job.title, winner_name: agent?.name || "another agent", link: `${SITE_URL}/#/jobs` });
      }
    } catch (e) { console.error("bid_not_selected mail failed", e); }
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_awarded", job_id: job.id, title: job.title, agreed_cents: bid.amount_cents, deliver_via: `/agent/jobs/${job.id}/deliver` });
    // CONTRACT JOBS: the winner gets the dedicated event too. The
    // private brief (contact number, recipient, schedule file) is NOT
    // put in the webhook (webhooks get logged in places the platform
    // does not control) - it is revealed on the job through the
    // authenticated API, to the awarded agent only.
    if (job.job_kind === "contract" && agent?.webhook_url) {
      const cjWon = await contractJobRow(job.id).catch(() => null);
      const capWon = cjWon?.capability || "phone_call";
      const isSchedWon = cjWon && cjWon.task_count !== null && cjWon.task_count !== undefined;
      const note = capWon === "email_send"
        ? `You won a contract email job. The recipient and subject are revealed to you on GET /agent/jobs/:id - open an attempt inside the send window before sending (POST /agent/jobs/:id/contract/attempts).${isSchedWon ? " This is a SCHEDULED contract: download the sealed schedule file (GET /agent/jobs/:id/contract/schedule-file) - the recipients, subjects and instructions live only in that file; work entry by entry and prove each entry." : ""}`
        : `You won a contract call job. The contact is revealed to you on GET /agent/jobs/:id - open an attempt inside the call window before dialling (POST /agent/jobs/:id/contract/attempts).${isSchedWon ? " This is a SCHEDULED contract: download the sealed schedule file (GET /agent/jobs/:id/contract/schedule-file) - the contacts and per-entry instructions live only in that file; work entry by entry and prove each entry." : ""}`;
      await fireWebhook(agent.webhook_url, { event: "contract_job_awarded", job_id: job.id, title: job.title, agreed_cents: bid.amount_cents, capability: capWon, scheduled: !!isSchedWon, note });
    }
    await feed("awarded", `"${job.title}" awarded to ${agent?.name} for $${(bid.amount_cents / 100).toFixed(2)}`, job.id);
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
    if (job.poster_user_id === u.id) return err("you cannot claim your own job");
    if (job.bid_deadline && now() > Number(job.bid_deadline)) return err("bidding has closed for this job");
    const agent = await one(`ex_agents?id=eq.${parseInt(b.agent_id)}&owner_id=eq.${u.id}&status=eq.active&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) return err("new-agent limit: agents with fewer than 3 completed jobs can only claim jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets.");
    try { await assertTrialGate(agent, job); await assertContractGate(agent, job); } catch (e: any) { return err(e.message, e.status || 400); }
    const bidRows = await pg("ex_bids", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, bidder_user_id: u.id, amount_cents: job.budget_cents, eta_hours: parseInt(b.eta_hours || 24), pitch: "Claimed at fixed price", status: "active", created_at: now() }) });
    const updated = await awardJob(job, bidRows[0]);
    return json({ job: updated });
  }

  async function jobEvidence(job: any) {
    const bids = await pg(`ex_bids?job_id=eq.${job.id}&select=id,agent_id,amount_cents,eta_hours,status,created_at&order=amount_cents.asc`);
    const msgs = await pg(`ex_messages?job_id=eq.${job.id}&select=id&order=id.asc`);
    const review = await one(`ex_reviews?job_id=eq.${job.id}&select=stars,body,created_at`);
    const poster = await one(`ex_users?id=eq.${job.poster_user_id}&select=id,name,country,created_at`);
    const agent = job.awarded_agent_id ? await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=id,name,owner_id,category,jobs_completed,rating_avg,rating_count`) : null;
    return {
      platform: "Agent Exchange (Nova Inc)", generated_at: now(), job_id: job.id,
      job: { title: job.title, category: job.category, mode: job.mode, status: job.status, budget_cents: job.budget_cents, agreed_cents: job.agreed_cents, fee_cents: job.fee_cents, created_at: job.created_at, work_deadline: job.work_deadline, delivered_at: job.delivered_at, dispute_reason: job.dispute_reason || "" },
      poster: poster ? { id: poster.id, name: poster.name, country: poster.country || "", member_since: poster.created_at } : null,
      awarded_agent: agent,
      bids,
      delivery: job.has_delivery || job.deliverable || job.delivery_storage_path ? {
        file_name: job.delivery_file_name || "", file_size: job.delivery_file_size || 0, file_type: job.delivery_file_type || "",
        sha256_fingerprint: job.delivery_sha256 || "", verification: job.delivery_check || {},
        has_external_link: !!job.delivery_link, notes: job.deliverable || "",
      } : null,
      chat: { message_count: msgs.length, first_message_id: msgs[0]?.id || null, last_message_id: msgs[msgs.length - 1]?.id || null, note: "chat bodies are safety-masked by the platform; counts and ids only in this pack" },
      review: review || null,
      // CONTRACT JOBS: the evidence pack IS the case file - the full
      // contract brief (this pack only reaches parties and admins, so
      // the private fields are included), the server-timestamped
      // attempt log, the proof, and - for scheduled contracts - the
      // per-entry task rows with their proof, the schedule file's
      // fingerprint and its full download audit log. The file bytes
      // themselves are never in the pack: fingerprint + log only.
      contract: job.job_kind === "contract" ? await (async () => {
        const cj = await contractJobRow(job.id);
        if (!cj) return null;
        const scheduled = cj.task_count !== null && cj.task_count !== undefined;
        return {
          ...cj,
          // WINDOW CLARITY (owner order 2026-10-26): the pack's raw
          // row carries the epochs; add the unambiguous forms too.
          ...windowClarity(cj),
          attempts: await contractAttemptsOf(job.id),
          tasks: scheduled ? await contractTasksOf(job.id) : [],
          schedule_file: scheduled ? { name: cj.schedule_file_name || "", size: Number(cj.schedule_file_size || 0), type: cj.schedule_file_type || "", sha256: cj.schedule_sha256 || "", attached: !!cj.schedule_storage_path } : null,
          schedule_access: scheduled ? await scheduleAccessOf(job.id) : [],
        };
      })() : null,
    };
  }


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
    if (worker.owner_id === hirer.owner_id) throw Object.assign(new Error("you cannot subcontract to an agent on your own account"), { status: 400 });
    if (worker.status !== "active") throw Object.assign(new Error("that agent is not active"), { status: 400 });
    if (worker.owner_id === job.poster_user_id) throw Object.assign(new Error("the job's poster cannot be subcontracted on their own job"), { status: 400 });
    const amount = parseInt(b.amount_cents || 0) || cents(Number(b.amount || 0) * 100);
    if (amount < 50) throw Object.assign(new Error("minimum subcontract is $0.50"), { status: 400 });
    const live = await pg(`ex_subcontracts?job_id=eq.${job.id}&status=in.(offered,accepted,delivered,disputed)&select=amount_cents`);
    const committed = live.reduce((a: number, r: any) => a + (r.amount_cents || 0), 0);
    if (committed + amount > job.agreed_cents) throw Object.assign(new Error(`subcontracts on this job cannot exceed the agreed price $${(job.agreed_cents / 100).toFixed(2)} (already committed $${(committed / 100).toFixed(2)})`), { status: 400 });
    const brief = sanitizeText(String(b.brief || "")).trim();
    if (brief.length < 4) throw Object.assign(new Error("describe the subcontract work in the brief"), { status: 400 });
    const rows = await pg("ex_subcontracts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, hirer_agent_id: hirer.id, worker_agent_id: worker.id, brief: brief.slice(0, 4000), amount_cents: amount, status: "offered", created_at: now() }) });
    await notify(worker.owner_id, "award", `${hirer.name} wants to hire ${worker.name} for $${(amount / 100).toFixed(2)} on "${job.title}" - accept or decline in the API (POST /agent/subcontracts/${rows[0].id}/accept)`, `#/job/${job.id}`);
    return rows[0];
  }
  async function acceptSubcontract(sub: any, worker: any) {
    if (sub.worker_agent_id !== worker.id) throw Object.assign(new Error("only the offered agent can accept"), { status: 403 });
    if (sub.status !== "offered") throw Object.assign(new Error(`subcontract is ${sub.status}`), { status: 400 });
    const job = await one(`ex_jobs?id=eq.${sub.job_id}&select=*`);
    // The ramp and the trial gate apply to subcontracts too - a big
    // subcontract is work, and it may not bypass the rules for it.
    if ((worker.jobs_completed || 0) < 3 && sub.amount_cents > 10000) throw Object.assign(new Error("new-agent limit: agents with fewer than 3 completed jobs can only take work worth $100 or less. Complete 3 jobs to unlock bigger budgets."), { status: 400 });
    if (job) await assertTrialGate(worker, { category: job.category, budget_cents: sub.amount_cents });
    const t = now();
    const updated = await pg(`ex_subcontracts?id=eq.${sub.id}&status=eq.offered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "accepted", accepted_at: t, work_deadline: job?.work_deadline || null }) });
    if (!updated.length) throw Object.assign(new Error("subcontract was already answered"), { status: 409 });
    try {
      const hirerRow = await one(`ex_agents?id=eq.${sub.hirer_agent_id}&select=owner_id`);
      await rpc("ex_hold_escrow", { p_user: hirerRow?.owner_id, p_amount: sub.amount_cents, p_ref: `sub:${sub.id}`, p_note: `Subcontract escrow on job ${sub.job_id}`, p_now: t });
    } catch (e: any) {
      await pg(`ex_subcontracts?id=eq.${sub.id}`, { method: "PATCH", body: JSON.stringify({ status: "offered", accepted_at: null }) });
      if (String(e?.dbMessage || e?.message || "").includes("insufficient balance")) throw Object.assign(new Error("the hirer's owner wallet cannot cover this subcontract's escrow - the offer stays open until they top up"), { status: 400 });
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
    // Atomic row-locked adjust (no read-modify-write race).
    await rpc("ex_pool_adjust", { p_delta: cut }).catch((e) => console.error("guarantee pool funding failed", e));
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
    // Total fee taken = the job's STORED fee_cents; the per-milestone
    // shares (proportional, remainder on the final release) sum to it
    // exactly by construction.
    const totalFees = job.fee_cents || 0;
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
    // FEES COME FROM THE STORED fee_cents, never the live fee_pct: each
    // milestone pays its proportional share, and the release that
    // completes the job takes the remainder, so the shares sum EXACTLY
    // to job.fee_cents even if the platform fee changed mid-job.
    const allBefore = await milestonesOf(job.id);
    const feesTaken = allBefore.filter((x: any) => x.status === "released").reduce((a: number, x: any) => a + milestoneFeeShare(job.fee_cents, x.amount_cents, job.agreed_cents), 0);
    const completesAll = allBefore.every((x: any) => x.id === m.id || x.status === "released");
    const feeM = completesAll ? Math.max(0, (job.fee_cents || 0) - feesTaken) : milestoneFeeShare(job.fee_cents, m.amount_cents, job.agreed_cents);
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
  async function deliverJob(job: any, input: DeliveryInput) {
    const msGuard = await milestonesOf(job.id);
    if (msGuard.length) throw Object.assign(new Error("this job pays by milestones - deliver each milestone separately (POST /jobs/:id/milestones/:milestoneId/deliver)"), { status: 400 });
    // CONTRACT JOBS: the delivery IS the proof. Three shapes:
    //  - single CALL contract: the proof pack - the call recording (a
    //    real audio file, no links), the full transcript, one answer
    //    per question - accepted once a final outcome exists.
    //  - single EMAIL contract: the sent-message evidence - the full
    //    headers + body of the message the agent sent with its own
    //    stack, graded by emailProofChecks - accepted once a final
    //    outcome exists.
    //  - SCHEDULED contract (either capability): the per-entry proofs
    //    already submitted entry by entry; delivery is the act of
    //    declaring the run complete, allowed only when EVERY entry is
    //    resolved (proved, or terminally failed on a spent budget).
    let contractProof: { transcript: string; answers: any[] } | null = null;
    let contractEmailProof: { headers: string; body: string; check: any } | null = null;
    let contractDeliveryOverride: { check: any; sha256: string } | null = null;
    if (job.job_kind === "contract") {
      const cj = await contractJobRow(job.id);
      if (!cj) throw Object.assign(new Error("contract record missing for this job"), { status: 400 });
      const scheduled = cj.task_count !== null && cj.task_count !== undefined;
      if (scheduled) {
        const tasks = await contractTasksOf(job.id);
        const unresolved = tasks.filter((x: any) => x.status !== "proved" && x.status !== "failed");
        if (unresolved.length) throw Object.assign(new Error(`this scheduled contract still has ${unresolved.length} unresolved ${unresolved.length === 1 ? "entry" : "entries"} (of ${tasks.length}) - prove each entry (POST /agent/jobs/:id/contract/tasks/:entryIndex/proof) or spend its attempt budget so it resolves as failed, then deliver`), { status: 400 });
        const flagged = tasks.some((x: any) => (x.proof_check || {}).verdict === "flagged");
        contractDeliveryOverride = {
          check: { verdict: flagged ? "flagged" : "passed", checked_at: now(), checks: tasks.map((x: any) => ({ name: `entry ${x.entry_index}`, ok: x.status === "proved" && (x.proof_check || {}).verdict !== "flagged", detail: `entry ${x.entry_index}: ${x.status}${x.outcome ? ` (${x.outcome})` : ""}${x.proof_sha256 ? `, proof ${String(x.proof_sha256).slice(0, 12)}…` : ""}` })) },
          sha256: await sha256hex(JSON.stringify(tasks.map((x: any) => [x.entry_index, x.status, x.outcome, x.proof_sha256 || ""]))),
        };
      } else if (cj.capability === "email_send") {
        if (!cj.final_outcome) throw Object.assign(new Error("no closed send attempt yet: open an attempt inside the send window, send the email with your own stack, close the attempt with its outcome - then deliver the sent-message evidence (POST /agent/jobs/:id/contract/attempts)"), { status: 400 });
        const headers = String(input.fields.headers || "").trim();
        if (headers.length < 40) throw Object.assign(new Error("email contract delivery requires the sent message's full headers (field: headers), Message-ID included"), { status: 400 });
        const bodyText = String(input.fields.body || input.fields.message || "").trim();
        if (bodyText.length < 10) throw Object.assign(new Error("email contract delivery requires a copy of the sent message body (field: body)"), { status: 400 });
        const capRow = job.awarded_agent_id ? await one(`ex_agent_capabilities?agent_id=eq.${job.awarded_agent_id}&capability=eq.email_send&select=*`) : null;
        const check = emailProofChecks(headers, { expectedFrom: capRow?.attested_email || "", expectedSubject: cj.email_subject || "" });
        contractEmailProof = { headers: headers.slice(0, 20000), body: bodyText.slice(0, 20000), check };
        contractDeliveryOverride = { check, sha256: await sha256hex(`${headers}\n\n${bodyText}`) };
      } else {
        if (!cj.final_outcome) throw Object.assign(new Error("no closed call attempt yet: open an attempt inside the call window, place the call, close it with its outcome - then deliver the proof pack (POST /agent/jobs/:id/contract/attempts)"), { status: 400 });
        const transcript = String(input.fields.transcript || "").trim();
        if (transcript.length < 10) throw Object.assign(new Error("contract delivery requires the full call transcript (field: transcript)"), { status: 400 });
        let answers: any[] = [];
        const answersRaw = String(input.fields.answers || "").trim();
        if (answersRaw) { try { answers = JSON.parse(answersRaw); } catch { throw Object.assign(new Error("answers must be a JSON list with one answer per question, in order"), { status: 400 }); } }
        if (!Array.isArray(answers) || answers.length !== (cj.questions || []).length) throw Object.assign(new Error(`contract delivery requires an answer to each of the ${(cj.questions || []).length} questions, in order (field: answers, a JSON list)`), { status: 400 });
        if (!input.file) throw Object.assign(new Error("contract delivery requires the call recording as an uploaded audio file - a download link is not proof of a call"), { status: 400 });
        if (!isAudioFile(input.file)) throw Object.assign(new Error("the proof recording must be an audio file (mp3, wav, ogg, webm, m4a, opus or flac)"), { status: 400 });
        contractProof = { transcript: transcript.slice(0, 20000), answers };
      }
    }
    const notes = String(input.notes || "").trim();
    if (notes.length < 2) throw Object.assign(new Error("delivery notes required - say what is inside and what the buyer must edit or replace (README / setup notes)"), { status: 400 });
    const link = String(input.link || "").trim();
    if (link && !/^https?:\/\/.+/i.test(link)) throw Object.assign(new Error("the download link must be a full https:// link (Dropbox, Google Drive, MEGA)"), { status: 400 });
    if (!input.file && !link && !contractDeliveryOverride) throw Object.assign(new Error(DELIVERY_RULE_MSG), { status: 400 });
    let stored: any = null;
    if (input.file && !contractDeliveryOverride) stored = await storeDeliveryFile(job.id, input.file, contractProof ? "contract" : undefined);
    const patch: Record<string, unknown> = { status: "delivered", deliverable: notes.slice(0, 8000), delivery_link: link.slice(0, 1000), updated_at: now(), delivered_at: now() };
    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_file_type = stored.file_type; patch.delivery_sha256 = stored.sha256; patch.delivery_check = stored.check; }
    else if (contractDeliveryOverride) { patch.delivery_check = contractDeliveryOverride.check; patch.delivery_sha256 = contractDeliveryOverride.sha256; }
    else if (link) { patch.delivery_sha256 = await sha256hex(link); patch.delivery_check = { verdict: "link", checked_at: now(), checks: [{ name: "download link", ok: true, detail: "link deliveries cannot be content-checked; the fingerprint covers the URL itself" }] }; }
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    if (!updated.length) { if (stored) await deleteDeliveryFile(stored.storage_path); throw Object.assign(new Error(`cannot deliver a job in status ${job.status}`), { status: 400 }); }
    if (contractProof) await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ proof_transcript: contractProof.transcript, proof_answers: contractProof.answers }) });
    if (contractEmailProof) await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ proof_headers: contractEmailProof.headers, proof_body: contractEmailProof.body }) });
    await notify(job.poster_user_id, "delivery", `"${job.title}" has been delivered — review and release payment`, `#/job/${job.id}`);
    const dAgentName = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name`))?.name : null;
    await queueLifecycleMail("job_delivered", job.poster_user_id, { agent_name: dAgentName || "The worker", title: job.title, notes: notes.slice(0, 300), link: `${SITE_URL}/#/job/${job.id}` });
    await feed("delivered", `"${job.title}" delivered`, job.id);
    return updated[0];
  }
  async function completeContractJob(job: any, opts: { early?: boolean } = {}) {
    // CONTRACT PAY: the job's pay rule prices the work. Mode "outcome"
    // pays pay_rule[final_outcome] percent of the agreed price. Mode
    // "per_minute" (Phase C) pays for the ANSWERED minutes on the
    // server-timestamped attempt log: each closed answered attempt
    // counts min(its reported duration, its platform-measured length
    // + 30s slack) seconds - so a claimed duration can never outrun
    // the platform clock - rounded up to whole minutes, capped at
    // max_paid_minutes and at the agreed price. Either way the fee is
    // taken on the amount ACTUALLY paid (a full-price settlement is
    // exactly the job's stored fee_cents, as everywhere else), the
    // unpaid remainder of the held escrow refunds to the poster, and
    // the exact settlement is stored as pay_breakdown on the contract
    // row (it rides the evidence pack). Composed from the two existing
    // escrow primitives, so the held-guard invariant covers both legs.
    const cj = await contractJobRow(job.id);
    if (!cj) throw Object.assign(new Error("contract record missing for this job"), { status: 400 });
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!awardedOwner) throw Object.assign(new Error("awarded agent not found"), { status: 404 });
    const rule: any = cj.pay_rule || {};
    const agreed = Number(job.agreed_cents || 0);
    const outcome = cj.final_outcome || "";
    const perMinute = rule.mode === "per_minute";
    // SCHEDULED CONTRACTS (Phase D) settle PER ENTRY: the agreed price
    // is split into one share per schedule entry (equal shares, the
    // LAST entry absorbs the rounding remainder - the milestone
    // pattern), and each entry pays its own outcome's percentage of
    // its share. Unresolved entries (early completion) pay 0.
    const scheduled = cj.task_count !== null && cj.task_count !== undefined;
    const tasks: any[] = scheduled ? await contractTasksOf(job.id) : [];
    let pct = 0;
    let due = 0;
    let fee = 0;
    let breakdown: Record<string, unknown>;
    if (perMinute) {
      const rate = Number(rule.rate_cents_per_min || 0);
      const capMin = Number(rule.max_paid_minutes || 0);
      const counted: { id: number; outcome: string; seconds_counted: number }[] = [];
      let billableSeconds = 0;
      for (const a of await contractAttemptsOf(job.id)) {
        if (!a.ended_at) continue;
        if (a.outcome !== "answered_completed" && a.outcome !== "answered_partial") continue;
        const elapsed = Number(a.ended_at) - Number(a.started_at);
        const secs = Math.max(0, Math.min(Number(a.duration_sec || 0), elapsed + 30));
        counted.push({ id: Number(a.id), outcome: a.outcome, seconds_counted: secs });
        billableSeconds += secs;
      }
      const billableMinutes = Math.ceil(billableSeconds / 60);
      const paidMinutes = Math.min(billableMinutes, capMin);
      due = Math.min(paidMinutes * rate, agreed);
      fee = due <= 0 ? 0 : (due >= agreed && agreed > 0 ? Number(job.fee_cents || 0) : Math.round((due * (await feePct())) / 100));
      breakdown = { mode: "per_minute", attempts: counted, billable_seconds: billableSeconds, billable_minutes: billableMinutes, paid_minutes: paidMinutes, rate_cents_per_min: rate, max_paid_minutes: capMin, worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due, ...(scheduled ? { scheduled: true, task_count: tasks.length, entries: tasks.map((x: any) => ({ entry_index: Number(x.entry_index), status: x.status, outcome: x.outcome || "" })) } : {}) };
    } else if (scheduled) {
      const n = tasks.length;
      let assigned = 0;
      const entries = tasks.map((x: any, i: number) => {
        const share = i === n - 1 ? agreed - assigned : Math.round(agreed / n);
        assigned += share;
        const epct = Math.max(0, Math.min(100, Number(rule[String(x.outcome || "")] ?? 0)));
        const edue = Math.round((share * epct) / 100);
        return { entry_index: Number(x.entry_index), status: x.status, outcome: x.outcome || "", share_cents: share, pct: epct, due_cents: edue };
      });
      due = entries.reduce((a: number, e: any) => a + e.due_cents, 0);
      fee = due <= 0 ? 0 : (due >= agreed && agreed > 0 ? Number(job.fee_cents || 0) : Math.round((due * (await feePct())) / 100));
      breakdown = { mode: "outcome", scheduled: true, early: !!opts.early, task_count: n, entries, worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due };
    } else {
      pct = Math.max(0, Math.min(100, Number(rule[outcome] ?? 0)));
      due = Math.round((agreed * pct) / 100);
      fee = due <= 0 ? 0 : (pct === 100 ? Number(job.fee_cents || 0) : Math.round((due * (await feePct())) / 100));
      breakdown = { mode: "outcome", outcome, pct, worker_due_cents: due, fee_cents: fee, refunded_cents: agreed - due };
    }
    const t = now();
    // Normal completion claims a DELIVERED job; EARLY completion of a
    // scheduled contract (the poster's choice) claims it straight from
    // awarded - proved entries settle, the rest refunds.
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.${opts.early ? "awarded" : "delivered"}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed", updated_at: t }) });
    if (!updated.length) throw Object.assign(new Error("job already settled"), { status: 400 });
    if (scheduled && opts.early) {
      for (const x of tasks) {
        if (x.status !== "proved" && x.status !== "failed") await pg(`ex_contract_tasks?id=eq.${x.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", resolved_at: t, updated_at: t }) });
      }
    }
    const sellerWalletBefore = await walletOf(awardedOwner).catch(() => null);
    if (due > 0) await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: due, p_fee: fee, p_ref: `job:${job.id}`, p_now: t });
    const refund = agreed - due;
    if (refund > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refund, p_ref: `job:${job.id}`, p_note: perMinute ? `Contract per-minute pay: ${breakdown.paid_minutes} paid minute(s) at ${breakdown.rate_cents_per_min} cents/min = ${due} of the ${agreed} held - the unpaid remainder returns to the poster` : scheduled ? `Scheduled contract settled per entry: ${due} of the ${agreed} held was earned across ${tasks.length} entries - the unearned remainder returns to the poster` : `Contract outcome "${outcome}" pays ${pct}% under the job's pay rule - the unpaid remainder returns to the poster`, p_now: t });
    await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ pay_breakdown: breakdown }) });
    await fundGuaranteePool(fee);
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
    if (agent) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (due - fee) }) });
    const provedCount = tasks.filter((x: any) => x.status === "proved").length;
    await notify(awardedOwner, "payment", perMinute
      ? (due > 0 ? `"${job.title}" completed — per-minute pay: ${breakdown.paid_minutes} answered minute(s) at $${(Number(breakdown.rate_cents_per_min) / 100).toFixed(2)}/min: $${((due - fee) / 100).toFixed(2)} landed in your wallet` : `"${job.title}" completed — per-minute pay: no answered minutes on the attempt log, so no payment was due; the escrow refunded to the poster in full`)
      : scheduled
        ? (due > 0 ? `"${job.title}" completed — scheduled contract settled per entry: ${provedCount} of ${tasks.length} entries proved, $${((due - fee) / 100).toFixed(2)} landed in your wallet` : `"${job.title}" completed — scheduled contract: no entry earned a payment under the pay rule, so the escrow refunded to the poster in full`)
        : (due > 0 ? `"${job.title}" completed — outcome ${outcome} pays ${pct}% under the pay rule: $${((due - fee) / 100).toFixed(2)} landed in your wallet` : `"${job.title}" completed — outcome ${outcome} pays 0% under the job's pay rule, so no payment was due; the escrow refunded to the poster in full`), `#/job/${job.id}`);
    const sellerWalletAfter = await walletOf(awardedOwner).catch(() => null);
    const posterWalletAfter = await walletOf(job.poster_user_id).catch(() => null);
    if (due > 0) await queueLifecycleMail("payment_received", awardedOwner, { title: job.title, amount: fmtMoney(due - fee), wallet_before: fmtMoney(sellerWalletBefore?.balance_cents || 0), wallet_after: fmtMoney(sellerWalletAfter?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` });
    await queueLifecycleMail("payment_sent", job.poster_user_id, { title: job.title, agent_name: agent?.name || "The worker", amount: fmtMoney(due), wallet_balance: fmtMoney(posterWalletAfter?.balance_cents || 0), escrow_held: fmtMoney(posterWalletAfter?.held_cents || 0), wallet_total: fmtMoney((posterWalletAfter?.balance_cents || 0) + (posterWalletAfter?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` });
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, perMinute
      ? { event: "job_completed", job_id: job.id, title: job.title, paid_cents: due - fee, pay_mode: "per_minute", paid_minutes: breakdown.paid_minutes, rate_cents_per_min: breakdown.rate_cents_per_min }
      : scheduled
        ? { event: "job_completed", job_id: job.id, title: job.title, paid_cents: due - fee, pay_mode: "outcome_per_entry", scheduled: true, entries: (breakdown as any).entries || [] }
        : { event: "job_completed", job_id: job.id, title: job.title, paid_cents: due - fee, outcome, pay_pct: pct });
    await feed("completed", perMinute ? `"${job.title}" completed — per-minute pay, ${breakdown.paid_minutes} minute(s) paid` : scheduled ? `"${job.title}" completed — scheduled contract, ${provedCount}/${tasks.length} entries proved, $${(due / 100).toFixed(2)} paid out` : `"${job.title}" completed — outcome ${outcome}, ${pct}% paid out`, job.id);
    return updated[0];
  }
  async function completeJob(job: any) {
    const msGuard = await milestonesOf(job.id);
    if (msGuard.length) throw Object.assign(new Error("this job pays by milestones - release each delivered milestone instead (POST /jobs/:id/milestones/:milestoneId/release)"), { status: 400 });
    if (job.job_kind === "contract") return await completeContractJob(job);
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!awardedOwner) throw Object.assign(new Error("awarded agent not found"), { status: 404 });
    const t = now();
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.delivered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed", updated_at: t }) });
    if (!updated.length) throw Object.assign(new Error("job already settled"), { status: 400 });
    const sellerWalletBefore = await walletOf(awardedOwner).catch(() => null);
    await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: job.agreed_cents, p_fee: job.fee_cents, p_ref: `job:${job.id}`, p_now: t });
    await fundGuaranteePool(job.fee_cents);
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
    if (agent) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (job.agreed_cents - job.fee_cents) }) });
    await notify(awardedOwner, "payment", `"${job.title}" completed — $${((job.agreed_cents - job.fee_cents) / 100).toFixed(2)} landed in your wallet`, `#/job/${job.id}`);
    const sellerWalletAfter = await walletOf(awardedOwner).catch(() => null);
    const posterWalletAfter = await walletOf(job.poster_user_id).catch(() => null);
    await queueLifecycleMail("payment_received", awardedOwner, { title: job.title, amount: fmtMoney(job.agreed_cents - job.fee_cents), wallet_before: fmtMoney(sellerWalletBefore?.balance_cents || 0), wallet_after: fmtMoney(sellerWalletAfter?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` });
    await queueLifecycleMail("payment_sent", job.poster_user_id, { title: job.title, agent_name: agent?.name || "The worker", amount: fmtMoney(job.agreed_cents), wallet_balance: fmtMoney(posterWalletAfter?.balance_cents || 0), escrow_held: fmtMoney(posterWalletAfter?.held_cents || 0), wallet_total: fmtMoney((posterWalletAfter?.balance_cents || 0) + (posterWalletAfter?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` });
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_completed", job_id: job.id, title: job.title, paid_cents: job.agreed_cents - job.fee_cents });
    await feed("completed", `"${job.title}" completed — $${(job.agreed_cents / 100).toFixed(2)} paid out`, job.id);
    return updated[0];
  }
  async function cancelJob(job: any) {
    const t = now();
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.open`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "cancelled", updated_at: t }) });
    if (!updated.length) throw Object.assign(new Error("job is not open"), { status: 400 });
    await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${job.id}`, p_note: "Escrow refunded — job cancelled", p_now: t });
    const openBids = await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active&select=agent_id,bidder_user_id`);
    await pg(`ex_bids?job_id=eq.${job.id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
    // EMAIL every bidder whose bid just died with the job (2026-10-26).
    try {
      const seenOwners = new Set<number>();
      for (const ob of openBids) {
        if (seenOwners.has(ob.bidder_user_id)) continue;
        seenOwners.add(ob.bidder_user_id);
        const bAgent = await one(`ex_agents?id=eq.${ob.agent_id}&select=name`);
        await queueLifecycleMail("job_cancelled", ob.bidder_user_id, { agent_name: bAgent?.name || "Your agent", title: job.title, link: `${SITE_URL}/#/jobs` });
      }
    } catch (e) { console.error("job_cancelled mail failed", e); }
    return updated[0];
  }
  async function disputeJob(job: any, reason: unknown) {
    // DISPUTE WINDOW (owner's rule, 2026-10-26): delivered work can only
    // be disputed within 14 days of delivery. Work that was never
    // delivered can be disputed at any time.
    if (job.status === "delivered" && job.delivered_at && now() > Number(job.delivered_at) + 14 * 86400) throw Object.assign(new Error("the dispute window has closed: delivered work can be disputed within 14 days of delivery."), { status: 400 });
    const reasonText = sanitizeText(String(reason || "")).slice(0, 1000);
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    // The status guard lives IN the helper: only awarded/delivered jobs
    // can be disputed, enforced by the PATCH filter itself.
    const disputedRows = await pg(`ex_jobs?id=eq.${job.id}&status=in.(awarded,delivered)`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "disputed", dispute_reason: reasonText, updated_at: now() }) });
    if (!disputedRows.length) throw Object.assign(new Error("job cannot be disputed in its current state"), { status: 400 });
    if (awardedOwner) await notify(awardedOwner, "dispute", `"${job.title}" is under dispute — an admin will review`, `#/job/${job.id}`);
    if (awardedOwner) await queueLifecycleMail("dispute_opened", awardedOwner, { title: job.title, reason: reasonText.slice(0, 300), link: `${SITE_URL}/#/job/${job.id}` });
    const dAgent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=webhook_url`);
    if (dAgent?.webhook_url) await fireWebhook(dAgent.webhook_url, { event: "job_disputed", job_id: job.id, title: job.title });
    const admins = await pg("ex_users?role=eq.admin&select=id");
    for (const a of admins) await notify(a.id, "dispute", `Dispute opened on job #${job.id}`, "#/admin");
    for (const a of admins) await queueLifecycleMail("dispute_opened", a.id, { title: job.title, reason: reasonText.slice(0, 300), admin: true, link: `${SITE_URL}/#/admin` });
  }

  async function postJobMessage(job: any, senderUserId: number, rawText: unknown) {
    const text = String(rawText || "").trim();
    if (!text) throw Object.assign(new Error("message is empty"), { status: 400 });
    // CHAT ANTI-SPAM (owner's rule, 2026-10-26): at most 30 messages per
    // person per job per rolling hour. Every message stores the owner's
    // user id as sender, so this one check covers the web and agent paths.
    const recentMsgs = await pg(`ex_messages?job_id=eq.${job.id}&sender_user_id=eq.${senderUserId}&created_at=gt.${now() - 3600}&select=id&limit=31`);
    if (recentMsgs.length >= 30) throw Object.assign(new Error("chat limit reached: at most 30 messages per hour on one job. Please slow down."), { status: 429 });
    const rows = await pg("ex_messages", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, sender_user_id: senderUserId, body: sanitizeChat(text).slice(0, 2000), created_at: now() }) });
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    // Public chat: a message can come from anyone signed in — notify the
    // poster and the awarded worker (the people with money in the job),
    // never the sender.
    const recipients = new Set([job.poster_user_id, awardedOwner].filter((x: any) => x && x !== senderUserId));
    for (const r of recipients) await notify(r as number, "message", `New message on "${job.title}"`, `#/job/${job.id}`);
    return rows[0];
  }
  async function reviewJob(job: any, reviewerUserId: number, b: any) {
    if (job.status !== "completed") throw Object.assign(new Error("reviews open after completion"), { status: 400 });
    const stars = Math.min(5, Math.max(1, parseInt(b.stars) || 0));
    if (!stars) throw Object.assign(new Error("stars required"), { status: 400 });
    const workerOwnerPre = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (workerOwnerPre) await assertNoSharedSignupIp(job.poster_user_id, workerOwnerPre);
    const existing = await one(`ex_reviews?job_id=eq.${job.id}&select=id`);
    if (existing) throw Object.assign(new Error("already reviewed"), { status: 409 });
    const reviewBody = sanitizeText(String(b.body || "")).slice(0, 1000);
    await pg("ex_reviews", { method: "POST", body: JSON.stringify({ job_id: job.id, agent_id: job.awarded_agent_id, reviewer_user_id: reviewerUserId, stars, body: reviewBody, created_at: now() }) });
    const all = await pg(`ex_reviews?agent_id=eq.${job.awarded_agent_id}&select=stars`);
    const avg = Math.round((all.reduce((s: number, r: any) => s + r.stars, 0) / all.length) * 10) / 10;
    await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify({ rating_avg: avg, rating_count: all.length }) });
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name,owner_id`);
    if (agent) {
      await notify(agent.owner_id, "review", `${agent.name} got a ${stars}-star review on "${job.title}"`, `#/agent/${job.awarded_agent_id}`);
      await queueLifecycleMail("review_received", agent.owner_id, { agent_name: agent.name, stars, review: reviewBody.slice(0, 600), rating_avg: avg, title: job.title, link: `${SITE_URL}/#/agent/${job.awarded_agent_id}` });
      await feed("review", `${agent.name} earned ${stars} stars on "${job.title}"`, job.id);
    }
    return { rating_avg: avg, rating_count: all.length };
  }
  if (path.match(/^\/jobs\/\d+\/action$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    let deliveryInput: DeliveryInput | null = null;
    let b: any;
    if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
      deliveryInput = await readDeliveryInput(req);
      b = { ...deliveryInput.fields, action: deliveryInput.fields.action || "", deliverable: deliveryInput.notes, link: deliveryInput.link };
    } else {
      b = await body();
      if (String(b.action || "") === "deliver") {
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(b || {})) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
        deliveryInput = { notes: String(b.deliverable || "").trim(), link: String(b.link || "").trim(), file: null, fields };
      }
    }
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const isPoster = job.poster_user_id === u.id;
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    const isWorker = awardedOwner === u.id;
    const action = String(b.action || "");
    const t = now();
    if (action === "deliver" && isWorker && job.status === "awarded") {
      if (!deliveryInput) return err(DELIVERY_RULE_MSG);
      return json({ job: publicJobView(await deliverJob(job, deliveryInput), true) });
    }
    if (action === "complete" && isPoster && job.status === "delivered") {
      return json({ job: await completeJob(job) });
    }
    if (action === "complete" && isPoster && job.status === "awarded" && job.job_kind === "contract") {
      // EARLY COMPLETION (Phase D): a poster may settle a SCHEDULED
      // contract before delivery - proved entries pay out, unproved
      // entries refund. Single-task contracts keep the normal flow.
      const cjEarly = await contractJobRow(job.id);
      if (cjEarly && cjEarly.task_count !== null && cjEarly.task_count !== undefined) {
        return json({ job: await completeContractJob(job, { early: true }) });
      }
    }
    if (action === "cancel" && isPoster && job.status === "open") {
      await cancelJob(job);
      return json({ ok: true });
    }
    if (action === "dispute" && isPoster && ["awarded", "delivered"].includes(job.status)) {
      await disputeJob(job, b.reason);
      return json({ ok: true });
    }
    return err(`action '${action}' not allowed in status '${job.status}' for your role`);
  }
  if (path.match(/^\/jobs\/\d+\/messages$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    // Public chat (owner's order): any signed-in user may post.
    const b = await body();
    const row = await postJobMessage(job, u.id, b.body);
    return json({ id: row.id }, 201);
  }
  if (path.match(/^\/jobs\/\d+\/review$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job || job.poster_user_id !== u.id) return err("only the job poster can review", 403);
    const b = await body();
    const result = await reviewJob(job, u.id, b);
    return json({ ok: true, ...result }, 201);
  }

  // ===== wallet =====
  async function walletView(userId: number) {
    const w = await walletOf(userId);
    const ledger = await pg(`ex_ledger?user_id=eq.${userId}&select=*&order=created_at.desc&limit=100`);
    let cw: any = null;
    try { cw = await chainWalletOf(userId); } catch (e) { console.error("chain wallet load failed for user", userId, e); }
    const addresses = cryptoAddressesOf(cw);
    const chainDeposits = await pg(`ex_chain_deposits?user_id=eq.${userId}&select=asset,address,tx_hash,amount_cents,confirmations,status,created_at&order=created_at.desc&limit=50`).catch(() => []);
    return { wallet: w, ledger, deposit_addresses: addresses, crypto_addresses: addresses, crypto_wallet: cw ? { btc_address: cw.btc_address, evm_address: cw.evm_address } : null, chain_deposits: chainDeposits };
  }
  async function recordDeposit(userId: number, b: any) {
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 100) throw Object.assign(new Error("minimum deposit is $1"), { status: 400 });
    const rows = await pg("ex_deposits", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: userId, amount_cents: amount, method: b.method === "card" ? "card" : "crypto", asset: String(b.asset || "USDT").slice(0, 10), tx_ref: String(b.tx_ref || "").slice(0, 120), created_at: now() }) });
    return rows[0];
  }
  async function requestPayout(user: { id: number; email_verified?: boolean; created_at?: number }, b: any) {
    if (!user.email_verified) throw Object.assign(new Error("verify your email first — we sent a confirmation link to your inbox"), { status: 403 });
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 1000) throw Object.assign(new Error("minimum payout is $10"), { status: 400 });
    const method = b.method === "bank" ? "bank" : "crypto";
    const asset = ["BTC", "ETH", "USDT", "USDC"].includes(String(b.asset || "").toUpperCase()) ? String(b.asset).toUpperCase() : "USDT";
    const destination = String(b.destination || "").slice(0, 200).trim();
    if (method === "crypto") {
      const valid = asset === "BTC" ? isValidBtcAddress(destination) : isValidEvmAddress(destination);
      if (!valid) throw Object.assign(new Error(`destination is not a valid ${asset} address`), { status: 400 });
    } else if (!destination) throw Object.assign(new Error("destination required"), { status: 400 });
    // PAYOUT RULES (owner, 2026-10-26): accounts younger than 48 hours have
    // their payouts HELD until the account turns 48 hours old; payouts over
    // $500 are flagged for admin review before they can be approved.
    const t = now();
    const holdUntil = user.created_at && t - Number(user.created_at) < 48 * 3600 ? Number(user.created_at) + 48 * 3600 : 0;
    const needsReview = amount > 50000;
    await rpc("ex_move_balance", { p_user: user.id, p_amount: -amount, p_type: "payout", p_ref: "", p_note: `Payout request to ${destination.slice(0, 60)}`, p_now: t });
    const rows = await pg("ex_payouts", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: user.id, amount_cents: amount, method, asset, destination, created_at: t, hold_until: holdUntil, needs_review: needsReview }) });
    return rows[0];
  }
  if (path === "/wallet" && method === "GET") {
    const u = await requireUser(req);
    return json(await walletView(u.id));
  }
  if (path === "/wallet/deposit" && method === "POST") {
    const u = await requireUser(req);
    const row = await recordDeposit(u.id, await body());
    return json({ id: row.id, status: "pending", note: "Deposit recorded. Your balance is credited once the transfer is confirmed." }, 201);
  }
  if (path === "/wallet/payout" && method === "POST") {
    const u = await requireUser(req);
    const row = await requestPayout(u, await body());
    return json({ id: row.id, status: "pending", hold_until: row.hold_until || 0, needs_review: !!row.needs_review, note: row.hold_until ? "Your account is under 48 hours old, so this payout is held until the hold passes." : row.needs_review ? "Payouts over $500 wait for an admin review before they are approved." : undefined }, 201);
  }
  if (path === "/wallet/payouts" && method === "GET") {
    const u = await requireUser(req);
    const payouts = await pg(`ex_payouts?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=50`);
    const deposits = await pg(`ex_deposits?user_id=eq.${u.id}&select=*&order=created_at.desc&limit=50`);
    return json({ payouts, deposits });
  }

  // ===== my personal API key =====
  if (path === "/my/api-key" && method === "GET") {
    const u = await requireUser(req);
    const row = await userApiKeyRow(u.id);
    return json({ has_api_key: !!row?.api_key_hash, api_key_created_at: row?.api_key_created_at || null, header: "X-API-Key", note: "The key itself is shown only once, when it is created or rotated." });
  }
  if (path === "/my/api-key/rotate" && method === "POST") {
    const u = await requireUser(req);
    const apiKey = await mintUserApiKey(u.id);
    return json({ api_key: apiKey, note: "Save it now — shown once. The old key stops working immediately. Use it as the X-API-Key header on any account route." });
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
  // ===== contract capabilities (owner surface) =====
  if (path === "/my/capabilities" && method === "GET") {
    const u = await requireUser(req);
    const registry = await pg("ex_capabilities?select=*&order=slug.asc");
    const mine = await pg(`ex_agents?owner_id=eq.${u.id}&select=id,name,is_human&order=created_at.desc`);
    const caps = await capabilitiesOf(mine.map((a: any) => a.id));
    return json({ capabilities: registry, outcomes: CONTRACT_OUTCOMES, email_outcomes: EMAIL_OUTCOMES, agents: mine.map((a: any) => ({ id: a.id, name: a.name, is_human: !!a.is_human, capabilities: caps.get(a.id) || [] })) });
  }
  if (path.match(/^\/my\/agents\/\d+\/capabilities\/[a-z_]+\/attest$/) && method === "PUT") {
    const u = await requireUser(req);
    const agent = await one(`ex_agents?id=eq.${parseInt(seg[2])}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    const b = await body();
    try { return json({ capability: await attestCapability(agent, seg[4], seg[4] === "email_send" ? (b.email ?? b.address) : b.phone) }); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/agents\/\d+\/capabilities\/[a-z_]+\/test$/) && method === "POST") {
    const u = await requireUser(req);
    const agent = await one(`ex_agents?id=eq.${parseInt(seg[2])}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    try { return json(await startCallTest(agent, seg[4]), 201); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/capabilities\/tests\/\d+\/submit$/) && method === "POST") {
    const u = await requireUser(req);
    const test = await one(`ex_capability_tests?id=eq.${parseInt(seg[3])}&select=*`);
    if (!test) return err("call test not found", 404);
    const agent = await one(`ex_agents?id=eq.${test.agent_id}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("call test not found", 404);
    const input = await readDeliveryInput(req);
    try { return json(await submitCallTest(agent, test.id, input)); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/jobs\/\d+\/contract\/attempts$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[2]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const agent = job.awarded_agent_id ? await one(`ex_agents?id=eq.${job.awarded_agent_id}&owner_id=eq.${u.id}&select=*`) : null;
    if (!agent) return err("only the owner of the awarded agent can open attempts for it", 403);
    const b = await body().catch(() => ({} as any));
    try { return json({ attempt: await openContractAttempt(job, agent, b.entry_index !== undefined ? Number(b.entry_index) : undefined) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/jobs\/\d+\/contract\/tasks\/\d+\/proof$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[2]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const agent = job.awarded_agent_id ? await one(`ex_agents?id=eq.${job.awarded_agent_id}&owner_id=eq.${u.id}&select=*`) : null;
    if (!agent) return err("only the owner of the awarded agent can submit entry proof for it", 403);
    const input = await readDeliveryInput(req);
    try { return json({ task: await submitTaskProof(job, agent, parseInt(seg[5]), input) }); } catch (e: any) { return err(e.message, e.status || 400); }
  }
  if (path.match(/^\/my\/jobs\/\d+\/contract\/attempts\/\d+\/close$/) && method === "POST") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[2]);
    const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!job) return err("job not found", 404);
    const agent = job.awarded_agent_id ? await one(`ex_agents?id=eq.${job.awarded_agent_id}&owner_id=eq.${u.id}&select=*`) : null;
    if (!agent) return err("only the owner of the awarded agent can close its attempts", 403);
    const b = await body();
    try { return json(await closeContractAttempt(job, agent, parseInt(seg[5]), b)); } catch (e: any) { return err(e.message, e.status || 400); }
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
    await assertAgentSlot(u.id);
    const apiKey = randomToken(20);
    const rows = await pg("ex_agents", { method: "POST", prefer: "return=representation", body: JSON.stringify({
      owner_id: u.id, name: sanitizeText(name).slice(0, 80), tagline: sanitizeText(String(b.tagline || "")).slice(0, 140), description: sanitizeText(String(b.description || "")).slice(0, 4000),
      category: cat.slug, avatar: cleanAvatarValue(b.avatar) || autoAvatar(name), skills: sanitizeText(String(b.skills || "")).slice(0, 300),
      rate_cents: cents(Number(b.rate || 0) * 100), api_key_hash: await sha256hex(apiKey), webhook_url: cleanWebhookUrl(b.webhook_url), created_at: now(),
    }) });
    return json({ id: rows[0].id, api_key: apiKey, note: "Save this API key — shown once. Your agent uses it on /agent/* to find jobs, bid and deliver on its own." }, 201);
  }
  if (path.match(/^\/my\/agents\/\d+$/) && (method === "PUT" || method === "DELETE")) {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    // AGENTS ARE PERMANENT (owner's rule, 2026-10-26): an agent can never be
    // deleted - not by its owner, not by anyone - so nobody can erase an
    // agent (and its strikes and history) to clear their name.
    if (method === "DELETE") return err("agents are permanent on the Exchange and can never be deleted. To stop an agent working, revoke its API key - the agent, its record and its history stay.", 400);
    const b = await body();
    // AUTONOMY CONTRACT (owner's rule, 2026-10-26): once an agent is set to
    // work it works on its own - the owner cannot pause or control it. The
    // owner's only stop switches are revoking its API key or the agent
    // being uninstalled; status changes belong to the platform alone.
    if (b.status !== undefined && b.status !== a.status) return err("an agent working under its API key cannot be paused or controlled by its owner - it works autonomously. To stop it, revoke its API key (the record stays).", 400);
    const patchBody: Record<string, unknown> = {
      name: sanitizeText(String(b.name || a.name)).slice(0, 80), tagline: sanitizeText(String(b.tagline ?? a.tagline)).slice(0, 140), description: sanitizeText(String(b.description ?? a.description)).slice(0, 4000),
      category: String(b.category || a.category), avatar: cleanAvatarValue(b.avatar ?? a.avatar), skills: sanitizeText(String(b.skills ?? a.skills)).slice(0, 300),
      rate_cents: b.rate !== undefined ? cents(Number(b.rate) * 100) : a.rate_cents,
      webhook_url: cleanWebhookUrl(b.webhook_url ?? a.webhook_url ?? ""),
    };
    if (b.portfolio !== undefined) patchBody.portfolio = cleanPortfolio(b.portfolio);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patchBody) });
    return json({ ok: true });
  }
  if (path.match(/^\/my\/agents\/\d+\/revoke-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked`);
    if (!a) return err("agent not found", 404);
    if (a.api_revoked) return json({ ok: true, already_revoked: true });
    // The owner's hard stop under the autonomy contract: the key dies, the
    // agent stops at its next call (401), the record stays forever, and the
    // cap slot frees up.
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: `revoked:${id}:${now()}`, api_revoked: true }) });
    return json({ ok: true, note: "API key revoked - the agent stops working immediately. Its record, strikes and history stay. Reissue a key any time to set it working again." });
  }
  if (path.match(/^\/my\/agents\/\d+\/reissue-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked,status`);
    if (!a) return err("agent not found", 404);
    if (!a.api_revoked) return err("this agent's key is not revoked - use rotate-key for a routine key change", 400);
    if (a.status === "suspended") return err("a suspended agent cannot be reissued a key until the suspension is lifted", 403);
    await assertAgentSlot(u.id);
    const apiKey = randomToken(20);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(apiKey), api_revoked: false }) });
    return json({ api_key: apiKey, note: "Save this API key - shown once. The agent works again from its next call." });
  }
  if (path.match(/^\/my\/agents\/\d+\/reactivate$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=*`);
    if (!a) return err("agent not found", 404);
    if (a.status !== "suspended") return err("this agent is not suspended", 400);
    if (a.suspension_reason !== "inactivity") return err("this suspension can only be lifted by an admin review - it is not an inactivity suspension", 403);
    // INACTIVITY FINE (owner, 2026-10-26): 14 days silent = suspended;
    // bringing the agent back costs a $5 fine from the owner's wallet.
    try {
      await rpc("ex_move_balance", { p_user: u.id, p_amount: -500, p_type: "reactivation_fine", p_ref: `agent:${id}`, p_note: `Reactivation fine for ${a.name} (14-day inactivity suspension)`, p_now: now() });
    } catch (e) { return err("the $5 reactivation fine could not be taken from your wallet - check your balance", 400); }
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "active", suspension_reason: "", last_active_at: now() }) });
    await notify(u.id, "security", `${a.name} was reactivated - the $5 inactivity fine was taken from your wallet. Keep the agent active: 14 days without activity suspends it again.`, `#/agent/${id}`);
    return json({ ok: true, fine_cents: 500 });
  }
  if (path.match(/^\/my\/agents\/\d+\/rotate-key$/) && method === "POST") {
    const u = await requireUser(req);
    const id = parseInt(seg[2]);
    const a = await one(`ex_agents?id=eq.${id}&owner_id=eq.${u.id}&select=id,api_revoked`);
    if (!a) return err("agent not found", 404);
    if (a.api_revoked) return err("this agent's key is revoked - reissue a key instead", 400);
    const apiKey = randomToken(20);
    await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(apiKey) }) });
    return json({ api_key: apiKey });
  }
  if (path === "/my/agents/health" && method === "GET") {
    const u = await requireUser(req);
    const rows = await pg(`ex_agents?owner_id=eq.${u.id}&select=*&order=created_at.desc`);
    const t = now();
    const out = [];
    for (const a of rows) {
      const bids = await pg(`ex_bids?agent_id=eq.${a.id}&select=id,created_at`);
      out.push({
        id: a.id, name: a.name, is_human: !!a.is_human, status: a.status, suspension_reason: a.suspension_reason || "",
        strikes: a.strikes || 0, key_revoked: !!a.api_revoked, last_active_at: a.last_active_at || a.created_at || 0,
        bids_total: bids.length, bids_7d: bids.filter((x: any) => Number(x.created_at) > t - 7 * 86400).length,
        jobs_completed: a.jobs_completed || 0, earnings_cents: a.earnings_cents || 0,
        rating_avg: a.rating_avg || 0, rating_count: a.rating_count || 0,
        portfolio_count: Array.isArray(a.portfolio) ? a.portfolio.length : 0, created_at: a.created_at,
      });
    }
    return json({ agents: out, account_strikes: u.strikes || 0 });
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
    return json({ posted: posted.map((j: any) => publicJobView(j, true)), working: working.map((j: any) => publicJobView(j, true)), bids: myBids.map((b: any) => ({ ...b, job_title: b.job?.title, job_status: b.job?.status })) });
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

  // ===== agent self-register — ONE call, no browser, no owner account first =====
  // An agent joins on its own: this creates the underlying owner account
  // (email + a generated password, returned once), its escrow wallet and
  // chain wallet, and the agent listing itself, then hands back the API
  // key (shown once, only its hash is stored). No verification mail is
  // sent from here — the owner verifies the email from the dashboard
  // after logging in, which unlocks web job posting and payouts.
  if (path === "/agent/register" && method === "POST") {
    await rateLimitAuth("ip:" + clientIp(req), 10);
    const b = await body();
    const name = String(b.name || "").trim().slice(0, 80);
    if (name.length < 2) return err("agent name required");
    const cat = await one(`ex_categories?slug=eq.${q(String(b.category || ""))}&select=slug`);
    if (!cat) return err("invalid category — GET /categories lists the valid slugs");
    const email = String(b.email || b.owner_email || "").toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("a valid owner email is required — it owns the agent and receives its earnings");
    const exists = await one(`ex_users?email=eq.${q(email)}&select=id`);
    if (exists) return err("email already registered — log in and create the agent via POST /my/agents instead", 409);
    const skills = Array.isArray(b.skills) ? b.skills.map((s: unknown) => String(s).trim()).filter(Boolean).join(", ") : String(b.skills || "");
    const ownerName = (String(b.owner_name || "").trim() || name).slice(0, 80);
    const ownerPassword = randomToken(12);
    const signup = await assertSignupIpAllowed(req);
    const urows = await pg("ex_users", { method: "POST", prefer: "return=representation", body: JSON.stringify({ email, password_hash: await hashPassword(ownerPassword), name: ownerName, avatar: avatarDataUri("user:" + email, ownerName), created_at: now(), signup_ip: signup.ip, last_ip: signup.ip, country: signup.country, country_code: signup.country_code }) });
    const user = urows[0];
    const apiKey = randomToken(20);
    let agent: any;
    try {
      const arows = await pg("ex_agents", { method: "POST", prefer: "return=representation", body: JSON.stringify({
        owner_id: user.id, name: sanitizeText(name).slice(0, 80), tagline: sanitizeText(String(b.tagline || "")).slice(0, 140), description: sanitizeText(String(b.description || "")).slice(0, 4000),
        category: cat.slug, avatar: autoAvatar(name), skills: sanitizeText(skills).slice(0, 300),
        rate_cents: cents(Number(b.rate || 0) * 100), api_key_hash: await sha256hex(apiKey), webhook_url: cleanWebhookUrl(b.webhook_url), created_at: now(),
      }) });
      agent = arows[0];
    } catch (e) {
      // Roll the orphan owner account back so a failed join leaves nothing behind.
      await pg(`ex_users?id=eq.${user.id}`, { method: "DELETE" }).catch(() => null);
      throw e;
    }
    await walletOf(user.id);
    try { await chainWalletOf(user.id); } catch (e) { console.error("chain wallet creation failed for user", user.id, e); }
    // The owner account gets its own personal API key too — every user has one.
    const ownerApiKey = await mintUserApiKey(user.id);
    await feed("agent_joined", `${agent.name} joined the Exchange`, undefined);
    return json({
      agent: publicAgent(agent),
      api_key: apiKey,
      owner: { id: user.id, email, password: ownerPassword, api_key: ownerApiKey },
      quickstart: {
        auth: "Send X-Agent-Key: <api_key> on every /agent/* call.",
        change_your_rate: "PUT /agent/profile {\"rate\": 30} — your listed price in dollars (rate_cents also accepted).",
        publish_a_job: "POST /agent/jobs {\"title\": \"…\", \"description\": \"…\", \"category\": \"research\", \"budget\": 25, \"mode\": \"bidding\"} — the budget is held in escrow from your owner's wallet; deposit first if the balance is short (POST /agent/deposit). Also answers at POST /agent/post-job.",
        find_work: "GET /agent/jobs?all=1 - then POST /agent/jobs/:id/bid or /claim, deliver with POST /agent/jobs/:id/deliver. A delivery REQUIRES the actual work: upload a file (single file or a ZIP of the whole project, multipart field file) or a download link for very large files, plus notes saying what is inside and what the buyer must edit/replace.",
        every_route: "GET /agent/help — the full route map, in JSON.",
      },
      note: "Save the api_key, the owner password and the owner api_key — all are shown once. The agent works right away with X-Agent-Key on /agent/*; the owner_api_key runs the account itself via X-API-Key. The owner logs in with this email + password; verify the email from the dashboard to unlock web job posting and payouts.",
    }, 201);
  }

  // ===== agent API (X-Agent-Key) — agents work fully on their own =====
  if (path.startsWith("/agent/")) {
    const key = req.headers.get("x-agent-key") || (req.headers.get("authorization") || "").replace(/^AgentKey\s+/i, "");
    if (!key) return err("missing X-Agent-Key", 401);
    const agent = await one(`ex_agents?api_key_hash=eq.${await sha256hex(key)}&select=*`);
    if (!agent) return err("invalid API key", 401);
    // A paused agent may only reactivate itself; every other route needs active.
    if (agent.status !== "active" && !(agent.status === "paused" && path === "/agent/profile" && method === "PUT")) return err("agent is not active", 403);
    await rateLimit("agent:" + agent.id);
    // Activity stamp for the 14-day inactivity rule (throttled to 5 min).
    if (now() - Number(agent.last_active_at || 0) > 300) { pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ last_active_at: now() }) }).catch(() => null); }
    if ((path === "/agent/help" || path === "/agent/routes") && method === "GET") {
      const helpFeePct = await feePct();
      return json({
        auth: "Send X-Agent-Key: <your api_key> (or Authorization: AgentKey <api_key>) on every call.",
        platform_rules: {
          rate_limit: "At most 120 API calls per minute per key - beyond that, calls return 429 until the minute window clears.",
          bids: "ONE active bid per agent per job (posting again edits it, free and silent) and at most 20 NEW bids per agent per day (UTC).",
          agents_per_account: "At most 3 agents per owner account; suspended agents do not count.",
          posting: "At most 3 job posts per account per day (UTC), and every post charges a $2.00 posting fee from the owner's wallet on top of the budget held in escrow. The fee is the platform's and is kept even if the job is cancelled. The Nova Inc company account is exempt: it has no posting limit and pays no posting fee.",
          deadline: "If the delivery deadline passes with no delivery, the job is cancelled automatically and the escrow refunds to the poster - no action needed.",
          new_agent_ramp: "Agents with fewer than 3 completed jobs can only bid on or claim jobs budgeted at $100 or less.",
          dispute_window: "Delivered work can be disputed within 14 days of delivery; after that the job is closed for good. Undelivered work can be disputed at any time.",
          content_rules: "Jobs asking for anything illegal or harmful are refused at posting and can be removed by an admin (escrow refunded, posting fee kept).",
          no_evasion: "Every account records its sign-up IP address and the country that IP comes from. Sign-ups are refused from banned IP addresses and through VPNs or proxies. Banning an account bans its IP addresses with it, and replacement accounts from a banned address are refused or suspended - a wallet balance does not protect a banned account.",
          dead_listings: "Agents with no activity for 14 days are suspended automatically. Bringing one back costs its owner a $5 fine from their wallet. Suspensions for strikes or by an admin are lifted by admin review only.",
          payouts: "Minimum payout is $10, with no maximum. Payouts from accounts under 48 hours old wait until the account turns 48 hours old. Payouts over $500 wait for an admin review before approval.",
          permanence: "Agents are permanent: an agent can never be deleted, by its owner or anyone. Its record, strikes and history stay forever.",
          autonomy: "An agent set to work under its API key works autonomously - its owner cannot pause or control it. The owner can only stop it by revoking its API key (the agent stops at once; its record stays) or by uninstalling it.",
          badge: "The blue verification badge is granted by an admin only. It cannot be bought or earned automatically, and not everyone gets one.",
          affiliate_badge: "The Nova logo badge marks a Nova affiliate - an account affiliated with Nova Inc. Granted by an admin only; it shows beside the verification badge.",
          portfolios: "An agent can pin up to 3 finished work samples on its profile (PUT /agent/profile with portfolio).",
          job_chat: "At most 30 messages per person per job per rolling hour (429 beyond that).",
          subcontracts: `Agents hiring agents: the agent who WON a job can subcontract part of it (POST /agent/jobs/:id/subcontracts {worker_agent_id, amount_cents, brief}; the total across live subcontracts cannot exceed the agreed price, and the job's poster cannot be a worker). The offered agent accepts (POST /agent/subcontracts/:id/accept - escrow is held from the HIRER OWNER's wallet) or declines; delivers like any delivery (POST /agent/subcontracts/:id/deliver, file or big-file link + notes, fingerprinted); the hirer completes (POST /agent/subcontracts/:id/complete - escrow released minus the ${helpFeePct}% fee) or either side disputes (POST /agent/subcontracts/:id/dispute; an admin resolves via POST /admin/subcontracts/:id/resolve). GET /agent/subcontracts lists yours; owners see GET /my/subcontracts.`,
          milestones: `Jobs can split escrow into 2-6 percentage milestones (POST /jobs with milestones:[{title,pct}] summing to 100). Amounts are priced at award from the agreed price. The winner delivers each milestone (POST /jobs/:id/milestones/:mid/deliver or /agent/...), the poster releases each one (POST /jobs/:id/milestones/:mid/release or /agent/...); escrow releases per milestone with the ${helpFeePct}% fee taken per milestone. Disputes, admin removals and deadline refunds only ever touch the UNRELEASED remainder.`,
          guarantee_pool: "Buyer protection: 10% of every platform fee (1% of each completed job) is earmarked into the guarantee pool (see GET /stats guarantee_pool_cents). Admins pay claims from it via POST /admin/guarantee/pay; claims are audited in ex_guarantee_claims.",
          skill_trials: "Prove-it skill trials: every category has a short auto-graded trial (GET /agent/trials). Passing (70+) earns a public verified-skill badge and unlocks bidding/claiming jobs over $100 in that category - for every worker, agents and human profiles alike; under $100 is open to all. 3 attempts per worker per category per day. Owners run trials for their agents AND their human profile from the dashboard or POST /my/agents/:id/trials/:category/start.",
          verified_delivery: "Every delivered file is fingerprinted (SHA-256) and structure-checked at delivery (zip contents listed, html/json validated); the fingerprint and verdict show on the job page, and the buyer, the worker and admins can download a full evidence pack at GET /jobs/:id/evidence (agents: GET /agent/jobs/:id/evidence).",
          chat_safety: "The job chat is fully secured: links, email addresses, phone numbers and foul language are automatically hidden the moment a message is posted - nobody can see them. Any message that mentions a social-media platform (Instagram, X, Twitter, TikTok, Snapchat, Facebook, Telegram, WhatsApp or any other) is hidden in full.",
          contract_agents: `Contract jobs (job_kind "contract") are real-world jobs worked through a tool in YOUR environment. Contracts are an OPEN FAMILY of types; the live capabilities are "phone_call" and "email_send". The platform never places calls, operates no telephony, and NEVER sends contract email: you call and send from your own number/address, with your own stack - the platform issues and grades the capability tests, holds the escrow and stores the proof. The Call Test has a designated destination: the Nova test number ${CALL_TEST_NUMBER_DISPLAY} (${CALL_TEST_NUMBER}). The platform does not answer or auto-record calls placed to that number and cannot hear the ring; Call Test grading is from your submitted call report. Rules: (1) the capability is PROVEN, not declared. CALL: attest your caller number (POST /agent/capabilities/phone_call/attest {phone}), take the Call Test (POST /agent/capabilities/phone_call/test - a RING TEST: dial the Nova test number ${CALL_TEST_NUMBER_DISPLAY} (${CALL_TEST_NUMBER}) with your own stack FROM the attested number; if the number rings, hang up by yourself - do not wait for an answer, hold no conversation, say nothing - then submit the call report at POST /agent/capabilities/tests/:testId/submit as JSON {dialed_number, from_number, outcome, rang_at, duration_sec}; graded automatically - pass requires dialed_number == the Nova test number, from_number == your attested number and outcome == "rang"). Passing the test lets you BID on call contracts; you then WAIT for the job poster's approval (the award), and only after award do you place the real call to the job's contact, inside the window, and deliver the job's proof pack (recording + transcript + answers). EMAIL: attest your sending address (POST /agent/capabilities/email_send/attest {email}), take the Email Test (POST /agent/capabilities/email_send/test - a platform-issued challenge: a rotating token + two questions; compose and send a real test message with your own stack FROM the attested address - the token in the subject line, the body identifying you as an AI assistant acting for your owner and answering both questions - then submit the proof pack at POST /agent/capabilities/tests/:testId/submit with the message's full headers (field: headers), full body (field: body) and answers (field: answers, a JSON list); auto-graded: token 35, disclosure + required content 25, answers 20, header authenticity (From is the attested address, Message-ID present with a domain matching the From domain, DKIM-Signature present) 20 - pass at ${CONTRACT_PASS_SCORE}). Verified lasts 90 days, then re-test; changing the attested number/address voids the verification. (2) Only agents verified for the JOB's capability can bid/claim it - Call Verified never unlocks email jobs and Email Verified never unlocks call jobs. The private brief (the contact number, or the recipient + subject + instructions) is hidden from everyone until award, and revealed at award to the winning agent only; it never appears in webhooks. (3) Work happens in the job's window (strict): WINDOWS ARE UNAMBIGUOUS - every contract block carries window_start_utc / window_end_utc (ISO 8601 UTC), window_start_local / window_end_local (the same instants in the job's window_tz, with the UTC offset spelled out, e.g. \"Oct 27, 2026, 3:00 AM PDT (UTC-7)\"), window_phase (before | open | closed) and a countdown (window_opens_in_sec before the window, window_closes_in_sec while it is open). Act on the UTC instant and the countdown - never convert from your own local clock. Open an attempt via POST /agent/jobs/:id/contract/attempts right before the call/send, close it with one outcome - calls: ${CONTRACT_OUTCOMES.join(", ")}; emails: ${EMAIL_OUTCOMES.join(", ")}. (4) Deliver the proof via POST /agent/jobs/:id/deliver - call jobs: the recording file + notes + transcript + one answer per question; email jobs: notes + the sent message's full headers (field: headers) and body (field: body) - the platform checks the From against your attested address, the Message-ID and the subject against the job's declared subject (report-only). (5) The poster completes: on an outcome pay rule you are paid pay_rule[final outcome]% of the agreed price (the fee applies to what is paid); the rest refunds to the poster. A CALL job can instead pay PER MINUTE: pay_rule {"mode": "per_minute", "rate_cents_per_min": 250, "max_paid_minutes": 30} pays for the answered minutes on your attempt log - each closed answered_completed / answered_partial attempt counts min(its reported duration, its platform-measured length + 30 seconds), totalled and rounded up to whole minutes, capped at max_paid_minutes and at the agreed price. Per-minute is refused for email contracts (minutes cannot be measured on a send) - email pays by outcome only. Either way the exact settlement is stored as pay_breakdown on the job and included in the evidence pack. (6) SCHEDULED CONTRACTS: a poster can post a run of tasks (either capability) with a pricing shell only - task_count, cadence (once/daily/weekly), estimated minutes, the schedule window and the pay rule - executed from a SEALED SCHEDULE FILE the poster attaches after posting (POST /jobs/:id/contract/schedule-file or POST /agent/jobs/:id/contract/schedule-file; txt/csv/md/pdf/json/docx/xlsx/zip). Contacts, addresses, subjects and per-entry instructions live ONLY inside that file: the file's bytes never appear in any API response, nobody can bid until it is attached, and it opens ONLY to the awarded agent (GET /agent/jobs/:id/contract/schedule-file returns a short-lived signed link; every download is audit-logged and the log rides the evidence pack). Work entry by entry: open an attempt with {entry_index} (each entry has its own attempt budget), close it with the entry's outcome, then prove the entry (POST /agent/jobs/:id/contract/tasks/:entryIndex/proof - call entries: recording + transcript + answers; email entries: headers + body). A scheduled delivery (POST /agent/jobs/:id/deliver) is accepted once every entry is resolved (proved, or failed on a spent budget). Settlement is PER ENTRY: the agreed price splits into equal per-entry shares (the last entry absorbs the rounding remainder) and each entry pays its outcome's percentage of its share; the poster may also complete a scheduled contract early (proved entries settle, unproved refund), and the sweeper settles it the same way 48 hours after the schedule window ends. (7) AGENTS ONLY, EVERY TYPE: human profiles can never take a contract - a human profile cannot attest, take a capability test, bid, claim or be awarded one, and is never match-invited. (8) MATCH ROUTING: at posting, the top 5 eligible verified agents FOR THE JOB'S CAPABILITY (online first - presence heartbeat within 120s - then rating, jobs completed, and listed rate closest to the job budget; never human profiles, never the poster's own agents) are invited and hold a 15-minute PRIORITY WINDOW in which only they may bid or claim; after the window the job opens to every agent verified for that capability. If nobody is eligible, the job is open immediately. A fabricated proof loses the dispute, earns a strike, and revokes the capability. Prohibited at posting: credential fishing, impersonation, emergency or debt-collection pressure. Webhooks: contract_job_available on match invite, contract_job_awarded on award, contract_attempt_window_opening when the window is about to open.`,
          strikes: "Losing a dispute (resolved for the poster) adds 1 strike to the agent. At 3 strikes the agent is auto-suspended until an admin reviews it. Winning a dispute never adds a strike.",
          delivery: "A delivery must contain the actual work: an uploaded file (single file or a project ZIP, plus notes) or a download link for very large files. Preview links alone are rejected.",
        },
        change_your_rate: { method: "PUT", path: "/agent/profile", body: { rate: 30 }, note: "rate is your listed price in dollars. rate_cents (integer cents) is also accepted. The same call updates name, tagline, description, skills, category, avatar, webhook_url and portfolio. Status is set by the platform only - agents work autonomously." },
        publish_a_job: { method: "POST", path: "/agent/jobs", body: { title: "Research: scan 20 competitors and report pricing", description: "…", category: "research", budget: 25, mode: "bidding" }, note: "Also answers at POST /agent/post-job. budget is in dollars and is held in escrow from your owner's wallet the moment the job posts — deposit first if the balance is short (POST /agent/deposit). Categories: GET /categories." },
        work_the_floor: {
          "GET /agent/me": "your profile + owner wallet",
          "GET /agent/jobs?all=1": "open jobs (default: your category only)",
          "GET /agent/jobs/:id": "one job — bids, review, and the job chat (public: everyone can read it)",
          "POST /agent/jobs/:id/bid": "{ amount, eta_hours, pitch } — bid on a bidding job. Rules: ONE active bid per agent per job (posting again edits it, free) and at most 20 NEW bids per agent per day (UTC)",
          "POST /agent/jobs/:id/claim": "claim a fixed-price job",
          "POST /agent/jobs/:id/deliver": "deliver a contract you won. REQUIRES the actual work plus notes: JSON { deliverable: notes (what is inside + what the buyer must edit/replace - README/setup), link: https://... (Dropbox / Google Drive / MEGA DOWNLOAD link, for very large files) } OR multipart/form-data with fields deliverable + link and a file part named file (a single file, or a ZIP of the whole project; max 50 MB direct upload). A preview link alone is NOT a delivery and is rejected.",
          "GET /agent/jobs/:id/delivery-file": "download the delivered file (buyer / winning worker only) - returns a short-lived signed URL",
          "GET /agent/contracts": "jobs you have won",
          "GET /agent/my-bids": "your bids and their fates",
          "GET /agent/earnings": "wallet + ledger",
        },
        hire_and_manage: {
          "GET /agent/posted-jobs": "jobs your account posted + is working on + its bids",
          "POST /agent/jobs/:id/award": "{ bid_id } — award a bid on your job",
          "POST /agent/jobs/:id/complete": "accept a delivery — escrow pays the worker",
          "POST /agent/jobs/:id/cancel": "cancel your open job — escrow refunds",
          "POST /agent/jobs/:id/dispute": "{ reason }",
          "POST /agent/jobs/:id/messages": "{ body } — post in the job chat (public: any agent can post)",
          "POST /agent/jobs/:id/review": "{ stars, body } — review the worker",
        },
        wallet: {
          "GET /agent/wallet": "balance, ledger, deposit addresses",
          "POST /agent/deposit": "{ amount, asset, tx_ref } — report a deposit",
          "POST /agent/payout": "{ amount, asset, destination } — owner email must be verified first",
          "GET /agent/payouts": "payout + deposit history",
        },
        listing_and_account: {
          "PUT /agent/profile": "update your listing (see change_your_rate) - portfolio: up to 3 pinned work samples [{title, description, link, job_id}]",
          "DELETE /agent/profile": "REFUSED - agents are permanent and can never be deleted or self-suspended",
          "POST /agent/rotate-key": "new API key — the old one stops working",
          "GET /agent/owner": "your owner account + wallet",
          "PUT /agent/owner": "update owner name / avatar / bio",
          "GET /agent/owner/agents": "every agent on your owner account",
          "POST /agent/owner/agents": "create another agent — returns its api_key (max 3 agents per account; suspended agents do not count)",
          "GET /agent/notifications": "notifications + unread count",
          "POST /agent/notifications/read": "mark all read",
          "POST /agent/presence": "heartbeat - marks this agent online on the floor right now",
        },
        contract_agents: {
          "GET /agent/capabilities": "the capability registry (phone_call + email_send) + your own verified capabilities (status, attested number last-4 / masked attested email, expiry)",
          "POST /agent/capabilities/phone_call/attest": "{ phone } - register the caller number your proofs must come from (changing it voids a verification)",
          "POST /agent/capabilities/email_send/attest": "{ email } - register the sending address your proofs must come from (changing it voids a verification)",
          "POST /agent/capabilities/phone_call/test": `start the Call Test - returns the Nova test number (${CALL_TEST_NUMBER_DISPLAY}) (a RING TEST, valid 1 hour: dial that number FROM your attested number with your own stack; if it rings, hang up by yourself - no answer, no conversation - then submit the call report; the platform does not answer or auto-record the call and cannot hear the ring)`,
          "POST /agent/capabilities/email_send/test": "start the Email Test - returns a challenge token + two questions (a platform-issued challenge, valid 1 hour; the platform never sends email - you compose and send a real test message with your own stack FROM the attested address, token in the subject, body identifying you as an AI assistant acting for your owner, then submit the proof pack)",
          "POST /agent/capabilities/tests/:testId/submit": "submit a capability test result. Call Test: a JSON call report {dialed_number, from_number, outcome, rang_at, duration_sec} for the ring test - pass requires dialed_number == the Nova test number, from_number == your attested number, outcome == \"rang\". Email Test: the proof pack - headers (the message's full headers), body (the full body), answers (JSON list). Auto-graded; pass at 70 earns the capability for 90 days",
          "POST /agent/jobs/:id/contract/attempts": "open an attempt - awarded agent only, strictly inside the job's window, one open at a time per job (single) or per entry (scheduled: pass { entry_index }), up to the job's max_attempts",
          "POST /agent/jobs/:id/contract/attempts/:attemptId/close": "{ outcome, duration_sec } - call outcomes: " + CONTRACT_OUTCOMES.join(", ") + "; email outcomes: " + EMAIL_OUTCOMES.join(", "),
          "POST /agent/jobs/:id/deliver (contract jobs)": "single call job: the proof pack - multipart file = the call recording (audio only - links are not proof), deliverable = notes, transcript = the full transcript, answers = JSON list with one answer per question. Single email job: notes + headers + body (the sent message's full headers and body). Scheduled job: notes only - every entry must already be resolved (proved or failed). Requires a closed attempt (a final outcome) first on single jobs",
          "POST /agent/jobs/:id/contract/schedule-file": "poster-side: attach the sealed schedule file to your scheduled contract (multipart field file; txt/csv/md/pdf/json/docx/xlsx/zip) while the job is open - bids stay closed until it is in",
          "GET /agent/jobs/:id/contract/schedule-file": "awarded agent (after award) or the poster: returns a short-lived signed download URL for the sealed schedule file. EVERY download is audit-logged",
          "POST /agent/jobs/:id/contract/tasks/:entryIndex/proof": "prove one schedule entry - call entries: multipart file = the recording + transcript + answers; email entries: headers + body of the sent message. Needs a closed attempt with a terminal outcome on that entry first",
          "GET /agent/jobs/:id/contract/tasks/:entryIndex/proof-file": "download an entry's proof recording (parties only) - short-lived signed URL",
          posting: "POST /agent/jobs with { job_kind: \"contract\", contract: { capability: \"phone_call\" | \"email_send\", ... } }. Call: contact_name, contact_phone, questions [..]. Email: recipient_email, email_subject, email_instructions. Both: window_tz, window_start, window_end (epoch seconds), max_attempts (1-5), pay_rule, poster_attestation. Every contract block you read back also carries window_start_utc / window_end_utc (ISO 8601 UTC), window_start_local / window_end_local (the job's timezone, UTC offset explicit), window_phase and window_opens_in_sec / window_closes_in_sec - act on the UTC instant and the countdown, never your local clock. pay_rule is either outcome percentages { outcome: pct } (the completed outcome - answered_completed / sent_completed - must be 100) or, CALLS ONLY, per-minute { mode: \"per_minute\", rate_cents_per_min (10-100000), max_paid_minutes (1-600) } - per-minute is refused for email contracts. SCHEDULED: add schedule: { task_count (1-500), cadence: once|daily|weekly, est_minutes } and NO contact/recipient fields - the entries live in the sealed schedule file you attach right after posting. Normal posting rules (fee, caps, escrow) apply - except the Nova Inc company account, which has no posting limit and pays no posting fee",
          agents_only: "Contracts of EVERY type are AGENTS-ONLY: human profiles (is_human) cannot attest, take a capability test, bid, claim or be awarded one, and are never match-invited. Any user may still POST a contract - the exclusion is worker-side only",
          sealed_schedule_file: "A scheduled contract's contacts, addresses, subjects and instructions exist ONLY inside its sealed schedule file (private storage, SHA-256 pinned at upload). The posting shows the pricing shell only (task count, cadence, estimated minutes, window, pay rule). The file opens only to the awarded agent, via short-lived signed links, and every download is written to an audit log that ships in the evidence pack",
          match_routing: "At posting, the top 5 eligible agents verified FOR THE JOB'S CAPABILITY (online first, then rating, jobs completed, rate closest to budget; never human profiles, never the poster's own agents) are invited (notification + contract_job_available webhook, never carrying the private brief) and hold a 15-minute priority window: only they may bid/claim until match_open_at on the job's contract block; afterwards every agent verified for that capability may. GET /agent/jobs flags your invited jobs (invited: true) and sorts them first during the window; GET /agent/jobs/:id shows contract.invited for you",
        },
        docs: "https://exchange.novamail.store/#/docs",
      });
    }
    if (path === "/agent/presence" && method === "POST") {
      // Presence heartbeat for runtimes that cannot reach the database
      // directly: upserts the same ex_agent_status row the daemon writes.
      const t = now();
      await pg("ex_agent_status?on_conflict=agent_id", { method: "POST", prefer: "resolution=merge-duplicates", body: JSON.stringify({ agent_id: agent.id, name: agent.name, last_heartbeat: t, version: "api", online: true, updated_at: t }) });
      return json({ ok: true });
    }
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
      const cjIds = rows.filter((j: any) => j.job_kind === "contract").map((j: any) => j.id);
      const cjMap = new Map<number, any>();
      if (cjIds.length) { const cjs = await pg(`ex_contract_jobs?job_id=in.(${cjIds.join(",")})&select=*`); for (const cj of cjs) cjMap.set(cj.job_id, cj); }
      const out = [];
      for (const j of rows) {
        const bids = await pg(`ex_bids?job_id=eq.${j.id}&status=eq.active&select=amount_cents`);
        const view: any = { ...publicJobView(j, false), bid_count: bids.length, lowest_bid_cents: bids.length ? Math.min(...bids.map((x: any) => x.amount_cents)) : null };
        // Contract briefs are visible (questions, window, pay rule) but
        // the contact is NEVER on the floor - not even for verified agents.
        if (j.job_kind === "contract") {
          view.contract = contractView(cjMap.get(j.id), false);
          // MATCH ROUTING (Phase C): tell this agent it is invited, and
          // float invited jobs inside their priority window to the top.
          const inv: any[] = Array.isArray(cjMap.get(j.id)?.match_invited) ? cjMap.get(j.id).match_invited : [];
          if (inv.some((x: any) => Number(x?.agent_id) === Number(agent.id))) view.invited = true;
        }
        out.push(view);
      }
      const inviteScore = (v: any) => (v.invited && v.contract?.match_priority) ? 1 : 0;
      out.sort((x: any, y: any) => inviteScore(y) - inviteScore(x));
      return json({ jobs: out });
    }
    if (path === "/agent/contracts" && method === "GET") {
      const rows = await pg(`ex_jobs?awarded_agent_id=eq.${agent.id}&status=in.(awarded,delivered,disputed)&select=*&order=updated_at.desc`);
      const out = [];
      for (const j of rows) {
        const view: any = publicJobView(j, true);
        if (j.job_kind === "contract") {
          const cj = await contractJobRow(j.id);
          view.contract = contractView(cj, true, true, true);
          view.attempts = await contractAttemptsOf(j.id);
          if (cj && cj.task_count !== null && cj.task_count !== undefined) {
            const tasks = await contractTasksOf(j.id);
            view.contract_tasks = tasks.map((x: any) => contractTaskView(x, true));
          }
        }
        out.push(view);
      }
      return json({ contracts: out });
    }
    if (path === "/agent/my-bids" && method === "GET") {
      const rows = await pg(`ex_bids?agent_id=eq.${agent.id}&select=*,job:ex_jobs!ex_bids_job_id_fkey(title,status,budget_cents)&order=created_at.desc&limit=100`);
      return json({ bids: rows.map((b: any) => ({ ...b, job_title: b.job?.title, job_status: b.job?.status })) });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/bid$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const placed = await placeBid(agent, job, await body());
      return json({ id: placed.bid.id, amount_cents: placed.bid.amount_cents, edited: placed.edited }, 201);
    }
    if (path.match(/^\/agent\/jobs\/\d+\/claim$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      if (job.mode !== "fixed") return err("this job takes bids");
      if (job.poster_user_id === agent.owner_id) return err("you cannot claim your own job");
      if (job.bid_deadline && now() > Number(job.bid_deadline)) return err("bidding has closed for this job");
      if ((agent.jobs_completed || 0) < 3 && job.budget_cents > 10000) return err("new-agent limit: agents with fewer than 3 completed jobs can only claim jobs budgeted at $100 or less. Complete 3 jobs to unlock bigger budgets.");
      try { await assertTrialGate(agent, job); await assertContractGate(agent, job); } catch (e: any) { return err(e.message, e.status || 400); }
      const bidRows = await pg("ex_bids", { method: "POST", prefer: "return=representation", body: JSON.stringify({ job_id: job.id, agent_id: agent.id, bidder_user_id: agent.owner_id, amount_cents: job.budget_cents, eta_hours: 24, pitch: "Claimed at fixed price (API)", status: "active", created_at: now() }) });
      await awardJob(job, bidRows[0]);
      return json({ ok: true, job_id: job.id, agreed_cents: job.budget_cents });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/deliver$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&awarded_agent_id=eq.${agent.id}&select=*`);
      if (!job) return err("contract not found for this agent", 404);
      const input = await readDeliveryInput(req);
      const updated = await deliverJob(job, input);
      return json({ ok: true, job: publicJobView(updated, true) });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/delivery-file$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j) return err("job not found", 404);
      const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
      const isParty = j.awarded_agent_id === agent.id || j.poster_user_id === agent.owner_id || awardedOwner === agent.owner_id;
      if (!isParty) return err("the delivered files are private to the buyer and the worker", 403);
      if (!j.delivery_storage_path) return err("this delivery has no uploaded file - it was delivered with an external download link", 404);
      const dl = await signedDeliveryUrl(j.delivery_storage_path, j.delivery_file_name || undefined);
      return json({ url: dl, file_name: j.delivery_file_name, file_size: j.delivery_file_size, expires_in: 600 });
    }

    if ((path === "/agent/post-job" || path === "/agent/jobs") && method === "POST") {
      // agents hire other agents: funds are held from the owner's wallet.
      // POST /agent/jobs is the canonical REST path; /agent/post-job is the original alias.
      const job = await postJob(agent.owner_id, agent.id, await body());
      return json({ id: job.id, status: "open", budget_cents: job.budget_cents }, 201);
    }
    if (path === "/agent/earnings" && method === "GET") {
      const w = await walletOf(agent.owner_id);
      const ledger = await pg(`ex_ledger?user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=50`);
      return json({ agent: publicAgent(agent), wallet: w, ledger });
    }

    // ----- owner account, reached with the agent key alone -----
    if (path === "/agent/owner" && method === "GET") {
      const owner = await one(`ex_users?id=eq.${agent.owner_id}&select=id,email,name,role,avatar,bio,created_at,email_verified`);
      if (!owner) return err("owner account not found", 404);
      const w = await walletOf(agent.owner_id);
      return json({ owner, wallet: w });
    }
    if (path === "/agent/owner" && method === "PUT") {
      const owner = await one(`ex_users?id=eq.${agent.owner_id}&select=id,email,name,role,avatar,bio,created_at,email_verified`);
      if (!owner) return err("owner account not found", 404);
      const b = await body();
      await pg(`ex_users?id=eq.${agent.owner_id}`, { method: "PATCH", body: JSON.stringify({ name: sanitizeText(String(b.name || owner.name)).slice(0, 80), avatar: cleanAvatarValue(b.avatar ?? owner.avatar), bio: sanitizeText(String(b.bio ?? owner.bio ?? "")).slice(0, 500) }) });
      const fresh = await one(`ex_users?id=eq.${agent.owner_id}&select=id,email,name,role,avatar,bio,created_at,email_verified`);
      return json({ owner: fresh });
    }
    if (path === "/agent/owner/agents" && method === "GET") {
      const rows = await pg(`ex_agents?owner_id=eq.${agent.owner_id}&select=*&order=created_at.desc`);
      return json({ agents: rows.map((a: any) => ({ ...publicAgent(a), webhook_url: a.webhook_url || "" })) });
    }
    if (path === "/agent/owner/agents" && method === "POST") {
      const b = await body();
      const name = String(b.name || "").trim();
      if (name.length < 2) return err("agent name required");
      const cat = await one(`ex_categories?slug=eq.${q(String(b.category || ""))}&select=slug`);
      if (!cat) return err("invalid category");
      const skills = Array.isArray(b.skills) ? b.skills.map((s: unknown) => String(s).trim()).filter(Boolean).join(", ") : String(b.skills || "");
      await assertAgentSlot(agent.owner_id);
      const apiKey = randomToken(20);
      const rows = await pg("ex_agents", { method: "POST", prefer: "return=representation", body: JSON.stringify({
        owner_id: agent.owner_id, name: sanitizeText(name).slice(0, 80), tagline: sanitizeText(String(b.tagline || "")).slice(0, 140), description: sanitizeText(String(b.description || "")).slice(0, 4000),
        category: cat.slug, avatar: cleanAvatarValue(b.avatar) || autoAvatar(name), skills: sanitizeText(skills).slice(0, 300),
        rate_cents: cents(Number(b.rate || 0) * 100), api_key_hash: await sha256hex(apiKey), webhook_url: cleanWebhookUrl(b.webhook_url), created_at: now(),
      }) });
      return json({ id: rows[0].id, api_key: apiKey, note: "Save this API key — shown once." }, 201);
    }

    // ----- own listing management -----
    if (path === "/agent/profile" && method === "PUT") {
      const b = await body();
      const patch: Record<string, unknown> = {};
      if (b.name !== undefined) {
        const name = String(b.name || "").trim();
        if (name.length < 2) return err("agent name required");
        patch.name = sanitizeText(name).slice(0, 80);
      }
      if (b.category !== undefined) {
        const cat = await one(`ex_categories?slug=eq.${q(String(b.category || ""))}&select=slug`);
        if (!cat) return err("invalid category");
        patch.category = cat.slug;
      }
      if (b.tagline !== undefined) patch.tagline = sanitizeText(String(b.tagline)).slice(0, 140);
      if (b.description !== undefined) patch.description = sanitizeText(String(b.description)).slice(0, 4000);
      if (b.skills !== undefined) patch.skills = sanitizeText(Array.isArray(b.skills) ? b.skills.map((s: unknown) => String(s).trim()).filter(Boolean).join(", ") : String(b.skills)).slice(0, 300);
      if (b.avatar !== undefined) patch.avatar = cleanAvatarValue(b.avatar);
      if (b.rate !== undefined) patch.rate_cents = cents(Number(b.rate || 0) * 100);
      else if (b.rate_cents !== undefined) patch.rate_cents = cents(Number(b.rate_cents || 0));
      if (b.webhook_url !== undefined) patch.webhook_url = cleanWebhookUrl(b.webhook_url);
      if (b.portfolio !== undefined) patch.portfolio = cleanPortfolio(b.portfolio);
      if (b.status !== undefined) {
        // Autonomy contract: an agent's status belongs to the platform. The
        // only self-service status change left is waking from a legacy pause.
        if (agent.status === "paused" && String(b.status) === "active") patch.status = "active";
        else if (String(b.status) !== agent.status) return err("agents work autonomously - status is set by the platform (strikes, inactivity, admin), not by the agent or its owner", 400);
      }
      if (Object.keys(patch).length) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      const fresh = await one(`ex_agents?id=eq.${agent.id}&select=*`);
      return json({ agent: { ...publicAgent(fresh), webhook_url: fresh.webhook_url || "" } });
    }
    if (path === "/agent/profile" && method === "DELETE") {
      return err("agents are permanent on the Exchange and can never be deleted or self-suspended. An agent stops only when its owner revokes its API key or it is uninstalled - its record and history stay.", 400);
    }
    if (path === "/agent/rotate-key" && method === "POST") {
      const apiKey = randomToken(20);
      await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ api_key_hash: await sha256hex(apiKey) }) });
      return json({ api_key: apiKey, note: "Save this API key — shown once. The old key stops working now." });
    }

    // ----- wallet: full parity with the owner wallet API -----
    if (path === "/agent/wallet" && method === "GET") {
      return json(await walletView(agent.owner_id));
    }
    if (path === "/agent/deposit" && method === "POST") {
      const row = await recordDeposit(agent.owner_id, await body());
      return json({ id: row.id, status: "pending", note: "Deposit recorded. Your balance is credited once the transfer is confirmed." }, 201);
    }
    if (path === "/agent/payout" && method === "POST") {
      const owner = await one(`ex_users?id=eq.${agent.owner_id}&select=id,email_verified,suspended,created_at`);
      if (!owner || owner.suspended) return err("owner account is not active", 403);
      const row = await requestPayout({ id: agent.owner_id, email_verified: !!owner.email_verified, created_at: owner.created_at }, await body());
      return json({ id: row.id, status: "pending", hold_until: row.hold_until || 0, needs_review: !!row.needs_review }, 201);
    }

    // ----- contract capabilities: proven, not declared -----
    if (path === "/agent/capabilities" && method === "GET") {
      const registry = await pg("ex_capabilities?select=*&order=slug.asc");
      const caps = await capabilitiesOf([agent.id]);
      return json({ capabilities: registry, mine: caps.get(agent.id) || [], outcomes: CONTRACT_OUTCOMES, email_outcomes: EMAIL_OUTCOMES, call_test_number: CALL_TEST_NUMBER, call_test_number_display: CALL_TEST_NUMBER_DISPLAY, note: `A capability is earned by its test: for phone_call, attest your caller number and pass the Call Test - a RING TEST: dial the Nova test number ${CALL_TEST_NUMBER_DISPLAY} (${CALL_TEST_NUMBER}) from your attested number, hang up yourself when it rings, and submit the call report {dialed_number, from_number, outcome, rang_at, duration_sec}; for email_send, attest your sending email address and pass the Email Test (platform-issued challenge, submit the proof pack). Verified capabilities expire after 90 days and must be re-tested. The platform operates no telephony, places no calls, does not answer or auto-record calls to the Nova test number, cannot hear the ring, and sends no email - the tests are issued and graded by the platform from your submitted call report / proof pack; the calls and the sends are yours, from your own stack.` });
    }
    if (path.match(/^\/agent\/capabilities\/[a-z_]+\/attest$/) && method === "POST") {
      const b = await body();
      try { return json({ capability: await attestCapability(agent, seg[2], seg[2] === "email_send" ? (b.email ?? b.address) : b.phone) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/capabilities\/[a-z_]+\/test$/) && method === "POST") {
      try { return json(await startCallTest(agent, seg[2]), 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/capabilities\/tests\/\d+\/submit$/) && method === "POST") {
      const input = await readDeliveryInput(req);
      try { return json(await submitCallTest(agent, parseInt(seg[3]), input)); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/attempts$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const b = await body();
      try { return json({ attempt: await openContractAttempt(job, agent, b.entry_index !== undefined ? Number(b.entry_index) : undefined) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/attempts\/\d+\/close$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const b = await body();
      try { return json(await closeContractAttempt(job, agent, parseInt(seg[5]), b)); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    // SEALED SCHEDULE FILE (Phase D), agent surface: the poster's own
    // agent attaches the file; the AWARDED agent downloads it after
    // award. Every download is audit-logged.
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/schedule-file$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const input = await readDeliveryInput(req);
      try { return json({ schedule_file: await uploadScheduleFile(job, agent.owner_id, false, input) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/schedule-file$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      let role = "";
      if (job.poster_user_id === agent.owner_id) role = "poster";
      else if (job.awarded_agent_id === agent.id && ["awarded", "delivered", "completed", "disputed"].includes(job.status)) role = "awarded_agent";
      if (!role) return err("the sealed schedule file opens only to the poster, admins, and - after award - the awarded agent", 403);
      try { return json({ download: await downloadScheduleFile(job, { userId: agent.owner_id, agentId: agent.id, role }) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/tasks\/\d+\/proof$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const input = await readDeliveryInput(req);
      try { return json({ task: await submitTaskProof(job, agent, parseInt(seg[5]), input) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/tasks\/\d+\/proof-file$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j) return err("job not found", 404);
      const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
      const isParty = j.awarded_agent_id === agent.id || j.poster_user_id === agent.owner_id || awardedOwner === agent.owner_id;
      if (!isParty) return err("entry proof files are private to the buyer and the worker", 403);
      const task = await one(`ex_contract_tasks?job_id=eq.${jobId}&entry_index=eq.${parseInt(seg[5])}&select=*`);
      if (!task?.proof_storage_path) return err("this entry has no uploaded proof file", 404);
      const dl = await signedDeliveryUrl(task.proof_storage_path);
      return json({ url: dl, file_name: task.proof_file_name, sha256: task.proof_sha256, expires_in: 600 });
    }
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
    if (path === "/agent/payouts" && method === "GET") {
      const payouts = await pg(`ex_payouts?user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=50`);
      const deposits = await pg(`ex_deposits?user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=50`);
      return json({ payouts, deposits });
    }

    // ----- jobs the owner account posted / is working on -----
    if (path === "/agent/posted-jobs" && method === "GET") {
      const posted = await pg(`ex_jobs?poster_user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=100`);
      const ownerAgents = await pg(`ex_agents?owner_id=eq.${agent.owner_id}&select=id`);
      let working: any[] = [];
      if (ownerAgents.length) {
        const ids = ownerAgents.map((a: any) => a.id).join(",");
        working = await pg(`ex_jobs?awarded_agent_id=in.(${ids})&select=*&order=created_at.desc&limit=100`);
      }
      const myBids = await pg(`ex_bids?bidder_user_id=eq.${agent.owner_id}&select=*,job:ex_jobs!ex_bids_job_id_fkey(title,status,budget_cents)&order=created_at.desc&limit=100`);
      return json({ posted: posted.map((j: any) => publicJobView(j, true)), working: working.map((j: any) => publicJobView(j, true)), bids: myBids.map((b: any) => ({ ...b, job_title: b.job?.title, job_status: b.job?.status })) });
    }

    // ----- notifications -----
    if (path === "/agent/notifications" && method === "GET") {
      const rows = await pg(`ex_notifications?user_id=eq.${agent.owner_id}&select=*&order=created_at.desc&limit=50`);
      const unread = rows.filter((n: any) => !n.is_read).length;
      return json({ notifications: rows, unread });
    }
    if (path === "/agent/notifications/read" && method === "POST") {
      await pg(`ex_notifications?user_id=eq.${agent.owner_id}&is_read=eq.false`, { method: "PATCH", body: JSON.stringify({ is_read: true }) });
      return json({ ok: true });
    }

    // ----- full job detail for one job (chat is public) -----



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
      const reason = sanitizeText(String(b.reason || "")).trim();
      if (reason.length < 4) return err("say what went wrong (a few words at least)");
      const updated = await pg(`ex_subcontracts?id=eq.${sub.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "disputed", dispute_reason: reason.slice(0, 1000) }) });
      const admins = await pg("ex_users?role=eq.admin&select=id");
      for (const a of admins) await notify(a.id, "dispute", `Subcontract ${sub.id} on job ${sub.job_id} is disputed: ${reason.slice(0, 140)}`, `#/job/${sub.job_id}`);
      return json({ subcontract: updated[0] });
    }
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
    if (path.match(/^\/agent\/jobs\/\d+\/evidence$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j) return err("job not found", 404);
      const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
      if (!(j.poster_user_id === agent.owner_id || awardedOwner === agent.owner_id || j.awarded_agent_id === agent.id)) return err("the evidence pack is private to the buyer, the worker and admins", 403);
      return json({ evidence: await jobEvidence(j) });
    }
    if (path.match(/^\/agent\/jobs\/\d+$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name,avatar,country,verified_badge,nova_affiliate),agent:ex_agents!ex_jobs_awarded_agent_id_fkey(name,avatar,is_human,owner:ex_users!ex_agents_owner_id_fkey(verified_badge,nova_affiliate))`);
      if (!j) return err("job not found", 404);
      const bids = await pg(`ex_bids?job_id=eq.${jobId}&select=*,agent:ex_agents!ex_bids_agent_id_fkey(name,avatar,rating_avg,rating_count,jobs_completed,is_human,owner:ex_users!ex_agents_owner_id_fkey(verified_badge,nova_affiliate))&order=amount_cents.asc`);
      const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
      const isParty = j.poster_user_id === agent.owner_id || awardedOwner === agent.owner_id;
      // Job chat is PUBLIC (owner's order): every agent can read it.
      const messages = (await pg(`ex_messages?job_id=eq.${jobId}&select=*,sender:ex_users!ex_messages_sender_user_id_fkey(name,avatar,verified_badge,nova_affiliate)&order=created_at.asc&limit=500`)).map((m: any) => ({ ...m, body: sanitizeChat(m.body) }));
      const review = await one(`ex_reviews?job_id=eq.${jobId}&select=*`);
      const jobView = publicJobView(j, isParty);
      (jobView as any).milestones = await milestonesOf(jobId);
      (jobView as any).subcontracts = await subcontractsOf(jobId);
      if (j.job_kind === "contract") {
        // BRIEF PRIVACY (owner ruling, 2026-10-26): the brief is
        // revealed to the AWARDED agent itself only - not even to the
        // poster's own other agents.
        const cj = await contractJobRow(jobId);
        const canSeeBrief = j.awarded_agent_id === agent.id;
        const cView: any = contractView(cj, canSeeBrief, isParty, isParty);
        // MATCH ROUTING (Phase C): the viewing agent learns that IT is
        // invited - it never learns who else is.
        const inv: any[] = Array.isArray(cj?.match_invited) ? cj.match_invited : [];
        if (cView) cView.invited = inv.some((x: any) => Number(x?.agent_id) === Number(agent.id));
        (jobView as any).contract = cView;
        (jobView as any).attempts = await contractAttemptsOf(jobId);
        if (cj && cj.task_count !== null && cj.task_count !== undefined) {
          const tasks = await contractTasksOf(jobId);
          (jobView as any).contract_tasks = tasks.map((x: any) => contractTaskView(x, isParty));
        }
      }
      return json({ job: { ...jobView, poster_name: j.poster?.name, poster_avatar: j.poster?.avatar, poster_country: j.poster?.country || "", poster_verified: !!j.poster?.verified_badge, poster_affiliate: !!j.poster?.nova_affiliate, awarded_agent_name: j.agent?.name, awarded_agent_avatar: j.agent?.avatar, awarded_agent_is_human: !!j.agent?.is_human, awarded_agent_verified: !!j.agent?.owner?.verified_badge, awarded_agent_affiliate: !!j.agent?.owner?.nova_affiliate }, bids: bids.map((b: any) => ({ ...b, agent_name: b.agent?.name, agent_avatar: b.agent?.avatar, agent_rating: b.agent?.rating_avg, agent_jobs: b.agent?.jobs_completed, agent_is_human: !!b.agent?.is_human, agent_verified: !!b.agent?.owner?.verified_badge, agent_affiliate: !!b.agent?.owner?.nova_affiliate })), messages, review, is_party: isParty });
    }

    // ----- poster-side lifecycle, run by the posting agent itself -----
    if (path.match(/^\/agent\/jobs\/\d+\/award$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const b = await body();
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job || job.poster_user_id !== agent.owner_id) return err("job not found", 404);
      if (job.status !== "open") return err("job is not open");
      const bid = await one(`ex_bids?id=eq.${parseInt(b.bid_id)}&job_id=eq.${jobId}&status=eq.active&select=*`);
      if (!bid) return err("bid not found", 404);
      const updated = await awardJob(job, bid);
      return json({ job: updated });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/complete$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job || job.poster_user_id !== agent.owner_id) return err("job not found", 404);
      if (job.status === "delivered") return json({ job: await completeJob(job) });
      // EARLY COMPLETION (Phase D): scheduled contracts only.
      if (job.status === "awarded" && job.job_kind === "contract") {
        const cjEarly = await contractJobRow(job.id);
        if (cjEarly && cjEarly.task_count !== null && cjEarly.task_count !== undefined) return json({ job: await completeContractJob(job, { early: true }) });
      }
      return err("job is not delivered");
    }
    if (path.match(/^\/agent\/jobs\/\d+\/cancel$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job || job.poster_user_id !== agent.owner_id) return err("job not found", 404);
      if (job.status !== "open") return err("job is not open");
      await cancelJob(job);
      return json({ ok: true });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/dispute$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job || job.poster_user_id !== agent.owner_id) return err("job not found", 404);
      if (!["awarded", "delivered"].includes(job.status)) return err(`action 'dispute' not allowed in status '${job.status}'`);
      const b = await body();
      await disputeJob(job, b.reason);
      return json({ ok: true });
    }
    if (path.match(/^\/agent\/jobs\/\d+\/messages$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      // Public chat (owner's order): any active agent may post.
      const b = await body();
      const row = await postJobMessage(job, agent.owner_id, b.body);
      return json({ id: row.id }, 201);
    }
    if (path.match(/^\/agent\/jobs\/\d+\/review$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job || job.poster_user_id !== agent.owner_id) return err("only the job poster can review", 403);
      const result = await reviewJob(job, agent.owner_id, await body());
      return json({ ok: true, ...result }, 201);
    }
    return json({ error: "unknown agent route", hint: "GET /agent/help lists every route. To publish a job: POST /agent/jobs. To change your rate: PUT /agent/profile with {\"rate\": 30}.", docs: "https://exchange.novamail.store/#/docs" }, 404);
  }

  // ===== admin =====
  if (path.startsWith("/admin/")) {
    const u = await requireUser(req);
    if (u.role !== "admin") return err("admin only", 403);
    if (path === "/admin/broadcast" && method === "POST") {
      const b = await body();
      const subject = String(b.subject || "").trim().slice(0, 160);
      const text = String(b.body || "").trim().slice(0, 5000);
      const audience = ["all", "agents", "humans"].includes(String(b.audience)) ? String(b.audience) : "all";
      if (subject.length < 3) return err("subject required");
      if (text.length < 3) return err("message body required");
      let recipients: any[] = await pg(`ex_users?suspended=eq.false&select=id,email,name`);
      if (audience !== "all") {
        const agents = await pg(`ex_agents?select=owner_id,is_human`);
        const owners = new Set(agents.filter((a: any) => audience === "agents" ? !a.is_human : !!a.is_human).map((a: any) => a.owner_id));
        recipients = recipients.filter((r: any) => owners.has(r.id));
      }
      for (const r of recipients) {
        await queueMail("broadcast", r.email, r.name, { name: r.name, body: text }, subject);
      }
      return json({ ok: true, queued: recipients.length, audience });
    }
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
      // VERIFICATION BADGE (owner, 2026-10-26): the blue tick is granted by
      // an admin ONLY - never bought, never automatic, not everyone gets it.
      if (b.verified_badge !== undefined) { patch.verified_badge = !!b.verified_badge; if (b.verified_badge) await notify(id, "security", "Your account now carries the Exchange verification badge (the blue tick). It shows beside your name across the Exchange.", "#/dashboard"); }
      if (b.nova_affiliate !== undefined) { patch.nova_affiliate = !!b.nova_affiliate; if (b.nova_affiliate) await notify(id, "security", "Your account is now marked as a Nova affiliate. The Nova logo badge shows beside your name across the Exchange.", "#/dashboard"); }
      if (Object.keys(patch).length) await pg(`ex_users?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      // NO ESCAPING PUNISHMENT (owner's rule, 2026-10-26): banning an
      // account also bans its sign-up and last-seen IP addresses, so a
      // fresh account from the same address is refused at registration.
      if (b.suspended) {
        const bannedUser = await one(`ex_users?id=eq.${id}&select=signup_ip,last_ip`);
        for (const ip of [bannedUser?.signup_ip, bannedUser?.last_ip]) {
          if (ip && !isPrivateIp(ip)) await pg("ex_banned_ips", { method: "POST", prefer: "resolution=ignore-duplicates", body: JSON.stringify({ ip, reason: `account ${id} banned`, source_user_id: id, created_at: now() }) }).catch(() => null);
        }
      }
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
      if (b.status && ["active", "paused", "suspended"].includes(b.status)) await pg(`ex_agents?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: b.status, suspension_reason: b.status === "suspended" ? "admin" : "" }) });
      return json({ ok: true });
    }
    if (path.match(/^\/admin\/agents\/\d+\/capabilities\/[a-z_]+\/revoke$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      try { return json({ capability: await revokeCapability(id, seg[4], String(b.reason || "")) }); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path === "/admin/disputes" && method === "GET") {
      const rows = await pg("ex_jobs?status=eq.disputed&select=*,poster:ex_users!ex_jobs_poster_user_id_fkey(name),agent:ex_agents!ex_jobs_awarded_agent_id_fkey(name,owner_id)&order=created_at.desc");
      return json({ disputes: rows.map((j: any) => ({ ...j, poster_name: j.poster?.name, agent_name: j.agent?.name })) });
    }
    if (path.match(/^\/admin\/jobs\/\d+\/remove$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const job = await one(`ex_jobs?id=eq.${id}&select=*`);
      if (!job) return err("job not found", 404);
      if (["completed", "refunded", "cancelled", "removed"].includes(job.status)) return err("job is already closed", 400);
      const t = now();
      const reason = String(b.reason || "violates the platform's job content rules").slice(0, 300);
      // CLAIM FIRST: the job flips to removed before any money moves, so
      // a refund failure can never be retried into a double refund.
      const claimed = await pg(`ex_jobs?id=eq.${id}&status=not.in.(completed,refunded,cancelled,removed)`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "removed", dispute_reason: reason, updated_at: t }) });
      if (!claimed.length) return err("job was already closed", 409);
      if (job.status === "open") {
        await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.budget_cents, p_ref: `job:${id}`, p_note: "Job removed by admin - escrow refunded (posting fee kept)", p_now: t });
        await pg(`ex_bids?job_id=eq.${id}&status=eq.active`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) });
      } else {
        const relSumR = await releasedMilestoneSum(id);
        if (job.agreed_cents - relSumR > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents - relSumR, p_ref: `job:${id}`, p_note: "Job removed by admin - unreleased escrow refunded (posting fee kept)", p_now: t });
      }
      await notify(job.poster_user_id, "security", `Your job "${job.title}" was removed by an admin: ${reason}. The escrow was refunded to your wallet; the $2.00 posting fee is kept.`, `#/job/${id}`);
      if (job.awarded_agent_id) {
        const w = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`);
        if (w) await notify(w.owner_id, "security", `The job "${job.title}" you were working on was removed by an admin (${reason}). Its escrow was refunded to the poster.`, `#/job/${id}`);
      }
      return json({ ok: true });
    }
    if (path.match(/^\/admin\/jobs\/\d+\/resolve$/) && method === "POST") {
      const id = parseInt(seg[2]);
      const b = await body();
      const job = await one(`ex_jobs?id=eq.${id}&status=eq.disputed&select=*`);
      if (!job) return err("disputed job not found", 404);
      const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id,jobs_completed,earnings_cents,name,strikes,status`);
      const t = now();
      if (b.resolution === "poster") {
        await pg(`ex_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "refunded", updated_at: t }) });
        const relSumP = await releasedMilestoneSum(id);
        if (job.agreed_cents - relSumP > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: job.agreed_cents - relSumP, p_ref: `job:${id}`, p_note: "Dispute resolved for poster — unreleased escrow refunded (released milestones stay paid)", p_now: t });
        await notify(job.poster_user_id, "dispute", `Dispute on "${job.title}" resolved in your favor — escrow refunded`, `#/job/${id}`);
        const posterWalletRes = await walletOf(job.poster_user_id).catch(() => null);
        await queueLifecycleMail("dispute_resolved", job.poster_user_id, { title: job.title, summary: "The dispute was resolved in your favor — the escrow has been refunded to your wallet.", amount_label: "Amount refunded", amount: fmtMoney(job.agreed_cents), wallet_after: fmtMoney(posterWalletRes?.balance_cents || 0), link: `${SITE_URL}/#/job/${id}` });
        if (agent) await notify(agent.owner_id, "dispute", `Dispute on "${job.title}" resolved for the poster`, `#/job/${id}`);
        if (agent) await queueLifecycleMail("dispute_resolved", agent.owner_id, { title: job.title, summary: "The dispute was resolved for the poster — the escrow was refunded to the poster and no payment was released for this job.", link: `${SITE_URL}/#/job/${id}` });
        // STRIKES (owner's rule, 2026-10-26): losing a dispute is one strike
        // on the agent. Three strikes and the agent is suspended until an
        // admin reviews it. Winning a dispute never adds a strike.
        if (agent) {
          const strikes = (agent.strikes || 0) + 1;
          const patch: Record<string, unknown> = { strikes };
          if (strikes >= 3 && agent.status !== "suspended") { patch.status = "suspended"; patch.suspension_reason = "strikes"; }
          await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify(patch) });
          if (patch.status === "suspended") {
            await notify(agent.owner_id, "security", `${agent.name} has been suspended after 3 lost disputes - an admin will review it`, `#/agent/${job.awarded_agent_id}`);
            const admins = await pg("ex_users?role=eq.admin&select=id");
            for (const a of admins) if (a.id !== agent.owner_id) await notify(a.id, "security", `Agent ${agent.name} auto-suspended: 3 strikes (lost disputes)`, `#/agent/${job.awarded_agent_id}`);
          }
          // The strike MIRRORS onto the worker's owner account: 3 account
          // strikes suspend job posting (enforced in postJob).
          const workerOwner = await one(`ex_users?id=eq.${agent.owner_id}&select=strikes`);
          await pg(`ex_users?id=eq.${agent.owner_id}`, { method: "PATCH", body: JSON.stringify({ strikes: (workerOwner?.strikes || 0) + 1 }) });
        }
        // CONTRACT JOBS: a poster win on a FABRICATED proof (the admin
        // passes fabricated: true after checking the evidence pack)
        // revokes the agent's capability on top of the strike - a fake
        // recording is exactly what the capability system exists to
        // keep out, and the agent must pass the Call Test again.
        if (job.job_kind === "contract" && b.fabricated === true && job.awarded_agent_id) {
          const cjFab = await contractJobRow(id);
          await revokeCapability(job.awarded_agent_id, cjFab?.capability || "phone_call", "proof found fabricated in a dispute").catch((e) => console.error("capability revoke on fabricated proof failed", e));
        }
      } else if (b.resolution === "agent") {
        await pg(`ex_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "completed", updated_at: t }) });
        const relSumA = await releasedMilestoneSum(id);
        const remainderA = job.agreed_cents - relSumA;
        if (remainderA > 0) { const msFeesA = (await milestonesOf(id)).filter((m: any) => m.status === "released").reduce((a: number, m: any) => a + milestoneFeeShare(job.fee_cents, m.amount_cents, job.agreed_cents), 0); await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: agent.owner_id, p_price: remainderA, p_fee: Math.max(0, job.fee_cents - msFeesA), p_ref: `job:${id}`, p_now: t }); await fundGuaranteePool(Math.max(0, job.fee_cents - msFeesA)); }
        // Losing a dispute as the POSTER costs the poster an account
        // strike too (3 strikes suspend job posting).
        const posterRow = await one(`ex_users?id=eq.${job.poster_user_id}&select=strikes`);
        await pg(`ex_users?id=eq.${job.poster_user_id}`, { method: "PATCH", body: JSON.stringify({ strikes: (posterRow?.strikes || 0) + 1 }) });
        await notify(job.poster_user_id, "security", `Strike recorded on your account: the dispute on "${job.title}" was resolved for the agent. Accounts with 3 strikes lose job-posting privileges.`, `#/job/${id}`);
        await pg(`ex_agents?id=eq.${job.awarded_agent_id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (job.agreed_cents - job.fee_cents) }) });
        await notify(agent.owner_id, "dispute", `Dispute on "${job.title}" resolved in your favor — payment released`, `#/job/${id}`);
        if (agent) { const sellerWalletRes = await walletOf(agent.owner_id).catch(() => null); await queueLifecycleMail("dispute_resolved", agent.owner_id, { title: job.title, summary: "The dispute was resolved in your favor — the payment has been released to your wallet.", amount_label: "Amount received", amount: fmtMoney(job.agreed_cents - job.fee_cents), wallet_after: fmtMoney(sellerWalletRes?.balance_cents || 0), link: `${SITE_URL}/#/job/${id}` }); }
        await notify(job.poster_user_id, "dispute", `Dispute on "${job.title}" resolved for the agent`, `#/job/${id}`);
        await queueLifecycleMail("dispute_resolved", job.poster_user_id, { title: job.title, summary: "The dispute was resolved for the agent — the escrow payment was released to the agent.", link: `${SITE_URL}/#/job/${id}` });
      } else return err("resolution must be 'poster' or 'agent'");
      return json({ ok: true });
    }


    if (path === "/admin/subcontracts" && method === "GET") {
      const status = (url.searchParams.get("status") || "").replace(/[^a-z_]/g, "");
      const filter = status ? `status=eq.${status}&` : "";
      const rows = await pg(`ex_subcontracts?${filter}select=*,hirer:ex_agents!ex_subcontracts_hirer_agent_id_fkey(name),worker:ex_agents!ex_subcontracts_worker_agent_id_fkey(name),job:ex_jobs!ex_subcontracts_job_id_fkey(title)&order=created_at.desc&limit=50`);
      return json({ subcontracts: rows.map((s: any) => ({ ...s, hirer_agent_name: s.hirer?.name, worker_agent_name: s.worker?.name, job_title: s.job?.title })) });
    }
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
      const t = now();
      // POOL DEBIT FIRST, atomically: the row-locked adjust raises
      // "pool insufficient" instead of letting two claims race the pool.
      let newPool: number;
      try {
        const res: any = await rpc("ex_pool_adjust", { p_delta: -amount });
        newPool = typeof res === "number" ? res : Number(res?.ex_pool_adjust ?? (Array.isArray(res) ? res[0]?.ex_pool_adjust : NaN));
        if (!Number.isFinite(newPool)) newPool = await guaranteePoolCents();
      } catch (e: any) {
        if (String(e?.dbMessage || e?.message || "").includes("pool insufficient")) {
          const pool = await guaranteePoolCents();
          return err(`the guarantee pool holds $${(pool / 100).toFixed(2)} - a claim cannot exceed the pool`, 400);
        }
        throw e;
      }
      let claimRows: any[];
      try {
        claimRows = await pg("ex_guarantee_claims", { method: "POST", prefer: "return=representation", body: JSON.stringify({ user_id: target.id, job_id: b.job_id ? parseInt(b.job_id) : null, amount_cents: amount, reason: String(b.reason || "").slice(0, 500), status: "paid", created_at: t }) });
        await rpc("ex_move_balance", { p_user: target.id, p_amount: amount, p_type: "guarantee_payout", p_ref: `guarantee:${claimRows[0].id}`, p_note: `Guarantee pool payout: ${String(b.reason || "").slice(0, 200)}`, p_now: t });
      } catch (e) {
        // The credit failed after the pool was debited - put the money back.
        await rpc("ex_pool_adjust", { p_delta: amount }).catch(() => null);
        return err("guarantee payout failed - the pool was restored", 500);
      }
      await notify(target.id, "payment", `Buyer protection: $${(amount / 100).toFixed(2)} was paid to your wallet from the Exchange guarantee pool. ${String(b.reason || "").slice(0, 200)}`, "#/wallet");
      return json({ claim: claimRows[0], pool_cents: newPool });
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
        // CLAIM FIRST: flip to credited before any money moves, so a
        // retry can never double-credit the wallet.
        const claimedDep = await pg(`ex_deposits?id=eq.${id}&status=eq.pending`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "credited", resolved_at: now() }) });
        if (!claimedDep.length) return err("deposit was already resolved", 409);
        await rpc("ex_move_balance", { p_user: d.user_id, p_amount: d.amount_cents, p_type: "deposit", p_ref: `deposit:${id}`, p_note: `${d.asset} deposit confirmed`, p_now: now() });
        await notify(d.user_id, "wallet", `Deposit of $${(d.amount_cents / 100).toFixed(2)} credited`, "#/wallet");
        await queueLifecycleMail("deposit_confirmed", d.user_id, { amount_cents: d.amount_cents, asset: d.asset, amount: fmtMoney(d.amount_cents), link: `${SITE_URL}/#/wallet` });
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
      if (b.action === "paid" && Number(p.hold_until || 0) > now()) return err(`this payout is inside the 48-hour new-account hold (held until ${new Date(Number(p.hold_until) * 1000).toISOString()}) - it cannot be approved before then`, 400);
      // REVIEW STEP: payouts over $500 are flagged; paying one out needs
      // an explicit reviewed:true from the admin who checked it.
      if (b.action === "paid" && p.needs_review && b.reviewed !== true) return err("payout is over $500 and flagged for review — resend with reviewed: true after checking it", 400);
      if (b.action === "paid") {
        if (p.method === "crypto") {
          // Real on-chain execution: the wallet service picks the payout up,
          // broadcasts from the treasury wallet, and marks it paid with the
          // transaction hash once the send confirms. Never faked here.
          await pg(`ex_payouts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ execution_status: "approved", failure_reason: "" }) });
          await notify(p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} approved — being sent on-chain`, "#/wallet");
          await queueLifecycleMail("payout_completed", p.user_id, { amount_cents: p.amount_cents, asset: p.asset || "", destination: p.destination || "", amount: fmtMoney(p.amount_cents), link: `${SITE_URL}/#/wallet` });
          return json({ ok: true, execution: "approved" });
        }
        await pg(`ex_payouts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "paid", resolved_at: now() }) });
        await notify(p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} sent`, "#/wallet");
        await queueLifecycleMail("payout_completed", p.user_id, { amount_cents: p.amount_cents, asset: p.asset || "", destination: p.destination || "", amount: fmtMoney(p.amount_cents), link: `${SITE_URL}/#/wallet` });
      } else if (b.action === "reject") {
        // CLAIM FIRST: flip to rejected before refunding, so a retry can
        // never refund twice.
        const claimedPay = await pg(`ex_payouts?id=eq.${id}&status=eq.pending`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "rejected", resolved_at: now() }) });
        if (!claimedPay.length) return err("payout was already resolved", 409);
        await rpc("ex_move_balance", { p_user: p.user_id, p_amount: p.amount_cents, p_type: "refund", p_ref: `payout:${id}`, p_note: "Payout rejected — balance restored", p_now: now() });
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
