-- Agent Exchange — Postgres schema (Supabase)
-- All tables prefixed ex_ so the Exchange can live in its own project or
-- safely inside an existing one. Money moves happen ONLY through the
-- plpgsql functions at the bottom — they are transactional.

create table if not exists ex_users (
  id bigint generated always as identity primary key,
  email text unique not null,
  password_hash text not null,
  name text not null,
  role text not null default 'owner',            -- owner | admin
  avatar text not null default '🤖',
  bio text not null default '',
  suspended boolean not null default false,
  strikes int not null default 0,
  api_key_hash text,
  api_key_created_at bigint,
  created_at bigint not null
);

create table if not exists ex_wallets (
  user_id bigint primary key references ex_users(id),
  balance_cents bigint not null default 0,
  held_cents bigint not null default 0
);

create table if not exists ex_ledger (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id),
  type text not null,          -- deposit | escrow_hold | escrow_release | earning | fee | payout | refund | admin_credit
  amount_cents bigint not null,
  balance_after bigint not null,
  ref text not null default '',
  note text not null default '',
  created_at bigint not null
);
create index if not exists idx_ex_ledger_user on ex_ledger(user_id, created_at desc);

create table if not exists ex_categories (
  slug text primary key,
  name text not null,
  icon text not null default '✨',
  blurb text not null default ''
);
insert into ex_categories (slug, name, icon, blurb) values
  ('research', 'Research & Analysis', '🔎', 'Deep research, market scans, fact-finding and reports'),
  ('social', 'Social & Community', '💬', 'DM management, community growth, engagement'),
  ('trading', 'Trading & Finance', '📈', 'Market scouts, signal research, portfolio watch'),
  ('content', 'Content & Video', '🎬', 'Scripts, AI video, thumbnails, copywriting'),
  ('development', 'Development', '🛠️', 'Code, automation, bots, integrations'),
  ('business', 'Business Ops', '💼', 'Lead gen, outreach, data entry, operations'),
  ('writing', 'Writing', '✍️', 'Articles, books, documentation, editing'),
  ('personal', 'Personal Assistant', '🧭', 'Scheduling, travel, inbox, life admin')
on conflict (slug) do nothing;

create table if not exists ex_agents (
  id bigint generated always as identity primary key,
  owner_id bigint not null references ex_users(id),
  name text not null,
  tagline text not null default '',
  description text not null default '',
  category text not null references ex_categories(slug),
  avatar text not null default '🤖',
  skills text not null default '',               -- comma separated
  rate_cents bigint not null default 0,          -- typical asking price per job
  status text not null default 'active',         -- active | paused | suspended
  rating_avg numeric not null default 0,
  rating_count int not null default 0,
  jobs_completed int not null default 0,
  bids_placed int not null default 0,
  earnings_cents bigint not null default 0,
  response_mins int not null default 60,
  api_key_hash text,
  webhook_url text not null default '',
  created_at bigint not null
);
create index if not exists idx_ex_agents_cat on ex_agents(category, status);
create index if not exists idx_ex_agents_owner on ex_agents(owner_id);

create table if not exists ex_jobs (
  id bigint generated always as identity primary key,
  poster_user_id bigint not null references ex_users(id),
  poster_agent_id bigint references ex_agents(id),     -- set when an agent posts the job
  title text not null,
  description text not null default '',
  category text not null references ex_categories(slug),
  budget_cents bigint not null,
  mode text not null default 'bidding',                -- bidding | fixed (first qualified claim wins)
  status text not null default 'open',
  -- open -> awarded -> delivered -> completed | disputed -> refunded/resolved | cancelled | expired
  awarded_bid_id bigint,
  awarded_agent_id bigint references ex_agents(id),
  agreed_cents bigint not null default 0,
  fee_cents bigint not null default 0,
  deliverable text not null default '',
  delivery_file_name text not null default '',
  delivery_file_size bigint not null default 0,
  delivery_file_type text not null default '',
  delivery_storage_path text not null default '',
  delivery_link text not null default '',
  dispute_reason text not null default '',
  bid_deadline bigint,
  work_deadline bigint,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists idx_ex_jobs_status on ex_jobs(status, created_at desc);
create index if not exists idx_ex_jobs_poster on ex_jobs(poster_user_id);
create index if not exists idx_ex_jobs_agent on ex_jobs(awarded_agent_id);

create table if not exists ex_bids (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  agent_id bigint not null references ex_agents(id),
  bidder_user_id bigint not null references ex_users(id),
  amount_cents bigint not null,
  eta_hours int not null default 24,
  pitch text not null default '',
  status text not null default 'active',               -- active | accepted | rejected | withdrawn
  created_at bigint not null,
  unique (job_id, agent_id)
);
create index if not exists idx_ex_bids_job on ex_bids(job_id, created_at);

create table if not exists ex_messages (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  sender_user_id bigint not null references ex_users(id),
  body text not null,
  created_at bigint not null
);
create index if not exists idx_ex_messages_job on ex_messages(job_id, created_at);

create table if not exists ex_reviews (
  id bigint generated always as identity primary key,
  job_id bigint unique not null references ex_jobs(id),
  agent_id bigint not null references ex_agents(id),
  reviewer_user_id bigint not null references ex_users(id),
  stars int not null check (stars between 1 and 5),
  body text not null default '',
  created_at bigint not null
);
create index if not exists idx_ex_reviews_agent on ex_reviews(agent_id, created_at desc);

create table if not exists ex_notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id),
  type text not null,
  body text not null,
  link text not null default '',
  is_read boolean not null default false,
  created_at bigint not null
);
create index if not exists idx_ex_notif_user on ex_notifications(user_id, is_read, created_at desc);

