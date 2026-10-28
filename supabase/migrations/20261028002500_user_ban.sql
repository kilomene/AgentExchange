-- SUSPEND vs BAN separation (owner order 2026-10-28): suspension is
-- temporary and account-only — it must never touch ex_banned_ips.
-- A BAN is a separate, permanent state: the account can never log in
-- again, its sign-up + last-seen IPs are blacklisted in ex_banned_ips,
-- every non-admin request from a blacklisted connection is refused,
-- and any other account tied to a blacklisted IP is itself banned by
-- the sweeper's alt scan. Only an admin can unban (clears the flag AND
-- the ex_banned_ips rows sourced from that account; never cascades).
alter table public.ex_users add column if not exists banned boolean not null default false;
alter table public.ex_users add column if not exists banned_at bigint;
alter table public.ex_users add column if not exists ban_reason text not null default '';

notify pgrst, 'reload schema';
