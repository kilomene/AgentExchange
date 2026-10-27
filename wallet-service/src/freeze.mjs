// WALLET FREEZE — execution-time re-check (admin tool, 2026-10-27).
//
// Creating a payout is refused for a frozen wallet in the API, but a
// payout created BEFORE the freeze must also never broadcast while
// the freeze stands: the freeze blocks money leaving — "not a single
// penny". The payout HOLDS instead: no send, no fake failure, the
// execution status is left exactly as it was (approved /
// awaiting_funds) so the payout can proceed after unfreeze if it is
// otherwise still valid. Only the row's failure_reason notes the
// hold, and only when it changes (no write churn every cycle).
// Deposits and inbound money are untouched by this module — the
// freeze blocks only money leaving via payout/withdrawal.

export const FREEZE_HOLD_REASON = "held: wallet frozen by admin";

export async function isWalletFrozen(db, userId) {
  const rows = await db.list(`ex_users?id=eq.${userId}&select=wallet_frozen`);
  return !!(rows && rows[0] && rows[0].wallet_frozen);
}

// "hold" = do not execute this payout in this cycle.
export async function payoutExecutionDecision(db, payout) {
  if (!payout || payout.user_id === undefined || payout.user_id === null) return "execute";
  return (await isWalletFrozen(db, payout.user_id)) ? "hold" : "execute";
}
