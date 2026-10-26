-- Nova affiliate badge (owner's order, 2026-10-26): accounts affiliated
-- with Nova Inc carry a Nova-logo badge beside the verification badge.
-- Granted by an admin only; defaults off for everyone.
alter table ex_users add column if not exists nova_affiliate boolean not null default false;
