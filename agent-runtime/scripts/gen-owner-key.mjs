#!/usr/bin/env node
// Owner tool: generate YOUR owner Ed25519 keypair for this install.
//   node scripts/gen-owner-key.mjs <owner-key.json>
// The public key is what you pin in the runtime config (owner_pubkey_b64)
// and what the daemon verifies config signatures and release manifests
// against. The private key signs them (scripts/sign-config.mjs) — keep it
// private; anyone holding it controls the install's settings and updates.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const [keyPath] = process.argv.slice(2);
if (!keyPath) { console.error("usage: gen-owner-key.mjs <owner-key.json>"); process.exit(1); }
if (existsSync(keyPath)) { console.error(`refusing to overwrite existing key file: ${keyPath}`); process.exit(1); }
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
writeFileSync(keyPath, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 1), { mode: 0o600 });
console.log(`owner key written to ${keyPath} (mode 600 — keep the private key secret)`);
console.log(`owner public key — pin this in your config as "owner_pubkey_b64":\n${pub}`);
