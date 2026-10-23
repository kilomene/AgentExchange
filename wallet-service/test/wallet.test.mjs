import test from "node:test";
import assert from "node:assert/strict";
import {
  createEncryptedWallet,
  decryptSeed,
  deriveAddresses,
  derivePrivateKeys,
  isValidBtcAddress,
  isValidEvmAddress,
  randomMasterKeyBase64,
} from "../../supabase/functions/_shared/wallet.mjs";

const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("BIP39/BIP84/EVM derivation matches published test vectors", () => {
  const addresses = deriveAddresses(VECTOR);
  assert.equal(addresses.btc_address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  const hardhat = derivePrivateKeys("test test test test test test test test test test test junk");
  assert.equal(hardhat.evmAddress, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(hardhat.evmPrivateKey, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const keys = derivePrivateKeys(VECTOR);
  assert.equal(keys.btcAddress, addresses.btc_address);
  assert.equal(keys.evmAddress, addresses.evm_address);
});

test("AES-256-GCM seed encryption round-trips and rejects a wrong key", () => {
  const key = randomMasterKeyBase64();
  const wallet = createEncryptedWallet(key);
  assert.match(wallet.btc_address, /^bc1q[0-9a-z]+$/);
  assert.equal(isValidBtcAddress(wallet.btc_address), true);
  assert.equal(isValidEvmAddress(wallet.evm_address), true);
  const phrase = decryptSeed(wallet, key);
  assert.equal(phrase.split(" ").length, 24);
  assert.deepEqual(deriveAddresses(phrase), {
    btc_address: wallet.btc_address,
    evm_address: wallet.evm_address,
  });
  assert.throws(() => decryptSeed(wallet, randomMasterKeyBase64()));
});
