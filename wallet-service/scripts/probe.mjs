// One-off network probe: run under the walletd unit's environment to see
// exactly which chain endpoints are reachable from the service context.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || "";
console.log("proxy configured:", !!proxyUrl);
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
function causeChain(e) {
  const parts = [];
  let cur = e;
  while (cur) { parts.push(`${cur.name || "Error"}: ${cur.message}${cur.code ? ` [${cur.code}]` : ""}`); cur = cur.cause; }
  return parts.join(" <= ");
}
const targets = [
  ["blockstream", "https://blockstream.info/api/blocks/tip/height", {}],
  ["mempool", "https://mempool.space/api/blocks/tip/height", {}],
  ["publicnode", "https://ethereum-rpc.publicnode.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }],
  ["llamarpc", "https://eth.llamarpc.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }],
  ["cloudflare-eth", "https://cloudflare-eth.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }],
  ["supabase", `${process.env.SUPABASE_URL}/rest/v1/`, {}],
  ["coinbase-price", "https://api.coinbase.com/v2/prices/BTC-USD/spot", {}],
];
for (const [name, url, opts] of targets) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    console.log(name, "->", res.status);
  } catch (e) {
    console.log(name, "-> FAIL", causeChain(e));
  }
}
