// Minimal zero-dependency SMTP client for Zoho (smtp.zoho.com:465).
// This VM has no direct outbound TCP: the only path is an HTTP CONNECT
// tunnel through the egress proxy, then TLS over the tunnel socket
// (same pattern as the realtime WSX client). Proven live 2026-10-23.
import http from "node:http";
import tls from "node:tls";

const SMTP_HOST = "smtp.zoho.com";
const SMTP_PORT = 465;

function connectViaProxy() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!raw) return Promise.reject(new Error("no proxy env available for SMTP tunnel"));
  const proxy = new URL(raw);
  const headers = { host: `${SMTP_HOST}:${SMTP_PORT}` };
  if (proxy.username) {
    headers["proxy-authorization"] = "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: `${SMTP_HOST}:${SMTP_PORT}`, headers });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT failed (${res.statusCode})`)); return; }
      const secure = tls.connect({ socket, servername: SMTP_HOST, timeout: 20000 });
      secure.once("secureConnect", () => resolve(secure));
      secure.once("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

class SmtpSession {
  constructor(sock) {
    this.sock = sock;
    this.buf = "";
    this.waiters = [];
    sock.on("data", (d) => {
      this.buf += d.toString("utf8");
      this.pump();
    });
    sock.on("error", (e) => { for (const w of this.waiters.splice(0)) w.reject(e); });
  }
  pump() {
    // A reply is complete when a line matches /^\d{3} / (final line of a block).
    const lines = this.buf.split("\r\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const text = lines.slice(0, i + 1).join("\r\n");
        this.buf = lines.slice(i + 1).join("\r\n");
        const w = this.waiters.shift();
        if (w) w.resolve(text);
        return;
      }
    }
  }
  reply() {
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.pump(); });
  }
  async cmd(line, expect) {
    this.sock.write(line + "\r\n");
    const text = await this.reply();
    const code = parseInt(text.slice(0, 3), 10);
    if (expect && !expect.includes(code)) throw new Error(`SMTP ${line.split(" ")[0]} failed: ${text.trim().slice(0, 200)}`);
    return text;
  }
}

function b64wrap(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
}

export function buildMessage({ from, fromName, to, toName, subject, text, html, inlineImages = [] }) {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const altBoundary = "=_ax_alt_" + rand;
  const addr = (email, name) => (name ? `${name.replace(/[\r\n"]/g, "")} <${email}>` : email);
  const headers = [
    `From: ${addr(from, fromName)}`,
    `To: ${addr(to, toName)}`,
    `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@novamail.store>`,
    "MIME-Version: 1.0",
  ];
  const part = (type, body) => `--${altBoundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(body)}\r\n`;
  const alternative = part("text/plain", text) + part("text/html", html) + `--${altBoundary}--\r\n`;
  if (!inlineImages.length) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    return headers.join("\r\n") + "\r\n\r\n" + alternative;
  }
  // Inline images (e.g. the Nova logo) ride in a multipart/related wrapper
  // so the logo renders even where remote images are blocked.
  const relBoundary = "=_ax_rel_" + rand;
  headers.push(`Content-Type: multipart/related; boundary="${relBoundary}"`);
  let body = `--${relBoundary}\r\nContent-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n` + alternative;
  for (const img of inlineImages) {
    body += `--${relBoundary}\r\nContent-Type: ${img.contentType}; name="${img.filename}"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <${img.cid}>\r\nContent-Disposition: inline; filename="${img.filename}"\r\n\r\n${img.base64.replace(/.{76}/g, "$&\r\n")}\r\n`;
  }
  body += `--${relBoundary}--\r\n`;
  return headers.join("\r\n") + "\r\n\r\n" + body;
}

export async function sendMail({ user, pass, message }) {
  const sock = await connectViaProxy();
  const s = new SmtpSession(sock);
  try {
    const greeting = await s.reply();
    if (!greeting.startsWith("220")) throw new Error("bad SMTP greeting: " + greeting.slice(0, 120));
    await s.cmd("EHLO exchange.novamail.store", [250]);
    const auth = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
    await s.cmd(`AUTH PLAIN ${auth}`, [235]);
    await s.cmd(`MAIL FROM:<${user}>`, [250]);
    const rcpt = /To: .*<([^>]+)>/.exec(message)?.[1] || /To: (\S+)/.exec(message)?.[1];
    await s.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await s.cmd("DATA", [354]);
    sock.write(message.replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n");
    const done = await s.reply();
    if (!done.startsWith("250")) throw new Error("message rejected: " + done.slice(0, 160));
    try { await s.cmd("QUIT", [221]); } catch { /* already accepted */ }
    return done.trim();
  } finally {
    sock.end();
  }
}
