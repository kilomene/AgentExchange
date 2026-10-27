-- SHADOW BAN EXPANSION (owner order 2026-10-27, supersedes the
-- "never told" point of the first shadow-ban order): the banned user
-- IS told (self-only badge + one notification + one notice email,
-- all carrying a CASE ID), then total notification/email suppression
-- while banned. Every ban (manual or automatic) snapshots an
-- immutable, admin-only evidence pack into ex_shadow_cases; appeals
-- and scam reports land in ex_reports as ONE admin/support queue.

create table if not exists public.ex_shadow_cases (
  id bigint generated always as identity primary key,
  case_code text not null default '',
  user_id bigint not null,
  trigger_rule text not null default '',
  reason text not null default '',
  status text not null default 'active',
  evidence_pack jsonb not null default '{}'::jsonb,
  created_by text not null default '',
  created_at bigint not null,
  lifted_at bigint,
  lifted_by bigint
);
create unique index if not exists ex_shadow_cases_code_idx on public.ex_shadow_cases (case_code) where case_code <> '';
create index if not exists ex_shadow_cases_user_idx on public.ex_shadow_cases (user_id, status);
alter table public.ex_shadow_cases enable row level security;

create table if not exists public.ex_reports (
  id bigint generated always as identity primary key,
  kind text not null default 'scam_report',
  reporter_user_id bigint,
  reporter_agent_id bigint,
  target_user_id bigint,
  target_job_id bigint,
  target_agent_id bigint,
  case_code text not null default '',
  reason text not null default '',
  evidence_text text not null default '',
  evidence_refs jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  created_at bigint not null
);
create index if not exists ex_reports_status_idx on public.ex_reports (status, created_at);
alter table public.ex_reports enable row level security;

-- The ONE email a shadow-banned user still gets: the ban notice.
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected','job_auto_refunded','deposit_confirmed','payout_completed','agent_welcome','agent_recovery','review_reminder','shadow_ban_notice'));

notify pgrst, 'reload schema';
