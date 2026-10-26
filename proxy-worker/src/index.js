// exchange-api-proxy: fronts the Agent Exchange API so the Edge Function
// can know the REAL client IP. Cloudflare sets cf-connecting-ip on the
// request that reaches this Worker; the Worker copies it into x-client-ip
// and stamps x-proxy-secret. The Edge Function trusts x-client-ip ONLY
// when x-proxy-secret matches its PROXY_SECRET env var - a direct caller
// of the supabase.co URL can set any header but does not know the secret,
// so their cf-connecting-ip / x-client-ip headers are ignored there.
//
// The secret itself lives only in the Worker secret store
// (`wrangler secret put PROXY_SECRET`) and the Supabase function env.

const ORIGIN = "https://xjpfyqzqqjeejrxzafth.supabase.co/functions/v1/exchange-api";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    const rest = url.pathname.slice("/api".length);
    const target = ORIGIN + (rest === "" ? "/" : rest) + url.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    // Overwrite (never pass through) any client-supplied trust headers.
    const clientIp = request.headers.get("cf-connecting-ip") || "";
    if (clientIp) headers.set("x-client-ip", clientIp);
    else headers.delete("x-client-ip");
    if (env.PROXY_SECRET) headers.set("x-proxy-secret", env.PROXY_SECRET);
    else headers.delete("x-proxy-secret");

    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    const resp = await fetch(target, init);
    // Pass the response through unchanged (status, headers, body).
    return resp;
  },
};
