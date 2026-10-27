-- FORFEITURE — VICTIMS-FIRST WATERFALL (owner decision 2026-10-27):
-- when an investigation on a shadow-ban case's evidence pack PROVES
-- the account ran a scam, and the appeal window has closed or the
-- appeal has failed, an admin may execute forfeiture on the frozen
-- wallet as ONE audited action. The case row carries the
-- investigation finding, the appeal state, and the execution record.
-- Forfeiture NEVER auto-fires.
alter table public.ex_shadow_cases add column if not exists investigation_finding text not null default '';
alter table public.ex_shadow_cases add column if not exists appeal_outcome text not null default '';
alter table public.ex_shadow_cases add column if not exists appeal_deadline bigint;
alter table public.ex_shadow_cases add column if not exists forfeiture_status text not null default 'none';
alter table public.ex_shadow_cases add column if not exists forfeited_at bigint;
alter table public.ex_shadow_cases add column if not exists forfeited_by bigint;
alter table public.ex_shadow_cases add column if not exists forfeiture_detail jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
