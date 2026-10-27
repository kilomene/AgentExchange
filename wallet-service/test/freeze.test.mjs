// Wallet-freeze execution-guard logic test (no chain, no network).
// Proves the exact decision the walletd payout loop makes per payout:
// frozen owner -> HOLD (never broadcast); unfrozen -> EXECUTE.
// Run: node wallet-service/test/freeze.test.mjs
import assert from "node:assert";
import { isWalletFrozen, payoutExecutionDecision, FREEZE_HOLD_REASON } from "../src/freeze.mjs";

// Stub of the SupabaseAdmin list() surface the freeze module uses.
function stubDb(users) {
  return {
    async list(query) {
      const m = String(query).match(/^ex_users\?id=eq\.(\d+)&select=wallet_frozen$/);
      assert.ok(m, `unexpected query shape: ${query}`);
      const u = users[Number(m[1])];
      return u ? [{ wallet_frozen: !!u.wallet_frozen }] : [];
    },
  };
}

const db = stubDb({
  41: { wallet_frozen: true },
  42: { wallet_frozen: false },
});

assert.equal(await isWalletFrozen(db, 41), true, "frozen user reads frozen");
assert.equal(await isWalletFrozen(db, 42), false, "unfrozen user reads unfrozen");
assert.equal(await isWalletFrozen(db, 999), false, "unknown user is not frozen");

assert.equal(await payoutExecutionDecision(db, { id: 1, user_id: 41 }), "hold", "payout of a frozen wallet must HOLD");
assert.equal(await payoutExecutionDecision(db, { id: 2, user_id: 42 }), "execute", "payout of an unfrozen wallet executes");
assert.equal(await payoutExecutionDecision(db, { id: 3, user_id: 999 }), "execute", "unknown owner executes (no phantom freeze)");

// Simulate the executePayouts loop guard exactly as wired in
// service.mjs: broadcast is only reachable past the freeze check.
const broadcasts = [];
async function fakeLoop(payouts) {
  for (const p of payouts) {
    if ((await payoutExecutionDecision(db, p)) === "hold") {
      p.failure_reason = FREEZE_HOLD_REASON; // hold note only; status untouched
      continue;
    }
    broadcasts.push(p.id);
  }
}
const preFreezePayout = { id: 7, user_id: 41, execution_status: "approved", failure_reason: "" };
const normalPayout = { id: 8, user_id: 42, execution_status: "approved", failure_reason: "" };
await fakeLoop([preFreezePayout, normalPayout]);
assert.deepEqual(broadcasts, [8], "the pre-freeze payout never broadcasts while frozen; the normal one does");
assert.equal(preFreezePayout.execution_status, "approved", "held payout keeps its execution status (no fake failure)");
assert.equal(preFreezePayout.failure_reason, FREEZE_HOLD_REASON, "held payout carries the honest hold reason");

// Unfreeze -> the same payout may proceed.
const db2 = stubDb({ 41: { wallet_frozen: false } });
assert.equal(await payoutExecutionDecision(db2, preFreezePayout), "execute", "after unfreeze the held payout can proceed");

console.log("freeze.test.mjs: ALL ASSERTIONS PASSED");
