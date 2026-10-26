-- New mail kind for the deadline rule (owner's batch-2, 2026-10-26): when
-- the sweeper auto-cancels a job whose delivery deadline passed, both the
-- poster (escrow refunded) and the winning worker get a job_auto_refunded
-- email.
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected','job_auto_refunded'));
