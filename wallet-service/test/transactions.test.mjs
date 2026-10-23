import test from "node:test";
import assert from "node:assert/strict";
import { derivePrivateKeys } from "../../supabase/functions/_shared/wallet.mjs";
import {
  buildSignedBtcTransaction,
  buildSignedErc20Transaction,
  buildSignedEvmTransaction,
  inspectSignedEvmTransaction,
} from "../src/transactions.mjs";
import { rawToUsdCents, usdCentsToRaw } from "../src/prices.mjs";

const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HARDHAT = "test test test test test test test test test test test junk";

test("BTC transaction builds and signs from a fabricated confirmed UTXO (no broadcast)", () => {
  const keys = derivePrivateKeys(VECTOR);
  const signed = buildSignedBtcTransaction({
    keys,
    utxos: [{ txid: "11".repeat(32), vout: 0, value: 100000, status: { confirmed: true } }],
    toAddress: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    amountSats: 50000n,
    feeRateSatPerVb: 2,
    changeAddress: keys.btcAddress,
  });
  assert.equal(signed.inputs, 1);
  assert.match(signed.txHash, /^[0-9a-f]{64}$/);
  assert.ok(signed.raw.length > 200);
  assert.ok(BigInt(signed.feeSats) > 0n);
});

test("ERC20 and ETH transactions build and sign (no broadcast)", async () => {
  const keys = derivePrivateKeys(HARDHAT);
  const token = await buildSignedErc20Transaction({
    privateKey: keys.evmPrivateKey,
    asset: "USDT",
    to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    amountRaw: "25000000",
    nonce: 7,
    gas: 65000n,
    gasPriceWei: 1000000000n,
  });
  assert.equal(token.from, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.match(token.txHash, /^0x[0-9a-f]{64}$/);
  const parsed = inspectSignedEvmTransaction(token.raw);
  assert.equal(parsed.to.toLowerCase(), "0xdac17f958d2ee523a2206206994597c13d831ec7");
  assert.ok(parsed.data.startsWith("0xa9059cbb"));

  const eth = await buildSignedEvmTransaction({
    privateKey: keys.evmPrivateKey,
    to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    valueWei: 12345n,
    nonce: 8,
    gas: 21000n,
    gasPriceWei: 1000000000n,
  });
  assert.equal(inspectSignedEvmTransaction(eth.raw).valueWei, "12345");
});

test("USD conversions are exact for stablecoins and sane for BTC", () => {
  assert.equal(rawToUsdCents("25000000", 6, "1"), 2500); // 25 USDT -> $25.00
  assert.equal(usdCentsToRaw(2500, 6, "1"), "25000000");
  assert.equal(rawToUsdCents("100000000", 8, "100000"), 10000000); // 1 BTC @ $100k -> $100,000.00
  assert.equal(usdCentsToRaw(10000000, 8, "100000"), "100000000");
});
