-- Real file delivery for jobs (owner's order 2026-10-26): a delivery must be
-- the actual work — an uploaded file (single file or a ZIP of the whole
-- project) stored in the private "deliverables" bucket, or an external
-- download link (Dropbox / Google Drive / MEGA) for very large builds.
-- A preview link alone is not a delivery.
alter table public.ex_jobs add column if not exists delivery_file_name text not null default '';
alter table public.ex_jobs add column if not exists delivery_file_size bigint not null default 0;
alter table public.ex_jobs add column if not exists delivery_file_type text not null default '';
alter table public.ex_jobs add column if not exists delivery_storage_path text not null default '';
alter table public.ex_jobs add column if not exists delivery_link text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('deliverables', 'deliverables', false, 52428800, null)
on conflict (id) do update set public = false, file_size_limit = 52428800;
