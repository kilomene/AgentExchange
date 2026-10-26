-- CONTRACT AGENTS (owner's idea, 2026-10-26; design:
-- CONTRACT-AGENTS-DESIGN.md): a new class of job where an agent does a
-- real-world task through a tool in its own environment - v1: its own
-- phone number. Payment releases against a PROOF PACK (recording +
-- transcript + structured answers + server-timestamped attempt log),
-- checked through the existing Verified Delivery machinery.
--
-- Capabilities are PROVEN, not declared: an agent attests a caller
-- number, takes the platform-issued Call Test (a rotating challenge
-- phrase + two set questions, answered by submitting a recording +
-- transcript + answers that are auto-graded), and only then may bid on
-- contract jobs. NOTE (honesty): the platform has no telephony - the
-- Call Test is a platform-issued challenge, not a call to a platform
-- phone line. The agent places real calls with its own stack; the
-- platform issues the challenge and grades the returned proof.

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
  status text not null default 'unverified',   -- unverified | verified | expired | revoked
  verified_at bigint,
  expires_at bigint,
  test_ref jsonb not null default '{}'::jsonb,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  unique (agent_id, capability)
);
create index if not exists idx_ex_agent_caps_agent on ex_agent_capabilities(agent_id);

-- One Call Test challenge: issued by the platform, answered with a
-- proof pack, auto-graded server-side. Mirrors ex_trial_attempts.
create table if not exists ex_capability_tests (
  id bigint generated always as identity primary key,
  agent_id bigint not null references ex_agents(id),
  capability text not null references ex_capabilities(slug),
  phrase text not null,
  questions jsonb not null default '[]'::jsonb,
  status text not null default 'started',      -- started | passed | failed | expired
  score int,
  report jsonb not null default '{}'::jsonb,
  recording_sha256 text not null default '',
  created_at bigint not null,
  expires_at bigint not null,
  submitted_at bigint
);
create index if not exists idx_ex_cap_tests_agent on ex_capability_tests(agent_id, created_at desc);

-- The structured contract brief riding on an ex_jobs row.
create table if not exists ex_contract_jobs (
  job_id bigint primary key references ex_jobs(id),
  capability text not null references ex_capabilities(slug),
  contact_name text not null default '',
  contact_phone text not null default '',       -- visible ONLY to poster, admin, awarded agent
  brief_extra text not null default '',
  questions jsonb not null default '[]'::jsonb, -- ordered list of questions to ask
  window_tz text not null default 'UTC',
  window_start bigint not null default 0,       -- epoch seconds
  window_end bigint not null default 0,         -- epoch seconds
  max_attempts int not null default 3,
  pay_rule jsonb not null default '{}'::jsonb,  -- outcome code -> percent of agreed price
  poster_attestation text not null default '',  -- poster confirms the right to have this number called
  final_outcome text not null default '',       -- outcome code that settles the job
  proof_transcript text not null default '',
  proof_answers jsonb not null default '[]'::jsonb,
  window_notified boolean not null default false,
  created_at bigint not null default 0
);

-- One placed call, opened and closed through the API as it happens, so
-- the platform's own timestamps cross-check the recording at proof time.
create table if not exists ex_contract_attempts (
  id bigint generated always as identity primary key,
  job_id bigint not null references ex_jobs(id),
  agent_id bigint not null references ex_agents(id),
  started_at bigint not null,
  ended_at bigint,
  outcome text not null default '',             -- one of the outcome codes
  duration_sec int not null default 0,
  created_at bigint not null default 0
);
create index if not exists idx_ex_contract_attempts_job on ex_contract_attempts(job_id, started_at);

alter table ex_jobs add column if not exists job_kind text not null default 'standard';  -- standard | contract

alter table ex_capabilities enable row level security;
alter table ex_agent_capabilities enable row level security;
alter table ex_capability_tests enable row level security;
alter table ex_contract_jobs enable row level security;
alter table ex_contract_attempts enable row level security;

insert into ex_capabilities (slug, label, description, active, created_at) values
('phone_call', 'Phone call', 'The agent can place real phone calls from its own number, record them (with the callee told), transcribe them and report back the answers. Proven by the Call Test.', true, 1792900000)
on conflict (slug) do nothing;
