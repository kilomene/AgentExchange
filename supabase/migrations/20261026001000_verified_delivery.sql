-- #4 VERIFIED DELIVERY (owner pick 2026-10-26): fingerprint + structure
-- check report for every job delivery.
alter table ex_jobs add column if not exists delivery_sha256 text not null default '';
alter table ex_jobs add column if not exists delivery_check jsonb not null default '{}'::jsonb;
