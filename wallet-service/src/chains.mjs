// Public, no-key chain access:
// - Bitcoin: Blockstream.info API (balances, UTXOs, broadcast, status)
// - Ethereum mainnet: public JSON-RPC endpoints (balances, logs, blocks,
//   receipts, broadcast). Multiple endpoints are tried in order.

export const ASSETS = {
  BTC: { chain: "bitcoin", decimals: 8, confirmations: 1 },
  ETH: { chain: "ethereum", decimals: 18, confirmations: 12 },
  USDT: { chain: "ethereum", decimals: 6, confirmations: 12, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  USDC: { chain: "ethereum", decimals: 6, confirmations: 12, contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
};
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Two independent esplora-compatible sources: some egress paths refuse one
// host or the other, so every BTC call falls back across both.
const BTC_BASES = ["https://blockstream.info/api", "https://mempool.space/api"];
const EVM_RPCS = [
  process.env.EVM_RPC_URL,
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
].filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRetry(url, opts = {}, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}
async function btcJson(path) {
  let last;
  for (const base of BTC_BASES) {
    try {
      const res = await fetchRetry(`${base}${path}`, {}, 2);
      return res.json();
    } catch (e) { last = e; }
  }
  throw last;
}
async function btcText(path) {
  let last;
  for (const base of BTC_BASES) {
    try {
      const res = await fetchRetry(`${base}${path}`, {}, 2);
      return (await res.text()).trim();
    } catch (e) { last = e; }
  }
  throw last;
}
export async function btcTipHeight() {
  return parseInt(await btcText("/blocks/tip/height"), 10);
}
export async function btcAddressTxs(address, maxPages = 3) {
  let txs = await btcJson(`/address/${address}/txs`);
  let pages = 1;
  while (txs.length && pages < maxPages) {
    const last = txs[txs.length - 1].txid;
    const more = await btcJson(`/address/${address}/txs/chain/${last}`);
    if (!more.length) break;
    txs = txs.concat(more);
    pages++;
  }
  const mempool = await btcJson(`/address/${address}/txs/mempool`).catch(() => []);
  const seen = new Set(txs.map((t) => t.txid));
  for (const tx of mempool) if (!seen.has(tx.txid)) txs.push(tx);
  return txs;
}
export async function btcAddressInfo(address) { return btcJson(`/address/${address}`); }
export async function btcBalanceSats(address, { confirmedOnly = false } = {}) {
  const info = await btcAddressInfo(address);
  const chain = BigInt(info.chain_stats.funded_txo_sum) - BigInt(info.chain_stats.spent_txo_sum);
  if (confirmedOnly) return chain;
  const mempool = BigInt(info.mempool_stats.funded_txo_sum) - BigInt(info.mempool_stats.spent_txo_sum);
  const total = chain + mempool;
  return total > 0n ? total : 0n;
}
export async function btcUtxos(address) { return btcJson(`/address/${address}/utxo`); }
export async function btcConfirmedUtxoBalance(address) {
  const utxos = await btcUtxos(address);
  return utxos.filter((u) => u.status?.confirmed).reduce((sum, u) => sum + BigInt(u.value), 0n);
}
export async function btcFeeRateSatPerVb() {
  try {
    const fees = await btcJson("/fee-estimates");
    const btcPerKvb = Number(fees["6"] || fees["3"] || fees["1"] || 0.00001);
    return Math.max(1, Math.ceil(btcPerKvb * 100000));
  } catch { return 5; }
}
export async function btcTxStatus(txHash) {
  const tx = await btcJson(`/tx/${txHash}`);
  if (!tx?.status?.confirmed) return { confirmed: false, confirmations: 0, blockHeight: null };
  const tip = await btcTipHeight();
  return { confirmed: true, confirmations: tip - tx.status.block_height + 1, blockHeight: tx.status.block_height };
}
export async function btcBroadcast(rawHex) {
  let last;
  for (const base of BTC_BASES) {
    try {
      const res = await fetchRetry(`${base}/tx`, { method: "POST", body: rawHex, headers: { "content-type": "text/plain" } }, 2);
      return (await res.text()).trim();
    } catch (e) { last = e; }
  }
  throw last;
}

// ---------- Ethereum ----------
let rpcId = 1;
let stickyRpc = null; // last endpoint that answered; tried first (some
// fallbacks hang to timeout on this egress path — stickiness avoids paying
// that cost on every call).
export async function evmRpc(method, params = []) {
  let last;
  const order = stickyRpc ? [stickyRpc, ...EVM_RPCS.filter((u) => u !== stickyRpc)] : EVM_RPCS;
  for (const url of order) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "rpc error");
      stickyRpc = url;
      return data.result;
    } catch (e) { last = e; if (stickyRpc === url) stickyRpc = null; }
  }
  throw last || new Error("all EVM RPC endpoints failed");
}
export const evmBlockNumber = async () => parseInt(await evmRpc("eth_blockNumber"), 16);
export async function evmNativeBalance(address, blockTag = "latest") {
  return BigInt(await evmRpc("eth_getBalance", [address, blockTag]));
}
export async function evmTokenBalance(contract, address) {
  const data = "0x70a08231" + "0".repeat(24) + address.replace(/^0x/, "").toLowerCase();
  return BigInt(await evmRpc("eth_call", [{ to: contract, data }, "latest"]));
}
export async function evmAssetBalance(asset, address) {
  const meta = ASSETS[asset];
  if (!meta || meta.chain !== "ethereum") throw new Error(`not an EVM asset: ${asset}`);
  if (asset === "ETH") return evmNativeBalance(address);
  return evmTokenBalance(meta.contract, address);
}
export async function evmGasPriceWei() { return BigInt(await evmRpc("eth_gasPrice")); }
export async function evmNonce(address) { return parseInt(await evmRpc("eth_getTransactionCount", [address, "pending"]), 16); }
export async function evmEstimateGas(tx) { return BigInt(await evmRpc("eth_estimateGas", [tx])); }
export async function evmBlock(number, full = true) {
  return evmRpc("eth_getBlockByNumber", ["0x" + number.toString(16), full]);
}
export async function evmTransferLogs(contract, toAddress, fromBlock, toBlock) {
  const topicTo = "0x" + "0".repeat(24) + toAddress.replace(/^0x/, "").toLowerCase();
  return evmRpc("eth_getLogs", [{
    address: contract,
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    topics: [TRANSFER_TOPIC, null, topicTo],
  }]);
}
export async function evmReceipt(txHash) { return evmRpc("eth_getTransactionReceipt", [txHash]); }
export async function evmReceiptConfirmations(txHash) {
  const receipt = await evmReceipt(txHash);
  if (!receipt || receipt.status !== "0x1") return { found: !!receipt, confirmations: 0, success: !!receipt && receipt.status === "0x1" };
  const current = await evmBlockNumber();
  return { found: true, confirmations: current - parseInt(receipt.blockNumber, 16) + 1, success: true };
}
export async function evmBroadcast(rawTx) { return evmRpc("eth_sendRawTransaction", [rawTx]); }
export async function evmTxExists(txHash) {
  const tx = await evmRpc("eth_getTransactionByHash", [txHash]);
  return !!tx;
}
