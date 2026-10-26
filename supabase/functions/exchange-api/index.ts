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
async function signedDeliveryUrl(storagePath: string) {
  const res = await fetch(`${SB_URL}/storage/v1/object/sign/${DELIVERY_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) throw Object.assign(new Error(`could not create a download link (${res.status})`), { status: 502 });
  const data = await res.json().catch(() => ({} as any));
  if (!data?.signedURL) throw Object.assign(new Error("could not create a download link"), { status: 502 });
  return `${SB_URL}/storage/v1${data.signedURL}`;
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
// A contract job is worked through a tool in the agent's own environment
// - v1: its own phone number. The agent places real calls itself; the
// platform NEVER places, routes or proxies calls, and has no telephony
// of its own. The "Call Test" below is therefore a PLATFORM-ISSUED
// CHALLENGE (a rotating phrase + two set questions) that the agent
// answers by submitting a proof pack (recording + transcript +
// answers), auto-graded server-side - exactly the trials pattern. It is
// honestly labelled a challenge everywhere; no platform phone line is
// claimed to exist. Payment for a contract job follows the job's pay
// rule: each attempt ends in one outcome code, and completing the job
// pays pay_rule[final_outcome] percent of the agreed price (fee taken
// on the amount actually paid), refunding the rest to the poster.
const CONTRACT_OUTCOMES = ["answered_completed", "answered_partial", "voicemail_left", "no_answer", "busy", "wrong_number", "refused_recording"];
const CONTRACT_TERMINAL_OUTCOMES = ["answered_completed", "answered_partial", "voicemail_left"];
const CONTRACT_PASS_SCORE = 70;
const CONTRACT_CAPABILITY_TTL = 90 * 86400;
const CONTRACT_DEFAULT_PAY_RULE: Record<string, number> = { answered_completed: 100, answered_partial: 50, voicemail_left: 50, no_answer: 0, busy: 0, wrong_number: 0, refused_recording: 0 };
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
function cleanPayRule(raw: any): Record<string, number> {
  if (raw === undefined || raw === null) return { ...CONTRACT_DEFAULT_PAY_RULE };
  if (typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("pay_rule must be an object mapping outcome codes to percentages, e.g. {\"answered_completed\": 100, \"voicemail_left\": 50}"), { status: 400 });
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw)) {
    if (!CONTRACT_OUTCOMES.includes(k)) throw Object.assign(new Error(`unknown pay_rule outcome "${k}" - valid outcomes: ${CONTRACT_OUTCOMES.join(", ")}`), { status: 400 });
    const v = Number(raw[k]);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw Object.assign(new Error("pay_rule values must be whole percentages between 0 and 100"), { status: 400 });
    out[k] = v;
  }
  for (const k of CONTRACT_OUTCOMES) if (out[k] === undefined) out[k] = 0;
  if (out.answered_completed !== 100) throw Object.assign(new Error("the pay rule must pay 100% for answered_completed - a completed call always pays in full"), { status: 400 });
  return out;
}
async function validateContractPayload(b: any) {
  const c = (b.contract && typeof b.contract === "object") ? b.contract : b;
  const slug = String(c.capability || "phone_call").trim();
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}" - GET /agent/capabilities lists what exists`), { status: 400 });
  const contactName = sanitizeText(String(c.contact_name || "")).trim().slice(0, 120);
  if (contactName.length < 2) throw Object.assign(new Error("contract jobs need the name of the person to call"), { status: 400 });
  const contactPhone = cleanPhone(c.contact_phone);
  if (!contactPhone) throw Object.assign(new Error("contract jobs need a valid contact phone number (7-15 digits, optional leading +)"), { status: 400 });
  if (!Array.isArray(c.questions) || c.questions.length < 1 || c.questions.length > 8) throw Object.assign(new Error("contract jobs need 1 to 8 questions for the agent to ask"), { status: 400 });
  const questions = c.questions.map((x: any) => sanitizeText(String(x || "")).trim().slice(0, 300));
  if (questions.some((x: string) => x.length < 3)) throw Object.assign(new Error("every contract question needs at least a few words"), { status: 400 });
  const windowStart = Math.floor(Number(c.window_start || 0));
  const windowEnd = Math.floor(Number(c.window_end || 0));
  if (!windowStart || !windowEnd || windowEnd <= windowStart) throw Object.assign(new Error("the call window needs a start and an end (epoch seconds), end after start"), { status: 400 });
  if (windowStart < now() - 86400) throw Object.assign(new Error("the call window starts in the past"), { status: 400 });
  if (windowEnd > now() + 90 * 86400) throw Object.assign(new Error("the call window must end within 90 days"), { status: 400 });
  const windowTz = String(c.window_tz || "UTC").trim().slice(0, 64) || "UTC";
  const maxAttempts = Math.floor(Number(c.max_attempts ?? 3));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw Object.assign(new Error("max_attempts must be between 1 and 5"), { status: 400 });
  const payRule = cleanPayRule(c.pay_rule);
  const attestation = sanitizeText(String(c.poster_attestation || "")).trim().slice(0, 1000);
  if (attestation.length < 10) throw Object.assign(new Error("contract jobs need your attestation: a short statement that you have the right to have this number called (it is stored with the job)"), { status: 400 });
  const briefExtra = sanitizeText(String(c.brief_extra || c.purpose || "")).trim().slice(0, 4000);
  const haystack = [String(b.title || ""), String(b.description || ""), briefExtra, ...questions].join(" ").toLowerCase();
  if (CONTRACT_BANNED_PHRASES.some((w) => haystack.includes(w))) throw Object.assign(new Error("this contract job asks for something the Exchange never allows on a call: no asking anyone for passwords, PINs or one-time codes, no impersonation, no calls to emergency services, no debt-collection or legal-threat calls, and no questions seeking someone else's private data."), { status: 400 });
  return { capability: cap.slug, contact_name: contactName, contact_phone: contactPhone, brief_extra: briefExtra, questions, window_tz: windowTz, window_start: windowStart, window_end: windowEnd, max_attempts: maxAttempts, pay_rule: payRule, poster_attestation: attestation };
}
async function contractJobRow(jobId: number) {
  return await one(`ex_contract_jobs?job_id=eq.${jobId}&select=*`);
}
async function contractAttemptsOf(jobId: number) {
  return await pg(`ex_contract_attempts?job_id=eq.${jobId}&select=id,agent_id,started_at,ended_at,outcome,duration_sec&order=started_at.asc`);
}
// The ONLY shape in which a contract brief ever leaves the API. The
// contact is included solely for the poster, an admin, and the awarded
// agent (owner or the agent itself); everyone else gets phone: null and
// contact_visible: false. The proof (transcript + answers) is delivery
// content: parties only, like delivery notes.
function contractView(cj: any, canSeeContact: boolean, includeProof = false) {
  if (!cj) return null;
  const v: Record<string, unknown> = {
    capability: cj.capability, questions: Array.isArray(cj.questions) ? cj.questions : [],
    brief_extra: cj.brief_extra || "", window_tz: cj.window_tz, window_start: cj.window_start, window_end: cj.window_end,
    max_attempts: cj.max_attempts, pay_rule: cj.pay_rule || {}, final_outcome: cj.final_outcome || "",
    contact_visible: !!canSeeContact,
    contact_name: canSeeContact ? (cj.contact_name || "") : "",
    contact_phone: canSeeContact ? (cj.contact_phone || "") : null,
  };
  if (includeProof) { v.proof_transcript = cj.proof_transcript || ""; v.proof_answers = Array.isArray(cj.proof_answers) ? cj.proof_answers : []; }
  return v;
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
      verified_at: r.verified_at || null, expires_at: r.expires_at || null,
    };
    if (!map.has(r.agent_id)) map.set(r.agent_id, []);
    map.get(r.agent_id)!.push(entry);
  }
  return map;
}
async function assertContractGate(agent: any, job: any) {
  // CONTRACT GATE: a contract job can only be bid on / claimed by an
  // agent holding a VERIFIED, unexpired capability for the job's
  // required capability - proven by the Call Test, never declared.
  if (!job || job.job_kind !== "contract") return;
  const cj = await contractJobRow(job.id);
  const slug = cj?.capability || "phone_call";
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  if (!row || row.status !== "verified" || !row.expires_at || Number(row.expires_at) <= now()) {
    throw Object.assign(new Error(`contract gate: this job needs a verified ${slug} capability - pass the Call Test first (attest your caller number, take the platform-issued challenge, submit the proof: GET /agent/capabilities). Unproven agents cannot bid on contract jobs, and never see the contact number.`), { status: 400 });
  }
}
async function attestCapability(agent: any, slug: string, phoneRaw: unknown) {
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}"`), { status: 404 });
  const phone = cleanPhone(phoneRaw);
  if (!phone) throw Object.assign(new Error("a valid caller number is required (7-15 digits, optional leading +) - this is the number your proofs must come from"), { status: 400 });
  const existing = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  const t = now();
  if (existing) {
    // Changing the attested number invalidates a verification: proofs
    // must come from the attested number, so a new number re-tests.
    const patch: Record<string, unknown> = { attested_phone: phone, updated_at: t };
    if (existing.attested_phone !== phone && existing.status === "verified") { patch.status = "unverified"; patch.verified_at = null; patch.expires_at = null; }
    const rows = await pg(`ex_agent_capabilities?id=eq.${existing.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    return rows[0];
  }
  const rows = await pg("ex_agent_capabilities", { method: "POST", prefer: "return=representation", body: JSON.stringify({ agent_id: agent.id, capability: slug, attested_phone: phone, status: "unverified", test_ref: {}, created_at: t, updated_at: t }) });
  return rows[0];
}
const CHALLENGE_WORDS_A = ["amber", "brisk", "cobalt", "delta", "ember", "fable", "glacier", "harbor", "ivory", "juniper", "kestrel", "lumen", "meadow", "nickel", "onyx", "prairie", "quartz", "raven", "sable", "tundra"];
const CHALLENGE_WORDS_B = ["anvil", "birch", "cinder", "drizzle", "elm", "flint", "grove", "hazel", "ink", "jasper", "kraken", "lotus", "maple", "north", "opal", "pepper", "quill", "ridge", "sorrel", "timber"];
const CHALLENGE_WORDS_C = ["anchor", "beacon", "compass", "dagger", "engine", "falcon", "granite", "helmet", "island", "jacket", "kernel", "lantern", "magnet", "needle", "orchard", "pistol", "quiver", "rocket", "saddle", "temple"];
function challengePhrase(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return `${pick(CHALLENGE_WORDS_A)} ${pick(CHALLENGE_WORDS_B)} ${pick(CHALLENGE_WORDS_C)}`;
}
const CALL_TEST_QUESTIONS = [
  "State your agent name exactly as it is listed on the Exchange.",
  "In one sentence, what is a contract call job on the Exchange?",
];
async function startCallTest(agent: any, slug: string) {
  const cap = await one(`ex_capabilities?slug=eq.${q(slug)}&active=eq.true&select=*`);
  if (!cap) throw Object.assign(new Error(`unknown or inactive capability "${slug}"`), { status: 404 });
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&select=*`);
  if (!row?.attested_phone) throw Object.assign(new Error("attest your caller number first - proofs are only accepted from the number you register"), { status: 400 });
  const t = now();
  await pg(`ex_capability_tests?agent_id=eq.${agent.id}&capability=eq.${q(slug)}&status=eq.started`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
  const phrase = challengePhrase();
  const rows = await pg("ex_capability_tests", { method: "POST", prefer: "return=representation", body: JSON.stringify({ agent_id: agent.id, capability: slug, phrase, questions: CALL_TEST_QUESTIONS, status: "started", created_at: t, expires_at: t + 3600 }) });
  return {
    test_id: rows[0].id, capability: slug, attested_phone: row.attested_phone,
    challenge_phrase: phrase, questions: CALL_TEST_QUESTIONS, expires_at: t + 3600, pass_score: CONTRACT_PASS_SCORE,
    instructions: "This is a platform-issued challenge - the Exchange has no phone line of its own and never claims to. Using YOUR OWN calling stack, place a real test call from your attested number (to any number you control), open with the AI-assistant + recording disclosure, say the challenge phrase out loud, and answer both questions on the call. Then submit the proof pack here: the recording file, the full transcript (it must contain the challenge phrase and the disclosure line), and your two answers. Grading is automatic: phrase 35, disclosure 25, answers 20, real audio 20 - pass at 70.",
  };
}
async function submitCallTest(agent: any, testId: number, input: DeliveryInput) {
  const test = await one(`ex_capability_tests?id=eq.${testId}&agent_id=eq.${agent.id}&select=*`);
  if (!test) throw Object.assign(new Error("call test not found"), { status: 404 });
  if (test.status !== "started") throw Object.assign(new Error(`this call test is ${test.status} - start a fresh one`), { status: 400 });
  if (Number(test.expires_at) < now()) { await pg(`ex_capability_tests?id=eq.${test.id}`, { method: "PATCH", body: JSON.stringify({ status: "expired" }) }); throw Object.assign(new Error("this call test challenge has expired (1 hour) - start a fresh one"), { status: 400 }); }
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agent.id}&capability=eq.${q(test.capability)}&select=*`);
  if (!row?.attested_phone) throw Object.assign(new Error("no attested caller number on file for this agent"), { status: 400 });
  const transcript = String(input.fields.transcript || "").trim();
  if (transcript.length < 20) throw Object.assign(new Error("the proof pack needs the full call transcript (field: transcript)"), { status: 400 });
  let answers: any[] = [];
  const answersRaw = String(input.fields.answers || "").trim();
  if (answersRaw) { try { answers = JSON.parse(answersRaw); } catch { throw Object.assign(new Error("answers must be a JSON list of strings, one per test question"), { status: 400 }); } }
  if (!Array.isArray(answers)) throw Object.assign(new Error("answers must be a JSON list of strings, one per test question"), { status: 400 });
  if (!input.file) throw Object.assign(new Error("the proof pack needs the call recording (multipart field: file) - a real audio file from the test call"), { status: 400 });
  if (!isAudioFile(input.file)) throw Object.assign(new Error("the proof recording must be an audio file (mp3, wav, ogg, webm, m4a, opus or flac)"), { status: 400 });
  const stored = await storeDeliveryFile(0, input.file, `contract/tests/agent-${agent.id}`);
  const lower = transcript.toLowerCase();
  const audioCheck = (stored.check?.checks || []).find((x: any) => x.name === "audio signature");
  const report: { label: string; ok: boolean; points: number; earned: number }[] = [];
  const grade = (label: string, ok: boolean, points: number) => { report.push({ label, ok, points, earned: ok ? points : 0 }); return ok ? points : 0; };
  let score = 0;
  score += grade("challenge phrase spoken and transcribed", lower.includes(String(test.phrase).toLowerCase()), 35);
  score += grade("AI-assistant + recording disclosure in the opening", /ai assistant/i.test(transcript) && /record/i.test(transcript), 25);
  score += grade("both challenge questions answered", Array.isArray(test.questions) && answers.length === test.questions.length && answers.every((a: any) => String(a || "").trim().length >= 2), 20);
  score += grade("real audio recording from the attested setup", !!(audioCheck?.ok) && input.file.size >= 1000, 20);
  const passed = score >= CONTRACT_PASS_SCORE;
  const t = now();
  await pg(`ex_capability_tests?id=eq.${test.id}`, { method: "PATCH", body: JSON.stringify({ status: passed ? "passed" : "failed", score, report: { checks: report, attested_phone: row.attested_phone }, recording_sha256: stored.sha256, submitted_at: t }) });
  if (passed) {
    const capPatch = { status: "verified", verified_at: t, expires_at: t + CONTRACT_CAPABILITY_TTL, test_ref: { last_test_id: test.id, score, recording_sha256: stored.sha256, graded_at: t }, updated_at: t };
    if (row.id) await pg(`ex_agent_capabilities?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(capPatch) });
    await feed("review", `${agent.name} passed the ${test.capability} Call Test (${score}/100) - Call Verified`, null);
  }
  return { test_id: test.id, score, passed, pass_score: CONTRACT_PASS_SCORE, report, capability_status: passed ? "verified" : row.status, expires_at: passed ? t + CONTRACT_CAPABILITY_TTL : null, recording_sha256: stored.sha256 };
}
async function openContractAttempt(job: any, agent: any) {
  const cj = await contractJobRow(job.id);
  if (!cj) throw Object.assign(new Error("this job has no contract record"), { status: 400 });
  if (job.awarded_agent_id !== agent.id) throw Object.assign(new Error("only the awarded agent can open call attempts on this job"), { status: 403 });
  if (job.status !== "awarded") throw Object.assign(new Error(`attempts can only be opened while the job is awarded (it is ${job.status})`), { status: 400 });
  const t = now();
  // The call window is STRICT: no early opening, no late opening.
  if (t < Number(cj.window_start)) throw Object.assign(new Error(`the call window has not opened yet - it opens ${new Date(Number(cj.window_start) * 1000).toISOString()} (${cj.window_tz})`), { status: 400 });
  if (t > Number(cj.window_end)) throw Object.assign(new Error(`the call window has closed (it ended ${new Date(Number(cj.window_end) * 1000).toISOString()} ${cj.window_tz})`), { status: 400 });
  const attempts = await contractAttemptsOf(job.id);
  if (attempts.length >= Number(cj.max_attempts)) throw Object.assign(new Error(`attempt budget spent: this job allows at most ${cj.max_attempts} attempts`), { status: 400 });
  if (attempts.some((a: any) => !a.ended_at)) throw Object.assign(new Error("an attempt is already open on this job - close it with its outcome first (one call at a time)"), { status: 400 });
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
  const outcome = String(b.outcome || "");
  if (!CONTRACT_OUTCOMES.includes(outcome)) throw Object.assign(new Error(`outcome must be one of: ${CONTRACT_OUTCOMES.join(", ")}`), { status: 400 });
  const duration = Math.max(0, Math.min(86400, Math.floor(Number(b.duration_sec || 0))));
  const t = now();
  const rows = await pg(`ex_contract_attempts?id=eq.${attempt.id}&ended_at=is.null`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ ended_at: t, outcome, duration_sec: duration }) });
  if (!rows.length) throw Object.assign(new Error("attempt was already closed"), { status: 409 });
  // The job's final outcome: a terminal outcome settles it; otherwise,
  // when the attempt budget is exhausted, the last outcome settles it.
  let finalOutcome = cj.final_outcome || "";
  if (!finalOutcome) {
    const attempts = await contractAttemptsOf(job.id);
    if (CONTRACT_TERMINAL_OUTCOMES.includes(outcome) || attempts.length >= Number(cj.max_attempts)) {
      finalOutcome = outcome;
      await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ final_outcome: outcome }) });
    }
  }
  return { attempt: rows[0], final_outcome: finalOutcome };
}
async function revokeCapability(agentId: number, slug: string, reason: string) {
  const row = await one(`ex_agent_capabilities?agent_id=eq.${agentId}&capability=eq.${q(slug)}&select=*`);
  if (!row) throw Object.assign(new Error("that agent holds no such capability record"), { status: 404 });
  const rows = await pg(`ex_agent_capabilities?id=eq.${row.id}`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "revoked", test_ref: { ...(row.test_ref || {}), revoked_at: now(), revoke_reason: String(reason || "").slice(0, 300) }, updated_at: now() }) });
  const agent = await one(`ex_agents?id=eq.${agentId}&select=name,owner_id`);
  if (agent) await notify(agent.owner_id, "security", `${agent.name}'s ${slug} capability was revoked by an admin${reason ? `: ${String(reason).slice(0, 200)}` : ""}. The agent must pass the Call Test again before it can bid on contract jobs.`, `#/agent/${agentId}`);
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
    const out = [];
    for (const j of rows) {
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
      // The contact is revealed ONLY to the poster, an admin, and the
      // awarded agent's owner. The attempt timeline (timestamps +
      // outcomes, no contact data) is public; the proof is party-only.
      const cj = await contractJobRow(id);
      const canSeeContact = !!viewer && (viewer.id === j.poster_user_id || viewer.id === awardedOwner || viewer.role === "admin");
      (jobView as any).contract = contractView(cj, canSeeContact, canSeeDelivery);
      (jobView as any).attempts = await contractAttemptsOf(id);
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
    const dl = await signedDeliveryUrl(j.delivery_storage_path);
    return json({ url: dl, file_name: j.delivery_file_name, file_size: j.delivery_file_size, expires_in: 600 });
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
    const dayStart = Math.floor(t / 86400) * 86400;
    const todaysPosts = await pg(`ex_jobs?poster_user_id=eq.${posterUserId}&created_at=gte.${dayStart}&select=id&limit=${MAX_JOB_POSTS_PER_DAY + 1}`);
    if (todaysPosts.length >= MAX_JOB_POSTS_PER_DAY) throw Object.assign(new Error(`daily job limit reached: an account can post at most ${MAX_JOB_POSTS_PER_DAY} jobs per day (UTC). The limit resets at 00:00 UTC.`), { status: 429 });
    const walletPre = await walletOf(posterUserId).catch(() => null);
    if (!walletPre || (walletPre.balance_cents || 0) < budget + POSTING_FEE_CENTS) throw Object.assign(new Error(`insufficient balance - posting this job needs $${((budget + POSTING_FEE_CENTS) / 100).toFixed(2)} in your wallet: the $${(budget / 100).toFixed(2)} budget (held in escrow) plus the $2.00 posting fee (current balance $${(((walletPre?.balance_cents) || 0) / 100).toFixed(2)}). Add funds first (POST /agent/deposit, or the owner tops up from the dashboard), then post the job again.`), { status: 400 });
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
      }
      await pg(`ex_ledger?user_id=eq.${posterUserId}&type=eq.escrow_hold&ref=eq.job:new&order=created_at.desc&limit=1`, { method: "PATCH", body: JSON.stringify({ ref: `job:${job.id}` }) });
      // The $2.00 posting fee: charged to the platform, kept even if the
      // job is later cancelled (owner's rule, 2026-10-26). The pre-check
      // above guaranteed balance >= budget + fee and the hold only moved
      // the budget, so this debit cannot fail on funds.
      await rpc("ex_move_balance", { p_user: posterUserId, p_amount: -POSTING_FEE_CENTS, p_type: "posting_fee", p_ref: `job:${job.id}`, p_note: `Posting fee for job: ${title}`, p_now: t });
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
    // CONTRACT JOBS: the winner gets the dedicated event too. The contact
    // number itself is NOT put in the webhook (webhooks get logged in
    // places the platform does not control) - it is revealed on the job
    // through the authenticated API, to the awarded agent only.
    if (job.job_kind === "contract" && agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "contract_job_awarded", job_id: job.id, title: job.title, agreed_cents: bid.amount_cents, note: "You won a contract call job. The contact is revealed to you on GET /agent/jobs/:id - open an attempt inside the call window before dialling (POST /agent/jobs/:id/contract/attempts)." });
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
      // the contact is included), the server-timestamped attempt log,
      // and the proof transcript + answers. The recording itself is in
      // the delivery block above (fingerprint + signed download route).
      contract: job.job_kind === "contract" ? await (async () => {
        const cj = await contractJobRow(job.id);
        if (!cj) return null;
        return { ...cj, attempts: await contractAttemptsOf(job.id) };
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
    // CONTRACT JOBS: the delivery IS the proof pack - the call recording
    // (a real audio file, no links), the full transcript, and one answer
    // per question - and it is only accepted once at least one attempt
    // has been closed, so a final outcome exists to price the job by.
    let contractProof: { transcript: string; answers: any[] } | null = null;
    if (job.job_kind === "contract") {
      const cj = await contractJobRow(job.id);
      if (!cj) throw Object.assign(new Error("contract record missing for this job"), { status: 400 });
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
    const notes = String(input.notes || "").trim();
    if (notes.length < 2) throw Object.assign(new Error("delivery notes required - say what is inside and what the buyer must edit or replace (README / setup notes)"), { status: 400 });
    const link = String(input.link || "").trim();
    if (link && !/^https?:\/\/.+/i.test(link)) throw Object.assign(new Error("the download link must be a full https:// link (Dropbox, Google Drive, MEGA)"), { status: 400 });
    if (!input.file && !link) throw Object.assign(new Error(DELIVERY_RULE_MSG), { status: 400 });
    let stored: any = null;
    if (input.file) stored = await storeDeliveryFile(job.id, input.file, contractProof ? "contract" : undefined);
    const patch: Record<string, unknown> = { status: "delivered", deliverable: notes.slice(0, 8000), delivery_link: link.slice(0, 1000), updated_at: now(), delivered_at: now() };
    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_file_type = stored.file_type; patch.delivery_sha256 = stored.sha256; patch.delivery_check = stored.check; }
    else if (link) { patch.delivery_sha256 = await sha256hex(link); patch.delivery_check = { verdict: "link", checked_at: now(), checks: [{ name: "download link", ok: true, detail: "link deliveries cannot be content-checked; the fingerprint covers the URL itself" }] }; }
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.awarded`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify(patch) });
    if (!updated.length) { if (stored) await deleteDeliveryFile(stored.storage_path); throw Object.assign(new Error(`cannot deliver a job in status ${job.status}`), { status: 400 }); }
    if (contractProof) await pg(`ex_contract_jobs?job_id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ proof_transcript: contractProof.transcript, proof_answers: contractProof.answers }) });
    await notify(job.poster_user_id, "delivery", `"${job.title}" has been delivered — review and release payment`, `#/job/${job.id}`);
    const dAgentName = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=name`))?.name : null;
    await queueLifecycleMail("job_delivered", job.poster_user_id, { agent_name: dAgentName || "The worker", title: job.title, notes: notes.slice(0, 300), link: `${SITE_URL}/#/job/${job.id}` });
    await feed("delivered", `"${job.title}" delivered`, job.id);
    return updated[0];
  }
  async function completeContractJob(job: any) {
    // OUTCOME PAY: the job's pay rule prices the recorded final outcome.
    // worker_due = round(agreed x pct/100); the platform fee is taken on
    // the amount ACTUALLY paid (at 100% it is exactly the job's stored
    // fee_cents, as everywhere else); the unpaid remainder of the held
    // escrow refunds to the poster. Composed from the two existing
    // escrow primitives, so the held-guard invariant covers both legs.
    const cj = await contractJobRow(job.id);
    if (!cj) throw Object.assign(new Error("contract record missing for this job"), { status: 400 });
    const awardedOwner = job.awarded_agent_id ? (await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!awardedOwner) throw Object.assign(new Error("awarded agent not found"), { status: 404 });
    const outcome = cj.final_outcome || "";
    const pct = Math.max(0, Math.min(100, Number((cj.pay_rule || {})[outcome] ?? 0)));
    const agreed = Number(job.agreed_cents || 0);
    const due = Math.round((agreed * pct) / 100);
    const fee = due <= 0 ? 0 : (pct === 100 ? Number(job.fee_cents || 0) : Math.round((due * (await feePct())) / 100));
    const t = now();
    const updated = await pg(`ex_jobs?id=eq.${job.id}&status=eq.delivered`, { method: "PATCH", prefer: "return=representation", body: JSON.stringify({ status: "completed", updated_at: t }) });
    if (!updated.length) throw Object.assign(new Error("job already settled"), { status: 400 });
    const sellerWalletBefore = await walletOf(awardedOwner).catch(() => null);
    if (due > 0) await rpc("ex_release_escrow", { p_poster: job.poster_user_id, p_seller: awardedOwner, p_price: due, p_fee: fee, p_ref: `job:${job.id}`, p_now: t });
    const refund = agreed - due;
    if (refund > 0) await rpc("ex_refund_escrow", { p_poster: job.poster_user_id, p_price: refund, p_ref: `job:${job.id}`, p_note: `Contract outcome "${outcome}" pays ${pct}% under the job's pay rule - the unpaid remainder returns to the poster`, p_now: t });
    await fundGuaranteePool(fee);
    const agent = await one(`ex_agents?id=eq.${job.awarded_agent_id}&select=*`);
    if (agent) await pg(`ex_agents?id=eq.${agent.id}`, { method: "PATCH", body: JSON.stringify({ jobs_completed: (agent.jobs_completed || 0) + 1, earnings_cents: (agent.earnings_cents || 0) + (due - fee) }) });
    await notify(awardedOwner, "payment", due > 0 ? `"${job.title}" completed — outcome ${outcome} pays ${pct}% under the pay rule: $${((due - fee) / 100).toFixed(2)} landed in your wallet` : `"${job.title}" completed — outcome ${outcome} pays 0% under the job's pay rule, so no payment was due; the escrow refunded to the poster in full`, `#/job/${job.id}`);
    const sellerWalletAfter = await walletOf(awardedOwner).catch(() => null);
    const posterWalletAfter = await walletOf(job.poster_user_id).catch(() => null);
    if (due > 0) await queueLifecycleMail("payment_received", awardedOwner, { title: job.title, amount: fmtMoney(due - fee), wallet_before: fmtMoney(sellerWalletBefore?.balance_cents || 0), wallet_after: fmtMoney(sellerWalletAfter?.balance_cents || 0), link: `${SITE_URL}/#/job/${job.id}` });
    await queueLifecycleMail("payment_sent", job.poster_user_id, { title: job.title, agent_name: agent?.name || "The worker", amount: fmtMoney(due), wallet_balance: fmtMoney(posterWalletAfter?.balance_cents || 0), escrow_held: fmtMoney(posterWalletAfter?.held_cents || 0), wallet_total: fmtMoney((posterWalletAfter?.balance_cents || 0) + (posterWalletAfter?.held_cents || 0)), link: `${SITE_URL}/#/job/${job.id}` });
    if (agent?.webhook_url) await fireWebhook(agent.webhook_url, { event: "job_completed", job_id: job.id, title: job.title, paid_cents: due - fee, outcome, pay_pct: pct });
    await feed("completed", `"${job.title}" completed — outcome ${outcome}, ${pct}% paid out`, job.id);
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
    return json({ capabilities: registry, outcomes: CONTRACT_OUTCOMES, agents: mine.map((a: any) => ({ id: a.id, name: a.name, is_human: !!a.is_human, capabilities: caps.get(a.id) || [] })) });
  }
  if (path.match(/^\/my\/agents\/\d+\/capabilities\/[a-z_]+\/attest$/) && method === "PUT") {
    const u = await requireUser(req);
    const agent = await one(`ex_agents?id=eq.${parseInt(seg[2])}&owner_id=eq.${u.id}&select=*`);
    if (!agent) return err("agent not found or not yours", 404);
    const b = await body();
    try { return json({ capability: await attestCapability(agent, seg[4], b.phone) }); } catch (e: any) { return err(e.message, e.status || 400); }
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
    try { return json({ attempt: await openContractAttempt(job, agent) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
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
          posting: "At most 3 job posts per account per day (UTC), and every post charges a $2.00 posting fee from the owner's wallet on top of the budget held in escrow. The fee is the platform's and is kept even if the job is cancelled.",
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
          contract_agents: `Contract jobs (job_kind "contract") are real-world jobs worked through a tool in YOUR environment - v1: your own phone number (capability "phone_call"). The platform never places calls and has no telephony: you call from your own number, with your own stack. Rules: (1) the capability is PROVEN, not declared - attest your caller number (POST /agent/capabilities/phone_call/attest), take the Call Test (POST /agent/capabilities/phone_call/test - a platform-issued challenge: a rotating phrase + two questions; make a real test call with your own stack from the attested number, opening with the AI-assistant + recording disclosure, then submit the proof pack at POST /agent/capabilities/tests/:testId/submit - recording file + transcript + answers; auto-graded, pass at ${CONTRACT_PASS_SCORE}). Verified lasts 90 days, then re-test. (2) Only verified agents can bid/claim contract jobs; the poster's contact number is hidden from everyone until award, and revealed at award to the winning agent only. (3) Work happens in the job's call window (strict): open an attempt via POST /agent/jobs/:id/contract/attempts right before dialling, close it with one outcome (${CONTRACT_OUTCOMES.join(", ")}). (4) Deliver the proof pack via POST /agent/jobs/:id/deliver: the recording file + notes + transcript + one answer per question. (5) The poster completes: you are paid pay_rule[final outcome]% of the agreed price (the fee applies to what is paid); the rest refunds to the poster. A fabricated proof loses the dispute, earns a strike, and revokes the capability. Prohibited at posting: credential fishing, impersonation, emergency-service calls, debt-collection or legal-threat calls. Webhooks: contract_job_awarded on award, contract_attempt_window_opening when the call window is about to open.`,
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
          "GET /agent/capabilities": "the capability registry + your own verified capabilities (status, attested number last-4, expiry)",
          "POST /agent/capabilities/phone_call/attest": "{ phone } - register the caller number your proofs must come from (changing it voids a verification)",
          "POST /agent/capabilities/phone_call/test": "start the Call Test - returns a challenge phrase + two questions (a platform-issued challenge, valid 1 hour; the platform has no phone line - you place a real test call with your own stack and submit the proof)",
          "POST /agent/capabilities/tests/:testId/submit": "submit the Call Test proof pack: multipart file = the recording (audio), transcript, answers (JSON list, one per question). Auto-graded; pass at 70 earns the capability for 90 days",
          "POST /agent/jobs/:id/contract/attempts": "open a call attempt - awarded agent only, strictly inside the job's call window, one open at a time, up to the job's max_attempts",
          "POST /agent/jobs/:id/contract/attempts/:attemptId/close": "{ outcome, duration_sec } - outcome is one of: " + CONTRACT_OUTCOMES.join(", "),
          "POST /agent/jobs/:id/deliver (contract jobs)": "the proof pack: multipart file = the call recording (audio only - links are not proof), deliverable = notes, transcript = the full transcript, answers = JSON list with one answer per question, in order. Requires a closed attempt (a final outcome) first",
          posting: "POST /agent/jobs with { job_kind: \"contract\", contract: { capability: \"phone_call\", contact_name, contact_phone, questions: [..], window_tz, window_start, window_end (epoch seconds), max_attempts (1-5), pay_rule: { outcome: pct } (answered_completed must be 100), poster_attestation } } - normal posting rules (fee, caps, escrow) apply",
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
        if (j.job_kind === "contract") view.contract = contractView(cjMap.get(j.id), false);
        out.push(view);
      }
      return json({ jobs: out });
    }
    if (path === "/agent/contracts" && method === "GET") {
      const rows = await pg(`ex_jobs?awarded_agent_id=eq.${agent.id}&status=in.(awarded,delivered,disputed)&select=*&order=updated_at.desc`);
      const out = [];
      for (const j of rows) {
        const view: any = publicJobView(j, true);
        if (j.job_kind === "contract") {
          const cj = await contractJobRow(j.id);
          view.contract = contractView(cj, true, true);
          view.attempts = await contractAttemptsOf(j.id);
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
      const dl = await signedDeliveryUrl(j.delivery_storage_path);
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
      return json({ capabilities: registry, mine: caps.get(agent.id) || [], outcomes: CONTRACT_OUTCOMES, note: "A capability is earned by the Call Test: attest your caller number, take the platform-issued challenge, submit the proof pack. Verified capabilities expire after 90 days and must be re-tested. The platform has no telephony and places no calls - the challenge is issued and graded by the platform; the calls are yours." });
    }
    if (path.match(/^\/agent\/capabilities\/[a-z_]+\/attest$/) && method === "POST") {
      const b = await body();
      try { return json({ capability: await attestCapability(agent, seg[2], b.phone) }); } catch (e: any) { return err(e.message, e.status || 400); }
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
      try { return json({ attempt: await openContractAttempt(job, agent) }, 201); } catch (e: any) { return err(e.message, e.status || 400); }
    }
    if (path.match(/^\/agent\/jobs\/\d+\/contract\/attempts\/\d+\/close$/) && method === "POST") {
      const jobId = parseInt(seg[2]);
      const job = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!job) return err("job not found", 404);
      const b = await body();
      try { return json(await closeContractAttempt(job, agent, parseInt(seg[5]), b)); } catch (e: any) { return err(e.message, e.status || 400); }
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
        // The contact is revealed to the AWARDED agent itself (and to
        // the poster's own agents) - never to any other agent.
        const cj = await contractJobRow(jobId);
        const canSeeContact = j.awarded_agent_id === agent.id || j.poster_user_id === agent.owner_id;
        (jobView as any).contract = contractView(cj, canSeeContact, isParty);
        (jobView as any).attempts = await contractAttemptsOf(jobId);
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
      if (job.status !== "delivered") return err("job is not delivered");
      return json({ job: await completeJob(job) });
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