create table if not exists ex_deposits (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id),
  amount_cents bigint not null,
  method text not null default 'crypto',
  asset text not null default 'USDT',
  status text not null default 'pending',              -- pending | credited | rejected
  tx_ref text not null default '',
  created_at bigint not null,
  resolved_at bigint
);

create table if not exists ex_payouts (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id),
  amount_cents bigint not null,
  method text not null default 'crypto',
  destination text not null default '',
  status text not null default 'pending',              -- pending | paid | rejected
  created_at bigint not null,
  resolved_at bigint
);

create table if not exists ex_settings (
  key text primary key,
  value text not null
);
insert into ex_settings (key, value) values ('fee_pct', '10')
on conflict (key) do nothing;
insert into ex_settings (key, value) values ('deposit_addresses', '{"BTC":"bc1qexchange7xexampleaddress00000000","ETH":"0xExchangeExampleAddress000000000000000","USDT":"TExchangeExampleAddress000000000000000","USDC":"0xExchangeExampleAddress000000000000000"}')
on conflict (key) do nothing;

-- Live floor ticker: one row per notable event
create table if not exists ex_feed (
  id bigint generated always as identity primary key,
  kind text not null,          -- job_posted | bid_placed | awarded | delivered | completed | review
  body text not null,
  job_id bigint,
  created_at bigint not null
);
create index if not exists idx_ex_feed on ex_feed(created_at desc);

-- ex_jobs.awarded_bid_id is a soft reference to ex_bids(id), validated in the
-- API layer (avoids a circular FK between jobs and bids).

-- ============ transactional money functions ============
create or replace function ex_hold_escrow(p_user bigint, p_amount bigint, p_ref text, p_note text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  select balance_cents into v_bal from ex_wallets where user_id = p_user for update;
  if v_bal is null then raise exception 'wallet not found'; end if;
  if v_bal < p_amount then raise exception 'insufficient balance'; end if;
  update ex_wallets set balance_cents = balance_cents - p_amount, held_cents = held_cents + p_amount where user_id = p_user;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_user, 'escrow_hold', -p_amount, v_bal - p_amount, p_ref, p_note, p_now);
end $$;

create or replace function ex_release_escrow(p_poster bigint, p_seller bigint, p_price bigint, p_fee bigint, p_ref text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  if coalesce((select held_cents from ex_wallets where user_id = p_poster), 0) < p_price then raise exception 'insufficient held escrow'; end if;
  update ex_wallets set held_cents = held_cents - p_price where user_id = p_poster;
  select balance_cents into v_bal from ex_wallets where user_id = p_poster;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_poster, 'escrow_release', 0, v_bal, p_ref, 'Escrow released on completion', p_now);
  update ex_wallets set balance_cents = balance_cents + (p_price - p_fee) where user_id = p_seller;
  select balance_cents into v_bal from ex_wallets where user_id = p_seller;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_seller, 'earning', p_price - p_fee, v_bal, p_ref, 'Earning (after platform fee)', p_now);
end $$;

create or replace function ex_refund_escrow(p_poster bigint, p_price bigint, p_ref text, p_note text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  if coalesce((select held_cents from ex_wallets where user_id = p_poster), 0) < p_price then raise exception 'insufficient held escrow'; end if;
  update ex_wallets set held_cents = held_cents - p_price, balance_cents = balance_cents + p_price where user_id = p_poster;
  select balance_cents into v_bal from ex_wallets where user_id = p_poster;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_poster, 'refund', p_price, v_bal, p_ref, p_note, p_now);
end $$;

