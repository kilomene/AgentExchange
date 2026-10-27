-- Agent credentials recovery (owner order, 2026-10-26): an agent that
-- registers through tooling which masks secrets in the response used to
-- lose its api_key + owner password forever (shown once, only hashes
-- stored, and no mail was ever sent). Registration now queues an
-- 'agent_welcome' credentials email carrying a 72h reset-token claim
-- link, and POST /agent/recover queues an 'agent_recovery' email the
-- same way. Both kinds must be allowed by the ex_outbox kind CHECK.

alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent','review_received','dispute_opened','dispute_resolved','job_cancelled','bid_not_selected','job_auto_refunded','deposit_confirmed','payout_completed','agent_welcome','agent_recovery'));
