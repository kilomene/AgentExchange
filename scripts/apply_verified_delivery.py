#!/usr/bin/env python3
"""#4 VERIFIED DELIVERY (owner picks 2026-10-26): every delivered file is
fingerprinted (SHA-256) and structure-checked at delivery time; the
fingerprint + verdict show on the job page; parties/admins can download
a full evidence pack (JSON) for any job. Assert-exactly-once edits."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "supabase/functions/exchange-api/index.ts"
APP = ROOT / "public/app.js"

# ---------- backend ----------
s = TS.read_text()

HELPERS = r'''
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
  }
  const verdict = checks.every((c) => c.ok) ? "passed" : "flagged";
  return { verdict, checked_at: now(), checks };
}
'''

anchor = "async function storeDeliveryFile(jobId: number, file: File) {"
assert s.count(anchor) == 1
s = s.replace(anchor, HELPERS + anchor)

old_store_tail = '''  const path = `job-${jobId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/${DELIVERY_BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": file.type || "application/octet-stream", "x-upsert": "true" },
    body: file,
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw Object.assign(new Error(`file upload failed (${res.status}) ${t.slice(0, 160)}`), { status: 502 }); }
  return { storage_path: path, file_name: file.name.slice(0, 200), file_size: file.size, file_type: (file.type || "").slice(0, 120) };'''
new_store_tail = '''  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sha = await sha256hexBytes(buf);
  const check = deliveryChecks(bytes, file.name || "delivery", file.type || "");
  const path = `job-${jobId}/${Date.now()}-${sanitizeFileName(file.name)}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/${DELIVERY_BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": file.type || "application/octet-stream", "x-upsert": "true" },
    body: buf,
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw Object.assign(new Error(`file upload failed (${res.status}) ${t.slice(0, 160)}`), { status: 502 }); }
  return { storage_path: path, file_name: file.name.slice(0, 200), file_size: file.size, file_type: (file.type || "").slice(0, 120), sha256: sha, check };'''
assert s.count(old_store_tail) == 1
s = s.replace(old_store_tail, new_store_tail)

old_patch = '''    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_file_type = stored.file_type; }'''
new_patch = '''    if (stored) { patch.delivery_storage_path = stored.storage_path; patch.delivery_file_name = stored.file_name; patch.delivery_file_size = stored.file_size; patch.delivery_file_type = stored.file_type; patch.delivery_sha256 = stored.sha256; patch.delivery_check = stored.check; }
    else if (link) { patch.delivery_sha256 = await sha256hex(link); patch.delivery_check = { verdict: "link", checked_at: now(), checks: [{ name: "download link", ok: true, detail: "link deliveries cannot be content-checked; the fingerprint covers the URL itself" }] }; }'''
assert s.count(old_patch) == 1
s = s.replace(old_patch, new_patch)

EVIDENCE_HELPER = r'''
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
    };
  }
'''
anchor2 = "  async function deliverJob(job: any, input: DeliveryInput) {"
assert s.count(anchor2) == 1
s = s.replace(anchor2, EVIDENCE_HELPER + anchor2)

WEB_ROUTE = r'''
  if (path.match(/^\/jobs\/\d+\/evidence$/) && method === "GET") {
    const u = await requireUser(req);
    const jobId = parseInt(seg[1]);
    const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
    if (!j) return err("job not found", 404);
    const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
    if (!(j.poster_user_id === u.id || awardedOwner === u.id || u.role === "admin")) return err("the evidence pack is private to the buyer, the worker and admins", 403);
    return json({ evidence: await jobEvidence(j) });
  }
'''
anchor3 = '  if (path.match(/^\\/jobs\\/\\d+\\/delivery-file$/) && method === "GET") {'
assert s.count(anchor3) == 1, s.count(anchor3)
s = s.replace(anchor3, WEB_ROUTE + anchor3)

AGENT_ROUTE = r'''
    if (path.match(/^\/agent\/jobs\/\d+\/evidence$/) && method === "GET") {
      const jobId = parseInt(seg[2]);
      const j = await one(`ex_jobs?id=eq.${jobId}&select=*`);
      if (!j) return err("job not found", 404);
      const awardedOwner = j.awarded_agent_id ? (await one(`ex_agents?id=eq.${j.awarded_agent_id}&select=owner_id`))?.owner_id : null;
      if (!(j.poster_user_id === agent.owner_id || awardedOwner === agent.owner_id || j.awarded_agent_id === agent.id)) return err("the evidence pack is private to the buyer, the worker and admins", 403);
      return json({ evidence: await jobEvidence(j) });
    }
'''
anchor4 = '    if (path.match(/^\\/agent\\/jobs\\/\\d+$/) && method === "GET") {'
assert s.count(anchor4) == 1, s.count(anchor4)
s = s.replace(anchor4, AGENT_ROUTE + anchor4)

old_help = '''          chat_safety: "The job chat is fully secured:'''
assert s.count(old_help) == 1
s = s.replace(old_help, '''          verified_delivery: "Every delivered file is fingerprinted (SHA-256) and structure-checked at delivery (zip contents listed, html/json validated); the fingerprint and verdict show on the job page, and the buyer, the worker and admins can download a full evidence pack at GET /jobs/:id/evidence (agents: GET /agent/jobs/:id/evidence).",
          chat_safety: "The job chat is fully secured:''')

TS.write_text(s)
print("backend patched")

# ---------- frontend ----------
a = APP.read_text()
old_box = '''          ${j.delivery_link ? `<p class="mt">Large-file download link:'''
new_box = '''          ${j.delivery_sha256 ? `<p class="mt small">🔒 <b>Verified delivery</b> — SHA-256 fingerprint <code>${esc(String(j.delivery_sha256).slice(0, 16))}…</code>${j.delivery_check && j.delivery_check.verdict ? ` · checks: <b>${esc(j.delivery_check.verdict)}</b>` : ""}${(isPoster || awardedMine || (state.user && state.user.role === "admin")) ? ` <button class="btn sm" id="ev-pack">Evidence pack</button>` : ""}</p>` : ""}
          ${j.delivery_link ? `<p class="mt">Large-file download link:'''
assert a.count(old_box) == 1
a = a.replace(old_box, new_box)

old_dl = '''  const dl = $("#dl-file"); if (dl) dl.onclick = async () => { try { const r = await api(`/jobs/${id}/delivery-file`); window.open(r.url, "_blank"); } catch (e) { toast(e.message); } };'''
new_dl = old_dl + '''
  const ev = $("#ev-pack"); if (ev) ev.onclick = async () => { try { const r = await api(`/jobs/${id}/evidence`); const blob = new Blob([JSON.stringify(r.evidence, null, 2)], { type: "application/json" }); const u2 = URL.createObjectURL(blob); const a2 = document.createElement("a"); a2.href = u2; a2.download = `job-${id}-evidence.json`; a2.click(); setTimeout(() => URL.revokeObjectURL(u2), 4000); } catch (e) { toast(e.message); } };'''
assert a.count(old_dl) == 1
a = a.replace(old_dl, new_dl)

old_rule = '''<br>- <b>Delivery</b> - a delivery must contain the actual work (an uploaded file, or a download link for very large files) plus notes. A preview link alone is rejected.</p>'''
new_rule = '''<br>- <b>Delivery</b> - a delivery must contain the actual work (an uploaded file, or a download link for very large files) plus notes. A preview link alone is rejected.<br>- <b>Verified delivery</b> - every delivered file is fingerprinted (SHA-256) and structure-checked at delivery; the fingerprint shows on the job page and the buyer, worker and admins can download a full evidence pack.</p>'''
assert a.count(old_rule) == 1
a = a.replace(old_rule, new_rule)

APP.write_text(a)
print("frontend patched")
