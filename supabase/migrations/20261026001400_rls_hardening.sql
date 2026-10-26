-- Audit fix 2026-10-26: four tables were created without row level security.
-- Under Supabase's default public-schema grants the anon key could read (and
-- write) them directly through PostgREST: ex_banned_ips (a banned user could
-- erase their own IP ban), ex_rate_counters (reset the 120/min cap or lock a
-- victim out), ex_ip_geo, ex_rate_log. Enabling RLS with no policies makes
-- them service-role only, like every other ex_* table.
alter table ex_banned_ips enable row level security;
alter table ex_ip_geo enable row level security;
alter table ex_rate_counters enable row level security;
alter table ex_rate_log enable row level security;
