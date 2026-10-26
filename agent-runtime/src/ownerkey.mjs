// OWNER TRUST ANCHOR — resolved per install.
//
// Releases and configs are accepted only with a valid Ed25519 signature
// from the OWNER's key. Whose key that is depends on the install:
// a third-party agent's owner signs with THEIR key, not the fleet's.
// The anchor for an install resolves, in order:
//   1. the EXCHANGE_OWNER_PUBKEY environment variable
//   2. "owner_pubkey_b64" inside the config itself (covered by the
//      config signature, and the value the local install was set up with)
//   3. a sibling file "config.owner_pubkey" next to the config
//   4. the compiled-in fleet key (charter.mjs) — back-compat default for
//      the original fleet install, which predates per-install pinning.
// Signature verification is mandatory in every path: an unsigned config
// or manifest is never accepted.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_PUBKEY_B64 as FLEET_OWNER_PUBKEY_B64 } from "./charter.mjs";
import { verifyObj } from "./sign.mjs";

export function resolveOwnerPubkey(config, configPath) {
  const env = process.env.EXCHANGE_OWNER_PUBKEY;
  if (env && env.trim()) return { pubkey: env.trim(), source: "env EXCHANGE_OWNER_PUBKEY" };
  if (config?.owner_pubkey_b64) return { pubkey: String(config.owner_pubkey_b64), source: "config owner_pubkey_b64" };
  if (configPath) {
    const p = join(dirname(configPath), "config.owner_pubkey");
    try {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").trim();
        if (v) return { pubkey: v, source: "config.owner_pubkey file" };
      }
    } catch { /* fall through to the default */ }
  }
  return { pubkey: FLEET_OWNER_PUBKEY_B64, source: "compiled-in fleet key (default)" };
}

// Verify a config bundle against this install's owner anchor.
// Returns { ok, pubkey, source } or { ok: false, reason, pubkey, source }.
export function verifyConfigSignature(cfg, configPath) {
  const anchor = resolveOwnerPubkey(cfg, configPath);
  if (!cfg.sig) {
    return { ok: false, reason: "config is unsigned — sign it with scripts/sign-config.mjs", ...anchor };
  }
  const { sig, ...rest } = cfg;
  if (!verifyObj(anchor.pubkey, rest, sig)) {
    return { ok: false, reason: `config signature does not verify against the owner key (${anchor.source})`, ...anchor };
  }
  return { ok: true, ...anchor };
}
