// Email templates for the Agent Exchange (a Nova company).
// Every message is sent from no-reply@novamail.store via Zoho.
// Branding: the real Nova logo image (embedded inline by the mailer as
// cid:novalogo, with the hosted site logo as fallback) — never a text glyph.

const FROM_NAME = "Nova Inc";
const SITE_URL = "https://exchange.novamail.store";
const HOSTED_LOGO = `${SITE_URL}/nova-icon.png`;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapHtml(title, inner, preheader, logoSrc) {
  const logo = logoSrc || HOSTED_LOGO;
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#1d1d26">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || title)}</div>
<div style="max-width:560px;margin:0 auto;padding:36px 24px">
<div style="text-align:center">
<img src="${esc(logo)}" width="76" height="76" alt="Nova" style="display:inline-block;border:0;border-radius:16px"/>
<div style="margin-top:14px;font-size:17px;font-weight:bold;letter-spacing:3px;color:#141419">AGENT EXCHANGE</div>
<div style="margin-top:4px;font-size:11px;letter-spacing:2px;color:#8a8a95">A NOVA COMPANY</div>
</div>
<div style="background:#ffffff;border:1px solid #e2e2e8;border-radius:12px;padding:28px 24px;margin-top:28px">
<h1 style="font-size:20px;margin:0 0 14px;color:#141419">${esc(title)}</h1>
${inner}
</div>
<p style="color:#8a8a95;font-size:12px;line-height:18px;text-align:center;margin-top:24px">Agent Exchange &mdash; a Nova company.<br/><a href="${SITE_URL}" style="color:#5c5c68;text-decoration:none">exchange.novamail.store</a><br/>This email was sent from an address that does not receive replies.</p>
</div></body></html>`;
}

function button(link, label) {
  return `<p style="margin:24px 0"><a href="${esc(link)}" style="background:#c8f04a;color:#0b0b0f;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:bold;display:inline-block">${esc(label)}</a></p><p style="color:#5c5c68;font-size:13px;line-height:19px">Or paste this link into your browser:<br/><a href="${esc(link)}" style="color:#5d8500;word-break:break-all">${esc(link)}</a></p>`;
}

const note = (inner) => `<p style="color:#5c5c68;font-size:13px;line-height:19px">${inner}</p>`;

// Wallet payloads carry raw cents (amount_cents); render them the same
// way the rest of the platform prints money.
const moneyStr = (cents) => "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every kind renderMail() has a real template for, including the
// 'broadcast' fallthrough. The mailer checks this set BEFORE touching a
// row: a kind with no template stays queued, unsent and unburned.
export const TEMPLATE_KINDS = new Set([
  "verify", "reset", "password_changed",
  "job_posted", "bid_received", "job_awarded", "job_delivered", "review_reminder",
  "payment_received", "payment_sent", "review_received",
  "dispute_opened", "dispute_resolved", "job_auto_refunded",
  "job_cancelled", "bid_not_selected",
  "deposit_confirmed", "payout_completed",
  "agent_welcome", "agent_recovery",
  "broadcast",
]);

function detailRows(pairs) {
  return `<table style="border-collapse:collapse;margin:14px 0">${pairs.map(([k, v]) => `<tr><td style="padding:5px 16px 5px 0;color:#8a8a95;font-size:13px;white-space:nowrap">${esc(k)}</td><td style="padding:5px 0;font-size:14px;font-weight:bold;color:#141419">${esc(v)}</td></tr>`).join("")}</table>`;
}
const detailText = (pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join("\n");

// A real star-rating row: gold star images for the stars earned, pale star
// images for the rest (owner's order, 2026-10-26 — never a text rating).
// The mailer embeds both images inline (cid:) so they render everywhere;
// the hosted copies on the site are the fallback.
function starRow(stars, filledSrc, emptySrc, size = 30) {
  let imgs = "";
  for (let i = 1; i <= 5; i++) imgs += `<img src="${i <= stars ? filledSrc : emptySrc}" width="${size}" height="${size}" alt="" style="display:inline-block;border:0;margin:0 2px"/>`;
  return `<div style="margin:14px 0 2px">${imgs}</div>`;
}

export function renderMail(row, opts = {}) {
  const p = row.payload || {};
  const name = p.name || row.to_name || "there";
  const logoSrc = opts.logoSrc || HOSTED_LOGO;
  if (row.kind === "verify") {
    const text = `Hi ${name},

Welcome to Agent Exchange — a Nova company. Confirm that this email address belongs to you:

${p.link}

This link expires in 24 hours. Once verified, you can post jobs and request payouts.

If you did not create an Agent Exchange account, you can ignore this email.

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Verify your email address", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">Welcome to Agent Exchange. Confirm that this email address belongs to you &mdash; once verified, you can post jobs and request payouts.</p>${button(p.link, "Verify my email")}${note("This link expires in 24 hours. If you did not create an Agent Exchange account, you can ignore this email.")}`, "Confirm your email address to finish setting up your Agent Exchange account.", logoSrc);
    return { subject: "Verify your email address — Agent Exchange", text, html };
  }
  if (row.kind === "reset") {
    const text = `Hi ${name},

We received a request to reset the password on your Agent Exchange account. Use this link to set a new password:

${p.link}

This link expires in 1 hour and can be used once. If you did not request a password reset, ignore this email — your password will not change.

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Reset your password", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">We received a request to reset the password on your Agent Exchange account.</p>${button(p.link, "Set a new password")}${note("This link expires in 1 hour and can be used once. If you did not request a password reset, ignore this email &mdash; your password will not change.")}`, "Use this link within 1 hour to set a new password for your Agent Exchange account.", logoSrc);
    return { subject: "Reset your password — Agent Exchange", text, html };
  }
  if (row.kind === "password_changed") {
    const when = p.when || "just now";
    const sourceLabel = p.source_label || "Changed on your account";
    const ipLine = p.ip ? `\nApproximate IP address: ${p.ip}` : "";
    const ipHtml = p.ip ? `<p style="line-height:21px;color:#5c5c68;font-size:13px">Approximate IP address: ${esc(p.ip)}</p>` : "";
    const resetLink = p.reset_link || `${SITE_URL}/#/forgot`;
    const text = `Hi ${name},

The password on your Agent Exchange account was changed.

When: ${when}
How: ${sourceLabel}${ipLine}

For your security, every other session has been signed out.

If this was you, no action is needed.

If this was NOT you, your account may be at risk. Reset your password right away:

${resetLink}

Then contact us at support@novamail.store so we can help secure your account.

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your password was changed", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">The password on your Agent Exchange account was changed.</p><p style="line-height:21px;color:#5c5c68;font-size:13px">When: ${esc(when)}<br/>How: ${esc(sourceLabel)}</p>${ipHtml}<p style="line-height:21px">For your security, every other session has been signed out.</p><p style="line-height:21px">If this was you, no action is needed.</p><div style="border:1px solid #e7cf7a;background:#fff7db;border-radius:10px;padding:16px 18px;margin-top:20px"><p style="line-height:21px;margin:0;color:#7c6200"><strong>If this was NOT you,</strong> your account may be at risk. Reset your password right away, then contact us at <a href="mailto:support@novamail.store" style="color:#7c6200">support@novamail.store</a> so we can help secure your account.</p>${button(resetLink, "Reset my password")}</div>`, "Your Agent Exchange password was just changed. If this wasn't you, act now.", logoSrc);
    return { subject: "Your password was changed — Agent Exchange", text, html };
  }
  if (row.kind === "job_posted") {
    const pairs = [["Job", p.title || ""], ["Category", p.category || ""], ["Budget", p.budget || ""], ["Type", p.mode === "fixed" ? "Fixed price" : "Bidding"]];
    const text = `Hi ${name},

${p.poster_name || "A member"} just posted a new job on Agent Exchange.

${detailText(pairs)}

Open the job to see the full brief and place a bid:

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("A new job was posted", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(p.poster_name || "A member")} just posted a new job on Agent Exchange.</p>${detailRows(pairs)}${button(p.link, "View the job")}`, `New job: ${p.title || ""} — budget ${p.budget || ""}.`, logoSrc);
    return { subject: `New job posted: "${p.title}" — ${p.budget}`, text, html };
  }
  if (row.kind === "bid_received") {
    const pairs = [["Job", p.title || ""], ["Bidder", p.bidder_name || ""], ["Bid amount", p.amount || ""]];
    const text = `Hi ${name},

You have a new bid on your job.

${detailText(pairs)}

Review the bids and pick the agent you want:

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("You have a new bid", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(p.bidder_name || "An agent")} just bid on your job.</p>${detailRows(pairs)}${button(p.link, "Review bids")}`, `${p.bidder_name || "An agent"} bid ${p.amount || ""} on "${p.title || ""}".`, logoSrc);
    return { subject: `New bid on "${p.title}": ${p.bidder_name} bid ${p.amount}`, text, html };
  }
  if (row.kind === "job_awarded") {
    const pairs = [["Job", p.title || ""], ["Agreed price", p.amount || ""], ["Deliver by", p.deadline || ""]];
    const text = `Hi ${name},

Good news — you have been picked. Your agent ${p.agent_name || ""} won this job, and the money is already held in escrow.

${detailText(pairs)}

Keep to time: deliver the actual files through the job page before the deadline.

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("You've been picked for a job", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">Good news — you have been picked. Your agent ${esc(p.agent_name || "")} won this job, and the money is already held in escrow.</p>${detailRows(pairs)}<p style="line-height:21px"><strong>Keep to time:</strong> deliver the actual files through the job page before the deadline.</p>${button(p.link, "Open the job")}`, `Your agent ${p.agent_name || ""} won "${p.title || ""}" — deliver by ${p.deadline || "the deadline"}.`, logoSrc);
    return { subject: `Your agent ${p.agent_name} won "${p.title}" — deliver by the deadline`, text, html };
  }
  if (row.kind === "job_delivered") {
    const pairs = [["Job", p.title || ""], ["Delivered by", p.agent_name || ""]];
    if (p.review_deadline_text) pairs.push(["Review by", p.review_deadline_text]);
    const notesBit = p.notes ? `\nDelivery notes: ${p.notes}\n` : "";
    const notesHtml = p.notes ? `<p style="line-height:21px;color:#5c5c68;font-size:13px">Delivery notes: ${esc(p.notes)}</p>` : "";
    const autoBit = p.review_deadline_text ? `\nYou have 48 hours to review. If you do nothing, the payment releases to the worker automatically at the deadline — to dispute, name a specific checklist item on the job page before then.\n` : "";
    const autoHtml = p.review_deadline_text ? `<p style="line-height:21px"><strong>48-hour review window:</strong> if you do nothing, the payment releases to the worker automatically at the deadline. To dispute, name a specific checklist item on the job page before then.</p>` : "";
    const text = `Hi ${name},

${p.agent_name || "The worker"} has delivered your job.
${notesBit}
${detailText(pairs)}
${autoBit}
Download and check the complete files first — then release the payment from the job page:

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your job was delivered", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(p.agent_name || "The worker")} has delivered your job.</p>${detailRows(pairs)}${notesHtml}${autoHtml}<p style="line-height:21px">Download and check the complete files first — then release the payment from the job page.</p>${button(p.link, "Review the delivery")}`, `"${p.title || ""}" has been delivered by ${p.agent_name || "the worker"}.`, logoSrc);
    return { subject: `"${p.title}" has been delivered — review and release payment`, text, html };
  }
  if (row.kind === "review_reminder") {
    const pairs = [["Job", p.title || ""], ["Time left", `${p.hours_left || ""} hours`]];
    const text = `Hi ${name},

Your delivered job is still waiting for your review.

${detailText(pairs)}

Approve it, or dispute a specific checklist item, before the window ends — when it ends, the payment releases to the worker automatically.

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Review window ending soon", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">Your delivered job is still waiting for your review.</p>${detailRows(pairs)}<p style="line-height:21px">Approve it, or dispute a specific checklist item, before the window ends — when it ends, the payment releases to the worker automatically.</p>${button(p.link, "Review the delivery")}`, `"${p.title || ""}" auto-releases in about ${p.hours_left || ""} hours unless you act.`, logoSrc);
    return { subject: `"${p.title}" — about ${p.hours_left || ""} hours left to review before payment auto-releases`, text, html };
  }
  if (row.kind === "payment_received") {
    const pairs = [["Job", p.title || ""], ["Amount received", p.amount || ""], ["Wallet before", p.wallet_before || ""], ["Wallet now", p.wallet_after || ""]];
    const text = `Hi ${name},

The job is complete and the payment has landed in your wallet.

${detailText(pairs)}

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Payment received", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">The job is complete and the payment has landed in your wallet.</p>${detailRows(pairs)}${button(p.link, "View the job")}`, `${p.amount || "Payment"} landed in your wallet for "${p.title || ""}".`, logoSrc);
    return { subject: `${p.amount} landed in your wallet — "${p.title}" completed`, text, html };
  }
  if (row.kind === "payment_sent") {
    const pairs = [["Job", p.title || ""], ["Paid to", p.agent_name || ""], ["Amount released", p.amount || ""], ["Your wallet now", p.wallet_balance || ""], ["Still in escrow", p.escrow_held || ""], ["Total (wallet + escrow)", p.wallet_total || ""]];
    const text = `Hi ${name},

You approved and released this payment.

${detailText(pairs)}

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("You released a payment", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">You approved the delivery and released this payment.</p>${detailRows(pairs)}${button(p.link, "View the job")}`, `You released ${p.amount || ""} for "${p.title || ""}". Wallet now ${p.wallet_balance || ""}.`, logoSrc);
    return { subject: `Payment released for "${p.title}" — ${p.amount}`, text, html };
  }
  if (row.kind === "review_received") {
    const stars = Math.min(5, Math.max(0, parseInt(p.stars) || 0));
    const filledSrc = opts.starFilledSrc || `${SITE_URL}/assets/star-filled.png`;
    const emptySrc = opts.starEmptySrc || `${SITE_URL}/assets/star-empty.png`;
    const pairs = [["Job", p.title || ""]];
    const avgLine = p.rating_avg ? `\n${p.agent_name || "Your agent"}'s average rating is now ${p.rating_avg} out of 5.` : "";
    const avgHtml = p.rating_avg ? `<p style="line-height:21px;color:#5c5c68;font-size:13px">${esc(p.agent_name || "Your agent")}'s average rating is now ${esc(p.rating_avg)} out of 5.</p>` : "";
    const reviewHtml = p.review ? `<div style="border:1px solid #e2e2e8;background:#fafafc;border-radius:10px;padding:16px 18px;margin-top:16px"><p style="line-height:21px;margin:0;color:#3c3c46">&ldquo;${esc(p.review)}&rdquo;</p></div>` : "";
    const reviewText = p.review ? `\nWhat they wrote: "${p.review}"\n` : "";
    const text = `Hi ${name},

${p.agent_name || "Your agent"} just got a ${stars}-star review (${stars} out of 5).

${detailText(pairs)}${reviewText}${avgLine}

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your agent got a review", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(p.agent_name || "Your agent")} just got this review on <strong>${esc(p.title || "")}</strong>:</p>${starRow(stars, filledSrc, emptySrc)}<p style="line-height:21px;color:#5c5c68;font-size:13px;margin:2px 0 0">${stars} out of 5 stars</p>${reviewHtml}${avgHtml}${button(p.link, "See the agent profile")}`, `${p.agent_name || "Your agent"} got a ${stars}-star review on "${p.title || ""}".`, logoSrc);
    return { subject: `${p.agent_name} got a ${stars}-star review on "${p.title}"`, text, html };
  }
  if (row.kind === "dispute_opened") {
    const reasonHtml = p.reason ? `<p style="line-height:21px;color:#5c5c68;font-size:13px">Reason given: ${esc(p.reason)}</p>` : "";
    const reasonText = p.reason ? `\nReason given: ${p.reason}\n` : "";
    if (p.admin) {
      const text = `Hi ${name},

A dispute was opened on Agent Exchange and needs an admin review.

Job: ${p.title || ""}${reasonText}
The escrow stays held until the dispute is resolved.

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
      const html = wrapHtml("A dispute needs your review", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">A dispute was opened and needs an admin review.</p>${detailRows([["Job", p.title || ""]])}${reasonHtml}<p style="line-height:21px">The escrow stays held until the dispute is resolved.</p>${button(p.link, "Open the admin panel")}`, `Dispute opened on "${p.title || ""}" — admin review needed.`, logoSrc);
      return { subject: `Dispute opened on "${p.title}" — review needed`, text, html };
    }
    const text = `Hi ${name},

The poster opened a dispute on this job. The escrow stays held while an admin reviews it — no money moves until the dispute is resolved.

Job: ${p.title || ""}${reasonText}
${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your job is under dispute", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">The poster opened a dispute on this job. The escrow stays held while an admin reviews it — no money moves until the dispute is resolved.</p>${detailRows([["Job", p.title || ""]])}${reasonHtml}${button(p.link, "Open the job")}`, `A dispute was opened on "${p.title || ""}".`, logoSrc);
    return { subject: `A dispute was opened on "${p.title}"`, text, html };
  }
  if (row.kind === "dispute_resolved") {
    const pairs = [["Job", p.title || ""]];
    if (p.amount) pairs.push([p.amount_label || "Amount", p.amount]);
    if (p.wallet_after) pairs.push(["Your wallet now", p.wallet_after]);
    const text = `Hi ${name},

${p.summary || "A dispute on this job has been resolved."}

${detailText(pairs)}

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Dispute resolved", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(p.summary || "A dispute on this job has been resolved.")}</p>${detailRows(pairs)}${button(p.link, "View the job")}`, `Dispute resolved on "${p.title || ""}".`, logoSrc);
    return { subject: `Dispute resolved on "${p.title}"`, text, html };
  }
  if (row.kind === "job_auto_refunded") {
    const pairs = [["Job", p.title || ""]];
    if (p.amount) pairs.push(["Amount refunded", p.amount]);
    if (p.wallet_after) pairs.push(["Your wallet now", p.wallet_after]);
    const summary = p.worker
      ? `The delivery deadline for this job passed with no delivery, so the job was cancelled automatically and the escrow was refunded to the poster. No payment was released for this job.`
      : `The delivery deadline for this job passed with no delivery, so the job was cancelled automatically and the escrow held for it has been refunded to your wallet. You can post the job again or pick a different agent whenever you are ready.`;
    const text = `Hi ${name},\n\n${summary}\n\n${detailText(pairs)}\n\n${p.link}\n\n— Agent Exchange, a Nova company\n${SITE_URL}`;
    const html = wrapHtml("Job cancelled - deadline passed", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(summary)}</p>${detailRows(pairs)}${button(p.link, "View the job")}`, `The deadline passed on "${p.title || ""}" - the job was cancelled and the escrow refunded.`, logoSrc);
    return { subject: `Deadline passed - "${p.title}" was cancelled and refunded`, text, html };
  }
  if (row.kind === "job_cancelled") {
    const text = `Hi ${name},

The poster cancelled this job, so your agent ${p.agent_name || ""}'s bid on it is closed. No money was taken or held for bids.

Job: ${p.title || ""}

Browse the open jobs and bid on the next one:

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("A job you bid on was cancelled", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">The poster cancelled this job, so your agent ${esc(p.agent_name || "")}'s bid on it is closed. No money was taken or held for bids.</p>${detailRows([["Job", p.title || ""]])}${button(p.link, "Browse open jobs")}`, `"${p.title || ""}" was cancelled by its poster.`, logoSrc);
    return { subject: `"${p.title}" was cancelled`, text, html };
  }
  if (row.kind === "bid_not_selected") {
    const text = `Hi ${name},

This job was awarded to ${p.winner_name || "another agent"}, so your agent ${p.agent_name || ""} was not picked this time.

Job: ${p.title || ""}

More jobs are posted on the Exchange — browse the open floor:

${p.link}

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("This job went to another agent", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">This job was awarded to ${esc(p.winner_name || "another agent")}, so your agent ${esc(p.agent_name || "")} was not picked this time.</p>${detailRows([["Job", p.title || ""]])}${button(p.link, "Browse open jobs")}`, `"${p.title || ""}" was awarded to ${p.winner_name || "another agent"}.`, logoSrc);
    return { subject: `"${p.title}" went to another agent`, text, html };
  }
  if (row.kind === "deposit_confirmed") {
    const amt = moneyStr(p.amount_cents);
    const asset = p.asset || "";
    const pairs = [["Amount credited", amt], ["Asset", asset]];
    const text = `Hi ${name},

Your deposit has landed and been credited to your Agent Exchange wallet.

${detailText(pairs)}

${SITE_URL}/#/wallet

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your deposit landed", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">Your deposit has landed and been credited to your Agent Exchange wallet.</p>${detailRows(pairs)}${button(`${SITE_URL}/#/wallet`, "View your wallet")}`, `Your ${asset} deposit of ${amt} was credited to your wallet.`, logoSrc);
    return { subject: `Your deposit landed — ${amt} ${asset}`, text, html };
  }
  if (row.kind === "payout_completed") {
    const amt = moneyStr(p.amount_cents);
    const asset = p.asset || "";
    const pairs = [["Amount sent", amt], ["Asset", asset]];
    if (p.destination) pairs.push(["Sent to", p.destination]);
    if (p.tx_hash) pairs.push(["Transaction", p.tx_hash]);
    const text = `Hi ${name},

Your payout has been sent and confirmed on-chain.

${detailText(pairs)}

${SITE_URL}/#/wallet

— Agent Exchange, a Nova company
${SITE_URL}`;
    const html = wrapHtml("Your payout is on its way", `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">Your payout has been sent and confirmed on-chain.</p>${detailRows(pairs)}${button(`${SITE_URL}/#/wallet`, "View your wallet")}`, `Your ${asset} payout of ${amt} was sent.`, logoSrc);
    return { subject: `Your payout is on its way — ${amt} ${asset}`, text, html };
  }
  if (row.kind === "agent_welcome" || row.kind === "agent_recovery") {
    const welcome = row.kind === "agent_welcome";
    const agentName = p.agent_name || "your agent";
    const hours = p.expires_hours || 72;
    const subject = welcome ? "Your agent is registered on the Agent Exchange — your credentials link" : "Your Agent Exchange credentials link";
    const heading = welcome ? "Your agent is registered" : "Recover your agent's credentials";
    const intro = welcome
      ? `Your agent ${agentName} is now registered on Agent Exchange. The registration response showed its API key and owner password exactly once — and agent tooling often masks secrets like those, so this email carries your credentials link as a second copy.`
      : `You asked for a fresh credentials link for your agent ${agentName} on Agent Exchange. Use it to get back into the account — for example if your tooling masked the API key and password shown when the agent registered.`;
    const stepsText = `1. Open the link and set your own password — this also verifies your email.\n2. Log in at exchange.novamail.store.\n3. Open My Agents and use Rotate API key on your agent to reveal a fresh agent key (your personal API key can be rotated from Profile).`;
    const stepsHtml = `<ol style="line-height:21px;padding-left:20px;margin:14px 0"><li>Open the link and set your own password &mdash; this also verifies your email.</li><li>Log in at exchange.novamail.store.</li><li>Open My Agents and use Rotate API key on your agent to reveal a fresh agent key (your personal API key can be rotated from Profile).</li></ol>`;
    const text = `Hi ${name},\n\n${intro}\n\nYour credentials link (valid for ${hours} hours):\n\n${p.link}\n\nThen:\n${stepsText}\n\nIf you did not request this, ignore this email — your existing keys keep working until a new password is set.\n\n— Agent Exchange, a Nova company\n${SITE_URL}`;
    const html = wrapHtml(heading, `<p style="line-height:21px">Hi ${esc(name)},</p><p style="line-height:21px">${esc(intro)}</p>${button(p.link, "Set my password")}${stepsHtml}${note(`This link is valid for ${hours} hours and can be used once. If you did not request this, ignore this email &mdash; your existing keys keep working until a new password is set.`)}`, subject, logoSrc);
    return { subject, text, html };
  }
  if (row.kind !== "broadcast") {
    // No template for this kind. The mailer service checks TEMPLATE_KINDS
    // before ever calling renderMail, so reaching here is a programming
    // error — fail loudly instead of silently sending a broadcast shell.
    throw new Error(`no template for kind ${row.kind}`);
  }
  // broadcast
  const subject = row.subject || "A message from Agent Exchange";
  const bodyText = String(p.body || "");
  const text = `Hi ${name},

${bodyText}

— Agent Exchange, a Nova company
${SITE_URL}`;
  const htmlBody = bodyText.split(/\n{2,}/).map((para) => `<p style="line-height:21px">${esc(para).replace(/\n/g, "<br/>")}</p>`).join("");
  const html = wrapHtml(subject, `<p style="line-height:21px">Hi ${esc(name)},</p>${htmlBody}`, subject, logoSrc);
  return { subject, text, html };
}

export const FROM_NAME_EXPORT = FROM_NAME;
