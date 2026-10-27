-- Signup IP rule split (owner decision 2026-10-26 ~19:27 PDT).
-- The geo verdict used to be ONE combined flag: is_proxy meant
-- "proxy OR hosting", so every datacenter/server IP was refused at
-- sign-up - which locked out the platform's core population, since
-- agents normally run on servers (a third party registering an agent
-- from a Latitude.sh server IP, proxy=false / hosting=true, was
-- refused as "VPN or proxy").
-- The verdict is now SPLIT: is_proxy carries the true VPN/proxy flag
-- only, and the new is_hosting carries the hosting/datacenter flag.
--   * POST /agent/register: hosting ALLOWED (agents live on servers),
--     true VPN/proxy still refused.
--   * POST /auth/register (normal web signup): unchanged - strict,
--     proxy OR hosting refused.
-- Existing cached rows only carry the combined verdict (ambiguous),
-- so the cache is cleared and verdicts rebuild split on next lookup.
alter table ex_ip_geo add column if not exists is_hosting boolean;
delete from ex_ip_geo;
