import { readFileSync } from "node:fs";

export function loadConfig() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  let smtpPass = process.env.ZOHO_SMTP_PASS || "";
  if (!smtpPass && process.env.ZOHO_SMTP_PASS_FILE) {
    smtpPass = readFileSync(process.env.ZOHO_SMTP_PASS_FILE, "utf8").trim();
  }
  const smtpUser = process.env.ZOHO_SMTP_USER || "no-reply@novamail.store";
  if (!smtpPass) throw new Error("ZOHO_SMTP_PASS or ZOHO_SMTP_PASS_FILE is required");
  return { url: url.replace(/\/$/, ""), serviceKey, smtpUser, smtpPass };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SupabaseAdmin {
  constructor(config) {
    this.url = config.url;
    this.key = config.serviceKey;
  }
  async request(path, { method = "GET", body, prefer } = {}) {
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
  patch(path, body) { return this.request(path, { method: "PATCH", body }); }
}
