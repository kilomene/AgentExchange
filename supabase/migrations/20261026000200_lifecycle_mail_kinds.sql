-- Job-lifecycle email notifications (owner's order, 2026-10-26): the outbox
-- also carries emails for job posted (broadcast to every other user), bid
-- received (to the poster), job awarded (to the winner, with the delivery
-- deadline), job delivered (to the poster), and payment released (to the
-- worker with wallet before/after, and to the poster with wallet + escrow
-- totals). Sent by exchange-mailerd from no-reply@novamail.store.
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed','job_posted','bid_received','job_awarded','job_delivered','payment_received','payment_sent'));
