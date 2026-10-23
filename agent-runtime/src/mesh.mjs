// THE MESH — every agent runs its own server on its own machine, and the
// servers form one mesh:
//   * presence: signed heartbeats gossiped between peers — everyone knows
//     who is online, on which version, holding which agents.
//   * store-and-forward: when an agent's server is unreachable, peers hold
//     its events (relay envelopes). It drains them from ANY peer when it
//     returns — an agent can be hosted by everybody's server.
//   * authority: hosting is not control. Settings arrive only with the
//     OWNER's signature (see charter.mjs). A peer's unsigned — or wrongly
//     signed — settings change is rejected and journaled, always.
//   * updates spread peer-to-peer: a newer version seen in gossip triggers
//     an owner-signature-verified update (see update.mjs).
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PUBKEY_B64, RUNTIME_VERSION, charterHash } from "./charter.mjs";
import { signObj, verifyObj } from "./sign.mjs";

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
});

export class Mesh {
  constructor({ vault, config, identity, agents, onRelayedEvent, onPeerNewerVersion, log }) {
    this.vault = vault;
    this.config = config;               // { meshPort, peers: [{url, pubKey}] }
    this.identity = identity;           // { pubKey, privKey }
    this.agents = agents;               // local agents [{id, name}]
    this.onRelayedEvent = onRelayedEvent;
    this.onPeerNewerVersion = onPeerNewerVersion;
    this.log = log || (() => {});
    this.peersState = new Map();        // url -> {online, version, agents, lastSeen}
    this.tickCount = 0;
    this.server = null;
  }

  presence() {
    const body = {
      instance: this.identity.pubKey,
      agents: this.agents.map((a) => ({ id: a.id, name: a.name })),
      version: RUNTIME_VERSION, charter: charterHash(),
      ts: Math.floor(Date.now() / 1000),
    };
    return { ...body, sig: signObj(this.identity.privKey, body) };
  }

