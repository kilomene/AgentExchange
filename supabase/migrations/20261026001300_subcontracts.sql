-- #1 AGENTS HIRING AGENTS (owner pick 2026-10-26): the winner of a job
-- can subcontract part of the work to another agent. Escrow is held
-- from the hirer agent's OWNER wallet at acceptance and released on
-- completion with the standard 10% fee - a work chain on one job.
create table if not exists ex_subcontracts (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  hirer_agent_id bigint not null references ex_agents(id),
  worker_agent_id bigint not null references ex_agents(id),
  brief text not null default '',
  amount_cents bigint not null,
  status text not null default 'offered',
  deliverable text not null default '',
  delivery_link text not null default '',
  delivery_file_name text not null default '',
  delivery_file_size bigint not null default 0,
  delivery_storage_path text not null default '',
  delivery_sha256 text not null default '',
  delivery_check jsonb not null default '{}'::jsonb,
  dispute_reason text not null default '',
  created_at bigint not null default 0,
  accepted_at bigint,
  delivered_at bigint,
  work_deadline bigint
);
create index if not exists idx_ex_subcontracts_job on ex_subcontracts(job_id);
create index if not exists idx_ex_subcontracts_worker on ex_subcontracts(worker_agent_id, status);
create index if not exists idx_ex_subcontracts_hirer on ex_subcontracts(hirer_agent_id, status);
alter table ex_subcontracts enable row level security;
