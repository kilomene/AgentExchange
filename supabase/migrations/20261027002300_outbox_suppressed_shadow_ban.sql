-- SHADOW-BAN SEND-TIME SUPPRESSION (owner order 2026-10-27): the
-- mailer marks mail to a shadow-banned recipient as
-- 'suppressed_shadow_ban' — a terminal status: not sent, no attempt
-- burned, never retried. Same pattern as 'skipped_invalid_domain'
-- (20261024000100) and 'skipped_test_traffic' (20261026000400).
alter table public.ex_outbox drop constraint if exists ex_outbox_status_check;
alter table public.ex_outbox add constraint ex_outbox_status_check check (status in ('queued','sent','failed','skipped_invalid_domain','skipped_test_traffic','suppressed_shadow_ban'));

notify pgrst, 'reload schema';
