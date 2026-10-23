// Supabase Realtime client (Phoenix protocol over WebSocket) — the
// runtime's live nerve. Postgres changes on the Exchange tables are pushed
// to this socket the instant they commit: no polling, no sync interval.
// Auto-reconnects with backoff; every (re)subscription triggers the owner's
// catch-up sync so nothing is ever missed, even across a network drop.
// The socket is WSX (wsx.mjs): it tunnels through the machine's HTTP egress
// proxy when one is configured — a plain WebSocket cannot leave such VMs.
import { WSX } from "./wsx.mjs";
export class Realtime {
  constructor({ url, key, topic = "exchange-live", bindings, onEvent, onSubscribed, log }) {
    this.url = url;           // wss://<project>.supabase.co/realtime/v1
    this.key = key;
    this.topic = `realtime:${topic}`;
    this.bindings = bindings; // [{event, schema, table, filter?}]
    this.onEvent = onEvent;   // (binding, record, oldRecord, type) => void
    this.onSubscribed = onSubscribed;
    this.log = log || (() => {});
    this.ws = null;
    this.ref = 0;
    this.bindingIds = new Map();
    this.connected = false;
    this.stopped = false;
    this.backoffMs = 1000;
    this.hbTimer = null;
    this.lastEventAt = 0;
  }

  start() { this.stopped = false; this.#connect(); }

  stop() {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  #connect() {
    if (this.stopped) return;
    const u = `${this.url}/websocket?apikey=${encodeURIComponent(this.key)}&vsn=1.0.0`;
    this.log(`realtime: connecting ${this.url}`);
    const ws = new WSX(u);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = 1000;
      this.#send({
        topic: this.topic, event: "phx_join",
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { key: "" },
            postgres_changes: this.bindings,
          },
          access_token: this.key,
        },
        ref: String(++this.ref), join_ref: String(this.ref),
      });
      if (this.hbTimer) clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => {
        this.#send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++this.ref) });
      }, 25000);
    });

    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.event === "phx_reply" && msg.payload?.status === "ok" && msg.topic === this.topic) {
        const changes = msg.payload.response?.postgres_changes || [];
        changes.forEach((c, i) => this.bindingIds.set(String(c.id), this.bindings[i]));
        const wasConnected = this.connected;
        this.connected = true;
        this.log(`realtime: subscribed (${changes.length} bindings)`);
        if (this.onSubscribed) this.onSubscribed(!wasConnected);
        return;
      }
      if (msg.event === "postgres_changes") {
        const ids = msg.payload?.ids || [];
        const data = msg.payload?.data || {};
        this.lastEventAt = Date.now();
        for (const id of ids) {
          const binding = this.bindingIds.get(String(id));
          if (binding && this.onEvent) {
            try { this.onEvent(binding, data.record || {}, data.old_record || {}, data.type); }
            catch (e) { this.log(`realtime: event handler error: ${e.message}`); }
          }
        }
      }
    });

    const onDown = (why) => {
      if (this.ws !== ws) return;
      this.connected = false;
      if (this.hbTimer) clearInterval(this.hbTimer);
      if (this.stopped) return;
      this.log(`realtime: down (${why}); reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.#connect(), this.backoffMs);
      this.backoffMs = Math.min(30000, this.backoffMs * 2);
    };
    ws.addEventListener("close", () => onDown("close"));
    ws.addEventListener("error", () => onDown("error"));
  }

  #send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* socket mid-close */ }
  }
}
