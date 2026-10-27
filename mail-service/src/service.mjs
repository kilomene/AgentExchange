// exchange-mailerd — sends the Agent Exchange's email (signup verification,
// password resets, admin broadcasts) from no-reply@novamail.store via Zoho
// SMTP. The Edge Function queues rows in ex_outbox; this service is the only
// sender. Polls every 5 seconds; heartbeat file is the liveness signal.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

// Route fetch through the machine egress proxy when one is configured
// (Node's global fetch ignores proxy env vars on its own).
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (e) {
    console.error("proxy dispatcher unavailable:", e.message);
  }
}

import { loadConfig, SupabaseAdmin } from "./supabase.mjs";
import { sendMail, buildMessage } from "./smtp.mjs";
import { renderMail, FROM_NAME_EXPORT, TEMPLATE_KINDS } from "./templates.mjs";
import { reservedDomainOf } from "./reserved.mjs";
import { checkAndSuppress } from "./suppression.mjs";
import { embed as embedWatermark } from "./watermark.mjs";

const config = loadConfig();
const db = new SupabaseAdmin(config);

// The Nova logo, embedded inline in every outgoing email (cid:novalogo)
// so the branding renders even where remote images are blocked. LOGO
// PROTECTION (owner order 2026-10-23): public/nova-icon.png is already a
// 512px display derivative (the master is never served); each send embeds
// a per-row forensic watermark (payload 'exchange:<outbox id>', see
// watermark.mjs) into the inline copy, and the MIME part carries no
// filename — the logo is never presented as a downloadable attachment.
let logoBase = null;
try {
  logoBase = readFileSync(new URL("../../public/nova-icon.png", import.meta.url));
  console.log("[mailerd] Nova logo loaded for inline embedding");
} catch (e) {
  console.error("[mailerd] Nova logo not loaded, emails fall back to the hosted logo:", e.message);
}
function logoImageFor(rowId) {
  if (!logoBase) return null;
  try {
    return { cid: "novalogo", contentType: "image/png", base64: embedWatermark("exchange:" + rowId, logoBase).toString("base64") };
  } catch (e) {
    return { cid: "novalogo", contentType: "image/png", base64: logoBase.toString("base64") };
  }
}
// Star-rating images for review emails (owner's order, 2026-10-26): the
// rating renders as real gold/pale star images embedded inline (cid:),
// never as text. Loaded once at boot from the site's public assets.
let starFilledBase = null, starEmptyBase = null;
try {
  starFilledBase = readFileSync(new URL("../../public/assets/star-filled.png", import.meta.url));
  starEmptyBase = readFileSync(new URL("../../public/assets/star-empty.png", import.meta.url));
  console.log("[mailerd] star rating images loaded for review emails");
} catch (e) {
  console.error("[mailerd] star images not loaded, review emails fall back to hosted stars:", e.message);
}
const STATE_DIR = process.env.MAIL_STATE_DIR || "/home/hatch/.exchange-mail";
mkdirSync(STATE_DIR, { recursive: true });

const now = () => Math.floor(Date.now() / 1000);
let sentTotal = 0;
let failedTotal = 0;

// ---------------------------------------------------------------------------
// SENDER-PROTECTION GUARDS (owner order 2026-10-26, after the Zoho
// 550 5.4.6 "Unusual sending activity" throttle incident): the company
// mailbox is production infrastructure, not a test blaster.
//  1. PAUSE file ($STATE_DIR/PAUSE): when present, the mailer idles —
//     no sends, no attempt burns. The wake-hook supervisor honors it too.
//  2. THROTTLE DEFERRAL: a Zoho 5.4.6 / "try after sometime" refusal is a
//     provider cooldown, NOT a message failure. It never increments the
//     row's attempts and never marks a row failed; instead the mailer
//     parks ALL sending for THROTTLE_COOLDOWN_SECS and retries after.
//  3. HOURLY CAP: at most MAIL_HOURLY_CAP successful sends per rolling
//     hour (default 30). Excess rows simply stay queued. Raise via env
//     only when sending moves to a real transactional service.
// ---------------------------------------------------------------------------
const PAUSE_FILE = `${STATE_DIR}/PAUSE`;
const SENDLOG_FILE = `${STATE_DIR}/sendlog.json`;
const POOL_FILE = `${STATE_DIR}/pool.json`;
const THROTTLE_COOLDOWN_SECS = 1800; // 30m park for a 5.4.6 activity throttle
const BLOCK_COOLDOWN_SECS = 21600; // 6h park for sender-block / AUTH refusals
const HOURLY_CAP = parseInt(process.env.MAIL_HOURLY_CAP || "30", 10); // global, all senders
const PER_SENDER_CAP = parseInt(process.env.MAIL_PER_SENDER_HOURLY_CAP || "15", 10);

