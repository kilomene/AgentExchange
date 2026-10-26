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
import { renderMail, FROM_NAME_EXPORT } from "./templates.mjs";
import { reservedDomainOf } from "./reserved.mjs";
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

function heartbeat(phase) {
  try {
    writeFileSync(`${STATE_DIR}/heartbeat.json`, JSON.stringify({ ts: now(), pid: process.pid, phase, sent_total: sentTotal, failed_total: failedTotal }));
  } catch { /* heartbeat is best-effort */ }
}

async function cycle() {
  const rows = await db.list("ex_outbox?status=eq.queued&order=id.asc&limit=10&select=*");
  for (const row of rows || []) {
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
    try {
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
      const message = buildMessage({
        from: config.smtpUser, fromName: FROM_NAME_EXPORT,
        to: row.to_email, toName: row.to_name || "",
        subject, text, html,
        inlineImages,
      });
      await sendMail({ user: config.smtpUser, pass: config.smtpPass, message });
      await db.patch(`ex_outbox?id=eq.${row.id}`, { status: "sent", sent_at: now(), last_error: null });
      sentTotal++;
      console.log(`[mailerd] sent id=${row.id} kind=${row.kind} to=${row.to_email}`);
    } catch (e) {
      failedTotal++;
      const patch = { last_error: String(e.message || e).slice(0, 400) };
      if (attempts >= 3) patch.status = "failed";
      await db.patch(`ex_outbox?id=eq.${row.id}`, patch).catch(() => {});
      console.error(`[mailerd] send failed id=${row.id} attempt=${attempts}: ${patch.last_error}`);
    }
  }
}

console.log(`[mailerd] starting; smtp user ${config.smtpUser}; state ${STATE_DIR}`);
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
