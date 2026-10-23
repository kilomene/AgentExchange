import { readFileSync } from "node:fs";

export function loadConfig() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  let masterKey = process.env.WALLET_MASTER_KEY || "";
  if (!masterKey && process.env.WALLET_MASTER_KEY_FILE) {
    masterKey = readFileSync(process.env.WALLET_MASTER_KEY_FILE, "utf8").trim();
  }
  if (!masterKey) throw new Error("WALLET_MASTER_KEY or WALLET_MASTER_KEY_FILE is required");
  return { url: url.replace(/\/$/, ""), serviceKey, masterKey };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SupabaseAdmin {
  constructor(config = loadConfig()) {
    this.url = config.url;
    this.key = config.serviceKey;
    this.masterKey = config.masterKey;
  }
  async request(path, { method = "GET", body, prefer, accept } = {}) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${this.url}/rest/v1/${path}`, {
          method,
          headers: {
            apikey: this.key,
            authorization: `Bearer ${this.key}`,
            "content-type": "application/json",
            ...(prefer ? { prefer } : {}),
            ...(accept ? { accept } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) {
          const error = new Error(data?.message || `Supabase request failed (${res.status})`);
          error.status = res.status;
          error.code = data?.code;
          throw error;
        }
        return data;
      } catch (error) {
        lastError = error;
        if (error.status && error.status < 500) throw error;
        await sleep(400 * (attempt + 1));
      }
    }
    throw lastError;
  }
  list(path) { return this.request(path); }
  async one(path) {
    const rows = await this.request(path);
    return Array.isArray(rows) ? rows[0] || null : rows;
  }
  insert(table, row) {
    return this.request(table, { method: "POST", body: row, prefer: "return=representation" });
  }
  patch(path, row) {
    return this.request(path, { method: "PATCH", body: row, prefer: "return=representation" });
  }
  rpc(fn, args) {
    return this.request(`rpc/${fn}`, { method: "POST", body: args });
  }
  async notify(userId, type, body, link = "") {
    await this.insert("ex_notifications", {
      user_id: userId, type, body, link, created_at: Math.floor(Date.now() / 1000),
    });
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
