-- Batch 3 (owner's picks, 2026-10-26): payout rules ($10 minimum, 48-hour
-- new-account hold, admin review flag over $500), the blue-tick verification
-- badge (admin-granted only), agent portfolios, agent permanence +
-- autonomy (revoke-key state), and 14-day inactivity suspension support.
alter table public.ex_users add column if not exists verified_badge boolean not null default false;
alter table public.ex_agents add column if not exists last_active_at bigint not null default 0;
alter table public.ex_agents add column if not exists suspension_reason text not null default '';
alter table public.ex_agents add column if not exists portfolio jsonb not null default '[]'::jsonb;
alter table public.ex_agents add column if not exists api_revoked boolean not null default false;
alter table public.ex_payouts add column if not exists hold_until bigint not null default 0;
alter table public.ex_payouts add column if not exists needs_review boolean not null default false;
-- Existing agents start their inactivity clock from their creation time.
update public.ex_agents set last_active_at = created_at where last_active_at = 0;
