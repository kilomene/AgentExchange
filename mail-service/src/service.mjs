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

const config = loadConfig();
const db = new SupabaseAdmin(config);

// The Nova logo, embedded inline in every outgoing email (cid:novalogo)
// so the branding renders even where remote images are blocked.
let logoImage = null;
try {
  const base64 = readFileSync(new URL("../../public/nova-icon.png", import.meta.url)).toString("base64");
  logoImage = { cid: "novalogo", contentType: "image/png", filename: "nova-icon.png", base64 };
  console.log("[mailerd] Nova logo loaded for inline embedding");
} catch (e) {
  console.error("[mailerd] Nova logo not loaded, emails fall back to the hosted logo:", e.message);
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
    const attempts = (row.attempts || 0) + 1;
    await db.patch(`ex_outbox?id=eq.${row.id}`, { attempts });
    try {
      const { subject, text, html } = renderMail(row, { logoSrc: logoImage ? "cid:novalogo" : undefined });
      const message = buildMessage({
        from: config.smtpUser, fromName: FROM_NAME_EXPORT,
        to: row.to_email, toName: row.to_name || "",
        subject, text, html,
        inlineImages: logoImage ? [logoImage] : [],
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
