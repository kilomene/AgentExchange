-- More lifecycle email kinds (owner's order, 2026-10-26): review received,
-- dispute opened, dispute resolved, job cancelled (to bidders), and bid not
-- selected (to losing bidders when a job is awarded).
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected'));
