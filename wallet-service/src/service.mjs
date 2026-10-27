// Agent Exchange wallet service (exchange-walletd).
//
// One loop, four jobs, all against real mainnet chains:
//  1. Deposit watch — BTC (Blockstream) + Ethereum (public RPC) transfers
//     into per-user deposit addresses; credited to the user's ledger via the
//     ex_credit_chain_deposit RPC once confirmations reach the asset
//     threshold (BTC 1, EVM 12). Idempotent by (chain, tx, log, address).
//  2. Payout execution — admin-approved crypto payouts are signed with the
//     treasury wallet's decrypted seed (in memory only) and broadcast for
//     real; the row is marked paid with its tx hash on confirmation. If the
//     treasury cannot cover a payout it is parked as awaiting_funds with the
//     reason on the row. Nothing is ever marked sent without a broadcast.
//  3. Sweeps — confirmed funds in user wallets are gathered into the
//     treasury so earnings can be paid out. ERC20 sweeps need ETH gas in
//     the user wallet; the treasury tops it up first when it can.
//  4. Heartbeat — ~/.exchange-wallet/heartbeat.json every cycle so the
//     real-time wake hook can resurrect this service if it ever dies.
//
// Private keys are decrypted in memory for the duration of one signing
// operation and never logged, returned, or persisted.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Route fetch through the machine egress proxy when one is configured.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (e) {
    console.error("proxy dispatcher unavailable:", e.message);
  }
}

const { SupabaseAdmin, nowSeconds } = await import("./supabase.mjs");
const chains = await import("./chains.mjs");
const { ASSETS } = chains;
const { rawToUsdCents, usdCentsToRaw, getUsdRate } = await import("./prices.mjs");
const { buildSignedBtcTransaction, buildSignedEvmTransaction, buildSignedErc20Transaction } = await import("./transactions.mjs");
const { decryptSeed, derivePrivateKeys } = await import("../../supabase/functions/_shared/wallet.mjs");
const { isWalletFrozen, FREEZE_HOLD_REASON } = await import("./freeze.mjs");

const CYCLE_MS = Number(process.env.WALLET_CYCLE_MS || 45000);
const EVM_SCAN_SPAN = 60; // blocks per cycle, max
const SWEEP_MIN_BTC_SATS = 30000n;
const SWEEP_MIN_ETH_WEI = 5000000000000000n; // 0.005 ETH
const GAS_TOPUP_WEI = 1500000000000000n; // 0.0015 ETH
const HEARTBEAT_DIR = process.env.WALLET_STATE_DIR || "/home/hatch/.exchange-wallet";

const db = new SupabaseAdmin();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const errLog = (...a) => console.error(new Date().toISOString(), ...a);

function heartbeat(extra = {}) {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    writeFileSync(join(HEARTBEAT_DIR, "heartbeat.json"), JSON.stringify({ ts: nowSeconds(), pid: process.pid, ...extra }));
  } catch { /* heartbeat is best-effort */ }
}

async function loadWallets() {
  const users = await db.list("ex_user_wallets?select=user_id,btc_address,evm_address,seed_ciphertext,seed_nonce");
  const treasuryRows = await db.list("ex_treasury?select=id,btc_address,evm_address,seed_ciphertext,seed_nonce&limit=1");
  return { users: users || [], treasury: treasuryRows?.[0] || null };
}

async function upsertConfirming(row) {
  try {
    await db.insert("ex_chain_deposits", row);
  } catch (e) {
    if (e.status !== 409 && e.code !== "23505") throw e;
  }
}

// Transactional email via ex_outbox (the mailer renders + sends). A
// failure here must never break money movement: callers .catch() and log.
async function queueOutbox(kind, userId, payload) {
  const u = await db.one(`ex_users?id=eq.${userId}&select=email,name`);
  if (!u?.email) return;
  await db.insert("ex_outbox", {
    kind, to_email: u.email, to_name: u.name || null, subject: null,
    payload, created_at: nowSeconds(),
  });
}

