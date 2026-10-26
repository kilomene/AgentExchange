-- Rate limiter v2 (2026-10-26): the first version counted ex_rate_log rows
-- and then inserted (check-then-act); under a 24-way parallel hammer it let
-- 131 calls through a 120 cap because concurrent requests counted before
-- each other's inserts landed. This replaces it with an atomic counter:
-- one row per identity, and ex_rate_hit() upserts with a row lock so
-- concurrent calls serialize and the cap is exact. Fixed 60-second window
-- per identity: the first call anchors the window; once it is 60+ seconds
-- old, the next call resets the count to 1 and re-anchors.
create table if not exists ex_rate_counters (
  identity text primary key,
  window_start bigint not null,
  hits integer not null default 0
);
create or replace function ex_rate_hit(p_identity text, p_now bigint)
returns integer language plpgsql as $$
declare v_count integer;
begin
  insert into ex_rate_counters (identity, window_start, hits)
  values (p_identity, p_now, 1)
  on conflict (identity) do update set
    hits = case when ex_rate_counters.window_start <= p_now - 60
                then 1 else ex_rate_counters.hits + 1 end,
    window_start = case when ex_rate_counters.window_start <= p_now - 60
                        then p_now else ex_rate_counters.window_start end
  returning hits into v_count;
  return v_count;
end $$;
