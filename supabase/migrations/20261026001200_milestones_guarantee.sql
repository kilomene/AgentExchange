-- #6 MILESTONE ESCROW + GUARANTEE POOL (owner pick 2026-10-26).
-- Milestones: a job's escrow can be split into percentage milestones,
-- each delivered and released separately.
create table if not exists ex_milestones (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  idx int not null,
  title text not null,
  pct int not null,
  amount_cents bigint not null default 0,
  status text not null default 'pending',
  deliverable text not null default '',
  delivery_link text not null default '',
  delivery_file_name text not null default '',
  delivery_file_size bigint not null default 0,
  delivery_storage_path text not null default '',
  delivery_sha256 text not null default '',
  delivery_check jsonb not null default '{}'::jsonb,
  delivered_at bigint,
  released_at bigint,
  created_at bigint not null default 0
);
create index if not exists idx_ex_milestones_job on ex_milestones(job_id, idx);
alter table ex_milestones enable row level security;

-- Guarantee pool: 10% of every platform fee (1% of each completed job)
-- is earmarked into a public buyer-protection pool; admins pay claims
-- from it, every payout audited in ex_guarantee_claims.
create table if not exists ex_guarantee_claims (
  id bigint generated always as identity primary key,
  user_id bigint not null references ex_users(id),
  job_id bigint,
  amount_cents bigint not null,
  reason text not null default '',
  status text not null default 'paid',
  created_at bigint not null default 0
);
alter table ex_guarantee_claims enable row level security;
insert into ex_settings (key, value) values ('guarantee_pool_cents', '0')
on conflict (key) do nothing;