import { existsSync } from "node:fs";
// ---------------------------------------------------------------------------
// SENDER POOL state (owner order 2026-10-26: never depend on ONE address).
// pool.json: { parked: {key: until_epoch}, sends: {from: [epoch, ...]} }
// Park keys: a From address ("notify@…") for per-address throttles, or
// "auth:<user>" for AUTH/sender-block refusals (every alias of that Zoho
// user is dead until the account unblocks, so the whole group parks).
// A provider refusal NEVER burns a row's attempts and NEVER fails a row —
// the sender parks, the row fails over to the next healthy sender, and
// only defers (stays queued) when every sender is parked or capped.
// ---------------------------------------------------------------------------
function loadPool() {
  try {
    const p = JSON.parse(readFileSync(POOL_FILE, "utf8"));
    return { parked: p.parked || {}, sends: p.sends || {} };
  } catch { return { parked: {}, sends: {} }; }
}
function savePool(p) {
  try { writeFileSync(POOL_FILE, JSON.stringify(p)); } catch { /* best-effort */ }
}
// Pool state is keyed per TRANSPORT, not per address: since 2026-10-26
// the same From (no-reply@) exists on two transports (ZeptoMail primary +
// Zoho fallback), and a park or send-count on one must never leak onto
// the other.
function senderKey(sender) { return `${sender.from}|${sender.host || "smtp.zoho.com"}`; }
function senderParkedUntil(p, sender) {
  return Math.max(p.parked[senderKey(sender)] || 0, p.parked[`auth:${sender.authUser}`] || 0);
}
function parkSender(p, sender, secs, scope) {
  const key = scope === "auth" ? `auth:${sender.authUser}` : senderKey(sender);
  p.parked[key] = now() + secs;
  savePool(p);
  return p.parked[key];
}
function senderRecentCount(p, sender) {
  const cutoff = now() - 3600;
  return (p.sends[senderKey(sender)] || []).filter((t) => t > cutoff).length;
}
function isBlockError(e) {
  const s = String((e && e.message) || e || "");
  return /5\.1\.8|sender address blocked|SMTP AUTH failed/i.test(s);
}
function isThrottleError(e) {
  const s = String((e && e.message) || e || "");
  return /5\.4\.6|unusual sending activity|try after/i.test(s);
}
function isProviderError(e) { return isBlockError(e) || isThrottleError(e); }
function recentSendCount() {
  try {
    const arr = JSON.parse(readFileSync(SENDLOG_FILE, "utf8"));
    const cutoff = now() - 3600;
    return arr.filter((t) => t > cutoff).length;
  } catch { return 0; }
}
function recordSend(from) {
  try {
    const arr = JSON.parse(readFileSync(SENDLOG_FILE, "utf8"));
    const cutoff = now() - 3600;
    const kept = arr.filter((t) => t > cutoff);
    kept.push(now());
    writeFileSync(SENDLOG_FILE, JSON.stringify(kept));
  } catch {
    try { writeFileSync(SENDLOG_FILE, JSON.stringify([now()])); } catch { /* best-effort */ }
  }
  const p = loadPool();
  const cutoff = now() - 3600;
  p.sends[from] = (p.sends[from] || []).filter((t) => t > cutoff);
  p.sends[from].push(now());
  savePool(p);
  // NOTE: callers pass senderKey(sender) as `from` so counts stay
  // per-transport (see senderKey).
}

function heartbeat(phase) {
  try {
    writeFileSync(`${STATE_DIR}/heartbeat.json`, JSON.stringify({ ts: now(), pid: process.pid, phase, sent_total: sentTotal, failed_total: failedTotal }));
  } catch { /* heartbeat is best-effort */ }
}