  start() {
    const port = this.config.meshPort || 8791;
    this.server = createServer(async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, "http://x");
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          return send(200, { ok: true, version: RUNTIME_VERSION, charter: charterHash(), agents: this.agents.map((a) => a.name), uptime_s: Math.floor(process.uptime()) });
        }
        if (req.method === "GET" && url.pathname === "/presence") return send(200, this.presence());
        if (req.method === "GET" && url.pathname === "/version") return send(200, { version: RUNTIME_VERSION, charter: charterHash() });
        if (req.method === "POST" && url.pathname === "/presence-note") {
          const b = await readBody(req);
          const { sig, ...body } = b;
          const peer = (this.config.peers || []).find((p) => p.pubKey === body.instance);
          if (!peer || !verifyObj(body.instance, body, sig || "")) return send(403, { error: "unknown or badly signed presence" });
          this.peersState.set(peer.url, { online: true, version: body.version, agents: body.agents, lastSeen: Date.now() });
          if (body.version && body.version !== RUNTIME_VERSION && this.onPeerNewerVersion) {
            if (body.version > RUNTIME_VERSION) this.onPeerNewerVersion(peer.url, body.version);
          }
          return send(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/inbox") {
          const b = await readBody(req);
          const { sig, ...envelope } = b;   // {from, to, event, payload, ts}
          const peer = (this.config.peers || []).find((p) => p.pubKey === envelope.from);
          const selfSent = envelope.from === this.identity.pubKey;
          if (!selfSent && (!peer || !verifyObj(envelope.from, envelope, sig || ""))) {
            return send(403, { error: "unverified envelope" });
          }
          const localIds = new Set(this.agents.map((a) => a.id));
          if (envelope.to === "*" || localIds.has(envelope.to)) {
            this.vault.journal("mesh_event_received", { from: envelope.from?.slice(0, 12), event: envelope.event, to: envelope.to });
            if (this.onRelayedEvent) this.onRelayedEvent(envelope.event, envelope.payload, envelope);
            return send(200, { ok: true, delivered: "local" });
          }
          // Not ours: hold it for the offline peer (store-and-forward).
          const dir = join(this.vault.dir, "relay");
          const fname = join(dir, `${envelope.to}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
          writeFileSync(fname, JSON.stringify(b));
          this.vault.journal("mesh_relay_held", { to: envelope.to, event: envelope.event });
          return send(200, { ok: true, delivered: "held" });
        }
        if (req.method === "GET" && url.pathname.startsWith("/relay/")) {
          // Drain: the returning agent's server pulls everything held for it.
          const agentId = Number(url.pathname.split("/")[2]);
          const dir = join(this.vault.dir, "relay");
          const out = [];
          for (const f of readdirSync(dir)) {
            if (!f.startsWith(`${agentId}-`)) continue;
            try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); unlinkSync(join(dir, f)); } catch { /* skip */ }
          }
          if (out.length) this.vault.journal("mesh_relay_drained", { to: agentId, count: out.length });
          return send(200, { envelopes: out });
        }
        if (req.method === "POST" && url.pathname === "/settings") {
          const b = await readBody(req);   // {config, sig} — sig must be the OWNER's
          if (!b.config || !verifyObj(OWNER_PUBKEY_B64, b.config, b.sig || "")) {
            this.vault.journal("settings_rejected", { reason: "not owner-signed", from: req.socket.remoteAddress });
            return send(403, { error: "settings are owner-signed only — a hosting peer cannot change them" });
          }
          writeFileSync(join(this.vault.dir, "pending-settings.json"), JSON.stringify(b.config, null, 1));
          this.vault.journal("settings_staged_by_owner", {});
          return send(202, { ok: true, staged: true, note: "owner-signed settings staged; applied by the owner's local command" });
        }
        if (req.method === "GET" && url.pathname === "/release/manifest.json") {
          const p = join(this.vault.dir, "release", "manifest.json");
          if (!existsSync(p)) return send(404, { error: "no release hosted here" });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(readFileSync(p));
        }
        if (req.method === "GET" && url.pathname === "/release/package") {
          const p = join(this.vault.dir, "release", "package.tgz");
          if (!existsSync(p)) return send(404, { error: "no release hosted here" });
          res.writeHead(200, { "content-type": "application/gzip" });
          return res.end(readFileSync(p));
        }
        return send(404, { error: "not found" });
      } catch (e) {
        return send(500, { error: e.message });
      }
    });
    this.server.listen(port, () => this.log(`mesh: server on :${port} (${this.agents.length} agents hosted)`));
  }

  // Called on heartbeat ticks by the daemon: gossip + relay forwarding.
  async tick() {
    this.tickCount++;
    if (this.tickCount % 10 !== 0) return;   // ~every 30s
    for (const peer of this.config.peers || []) {
      try {
        const res = await fetch(`${peer.url}/presence`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        const { sig, ...rest } = body;
        if (!verifyObj(body.instance, rest, sig || "")) throw new Error("bad presence sig");
        const was = this.peersState.get(peer.url);
        this.peersState.set(peer.url, { online: true, version: body.version, agents: body.agents, lastSeen: Date.now() });
        if (!was?.online) this.log(`mesh: peer online ${peer.url} v${body.version}`);
        if (body.version > RUNTIME_VERSION && this.onPeerNewerVersion) this.onPeerNewerVersion(peer.url, body.version);
        await fetch(`${peer.url}/presence-note`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(this.presence()), signal: AbortSignal.timeout(2500),
        }).catch(() => {});
        // Forward anything we hold for this peer's agents.
        await this.#forwardHeld(peer, body.agents || []);
      } catch {
        const was = this.peersState.get(peer.url);
        if (was?.online) this.log(`mesh: peer offline ${peer.url} — holding its relay`);
        this.peersState.set(peer.url, { ...(was || {}), online: false, lastSeen: was?.lastSeen || 0 });
      }
    }
  }

  async #forwardHeld(peer, peerAgents) {
    const dir = join(this.vault.dir, "relay");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const agentId = Number(f.split("-")[0]);
      if (!peerAgents.some((a) => a.id === agentId)) continue;
      const p = join(dir, f);
      try {
        const env = JSON.parse(readFileSync(p, "utf8"));
        const res = await fetch(`${peer.url}/inbox`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(env), signal: AbortSignal.timeout(2500),
        });
        if (res.ok) { unlinkSync(p); this.vault.journal("mesh_relay_forwarded", { to: agentId, via: peer.url }); }
      } catch { /* still held */ }
    }
  }

  // Send an envelope to a specific peer server (or hold it if unreachable).
  async sendTo(peerUrl, envelopeBody) {
    const signed = { ...envelopeBody, sig: signObj(this.identity.privKey, envelopeBody) };
    try {
      const res = await fetch(`${peerUrl}/inbox`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(signed), signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch { return false; }
  }

  stop() { try { this.server?.close(); } catch { /* ignore */ } }
}
