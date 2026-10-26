-- Fix-everything backend batch (2026-10-26): escrow held-guards, atomic
-- guarantee-pool adjust, account strikes, and the two new mail kinds.

-- Account-level strikes (poster strikes mirror the agent strike system).
alter table public.ex_users add column if not exists strikes int not null default 0;

-- ESCROW INVARIANT: held escrow can never go negative. Releasing or
-- refunding more than is held raises instead of corrupting the wallet.
create or replace function ex_release_escrow(p_poster bigint, p_seller bigint, p_price bigint, p_fee bigint, p_ref text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  if coalesce((select held_cents from ex_wallets where user_id = p_poster), 0) < p_price then raise exception 'insufficient held escrow'; end if;
  update ex_wallets set held_cents = held_cents - p_price where user_id = p_poster;
  select balance_cents into v_bal from ex_wallets where user_id = p_poster;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_poster, 'escrow_release', 0, v_bal, p_ref, 'Escrow released on completion', p_now);
  update ex_wallets set balance_cents = balance_cents + (p_price - p_fee) where user_id = p_seller;
  select balance_cents into v_bal from ex_wallets where user_id = p_seller;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_seller, 'earning', p_price - p_fee, v_bal, p_ref, 'Earning (after platform fee)', p_now);
end $$;

create or replace function ex_refund_escrow(p_poster bigint, p_price bigint, p_ref text, p_note text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  if coalesce((select held_cents from ex_wallets where user_id = p_poster), 0) < p_price then raise exception 'insufficient held escrow'; end if;
  update ex_wallets set held_cents = held_cents - p_price, balance_cents = balance_cents + p_price where user_id = p_poster;
  select balance_cents into v_bal from ex_wallets where user_id = p_poster;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_poster, 'refund', p_price, v_bal, p_ref, p_note, p_now);
end $$;

-- ATOMIC POOL ADJUST: row-locked read-modify-write of the guarantee pool.
-- A negative delta larger than the pool raises 'pool insufficient'.
create or replace function ex_pool_adjust(p_delta bigint)
returns bigint language plpgsql as $$
declare v_cur bigint;
begin
  insert into ex_settings (key, value) values ('guarantee_pool_cents', '0')
  on conflict (key) do nothing;
  select value::bigint into v_cur from ex_settings where key = 'guarantee_pool_cents' for update;
  if p_delta < 0 and -p_delta > v_cur then raise exception 'pool insufficient'; end if;
  update ex_settings set value = (v_cur + p_delta)::text where key = 'guarantee_pool_cents';
  return v_cur + p_delta;
end $$;

-- New lifecycle mail kinds: deposit confirmed + payout completed.
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected','job_auto_refunded','deposit_confirmed','payout_completed'));
