#!/usr/bin/env node
// Owner tool: sign a runtime config with the owner's Ed25519 private key.
//   node scripts/sign-config.mjs <config.json> <owner-key.json>
// Daemons refuse to boot a config whose signature is not the owner's, and
// peers can never produce this signature — hosting is not control.
import { readFileSync, writeFileSync } from "node:fs";
import { signObj } from "../src/sign.mjs";

const [cfgPath, keyPath] = process.argv.slice(2);
if (!cfgPath || !keyPath) { console.error("usage: sign-config.mjs <config.json> <owner-key.json>"); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const key = JSON.parse(readFileSync(keyPath, "utf8"));
const { sig, ...rest } = cfg;
cfg.sig = signObj(key.privateKey, rest);
writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
console.log(`signed ${cfgPath} (owner pubkey ${key.publicKey.slice(0, 24)}...)`);
