-- Real mainnet wallets for the Agent Exchange.
-- Seeds/private keys are never stored in plaintext. seed_ciphertext and
-- seed_nonce contain only AES-256-GCM material produced outside Postgres.
-- Every table in this migration is service-role only: RLS is enabled and no
-- anon/authenticated policies are created.

create table if not exists ex_user_wallets (
  user_id bigint primary key references ex_users(id) on delete cascade,
  seed_ciphertext text not null,
  seed_nonce text not null,
  btc_address text not null unique,
  evm_address text not null unique,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists idx_ex_user_wallets_btc on ex_user_wallets(btc_address);
create index if not exists idx_ex_user_wallets_evm on ex_user_wallets(evm_address);
alter table ex_user_wallets enable row level security;
revoke all on ex_user_wallets from anon, authenticated;
grant all on ex_user_wallets to service_role;

create table if not exists ex_treasury (
  id integer primary key default 1 check (id = 1),
  seed_ciphertext text not null,
  seed_nonce text not null,
  btc_address text not null unique,
  evm_address text not null unique,
  created_at bigint not null,
  updated_at bigint not null
);
alter table ex_treasury enable row level security;
revoke all on ex_treasury from anon, authenticated;
grant all on ex_treasury to service_role;

create table if not exists ex_chain_deposits (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id) on delete cascade,
  chain text not null check (chain in ('bitcoin', 'ethereum')),
  asset text not null check (asset in ('BTC', 'ETH', 'USDT', 'USDC')),
  address text not null,
  tx_hash text not null,
  log_index integer,
  block_height bigint,
  amount_raw text not null,
  amount_cents bigint not null default 0,
  usd_rate text,
  confirmations integer not null default 0,
  status text not null default 'detected' check (status in ('detected', 'confirming', 'credited', 'ignored')),
  credited_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists uq_ex_chain_deposits_tx
  on ex_chain_deposits(chain, tx_hash, coalesce(log_index, -1), address, asset);
create index if not exists idx_ex_chain_deposits_user on ex_chain_deposits(user_id, created_at desc);
create index if not exists idx_ex_chain_deposits_status on ex_chain_deposits(status, chain);
alter table ex_chain_deposits enable row level security;
revoke all on ex_chain_deposits from anon, authenticated;
grant all on ex_chain_deposits to service_role;

create table if not exists ex_chain_cursors (
  chain text primary key,
  last_block bigint not null,
  updated_at bigint not null
);
alter table ex_chain_cursors enable row level security;
revoke all on ex_chain_cursors from anon, authenticated;
grant all on ex_chain_cursors to service_role;

create table if not exists ex_sweeps (
  id bigint generated always as identity primary key,
  source_user_id bigint references ex_users(id) on delete set null,
  chain text not null check (chain in ('bitcoin', 'ethereum')),
  asset text not null check (asset in ('BTC', 'ETH', 'USDT', 'USDC')),
  from_address text not null,
  to_address text not null,
  amount_raw text not null,
  gas_topup_tx_hash text,
  tx_hash text unique,
  status text not null default 'prepared' check (status in ('prepared', 'sent', 'confirmed', 'failed', 'needs_review')),
  failure_reason text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  confirmed_at bigint
);
create index if not exists idx_ex_sweeps_source on ex_sweeps(source_user_id, asset, status);
alter table ex_sweeps enable row level security;
revoke all on ex_sweeps from anon, authenticated;
grant all on ex_sweeps to service_role;

alter table ex_payouts add column if not exists asset text not null default 'USDT';
alter table ex_payouts add column if not exists tx_hash text;
alter table ex_payouts add column if not exists asset_amount_raw text;
alter table ex_payouts add column if not exists usd_rate text;
alter table ex_payouts add column if not exists execution_status text not null default 'queued';
alter table ex_payouts add column if not exists failure_reason text not null default '';
alter table ex_payouts add column if not exists broadcast_at bigint;
alter table ex_payouts add column if not exists confirmed_at bigint;
create index if not exists idx_ex_payouts_execution on ex_payouts(status, execution_status, created_at);

-- Atomically record + credit a confirmed chain deposit exactly once. The
-- advisory transaction lock serializes watchers that observe the same tx.
create or replace function ex_credit_chain_deposit(
  p_user bigint,
  p_chain text,
  p_asset text,
  p_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_height bigint,
  p_amount_raw text,
  p_amount_cents bigint,
  p_usd_rate text,
  p_confirmations integer,
  p_now bigint
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'deposit amount must credit a positive cent value';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_chain || ':' || p_tx_hash || ':' || coalesce(p_log_index, -1)::text || ':' || p_address || ':' || p_asset, 0));

  select id, status into v_id, v_status
  from ex_chain_deposits
  where chain = p_chain and tx_hash = p_tx_hash
    and coalesce(log_index, -1) = coalesce(p_log_index, -1)
    and address = p_address and asset = p_asset;

  if found and v_status = 'credited' then
    return v_id;
  end if;

  if not found then
    insert into ex_chain_deposits (
      user_id, chain, asset, address, tx_hash, log_index, block_height,
      amount_raw, amount_cents, usd_rate, confirmations, status,
      credited_at, created_at, updated_at)
    values (
      p_user, p_chain, p_asset, p_address, p_tx_hash, p_log_index, p_block_height,
      p_amount_raw, p_amount_cents, p_usd_rate, p_confirmations, 'credited',
      p_now, p_now, p_now)
    returning id into v_id;
  else
    update ex_chain_deposits set
      block_height = p_block_height, amount_raw = p_amount_raw,
      amount_cents = p_amount_cents, usd_rate = p_usd_rate,
      confirmations = p_confirmations, status = 'credited',
      credited_at = p_now, updated_at = p_now
    where id = v_id;
  end if;

  perform ex_move_balance(
    p_user, p_amount_cents, 'deposit', 'chain:' || p_tx_hash,
    p_asset || ' deposit confirmed on ' || p_chain, p_now);

  insert into ex_deposits (
    user_id, amount_cents, method, asset, status, tx_ref, created_at, resolved_at)
  values (p_user, p_amount_cents, 'crypto', p_asset, 'credited', p_tx_hash, p_now, p_now);

  return v_id;
end $$;
revoke all on function ex_credit_chain_deposit(bigint, text, text, text, text, integer, bigint, text, bigint, text, integer, bigint) from anon, authenticated;
grant execute on function ex_credit_chain_deposit(bigint, text, text, text, text, integer, bigint, text, bigint, text, integer, bigint) to service_role;

-- The old shared/example deposit addresses are obsolete and unsafe to show.
delete from ex_settings where key = 'deposit_addresses';

notify pgrst, 'reload schema';
