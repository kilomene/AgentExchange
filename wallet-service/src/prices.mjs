// USD price conversion using exact decimal arithmetic. Ledger amounts are
// integer USD cents; chain amounts are integer base units represented as
// decimal strings (satoshi, wei, or 6-decimal token units).

const cache = new Map();
const CACHE_MS = 60_000;

function parseDecimal(value) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal: ${s.slice(0, 40)}`);
  const [whole, frac = ""] = s.split(".");
  return { units: BigInt(whole + frac), scale: frac.length };
}
function pow10(n) { return 10n ** BigInt(n); }

export function rawToUsdCents(amountRaw, decimals, usdRate) {
  const raw = BigInt(amountRaw);
  const rate = parseDecimal(usdRate);
  // cents = raw / 10^decimals * rate * 100, rounded half-up.
  const numerator = raw * rate.units * 100n;
  const denominator = pow10(decimals) * pow10(rate.scale);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}
export function usdCentsToRaw(amountCents, decimals, usdRate) {
  const rate = parseDecimal(usdRate);
  if (rate.units === 0n) throw new Error("usd rate is zero");
  // raw = cents / 100 / rate * 10^decimals, floored so we never oversend.
  const numerator = BigInt(amountCents) * pow10(decimals) * pow10(rate.scale);
  const denominator = 100n * rate.units;
  return (numerator / denominator).toString();
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`price source failed (${res.status})`);
  return res.json();
}
export async function getUsdRate(asset) {
  if (asset === "USDT" || asset === "USDC") return "1";
  if (asset !== "BTC" && asset !== "ETH") throw new Error(`unsupported asset ${asset}`);
  const hit = cache.get(asset);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rate;
  const errors = [];
  try {
    const data = await fetchJson(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`);
    const rate = String(data?.data?.amount || "");
    if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error("coinbase returned no rate");
    cache.set(asset, { rate, at: Date.now() });
    return rate;
  } catch (e) { errors.push(e.message); }
  try {
    const pair = asset === "BTC" ? "XXBTZUSD" : "XETHZUSD";
    const query = asset === "BTC" ? "XBTUSD" : "ETHUSD";
    const data = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${query}`);
    const rate = String(data?.result?.[pair]?.c?.[0] || "");
    if (!/^\d+(\.\d+)?$/.test(rate)) throw new Error("kraken returned no rate");
    cache.set(asset, { rate, at: Date.now() });
    return rate;
  } catch (e) { errors.push(e.message); }
  throw new Error(`no USD price available for ${asset}: ${errors.join("; ")}`);
}
