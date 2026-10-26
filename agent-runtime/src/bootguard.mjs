// BOOT GUARD — an auto-update that cannot boot must not loop forever.
//
// The updater keeps the previous version at "<app>.prev-<version>" but
// until now nothing ever restored it. The guard tracks boot health in
// the vault (boot.json, outside the app dir so updates never touch it):
//   * every boot of a version that is not yet known-good counts as an
//     attempt;
//   * a version becomes known-good once the daemon has run 60s and
//     confirmed it can reach the Exchange API (markHealthy);
//   * on the MAX_UNPROVEN_BOOTS-th consecutive boot of an unproven
//     version, the .prev copy is restored, marked known-good, and the
//     caller exits so the service restarts into the restored version.
// The bad copy is kept at "<app>.bad-<version>" for inspection.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const MAX_UNPROVEN_BOOTS = 3;
export const HEALTHY_AFTER_MS = 60000;
const BOOT_FILE = "boot.json";

export function readBootState(vaultDir) {
  const p = join(vaultDir, BOOT_FILE);
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8"));
      return { knownGood: s.knownGood ?? null, current: s.current ?? null, attempts: s.attempts || 0, healthy: !!s.healthy };
    } catch { /* corrupt state: start fresh rather than refuse to boot */ }
  }
  return { knownGood: null, current: null, attempts: 0, healthy: false };
}

export function writeBootState(vaultDir, state) {
  const p = join(vaultDir, BOOT_FILE);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, p);
}

// Count this boot. Returns the updated state.
export function registerBoot(vaultDir, version) {
  const s = readBootState(vaultDir);
  if (s.knownGood === version) { s.current = version; s.attempts = 0; s.healthy = true; }
  else if (s.current === version) { s.attempts += 1; s.healthy = false; }
  else { s.current = version; s.attempts = 1; s.healthy = false; }
  writeBootState(vaultDir, s);
  return s;
}

// Pure decision: should this boot roll back to the previous version?
export function decideRollback(state, version, prevAvailable) {
  if (state.knownGood === version) return { action: "none", reason: "known-good" };
  if (state.current === version && state.attempts >= MAX_UNPROVEN_BOOTS) {
    if (!prevAvailable) return { action: "none", reason: "unproven but no .prev copy to restore" };
    return { action: "rollback", from: version };
  }
  return { action: "none", reason: "proving" };
}

// The newest "<app>.prev-<version>" sibling copy, if any.
export function findPrevCopy(appDir) {
  const parent = dirname(appDir);
  const prefix = `${basename(appDir)}.prev-`;
  let best = null;
  try {
    for (const name of readdirSync(parent)) {
      if (name.startsWith(prefix) && (!best || name > best.name)) {
        best = { dir: join(parent, name), version: name.slice(prefix.length), name };
      }
    }
  } catch { /* no readable parent — no prev copy */ }
  return best;
}

// Record a version as proven: it ran and reached the Exchange API.
export function markHealthy(vaultDir, version) {
  const s = readBootState(vaultDir);
  s.knownGood = version; s.current = version; s.attempts = 0; s.healthy = true;
  writeBootState(vaultDir, s);
  return s;
}

// Startup entry point: register this boot, decide, roll back if needed.
// Returns { rolledBack, state, decision, from?, to? }.
export function bootGuard(vaultDir, appDir, version, log = () => {}) {
  const state = registerBoot(vaultDir, version);
  const prev = findPrevCopy(appDir);
  const decision = decideRollback(state, version, !!prev);
  if (decision.action !== "rollback") return { rolledBack: false, state, decision };
  const bad = `${appDir}.bad-${version}`;
  rmSync(bad, { recursive: true, force: true });
  renameSync(appDir, bad);
  renameSync(prev.dir, appDir);
  const restored = { knownGood: prev.version, current: prev.version, attempts: 0, healthy: true };
  writeBootState(vaultDir, restored);
  log(`BOOT ROLLBACK: v${version} failed to prove healthy after ${state.attempts} boots — restored v${prev.version}; bad copy kept at ${bad}`);
  return { rolledBack: true, from: version, to: prev.version, state: restored, decision };
}
