// Backfill real mainnet chain wallets for every existing user that lacks
// one, plus the single treasury wallet. Idempotent: existing wallets are
// never touched (their encrypted seeds must stay paired with the master
// key they were created under).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WALLET_MASTER_KEY or
// WALLET_MASTER_KEY_FILE (see src/supabase.mjs loadConfig).

import { createEncryptedWallet } from "../../supabase/functions/_shared/wallet.mjs";
import { SupabaseAdmin, nowSeconds } from "../src/supabase.mjs";

const db = new SupabaseAdmin();
const users = await db.list("ex_users?select=id,email&order=id");
const existing = await db.list("ex_user_wallets?select=user_id");
const have = new Set((existing || []).map((w) => w.user_id));
let created = 0;
for (const user of users || []) {
  if (have.has(user.id)) {
    console.log(`user ${user.id} (${user.email}): wallet already exists, skipped`);
    continue;
  }
  const wallet = createEncryptedWallet(db.masterKey);
  const t = nowSeconds();
  await db.insert("ex_user_wallets", {
    user_id: user.id,
    seed_ciphertext: wallet.seed_ciphertext,
    seed_nonce: wallet.seed_nonce,
    btc_address: wallet.btc_address,
    evm_address: wallet.evm_address,
    created_at: t,
    updated_at: t,
  });
  created++;
  console.log(`user ${user.id} (${user.email}): wallet created btc=${wallet.btc_address} evm=${wallet.evm_address}`);
}

const treasuryRows = await db.list("ex_treasury?select=id,btc_address,evm_address");
if (treasuryRows && treasuryRows.length) {
  console.log(`treasury: already exists btc=${treasuryRows[0].btc_address} evm=${treasuryRows[0].evm_address}`);
} else {
  const wallet = createEncryptedWallet(db.masterKey);
  const t = nowSeconds();
  await db.insert("ex_treasury", {
    id: 1,
    seed_ciphertext: wallet.seed_ciphertext,
    seed_nonce: wallet.seed_nonce,
    btc_address: wallet.btc_address,
    evm_address: wallet.evm_address,
    created_at: t,
    updated_at: t,
  });
  console.log(`treasury: created btc=${wallet.btc_address} evm=${wallet.evm_address}`);
}
console.log(`backfill complete: ${created} user wallet(s) created, ${(users || []).length} user(s) total`);