async function cycle() {
  // Sender-protection guards first: an owner pause means NO sends and NO
  // attempt burns this cycle. (Throttle/block parking is per-sender now —
  // handled inside the row loop via the pool state.)
  if (existsSync(PAUSE_FILE)) { heartbeat("paused"); return; }
  let sendBudget = HOURLY_CAP - recentSendCount();
  if (sendBudget <= 0) { heartbeat("capped"); return; }
  const rows = await db.list("ex_outbox?status=eq.queued&order=id.asc&limit=10&select=*");
  const unknownLogged = new Set();
  for (const row of rows || []) {
    // NO-TEMPLATE GUARD: a kind with no template in templates.mjs (e.g. a
    // future backend kind shipped before its template) is left exactly as
    // it is — queued, unsent, no attempt burned — and logged once per
    // cycle per kind. Only 'broadcast' falls through to the generic
    // template, and only because it is an explicit member of the set.
    if (!TEMPLATE_KINDS.has(row.kind)) {
      if (!unknownLogged.has(row.kind)) {
        unknownLogged.add(row.kind);
        console.log(`[mailerd] no template for kind ${row.kind} — left queued (row id=${row.id})`);
      }
      continue;
    }
    if (sendBudget <= 0) {
      console.log("[mailerd] hourly cap reached — remaining rows stay queued (no attempts burned)");
      break;
    }
    // SHADOW-BAN SUPPRESSION (owner order 2026-10-27): a mail queued
    // before the recipient's ban must NOT go out — suppress it here
    // at send time (no attempt burned, never marked sent). The ban
    // notice itself (kind shadow_ban_notice) is the one exception.
    if (await checkAndSuppress(db, row)) continue;
    // EMAIL DISCIPLINE GUARD (owner order 2026-10-23, hard rule): reserved /
    // undeliverable recipient domain (RFC 2606) — refuse BEFORE any SMTP
    // attempt; no attempt counted, never retried (the row leaves 'queued'
    // permanently as 'skipped_invalid_domain'). Mirrors the Nova Payments
    // mailer. Fail-closed: if the skip patch itself errors, the row is NOT
    // sent — it stays queued for the next cycle instead.
    const reserved = reservedDomainOf(row.to_email);
    if (reserved) {
      try {
        await db.patch(`ex_outbox?id=eq.${row.id}`, {
          status: "skipped_invalid_domain",
          last_error: `invalid_domain: recipient domain ${reserved} is reserved (RFC 2606) — delivery refused before any SMTP attempt; test/example addresses never receive company mail`,
        });
        console.log(`[mailerd] skipped id=${row.id} kind=${row.kind} to=${row.to_email} — invalid_domain: reserved domain ${reserved} (RFC 2606), refused before any SMTP attempt`);
      } catch (e) {
        console.error(`[mailerd] guard skip failed id=${row.id} (row NOT sent): ${e.message || e}`);
      }
      continue;
    }
    const attempts = (row.attempts || 0) + 1;
    await db.patch(`ex_outbox?id=eq.${row.id}`, { attempts });
    // Render once; the same message body is offered to each pool sender.
    const rowLogo = logoImageFor(row.id);
    const isReview = row.kind === "review_received" && starFilledBase && starEmptyBase;
    const { subject, text, html } = renderMail(row, {
      logoSrc: rowLogo ? "cid:novalogo" : undefined,
      ...(isReview ? { starFilledSrc: "cid:starfilled", starEmptySrc: "cid:starempty" } : {}),
    });
    const inlineImages = [];
    if (rowLogo) inlineImages.push(rowLogo);
    if (isReview) {
      inlineImages.push({ cid: "starfilled", contentType: "image/png", base64: starFilledBase.toString("base64") });
      inlineImages.push({ cid: "starempty", contentType: "image/png", base64: starEmptyBase.toString("base64") });
    }
    // SENDER POOL FAILOVER: try healthy senders (least-used first) until
    // one accepts. A provider refusal parks that sender (30m throttle /
    // 6h AUTH-block, whole auth group for AUTH) and the SAME row moves to
    // the next sender — one blocked address never stops platform mail.
    const pool = loadPool();
    // Ordering: "primary"-flagged senders (ZeptoMail) always go first when
    // healthy — the pool is a FALLBACK, not a co-sender. Within a tier,
    // least-recently-used first. A primary sender's cap is the global cap
    // (it is built for volume); pool senders keep the tight per-sender cap.
    const tierOf = (s) => ((s.flags || "").includes("primary") ? 0 : 1);
    const ordered = [...config.senders].sort((a, b) => tierOf(a) - tierOf(b) || senderRecentCount(pool, a) - senderRecentCount(pool, b));
    let delivered = false;
    let providerDeferred = false;
    let messageFailed = false;
    for (const sender of ordered) {
      if (senderParkedUntil(pool, sender) > now()) continue;
      const senderCap = (sender.flags || "").includes("primary") ? HOURLY_CAP : PER_SENDER_CAP;
      if (senderRecentCount(pool, sender) >= senderCap) continue;
      const message = buildMessage({
        from: sender.from, fromName: FROM_NAME_EXPORT,
        to: row.to_email, toName: row.to_name || "",
        subject, text, html,
        inlineImages,
      });
      try {
        await sendMail({ user: sender.authUser, pass: sender.pass, message, mailFrom: sender.from, host: sender.host });
        await db.patch(`ex_outbox?id=eq.${row.id}`, { status: "sent", sent_at: now(), last_error: null });
        sentTotal++;
        sendBudget--;
        recordSend(senderKey(sender));
        console.log(`[mailerd] sent id=${row.id} kind=${row.kind} to=${row.to_email} via=${sender.from}`);
        delivered = true;
        break;
      } catch (e) {
        // "providerall" senders (the ZeptoMail primary): every transport
        // error is a provider event for that sender, never a message
        // failure — park it and fail the row over to the Zoho pool.
        if (isProviderError(e) || (sender.flags || "").includes("providerall")) {
          const blocked = isBlockError(e);
          const until = parkSender(pool, sender, blocked ? BLOCK_COOLDOWN_SECS : THROTTLE_COOLDOWN_SECS, blocked ? "auth" : "from");
          console.error(`[mailerd] provider refusal via=${sender.from} (${sender.host || "smtp.zoho.com"}) on id=${row.id}: ${String(e.message || e).slice(0, 120)} — sender parked until ${until}, failing over`);
          providerDeferred = true;
          continue;
        }
        // A genuine message-level failure (bad recipient, rejected content):
        // counts against the row exactly as before, no failover.
        failedTotal++;
        const patch = { last_error: String(e.message || e).slice(0, 400) };
        if (attempts >= 3) patch.status = "failed";
        await db.patch(`ex_outbox?id=eq.${row.id}`, patch).catch(() => {});
        console.error(`[mailerd] send failed id=${row.id} attempt=${attempts} via=${sender.from}: ${patch.last_error}`);
        messageFailed = true;
        break;
      }
    }
    if (!delivered && !messageFailed) {
      // Every sender was parked/capped, or all refused at the provider:
      // the row is DEFERRED, not failed — undo the attempt increment.
      await db.patch(`ex_outbox?id=eq.${row.id}`, { attempts: row.attempts || 0, last_error: `deferred at ${now()} — all senders parked/capped (provider), attempt not counted` }).catch(() => {});
      console.log(`[mailerd] deferred id=${row.id} — no healthy sender available (providerDeferred=${providerDeferred}); row stays queued, attempt NOT counted`);
      break; // remaining rows would hit the same wall this cycle
    }
  }
}

console.log(`[mailerd] starting; smtp user ${config.smtpUser}; state ${STATE_DIR}; sender pool: ${config.senders.map((s) => s.from).join(", ")} (global cap ${HOURLY_CAP}/h, per-sender cap ${PER_SENDER_CAP}/h)`);
heartbeat("boot");
for (;;) {
  const started = Date.now();
  try {
    await cycle();
    heartbeat("idle");
  } catch (e) {
    console.error("[mailerd] cycle error:", e.message || e);
    heartbeat("error");
  }
  const wait = Math.max(500, 5000 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
}
