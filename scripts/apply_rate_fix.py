#!/usr/bin/env python3
"""Rate limiter v2: swap the count-then-insert check (which let 131 calls
through a 120 cap under a 24-way parallel hammer in the live probe) for
the atomic ex_rate_hit() counter RPC (migration 20261026000500). Every
call counts - including rejected ones - so hammering keeps the caller
locked out until the fixed 60-second window resets. Fail-open on
infrastructure errors stays. Exact-string replacement, asserted.
"""
from pathlib import Path

IDX = Path(__file__).resolve().parent.parent / "supabase/functions/exchange-api/index.ts"
src = IDX.read_text()

old_comment = """// RATE LIMIT (owner's rule #1, 2026-10-26): at most 120 authenticated API
// calls per minute per key - per user account on the web surface, per agent
// on the agent surface. Counted from ex_rate_log over a rolling 60-second
// window; going over returns 429 and the rejected call is not counted. The
// limiter fails OPEN on infrastructure errors (a broken counter must never
// take the site down) and CLOSED only on a real breach."""
new_comment = """// RATE LIMIT (owner's rule #1, 2026-10-26): at most 120 authenticated API
// calls per minute per key - per user account on the web surface, per agent
// on the agent surface. Counted by the atomic ex_rate_hit() RPC over a
// fixed 60-second window per identity (row-locked upsert, so the cap is
// exact even under parallel hammering); going over returns 429. Every call
// counts, including rejected ones. The limiter fails OPEN on
// infrastructure errors (a broken counter must never take the site down)
// and CLOSED only on a real breach."""
assert src.count(old_comment) == 1, f"comment anchor: {src.count(old_comment)}"
src = src.replace(old_comment, new_comment)

old_fn = """async function rateLimit(identity: string) {
  const t = now();
  try {
    const recent = await pg(`ex_rate_log?identity=eq.${q(identity)}&created_at=gt.${t - 60}&select=id&order=id.desc&limit=${RATE_LIMIT_PER_MIN + 1}`);
    if (recent.length >= RATE_LIMIT_PER_MIN) throw Object.assign(new Error(`rate limit reached: at most ${RATE_LIMIT_PER_MIN} API calls per minute per key. Slow down and retry in a few seconds.`), { status: 429 });
    await pg("ex_rate_log", { method: "POST", body: JSON.stringify({ identity, created_at: t }) });
  } catch (e: any) {
    if (e && e.status === 429) throw e;
    console.error("rate limiter error (failing open)", identity, e);
  }
  // Opportunistic cleanup so the log stays tiny.
  await pg(`ex_rate_log?identity=eq.${q(identity)}&created_at=lt.${t - 600}`, { method: "DELETE" }).catch(() => null);
}"""
new_fn = """async function rateLimit(identity: string) {
  try {
    const res: any = await rpc("ex_rate_hit", { p_identity: identity, p_now: now() });
    const hits = typeof res === "number" ? res : Number(res?.ex_rate_hit ?? (Array.isArray(res) ? res[0]?.ex_rate_hit : 0) ?? 0);
    if (hits > RATE_LIMIT_PER_MIN) throw Object.assign(new Error(`rate limit reached: at most ${RATE_LIMIT_PER_MIN} API calls per minute per key. Slow down and retry in a few seconds.`), { status: 429 });
  } catch (e: any) {
    if (e && e.status === 429) throw e;
    console.error("rate limiter error (failing open)", identity, e);
  }
}"""
assert src.count(old_fn) == 1, f"fn anchor: {src.count(old_fn)}"
src = src.replace(old_fn, new_fn)
IDX.write_text(src)
print("rate limiter v2 patched OK")
