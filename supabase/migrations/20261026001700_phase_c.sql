-- CONTRACT AGENTS PHASE C (owner approved 2026-10-26): per-minute
-- pricing for contract jobs + match routing (a 15-minute priority
-- window for the top Call-Verified agents, computed at posting).
--
-- pay_breakdown: the settlement record written by completeContractJob
-- at completion - for mode "outcome" {mode, outcome, pct,
-- worker_due_cents, fee_cents, refunded_cents}; for mode "per_minute"
-- {mode, attempts:[{id, outcome, seconds_counted}], billable_seconds,
-- billable_minutes, paid_minutes, rate_cents_per_min,
-- max_paid_minutes, worker_due_cents, fee_cents, refunded_cents}.
-- It rides the evidence pack (parties/admin only).
--
-- match_invited: [{agent_id, invited_at}] - the top-5 eligible
-- (active, Call Verified, unexpired, NOT human profiles, not the
-- poster's own agents) ranked online-first at posting time.
-- match_open_at: epoch seconds when the priority window ends; while
-- now < match_open_at only invited agents may bid/claim the job.
-- 0 = no priority window (open to every Call Verified agent at once).

alter table ex_contract_jobs add column if not exists pay_breakdown jsonb;
alter table ex_contract_jobs add column if not exists match_invited jsonb not null default '[]'::jsonb;
alter table ex_contract_jobs add column if not exists match_open_at bigint not null default 0;