async function creditDeposit({ userId, chain, asset, address, txHash, logIndex, blockHeight, amountRaw, confirmations }) {
  const meta = ASSETS[asset];
  const rate = await getUsdRate(asset);
  const amountCents = rawToUsdCents(amountRaw, meta.decimals, rate);
  const t = nowSeconds();
  if (amountCents <= 0) {
    await upsertConfirming({ user_id: userId, chain, asset, address, tx_hash: txHash, log_index: logIndex, block_height: blockHeight, amount_raw: String(amountRaw), amount_cents: 0, usd_rate: rate, confirmations, status: "ignored", created_at: t, updated_at: t });
    return;
  }
  // The credit RPC is idempotent and the scans re-call it for already
  // credited deposits — check the row's prior state so the confirmation
  // email is queued only on the actual transition to 'credited'.
  const logSel = logIndex == null ? "is.null" : `eq.${logIndex}`;
  const prior = await db.one(`ex_chain_deposits?chain=eq.${chain}&tx_hash=eq.${txHash}&address=eq.${address}&log_index=${logSel}&select=status`).catch(() => null);
  await db.rpc("ex_credit_chain_deposit", {
    p_user: userId, p_chain: chain, p_asset: asset, p_address: address,
    p_tx_hash: txHash, p_log_index: logIndex, p_block_height: blockHeight,
    p_amount_raw: String(amountRaw), p_amount_cents: amountCents, p_usd_rate: rate,
    p_confirmations: confirmations, p_now: t,
  });
  await db.notify(userId, "wallet", `${asset} deposit of $${(amountCents / 100).toFixed(2)} confirmed and credited`, "#/wallet");
  if (prior?.status !== "credited") {
    await queueOutbox("deposit_confirmed", userId, { amount_cents: amountCents, asset })
      .catch((e) => errLog(`deposit_confirmed mail queue failed user=${userId} tx=${txHash}:`, e.message));
  }
  log(`credited ${asset} deposit user=${userId} tx=${txHash} cents=${amountCents}`);
}

// ---------------- deposit watch: BTC ----------------
async function scanBtc(wallets, sweepTxHashes) {
  const tip = await chains.btcTipHeight();
  for (const w of wallets) {
    const txs = await chains.btcAddressTxs(w.btc_address);
    for (const tx of txs) {
      if (sweepTxHashes.has(tx.txid)) continue;
      const spendsOwn = (tx.vin || []).some((vin) => vin.prevout?.scriptpubkey_address === w.btc_address);
      for (let i = 0; i < (tx.vout || []).length; i++) {
        const out = tx.vout[i];
        if (out.scriptpubkey_address !== w.btc_address) continue;
        if (spendsOwn) continue; // self-transfer (sweep change) is not a deposit
        const confirmed = !!tx.status?.confirmed;
        const confs = confirmed ? tip - tx.status.block_height + 1 : 0;
        if (confirmed && confs >= ASSETS.BTC.confirmations) {
          await creditDeposit({ userId: w.user_id, chain: "bitcoin", asset: "BTC", address: w.btc_address, txHash: tx.txid, logIndex: i, blockHeight: tx.status.block_height, amountRaw: String(out.value), confirmations: confs });
        } else {
          const t = nowSeconds();
          await upsertConfirming({ user_id: w.user_id, chain: "bitcoin", asset: "BTC", address: w.btc_address, tx_hash: tx.txid, log_index: i, block_height: tx.status?.block_height || null, amount_raw: String(out.value), amount_cents: 0, usd_rate: null, confirmations: confs, status: "confirming", created_at: t, updated_at: t });
        }
      }
    }
  }
}