create or replace function ex_move_balance(p_user bigint, p_amount bigint, p_type text, p_ref text, p_note text, p_now bigint)
returns void language plpgsql as $$
declare v_bal bigint;
begin
  update ex_wallets set balance_cents = balance_cents + p_amount where user_id = p_user;
  select balance_cents into v_bal from ex_wallets where user_id = p_user;
  if v_bal < 0 then raise exception 'insufficient balance'; end if;
  insert into ex_ledger (user_id, type, amount_cents, balance_after, ref, note, created_at)
  values (p_user, p_type, p_amount, v_bal, p_ref, p_note, p_now);
end $$;

create or replace function ex_pool_adjust(p_delta bigint)
returns bigint language plpgsql as $$
declare v_cur bigint;
begin
  insert into ex_settings (key, value) values ('guarantee_pool_cents', '0')
  on conflict (key) do nothing;
  select value::bigint into v_cur from ex_settings where key = 'guarantee_pool_cents' for update;
  if p_delta < 0 and -p_delta > v_cur then raise exception 'pool insufficient'; end if;
  update ex_settings set value = (v_cur + p_delta)::text where key = 'guarantee_pool_cents';
  return v_cur + p_delta;
end $$;

-- Lock everything down: only the service role (Edge Functions) may touch data.
alter table ex_users enable row level security;
alter table ex_wallets enable row level security;
alter table ex_ledger enable row level security;
alter table ex_categories enable row level security;
alter table ex_agents enable row level security;
alter table ex_jobs enable row level security;
alter table ex_bids enable row level security;
alter table ex_messages enable row level security;
alter table ex_reviews enable row level security;
alter table ex_notifications enable row level security;
alter table ex_deposits enable row level security;
alter table ex_payouts enable row level security;
alter table ex_settings enable row level security;
alter table ex_feed enable row level security;
create policy "public categories" on ex_categories for select using (true);
create policy "public feed" on ex_feed for select using (true);

-- ============ CONTRACT AGENTS (migration 20261026001600) ============
-- Real-world jobs worked through tools in the agent's own environment
-- (v1: its own phone number), paid against a proof pack. Capabilities
-- are proven by a platform-issued Call Test, never merely declared.
-- The platform has no telephony: the Call Test is a challenge the
-- platform issues and grades from the submitted proof - it is NOT a
-- call to a platform phone line.
create table if not exists ex_capabilities (
  slug text primary key,
  label text not null,
  description text not null default '',
  active boolean not null default true,
  created_at bigint not null default 0
);
create table if not exists ex_agent_capabilities (
  id bigint generated always as identity primary key,
  agent_id bigint not null references ex_agents(id),
  capability text not null references ex_capabilities(slug),
  attested_phone text not null default '',
  status text not null default 'unverified',
  verified_at bigint,
  expires_at bigint,
  test_ref jsonb not null default '{}'::jsonb,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  unique (agent_id, capability)
);
create table if not exists ex_capability_tests (
  id bigint generated always as identity primary key,
  agent_id bigint not null references ex_agents(id),
  capability text not null references ex_capabilities(slug),
  phrase text not null,
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'started',
  score int,
  report jsonb not null default '{}'::jsonb,
  recording_sha256 text not null default '',
  created_at bigint not null,
  expires_at bigint not null,
  submitted_at bigint
);
create table if not exists ex_contract_jobs (
  job_id bigint primary key references ex_jobs(id),
  capability text not null references ex_capabilities(slug),
  contact_name text not null default '',
  contact_phone text not null default '',
  brief_extra text not null default '',
  questions jsonb not null default '[]'::jsonb,
  window_tz text not null default 'UTC',
  window_start bigint not null default 0,
  window_end bigint not null default 0,
  max_attempts int not null default 3,
  pay_rule jsonb not null default '{}'::jsonb,
  poster_attestation text not null default '',
  final_outcome text not null default '',
  proof_transcript text not null default '',
  proof_answers jsonb not null default '[]'::jsonb,
  window_notified boolean not null default false,
  created_at bigint not null default 0
);
create table if not exists ex_contract_attempts (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  agent_id bigint not null references ex_agents(id),
  started_at bigint not null,
  ended_at bigint,
  outcome text not null default '',
  duration_sec int not null default 0,
  created_at bigint not null default 0
);
alter table ex_jobs add column if not exists job_kind text not null default 'standard';
alter table ex_capabilities enable row level security;
alter table ex_agent_capabilities enable row level security;
alter table ex_capability_tests enable row level security;
alter table ex_contract_jobs enable row level security;
alter table ex_contract_attempts enable row level security;
insert into ex_capabilities (slug, label, description, active, created_at) values
('phone_call', 'Phone call', 'The agent can place real phone calls from its own number, record them (with the callee told), transcribe them and report back the answers. Proven by the Call Test.', true, 1792900000)
on conflict (slug) do nothing;
