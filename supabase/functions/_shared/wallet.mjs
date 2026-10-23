// Shared wallet core for the Agent Exchange.
//
// This module is used by the Deno Edge Function (wallet creation) and by the
// Node wallet service (backfill, sweeps and payouts). It derives exactly one
// BIP39 seed per wallet:
//   BTC:  m/84'/0'/0'/0/0  (BIP84 native SegWit, bc1q...)
//   EVM:  m/44'/60'/0'/0/0  (same address for ETH, USDT-ERC20 and USDC-ERC20)
//
// Seed material is encrypted with AES-256-GCM. The caller supplies the master
// key from a secret store; this module never logs or returns key material
// except to the immediate in-memory caller that explicitly asks to decrypt.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { gcm } from "@noble/ciphers/aes.js";

export const BTC_DERIVATION_PATH = "m/84'/0'/0'/0/0";
export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const AAD = new TextEncoder().encode("agent-exchange-wallet-v1");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(String(value).trim());
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("invalid hex");
  return Uint8Array.from(clean.match(/.{2}/g) || [], (h) => parseInt(h, 16));
}
export function parseMasterKey(value) {
  if (!value) throw new Error("WALLET_MASTER_KEY is not configured");
  let key;
  try { key = base64ToBytes(value); } catch { key = new Uint8Array(); }
  if (key.length !== 32) {
    try { key = hexToBytes(value); } catch { key = new Uint8Array(); }
  }
  if (key.length !== 32) throw new Error("WALLET_MASTER_KEY must be 32 bytes (base64 or hex)");
  return key;
}
export function randomMasterKeyBase64() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function rootFromMnemonic(mnemonic) {
  const phrase = String(mnemonic || "").trim().replace(/\s+/g, " ");
  if (!validateMnemonic(phrase, wordlist)) throw new Error("invalid BIP39 mnemonic");
  return { phrase, root: HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)) };
}
export function evmAddressFromPublicKey(compressedPublicKey) {
  const uncompressed = secp256k1.Point.fromBytes(compressedPublicKey).toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return toEvmChecksumAddress(bytesToHex(hash.slice(-20)));
}
export function toEvmChecksumAddress(address) {
  const lower = String(address).replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("invalid EVM address");
  const hash = bytesToHex(keccak_256(textEncoder.encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}
export function isValidEvmAddress(address) {
  try {
    const value = String(address || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
    // All-lower and all-upper are accepted as unchecksummed; mixed case must
    // match EIP-55 exactly.
    if (value === value.toLowerCase() || value === value.toUpperCase().replace("0X", "0x")) return true;
    return toEvmChecksumAddress(value) === value;
  } catch { return false; }
}
export function isValidBtcAddress(address) {
  try {
    btc.Address(btc.NETWORK).decode(String(address || ""));
    return true;
  } catch { return false; }
}
export function deriveAddresses(mnemonic) {
  const { root } = rootFromMnemonic(mnemonic);
  const btcChild = root.derive(BTC_DERIVATION_PATH);
  const evmChild = root.derive(EVM_DERIVATION_PATH);
  if (!btcChild.publicKey || !evmChild.publicKey) throw new Error("wallet derivation failed");
  return {
    btc_address: btc.p2wpkh(btcChild.publicKey, btc.NETWORK).address,
    evm_address: evmAddressFromPublicKey(evmChild.publicKey),
  };
}
export function generateMnemonicPhrase() {
  return generateMnemonic(wordlist, 256);
}
export function encryptSeed(mnemonic, masterKeyValue) {
  const { phrase } = rootFromMnemonic(mnemonic);
  const key = parseMasterKey(masterKeyValue);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = gcm(key, nonce, AAD).encrypt(textEncoder.encode(phrase));
  return { seed_ciphertext: bytesToBase64(ciphertext), seed_nonce: bytesToBase64(nonce) };
}
export function decryptSeed(record, masterKeyValue) {
  const key = parseMasterKey(masterKeyValue);
  const nonce = base64ToBytes(record.seed_nonce);
  const ciphertext = base64ToBytes(record.seed_ciphertext);
  if (nonce.length !== 12) throw new Error("invalid wallet nonce");
  const plain = gcm(key, nonce, AAD).decrypt(ciphertext);
  const phrase = textDecoder.decode(plain);
  rootFromMnemonic(phrase); // throws if the decrypted payload is not a wallet seed
  return phrase;
}
export function createEncryptedWallet(masterKeyValue) {
  const mnemonic = generateMnemonicPhrase();
  const encrypted = encryptSeed(mnemonic, masterKeyValue);
  const addresses = deriveAddresses(mnemonic);
  return { ...encrypted, ...addresses };
}
export function derivePrivateKeys(mnemonic) {
  const { root } = rootFromMnemonic(mnemonic);
  const btcChild = root.derive(BTC_DERIVATION_PATH);
  const evmChild = root.derive(EVM_DERIVATION_PATH);
  if (!btcChild.privateKey || !evmChild.privateKey) throw new Error("wallet private derivation failed");
  return {
    btcPrivateKey: new Uint8Array(btcChild.privateKey),
    btcPublicKey: new Uint8Array(btcChild.publicKey),
    evmPrivateKey: `0x${bytesToHex(evmChild.privateKey)}`,
    evmAddress: evmAddressFromPublicKey(evmChild.publicKey),
    btcAddress: btc.p2wpkh(btcChild.publicKey, btc.NETWORK).address,
  };
}