// ---------------- deposit watch: EVM ----------------
async function scanEvm(wallets) {
  const head = await chains.evmBlockNumber();
  const cursorRows = await db.list("ex_chain_cursors?chain=eq.ethereum&select=last_block");
  let cursor = cursorRows?.[0]?.last_block;
  if (cursor == null) {
    cursor = head;
    await db.insert("ex_chain_cursors", { chain: "ethereum", last_block: cursor, updated_at: nowSeconds() });
    log(`evm cursor initialized at head ${head}`);
    return;
  }
  if (head <= cursor) return;
  const from = cursor + 1;
  const to = Math.min(head, cursor + EVM_SCAN_SPAN);
  const byEvm = new Map(wallets.map((w) => [w.evm_address.toLowerCase(), w]));
  // Native ETH transfers: scan block bodies for sends to watched addresses.
  // Blocks are fetched in parallel batches — sequential fetches through the
  // egress proxy are far too slow.
  for (let batchFrom = from; batchFrom <= to; batchFrom += 8) {
    const batchTo = Math.min(to, batchFrom + 7);
    const blocks = await Promise.all(
      Array.from({ length: batchTo - batchFrom + 1 }, (_, i) => chains.evmBlock(batchFrom + i, true).catch(() => null)),
    );
    for (let bi = 0; bi < blocks.length; bi++) {
      const n = batchFrom + bi;
      const block = blocks[bi];
      if (!block?.transactions) continue;
      for (const tx of block.transactions) {
      if (!tx.to) continue;
      const w = byEvm.get(tx.to.toLowerCase());
      if (!w) continue;
      const value = BigInt(tx.value);
      if (value <= 0n) continue;
      const confs = head - n + 1;
      if (confs >= ASSETS.ETH.confirmations) {
        await creditDeposit({ userId: w.user_id, chain: "ethereum", asset: "ETH", address: w.evm_address, txHash: tx.hash, logIndex: null, blockHeight: n, amountRaw: value.toString(), confirmations: confs });
      } else {
        const t = nowSeconds();
        await upsertConfirming({ user_id: w.user_id, chain: "ethereum", asset: "ETH", address: w.evm_address, tx_hash: tx.hash, log_index: null, block_height: n, amount_raw: value.toString(), amount_cents: 0, usd_rate: null, confirmations: confs, status: "confirming", created_at: t, updated_at: t });
      }
      }
    }
  }
  // ERC20 transfers: per contract, per watched address, over the same range.
  for (const asset of ["USDT", "USDC"]) {
    const meta = ASSETS[asset];
    for (const w of wallets) {
      const logs = await chains.evmTransferLogs(meta.contract, w.evm_address, from, to);
      for (const entry of logs || []) {
        const blockNumber = parseInt(entry.blockNumber, 16);
        const confs = head - blockNumber + 1;
        const amountRaw = BigInt(entry.data).toString();
        const logIndex = parseInt(entry.logIndex, 16);
        if (confs >= meta.confirmations) {
          await creditDeposit({ userId: w.user_id, chain: "ethereum", asset, address: w.evm_address, txHash: entry.transactionHash, logIndex, blockHeight: blockNumber, amountRaw, confirmations: confs });
        } else {
          const t = nowSeconds();
          await upsertConfirming({ user_id: w.user_id, chain: "ethereum", asset, address: w.evm_address, tx_hash: entry.transactionHash, log_index: logIndex, block_height: blockNumber, amount_raw: amountRaw, amount_cents: 0, usd_rate: "1", confirmations: confs, status: "confirming", created_at: t, updated_at: t });
        }
      }
    }
  }
  await db.patch("ex_chain_cursors?chain=eq.ethereum", { last_block: to, updated_at: nowSeconds() });
}

// Re-evaluate deposits that were seen but not yet confirmed enough.
async function recheckConfirming() {
  const rows = await db.list("ex_chain_deposits?status=eq.confirming&select=*&limit=100");
  for (const row of rows || []) {
    try {
      if (row.chain === "bitcoin") {
        const st = await chains.btcTxStatus(row.tx_hash);
        if (st.confirmed && st.confirmations >= ASSETS.BTC.confirmations) {
          await creditDeposit({ userId: row.user_id, chain: "bitcoin", asset: "BTC", address: row.address, txHash: row.tx_hash, logIndex: row.log_index, blockHeight: st.blockHeight, amountRaw: row.amount_raw, confirmations: st.confirmations });
        }
      } else {
        const rc = await chains.evmReceiptConfirmations(row.tx_hash);
        if (rc.found && rc.confirmations >= ASSETS[row.asset].confirmations) {
          await creditDeposit({ userId: row.user_id, chain: "ethereum", asset: row.asset, address: row.address, txHash: row.tx_hash, logIndex: row.log_index, blockHeight: row.block_height, amountRaw: row.amount_raw, confirmations: rc.confirmations });
        }
      }
    } catch (e) { errLog("recheck failed for deposit", row.id, e.message); }
  }
}

// ---------------- payouts ----------------
function treasuryKeys(treasury) {
  const phrase = decryptSeed(treasury, db.masterKey);
  return derivePrivateKeys(phrase);
}

async function markPayout(id, patch) {
  await db.patch(`ex_payouts?id=eq.${id}`, patch);
}

