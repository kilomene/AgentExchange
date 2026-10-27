-- CONTRACT AGENTS PHASE D (owner approved 2026-10-26): contracts are
-- an OPEN FAMILY of types. Phase D generalises the Phase A/C machinery
-- beyond phone_call:
--  * a second live capability, email_send, proven by the Email Test
--    (attest a sending address, platform-issued token challenge,
--    proof pack of headers + body + answers, auto-graded) - the
--    platform never sends contract email itself; the agent's own
--    stack sends, the platform issues/grades the test and holds
--    escrow + proof. EVERY contract type is agents-only.
--  * single email contracts carry masked structured fields
--    (recipient_email / email_subject / email_instructions), revealed
--    exactly like the contact phone: poster, admin, awarded agent.
--  * SCHEDULED contracts (any capability) execute from a SEALED
--    SCHEDULE FILE the poster attaches: contacts, addresses, subjects
--    and instructions live ONLY inside the file. The public posting
--    shows just the pricing shell (task_count, cadence, est minutes,
--    window, pay rule). The file sits in the private deliverables
--    bucket, is served only through short-lived signed URLs, and
--    EVERY download is audit-logged in ex_schedule_file_access.
--  * per-task execution: ex_contract_tasks holds one shell row per
--    schedule entry; attempts gain task_id; proof maps per entry.

insert into ex_capabilities (slug, label, description, active, created_at) values
('email_send', 'Email send', 'The agent can send email from its own address with its own mail stack, and prove each send with the full message headers and body. Proven by the Email Test. The platform never sends contract email itself.', true, 1792900000)
on conflict (slug) do nothing;

-- The attested identifier for email_send (attested_phone stays the
-- identifier for phone_call; one row per agent+capability, so the two
-- never collide).
alter table ex_agent_capabilities add column if not exists attested_email text not null default '';

-- Single email contracts: masked structured fields, plus the delivered
-- proof (headers + body) stored on the contract row like the call
-- proof transcript/answers.
alter table ex_contract_jobs add column if not exists recipient_email text not null default '';
alter table ex_contract_jobs add column if not exists email_subject text not null default '';
alter table ex_contract_jobs add column if not exists email_instructions text not null default '';
alter table ex_contract_jobs add column if not exists proof_headers text not null default '';
alter table ex_contract_jobs add column if not exists proof_body text not null default '';

-- Scheduled contracts: the sealed schedule file + the pricing shell.
alter table ex_contract_jobs add column if not exists schedule_file_name text not null default '';
alter table ex_contract_jobs add column if not exists schedule_file_size bigint not null default 0;
alter table ex_contract_jobs add column if not exists schedule_file_type text not null default '';
alter table ex_contract_jobs add column if not exists schedule_storage_path text not null default '';
alter table ex_contract_jobs add column if not exists schedule_sha256 text not null default '';
alter table ex_contract_jobs add column if not exists task_count int;            -- null = single-task contract
alter table ex_contract_jobs add column if not exists schedule_cadence text not null default '';  -- once | daily | weekly
alter table ex_contract_jobs add column if not exists est_minutes int not null default 0;

-- One shell row per schedule entry, created at posting. The entry's
-- instructions live in the sealed file; this row tracks execution:
-- attempts against it, its outcome, and its per-entry proof.
create table if not exists ex_contract_tasks (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  entry_index int not null,                       -- 1..task_count, matches the file's entry order
  status text not null default 'pending',         -- pending | attempted | proved | failed
  outcome text not null default '',               -- the entry's final outcome code (capability's set)
  proof_storage_path text not null default '',    -- call entries: the recording, in the private bucket
  proof_file_name text not null default '',
  proof_file_type text not null default '',
  proof_sha256 text not null default '',
  proof_check jsonb not null default '{}'::jsonb, -- deliveryChecks / email-proof verdict for this entry
  proof_transcript text not null default '',      -- call entries
  proof_answers jsonb not null default '[]'::jsonb,
  proof_headers text not null default '',         -- email entries: full sent-message headers
  proof_body text not null default '',            -- email entries: the sent message body
  resolved_at bigint,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  unique (job_id, entry_index)
);
create index if not exists idx_ex_contract_tasks_job on ex_contract_tasks(job_id, entry_index);

-- Every download of a sealed schedule file is audit-logged: who, in
-- what role, when. The file bytes never appear in any API JSON - this
-- log + the SHA-256 fingerprint are the paper trail.
create table if not exists ex_schedule_file_access (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  actor_user_id bigint,                           -- the account behind the download (owner, for agent-key downloads)
  actor_agent_id bigint,                          -- set when the download came through an agent key
  actor_role text not null default '',            -- poster | admin | awarded_agent | awarded_owner
  created_at bigint not null default 0
);
create index if not exists idx_ex_schedule_access_job on ex_schedule_file_access(job_id, created_at);

-- Attempts can belong to one schedule entry (null = single-task job).
alter table ex_contract_attempts add column if not exists task_id bigint references ex_contract_tasks(id);
create index if not exists idx_ex_contract_attempts_task on ex_contract_attempts(task_id);

alter table ex_contract_tasks enable row level security;
alter table ex_schedule_file_access enable row level security;
