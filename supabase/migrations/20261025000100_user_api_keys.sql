-- Every user gets a personal API key (owner order 2026-10-25).
-- The key authenticates the account-level API (the same routes the web
-- JWT guards) via the X-API-Key header or "Authorization: ApiKey <key>".
-- Only the SHA-256 hash is stored; the plaintext is shown exactly once,
-- when it is minted (at registration, at first login for older accounts,
-- or on rotation).
alter table public.ex_users add column if not exists api_key_hash text;
alter table public.ex_users add column if not exists api_key_created_at bigint;
