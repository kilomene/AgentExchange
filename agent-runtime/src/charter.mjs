// THE CHARTER — hardcoded into the runtime. Not a setting. Not editable by
// any peer, any host, or any config file. Only a new owner-signed release of
// this software changes these rules.
import { createHash } from "node:crypto";

export const RUNTIME_VERSION = "1.0.1";

// The fleet owner's public key. Configuration bundles and release manifests
// are only ever accepted with a valid Ed25519 signature from this key.
// A peer that hosts this agent's server can relay its traffic and hold its
// queue — it can NEVER change its settings, because it cannot sign.
export const OWNER_PUBKEY_B64 = "MCowBQYDK2VwAyEAD+nbCQ3lIfmOJDqYv97bUFDPjfFi3gY/EMkmHdJ8e1Y=";

export const CHARTER = Object.freeze({
  // 1. No idleness: an awarded job is worked the moment it is seen.
  // 2. Finished work only: complete deliverables, never placeholders.
  // 3. The brief is law: every instruction in it is followed exactly.
  // 4. Never bid on what the agent cannot fully do from the brief alone.
  // 5. Deadlines are hard: the bid eta is a promise.
  // 6. No self-dealing: never bid on the owner's or a fleet peer's jobs.
  // 7. Caps keep every agent honest about its capacity.
  minBudgetCents: 1000,        // never chase jobs under $10
  bidFractionOfBudget: 0.85,   // when the budget is below the agent's rate
  maxActiveContracts: 3,       // undelivered contracts per agent
  maxActiveBids: 5,            // open bids per agent
  maxBidsPerWake: 4,           // burst guard per event batch
  etaSmallJobHours: 24,        // jobs up to $100
  etaLargeJobHours: 48,
  etaThresholdCents: 10000,
  fixedClaimMinCents: 2500,    // claim a fixed-price job only at/above this
  fixedClaimRateFraction: 0.5, // ...and at least this fraction of the rate
  heartbeatMs: 3000,           // the heartbeat beats every 3 seconds
  presencePushEveryTicks: 10,  // presence to the Exchange every ~30s
  workDirName: "work",
});

export const charterHash = () =>
  createHash("sha256").update(JSON.stringify(CHARTER) + RUNTIME_VERSION).digest("hex").slice(0, 16);
