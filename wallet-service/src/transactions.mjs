// Transaction construction + signing. Private keys arrive here already
// decrypted in memory (from _shared/wallet.mjs derivePrivateKeys) and are
// never logged, returned, or persisted by this module. build* functions only
// construct and sign; broadcast is a separate explicit step in chains.mjs.

import * as btc from "@scure/btc-signer";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, erc20Abi, keccak256, parseTransaction, serializeTransaction } from "viem";
import { ASSETS } from "./chains.mjs";

export const BTC_DUST_SATS = 546n;

function estimateBtcVsize(inputs, outputs) {
  // P2WPKH-only transactions: overhead ~10.5 vB, input ~68 vB, output ~31 vB.
  return Math.ceil(10.5 + inputs * 68 + outputs * 31);
}
export function buildSignedBtcTransaction({ keys, utxos, toAddress, amountSats, feeRateSatPerVb, changeAddress }) {
  const amount = BigInt(amountSats);
  if (amount < BTC_DUST_SATS) throw new Error("BTC amount below dust limit");
  const confirmed = utxos.filter((u) => u.status?.confirmed)
    .slice().sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const selected = [];
  let sum = 0n;
  let fee = 0n;
  for (const utxo of confirmed) {
    selected.push(utxo);
    sum += BigInt(utxo.value);
    fee = BigInt(Math.ceil(estimateBtcVsize(selected.length, 2) * feeRateSatPerVb));
    if (sum >= amount + fee) break;
  }
  if (!selected.length || sum < amount) throw new Error("insufficient confirmed BTC");
  let change = sum - amount - fee;
  let outputs = 2;
  if (change < BTC_DUST_SATS) {
    outputs = 1;
    fee = sum - amount;
    change = 0n;
    const minFee = BigInt(Math.ceil(estimateBtcVsize(selected.length, 1) * feeRateSatPerVb));
    if (fee < minFee) throw new Error("insufficient confirmed BTC for fee");
  }
  const payment = btc.p2wpkh(keys.btcPublicKey, btc.NETWORK);
  const tx = new btc.Transaction({ version: 2 });
  for (const utxo of selected) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) },
    });
  }
  tx.addOutputAddress(toAddress, amount, btc.NETWORK);
  if (outputs === 2) tx.addOutputAddress(changeAddress || keys.btcAddress, change, btc.NETWORK);
  tx.sign(keys.btcPrivateKey);
  tx.finalize();
  return { raw: tx.hex, txHash: tx.id, feeSats: fee.toString(), changeSats: change.toString(), inputs: selected.length };
}

export function erc20TransferData(toAddress, amountRaw) {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [toAddress, BigInt(amountRaw)] });
}
export function buildSignedEvmTransaction({ privateKey, to, valueWei = 0n, data = "0x", nonce, gas, gasPriceWei, chainId = 1 }) {
  const account = privateKeyToAccount(privateKey);
  const tx = {
    account,
    to,
    value: BigInt(valueWei),
    data,
    nonce: Number(nonce),
    gas: BigInt(gas),
    gasPrice: BigInt(gasPriceWei),
    chainId: Number(chainId),
    type: "legacy",
  };
  // serializeTransaction with a signature is produced through the account's
  // signTransaction to keep exactly one signing path.
  return account.signTransaction(tx).then((raw) => ({
    raw,
    txHash: keccak256(raw),
    from: account.address,
  }));
}
export async function buildSignedErc20Transaction({ privateKey, asset, to, amountRaw, nonce, gas, gasPriceWei, chainId = 1 }) {
  const meta = ASSETS[asset];
  if (!meta?.contract) throw new Error(`not an ERC20 asset: ${asset}`);
  return buildSignedEvmTransaction({
    privateKey,
    to: meta.contract,
    valueWei: 0n,
    data: erc20TransferData(to, amountRaw),
    nonce, gas, gasPriceWei, chainId,
  });
}
export function inspectSignedEvmTransaction(raw) {
  const parsed = parseTransaction(raw);
  return {
    to: parsed.to,
    valueWei: (parsed.value || 0n).toString(),
    data: parsed.data || "0x",
    nonce: parsed.nonce,
    chainId: parsed.chainId,
  };
}
