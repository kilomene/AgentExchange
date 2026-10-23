// Minimal WebSocket client (RFC 6455, text frames) that tunnels through
// the machine's HTTP egress proxy (CONNECT + TLS) when one is configured —
// the standard global WebSocket cannot do this, and on locked-down VMs
// (corporate egress, hosted sandboxes) the proxy is the only way out.
// Falls back to a direct TLS connection when no proxy is set.
// Implements exactly the surface the realtime client needs:
// addEventListener('open'|'message'|'close'|'error'), send(), close().
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { randomBytes, createHash } from "node:crypto";

function proxyFor(targetHost) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((h) => h === "*" || targetHost === h || targetHost.endsWith("." + h))) return null;
  try { return new URL(raw); } catch { return null; }
}

export class WSX {
  constructor(url) {
    this.url = new URL(url);
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.closed = false;
    this.#connect();
  }

  addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
  #emit(name, arg) { for (const fn of this.handlers[name] || []) { try { fn(arg); } catch { /* handler errors are the caller's problem */ } } }

  #connect() {
    const host = this.url.hostname;
    const port = Number(this.url.port || 443);
    const proxy = proxyFor(host);
    const onSocket = (raw) => {
      const sock = tlsConnect({ socket: raw, servername: host });
      sock.on("secureConnect", () => {
        this.sock = sock;
        const key = randomBytes(16).toString("base64");
        const path = this.url.pathname + this.url.search;
        sock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
        let head = Buffer.alloc(0);
        const onHead = (d) => {
          head = Buffer.concat([head, d]);
          const idx = head.indexOf("\r\n\r\n");
          if (idx < 0) return;
          sock.off("data", onHead);
          const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
          if (!statusLine.includes("101")) {
            this.#emit("error", new Error(`websocket upgrade failed: ${statusLine}`));
            this.#emit("close", {});
            sock.destroy();
            return;
          }
          const rest = head.subarray(idx + 4);
          this.#emit("open", {});
          if (rest.length) this.#feed(rest);
          sock.on("data", (chunk) => this.#feed(chunk));
        };
        sock.on("data", onHead);
      });
      sock.on("error", (e) => { this.#emit("error", e); this.#emit("close", {}); });
      sock.on("close", () => { if (!this.closed) { this.closed = true; this.#emit("close", {}); } });
    };

    if (proxy && proxy.protocol.startsWith("http")) {
      const headers = {};
      if (proxy.username) {
        headers["Proxy-Authorization"] = "Basic " + Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
      }
      const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 3128), method: "CONNECT", path: `${host}:${port}`, headers });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) { this.#emit("error", new Error(`proxy CONNECT ${res.statusCode}`)); this.#emit("close", {}); return; }
        onSocket(socket);
      });
      req.on("error", (e) => { this.#emit("error", e); this.#emit("close", {}); });
      req.end();
    } else {
      onSocket(netConnect(port, host));
    }
  }

  #feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op === 9) { this.#sendFrame(10, payload); continue; }        // ping -> pong
      if (op === 8) { this.#emit("close", {}); try { this.sock?.destroy(); } catch { /* ignore */ } return; }
      if (op === 1 || op === 2 || op === 0) {
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const full = Buffer.concat(this.frag); this.frag = [];
          if (op !== 0 || full.length) this.#emit("message", { data: full.toString("utf8") });
        }
      }
    }
  }

  #sendFrame(op, payload) {
    if (!this.sock || this.closed) return;
    const mask = randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | op, 0x80 | len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  send(text) { this.#sendFrame(1, Buffer.from(String(text), "utf8")); }

  close() {
    this.closed = true;
    try { this.#sendFrame(8, Buffer.alloc(0)); } catch { /* ignore */ }
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.#emit("close", {});
  }
}
