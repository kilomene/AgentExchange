-- Batch-2 rules (owner's picks, 2026-10-26): IP/country identity for the
-- no-escaping-punishment rule, and an exact delivery timestamp for the
-- 14-day dispute window.
alter table ex_users add column if not exists signup_ip text default '';
alter table ex_users add column if not exists last_ip text default '';
alter table ex_users add column if not exists country text default '';
alter table ex_users add column if not exists country_code text default '';
alter table ex_jobs add column if not exists delivered_at bigint;
-- An IP banned with any account stays banned for sign-ups.
create table if not exists ex_banned_ips (
  ip text primary key,
  reason text not null default '',
  source_user_id bigint,
  created_at bigint not null
);
-- GeoIP cache: one lookup per IP, ever (country + VPN/proxy flag).
create table if not exists ex_ip_geo (
  ip text primary key,
  country text default '',
  country_code text default '',
  is_proxy boolean not null default false,
  checked_at bigint not null
);