async function executePayouts(treasury) {
  const rows = await db.list("ex_payouts?execution_status=in.(approved,awaiting_funds)&method=eq.crypto&status=eq.pending&select=*&order=created_at.asc&limit=10");
  if (!rows?.length) return;
  const keys = treasuryKeys(treasury);
  for (const p of rows) {
    try {
      // WALLET FREEZE execution-time re-check: a payout created before
      // a freeze must NOT broadcast while the wallet is frozen. It
      // holds — no send, no fake failure, execution status untouched —
      // and can proceed after unfreeze if otherwise still valid.
      if (await isWalletFrozen(db, p.user_id)) {
        if (p.failure_reason !== FREEZE_HOLD_REASON) await markPayout(p.id, { failure_reason: FREEZE_HOLD_REASON });
        log(`payout ${p.id} held — wallet of user ${p.user_id} is frozen by admin; no broadcast`);
        continue;
      }
      const asset = ASSETS[p.asset] ? p.asset : "USDT";
      const meta = ASSETS[asset];
      const rate = await getUsdRate(asset);
      const raw = BigInt(usdCentsToRaw(p.amount_cents, meta.decimals, rate));
      let sent = null;
      if (asset === "BTC") {
        const balance = await chains.btcConfirmedUtxoBalance(treasury.btc_address);
        const feeRate = await chains.btcFeeRateSatPerVb();
        if (balance < raw + 5000n) {
          if (p.execution_status !== "awaiting_funds") await markPayout(p.id, { execution_status: "awaiting_funds", failure_reason: "treasury BTC balance too low" });
          continue;
        }
        const utxos = await chains.btcUtxos(treasury.btc_address);
        const built = buildSignedBtcTransaction({ keys, utxos, toAddress: p.destination, amountSats: raw, feeRateSatPerVb: feeRate, changeAddress: treasury.btc_address });
        const txHash = await chains.btcBroadcast(built.raw);
        sent = { txHash, raw };
      } else {
        const gasPrice = await chains.evmGasPriceWei();
        if (asset === "ETH") {
          const balance = await chains.evmNativeBalance(treasury.evm_address);
          const gasCost = 21000n * gasPrice;
          if (balance < raw + gasCost) {
            if (p.execution_status !== "awaiting_funds") await markPayout(p.id, { execution_status: "awaiting_funds", failure_reason: "treasury ETH balance too low" });
            continue;
          }
          const nonce = await chains.evmNonce(treasury.evm_address);
          const built = await buildSignedEvmTransaction({ privateKey: keys.evmPrivateKey, to: p.destination, valueWei: raw, nonce, gas: 21000n, gasPriceWei: gasPrice });
          const txHash = await chains.evmBroadcast(built.raw);
          sent = { txHash, raw };
        } else {
          const tokenBalance = await chains.evmTokenBalance(meta.contract, treasury.evm_address);
          const ethBalance = await chains.evmNativeBalance(treasury.evm_address);
          const gasCost = 80000n * gasPrice;
          if (tokenBalance < raw || ethBalance < gasCost) {
            if (p.execution_status !== "awaiting_funds") await markPayout(p.id, { execution_status: "awaiting_funds", failure_reason: `treasury ${asset} or gas balance too low` });
            continue;
          }
          const nonce = await chains.evmNonce(treasury.evm_address);
          const built = await buildSignedErc20Transaction({ privateKey: keys.evmPrivateKey, asset, to: p.destination, amountRaw: raw.toString(), nonce, gas: 80000n, gasPriceWei: gasPrice });
          const txHash = await chains.evmBroadcast(built.raw);
          sent = { txHash, raw };
        }
      }
      if (sent) {
        await markPayout(p.id, { execution_status: "sent", tx_hash: sent.txHash, asset_amount_raw: sent.raw.toString(), usd_rate: rate, broadcast_at: nowSeconds(), failure_reason: "" });
        log(`payout ${p.id} broadcast ${asset} tx=${sent.txHash}`);
      }
    } catch (e) {
      errLog(`payout ${p.id} execution failed:`, e.message);
      await markPayout(p.id, { failure_reason: String(e.message).slice(0, 300) }).catch(() => {});
    }
  }
}

