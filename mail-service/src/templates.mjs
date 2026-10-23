// Email templates for the Agent Exchange (a Nova company).
// Every message is sent from no-reply@novamail.store via Zoho.
// Branding: the real Nova logo image (embedded inline by the mailer as
// cid:novalogo, with the hosted site logo as fallback) — never a text glyph.

const FROM_NAME = "Agent Exchange";
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
