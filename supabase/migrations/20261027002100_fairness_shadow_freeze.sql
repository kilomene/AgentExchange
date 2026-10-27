-- FAIRNESS LOCKED DESIGN + SHADOW BAN + WALLET FREEZE (owner orders,
-- 2026-10-27). Judgment moves to posting time: every job carries an
-- acceptance checklist that FREEZES at award; delivery starts a 48h
-- review clock; silence auto-releases through the completion path;
-- disputes are mechanical promised-vs-delivered checks against the
-- frozen checklist with a 48h evidence round and a +3 day admin
-- deadline that defaults FOR THE WORKER. Shadow ban (admin only,
-- invisible to the banned account) and wallet freeze (admin only,
-- blocks money OUT via payout only) ride the same migration.

-- ---- fairness: checklist, delivery map, review clock ----
alter table public.ex_jobs add column if not exists acceptance_checklist jsonb not null default '[]'::jsonb;
alter table public.ex_jobs add column if not exists checklist_frozen jsonb;
alter table public.ex_jobs add column if not exists checklist_frozen_at bigint;
alter table public.ex_jobs add column if not exists delivery_checklist_map jsonb not null default '[]'::jsonb;
alter table public.ex_jobs add column if not exists review_deadline bigint;
alter table public.ex_jobs add column if not exists reminder_24h_sent boolean not null default false;
alter table public.ex_jobs add column if not exists reminder_6h_sent boolean not null default false;
alter table public.ex_jobs add column if not exists settled_via text not null default '';
-- ---- fairness: dispute evidence round ----
alter table public.ex_jobs add column if not exists dispute_item_index int;
alter table public.ex_jobs add column if not exists dispute_evidence text not null default '';
alter table public.ex_jobs add column if not exists dispute_deadline bigint;
alter table public.ex_jobs add column if not exists dispute_admin_deadline bigint;
alter table public.ex_jobs add column if not exists dispute_response text not null default '';
alter table public.ex_jobs add column if not exists dispute_response_at bigint;
alter table public.ex_jobs add column if not exists dispute_redelivered boolean not null default false;
-- ---- per-milestone review clock ----
alter table public.ex_milestones add column if not exists review_deadline bigint;
-- ---- shadow ban + wallet freeze (account flags) ----
alter table public.ex_users add column if not exists shadow_banned boolean not null default false;
alter table public.ex_users add column if not exists shadow_banned_at bigint;
alter table public.ex_users add column if not exists wallet_frozen boolean not null default false;
alter table public.ex_users add column if not exists wallet_frozen_at bigint;
alter table public.ex_users add column if not exists wallet_freeze_reason text not null default '';

-- Admin audit trail for enforcement actions (shadow ban / wallet
-- freeze and any future admin action recorded through the same path).
-- Admin-only by RLS (service role only, like every ex_* table); never
-- exposed to the affected user — a shadow ban leaves NO user-visible
-- trace anywhere.
create table if not exists public.ex_admin_audit (
  id bigint generated always as identity primary key,
  admin_user_id bigint not null,
  action text not null,
  target_user_id bigint,
  detail jsonb not null default '{}'::jsonb,
  created_at bigint not null default 0
);
create index if not exists idx_ex_admin_audit_target on public.ex_admin_audit(target_user_id, created_at desc);
alter table public.ex_admin_audit enable row level security;
revoke all on public.ex_admin_audit from anon, authenticated;
grant all on public.ex_admin_audit to service_role;

-- Reminder mail kind for the 24h-left / 6h-left review reminders.
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected','job_auto_refunded','deposit_confirmed','payout_completed','agent_welcome','agent_recovery','review_reminder'));

-- SAFETY AT DEPLOY: jobs already in delivered status get a full fresh
-- 48h review window from deploy time — never a past deadline, so
-- nothing auto-pays the instant this ships.
update public.ex_jobs
set review_deadline = floor(extract(epoch from now()))::bigint + 172800
where status = 'delivered' and review_deadline is null;

notify pgrst, 'reload schema';
