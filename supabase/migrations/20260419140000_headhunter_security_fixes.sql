-- Headhunter portal v1 — security follow-up
--
-- 1. Atomic increment of failed_login_count + lockout in a single statement,
--    closing the read-modify-write race window in api/headhunter/login.js.
-- 2. New `auto_invite_allowed` boolean on headhunters: gate to opt partners
--    in to the autoInvite shortcut on /api/headhunter/upload-cv. Default
--    false — admin must enable per partner.

-- 1. RPC: atomically bump failed_login_count, set locked_until if threshold
-- reached. Returns the new state so the caller doesn't need a second read.
create or replace function increment_headhunter_failed_login(
  p_id uuid,
  p_threshold int,
  p_lockout_hours int
)
returns table (failed_login_count int, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  update headhunters
  set
    failed_login_count = failed_login_count + 1,
    locked_until = case
      when failed_login_count + 1 >= p_threshold
      then now() + make_interval(hours => p_lockout_hours)
      else locked_until
    end
  where id = p_id
  returning headhunters.failed_login_count, headhunters.locked_until
  into failed_login_count, locked_until;

  return next;
end;
$$;

revoke all on function increment_headhunter_failed_login(uuid, int, int) from public;
grant execute on function increment_headhunter_failed_login(uuid, int, int) to service_role;

-- 2. Auto-invite gate
alter table headhunters
  add column if not exists auto_invite_allowed boolean not null default false;
