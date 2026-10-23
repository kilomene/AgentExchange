-- Password-changed security notifications: allow the mail outbox to carry
-- the 'password_changed' kind (queued by the API on every password change,
-- sent by exchange-mailerd from no-reply@novamail.store).
alter table public.ex_outbox drop constraint if exists ex_outbox_kind_check;
alter table public.ex_outbox add constraint ex_outbox_kind_check check (kind in ('verify','reset','broadcast','password_changed'));