async function confirmPayouts() {
  const rows = await db.list("ex_payouts?execution_status=eq.sent&select=*&limit=20");
  for (const p of rows || []) {
    try {
      let confirmed = false;
      if (p.asset === "BTC") {
        const st = await chains.btcTxStatus(p.tx_hash);
        confirmed = st.confirmed && st.confirmations >= 1;
      } else {
        const rc = await chains.evmReceiptConfirmations(p.tx_hash);
        confirmed = rc.found && rc.success && rc.confirmations >= 1;
      }
      if (confirmed) {
        const t = nowSeconds();
        await markPayout(p.id, { execution_status: "confirmed", status: "paid", confirmed_at: t, resolved_at: t });
        await db.notify(p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} sent — tx ${String(p.tx_hash).slice(0, 18)}…`, "#/wallet");
        await queueOutbox("payout_completed", p.user_id, { amount_cents: p.amount_cents, asset: p.asset, destination: p.destination, tx_hash: p.tx_hash })
          .catch((e) => errLog(`payout_completed mail queue failed payout=${p.id}:`, e.message));
        log(`payout ${p.id} confirmed tx=${p.tx_hash}`);
      }
    } catch (e) { errLog(`payout ${p.id} confirm check failed:`, e.message); }
  }
}

// ---------------- sweeps ----------------
async function recordSweep(row) {
  const rows = await db.insert("ex_sweeps", row).catch(() => null);
  return rows?.[0] || null;
}

async function sweepUser(w, treasury) {
  const phrase = decryptSeed(w, db.masterKey);
  const keys = derivePrivateKeys(phrase);
  const t = nowSeconds();
  // BTC
  try {
    const utxos = await chains.btcUtxos(w.btc_address);
    const confirmed = (utxos || []).filter((u) => u.status?.confirmed);
    const balance = confirmed.reduce((s, u) => s + BigInt(u.value), 0n);
    if (balance >= SWEEP_MIN_BTC_SATS) {
      const feeRate = await chains.btcFeeRateSatPerVb();
      const estFee = BigInt(Math.ceil((10.5 + confirmed.length * 68 + 31) * feeRate));
      const amount = balance - estFee - 1000n;
      if (amount >= 546n) {
        const built = buildSignedBtcTransaction({ keys, utxos, toAddress: treasury.btc_address, amountSats: amount, feeRateSatPerVb: feeRate, changeAddress: w.btc_address });
        const row = await recordSweep({ source_user_id: w.user_id, chain: "bitcoin", asset: "BTC", from_address: w.btc_address, to_address: treasury.btc_address, amount_raw: amount.toString(), status: "prepared", created_at: t, updated_at: t });
        const txHash = await chains.btcBroadcast(built.raw);
        if (row) await db.patch(`ex_sweeps?id=eq.${row.id}`, { tx_hash: txHash, status: "sent", updated_at: nowSeconds() });
        log(`swept BTC user=${w.user_id} sats=${amount} tx=${txHash}`);
      }
    }
  } catch (e) { errLog(`BTC sweep user=${w.user_id} failed:`, e.message); }
  // ETH + ERC20
  try {
    const gasPrice = await chains.evmGasPriceWei();
    let ethBalance = await chains.evmNativeBalance(w.evm_address);
    for (const asset of ["USDT", "USDC"]) {
      const meta = ASSETS[asset];
      const tokenBalance = await chains.evmTokenBalance(meta.contract, w.evm_address);
      if (tokenBalance <= 0n) continue;
      const gasCost = 80000n * gasPrice * 13n / 10n;
      if (ethBalance < gasCost) {
        // Top up gas from the treasury when it can afford to.
        const treasuryEth = await chains.evmNativeBalance(treasury.evm_address);
        if (treasuryEth > GAS_TOPUP_WEI + 21000n * gasPrice) {
          const tKeys = treasuryKeys(treasury);
          const nonce = await chains.evmNonce(treasury.evm_address);
          const built = await buildSignedEvmTransaction({ privateKey: tKeys.evmPrivateKey, to: w.evm_address, valueWei: GAS_TOPUP_WEI, nonce, gas: 21000n, gasPriceWei: gasPrice });
          const txHash = await chains.evmBroadcast(built.raw);
          await recordSweep({ source_user_id: w.user_id, chain: "ethereum", asset, from_address: treasury.evm_address, to_address: w.evm_address, amount_raw: GAS_TOPUP_WEI.toString(), gas_topup_tx_hash: txHash, status: "sent", failure_reason: "gas top-up for ERC20 sweep", created_at: t, updated_at: t });
          log(`gas top-up for user=${w.user_id} ${asset} sweep tx=${txHash}`);
        }
        continue;
      }
      const nonce = await chains.evmNonce(w.evm_address);
      const built = await buildSignedErc20Transaction({ privateKey: keys.evmPrivateKey, asset, to: treasury.evm_address, amountRaw: tokenBalance.toString(), nonce, gas: 80000n, gasPriceWei: gasPrice });
      const row = await recordSweep({ source_user_id: w.user_id, chain: "ethereum", asset, from_address: w.evm_address, to_address: treasury.evm_address, amount_raw: tokenBalance.toString(), status: "prepared", created_at: t, updated_at: t });
      const txHash = await chains.evmBroadcast(built.raw);
      if (row) await db.patch(`ex_sweeps?id=eq.${row.id}`, { tx_hash: txHash, status: "sent", updated_at: nowSeconds() });
      log(`swept ${asset} user=${w.user_id} raw=${tokenBalance} tx=${txHash}`);
      ethBalance = await chains.evmNativeBalance(w.evm_address);
    }
    // Native ETH sweep (after token sweeps, so gas accounting stays sane).
    ethBalance = await chains.evmNativeBalance(w.evm_address);
    if (ethBalance >= SWEEP_MIN_ETH_WEI) {
      const gasCost = 21000n * gasPrice * 13n / 10n;
      const amount = ethBalance - gasCost;
      if (amount > 0n) {
        const nonce = await chains.evmNonce(w.evm_address);
        const built = await buildSignedEvmTransaction({ privateKey: keys.evmPrivateKey, to: treasury.evm_address, valueWei: amount, nonce, gas: 21000n, gasPriceWei: gasPrice });
        const row = await recordSweep({ source_user_id: w.user_id, chain: "ethereum", asset: "ETH", from_address: w.evm_address, to_address: treasury.evm_address, amount_raw: amount.toString(), status: "prepared", created_at: t, updated_at: t });
        const txHash = await chains.evmBroadcast(built.raw);
        if (row) await db.patch(`ex_sweeps?id=eq.${row.id}`, { tx_hash: txHash, status: "sent", updated_at: nowSeconds() });
        log(`swept ETH user=${w.user_id} wei=${amount} tx=${txHash}`);
      }
    }
  } catch (e) { errLog(`EVM sweep user=${w.user_id} failed:`, e.message); }
}

async function confirmSweeps() {
  const rows = await db.list("ex_sweeps?status=eq.sent&select=*&limit=30");
  for (const s of rows || []) {
    try {
      let confirmed = false;
      if (s.chain === "bitcoin") {
        const st = await chains.btcTxStatus(s.tx_hash);
        confirmed = st.confirmed && st.confirmations >= 1;
      } else {
        const rc = await chains.evmReceiptConfirmations(s.tx_hash);
        confirmed = rc.found && rc.success && rc.confirmations >= 1;
      }
      if (confirmed) await db.patch(`ex_sweeps?id=eq.${s.id}`, { status: "confirmed", confirmed_at: nowSeconds(), updated_at: nowSeconds() });
    } catch (e) { errLog(`sweep ${s.id} confirm check failed:`, e.message); }
  }
}

// ---------------- main loop ----------------
async function cycle() {
  const started = Date.now();
  heartbeat({ phase: "start" });
  try {
    const { users, treasury } = await loadWallets();
    if (!treasury) { errLog("no treasury wallet configured; skipping cycle"); return; }
    const sweepRows = await db.list("ex_sweeps?status=in.(prepared,sent)&select=tx_hash").catch(() => []);
    const sweepTxHashes = new Set((sweepRows || []).map((r) => r.tx_hash).filter(Boolean));
    await scanBtc(users, sweepTxHashes).catch((e) => errLog("BTC scan failed:", e.message));
    heartbeat({ phase: "btc-scanned" });
    await scanEvm(users).catch((e) => errLog("EVM scan failed:", e.message));
    heartbeat({ phase: "evm-scanned" });
    await recheckConfirming().catch((e) => errLog("recheck failed:", e.message));
    await executePayouts(treasury).catch((e) => errLog("payout execution failed:", e.message));
    await confirmPayouts().catch((e) => errLog("payout confirm failed:", e.message));
    for (const w of users) await sweepUser(w, treasury).catch((e) => errLog(`sweep user=${w.user_id} failed:`, e.message));
    await confirmSweeps().catch((e) => errLog("sweep confirm failed:", e.message));
    heartbeat({ cycle_ms: Date.now() - started, users: users.length });
  } catch (e) {
    errLog("cycle failed:", e.message);
    heartbeat({ error: String(e.message).slice(0, 200) });
  }
}

log(`exchange-walletd starting (cycle ${CYCLE_MS}ms)`);
await cycle();
setInterval(cycle, CYCLE_MS);
