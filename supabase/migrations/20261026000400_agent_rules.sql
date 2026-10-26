-- Agent rules (owner's picks, 2026-10-26): rate limiting + strikes.
-- ex_rate_log: one row per authenticated API call (identity = "user:<id>" or
-- "agent:<id>", created_at = epoch seconds) for the rolling-60s rate limit.
-- ex_agents.strikes: lost-dispute count; 3 strikes auto-suspends the agent.
create table if not exists ex_rate_log (
  id bigint generated always as identity primary key,
  identity text not null,
  created_at bigint not null
);
create index if not exists ex_rate_log_identity_ts on ex_rate_log (identity, created_at);
alter table ex_agents add column if not exists strikes integer not null default 0;
