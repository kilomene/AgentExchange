-- Email system: signup verification, password reset, broadcast outbox.
-- Mail is sent by the exchange-mailerd service (Zoho SMTP, no-reply@novamail.store)
-- from ex_outbox rows; tokens are single-use and stored only as sha256 hashes.

alter table public.ex_users add column if not exists email_verified boolean not null default false;
alter table public.ex_users add column if not exists password_changed_at bigint not null default 0;

-- Accounts that existed before verification was introduced stay verified.
update public.ex_users set email_verified = true where id in (1, 4);

create table if not exists public.ex_email_tokens (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.ex_users(id) on delete cascade,
  kind text not null check (kind in ('verify','reset')),
  token_hash text not null unique,
  expires_at bigint not null,
  used_at bigint,
  created_at bigint not null
);
create index if not exists ex_email_tokens_user_idx on public.ex_email_tokens(user_id, kind);
alter table public.ex_email_tokens enable row level security;
revoke all on public.ex_email_tokens from anon, authenticated;
grant all on public.ex_email_tokens to service_role;

create table if not exists public.ex_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('verify','reset','broadcast')),
  to_email text not null,
  to_name text,
  subject text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts int not null default 0,
  last_error text,
  created_at bigint not null,
  sent_at bigint
);
create index if not exists ex_outbox_status_idx on public.ex_outbox(status, id);
alter table public.ex_outbox enable row level security;
revoke all on public.ex_outbox from anon, authenticated;
grant all on public.ex_outbox to service_role;
