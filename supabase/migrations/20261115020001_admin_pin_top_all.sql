-- 1) Leaderboard "Top: All": top_n NULL means every ranked entry (board_rows uses LIMIT p_top_n; LIMIT NULL = no limit).
alter table public.leaderboard_configs alter column top_n drop not null;
alter table public.leaderboard_configs drop constraint if exists leaderboard_configs_top_n_check;
alter table public.leaderboard_configs add constraint leaderboard_configs_top_n_check
  check (top_n is null or top_n between 1 and 100);
comment on column public.leaderboard_configs.top_n is 'Places shown; NULL = All.';

-- 2) Admin PIN. One global row the owner edits by hand in the Supabase Table Editor.
create table public.app_settings (
  id         int primary key default 1 check (id = 1),
  admin_pin  text check (admin_pin is null or length(btrim(admin_pin)) between 4 and 32),
  note       text,
  updated_at timestamptz not null default now()
);
comment on table public.app_settings is
  'Single settings row. Type the admin PIN (4-32 characters) into admin_pin. No app user can read this table; the PIN is only checked by verify_admin_pin().';
comment on column public.app_settings.admin_pin is 'Admin mode PIN (plain text, 4-32 characters). NULL = admin mode is locked until a PIN is set.';
insert into public.app_settings (id, admin_pin, note)
values (1, null, 'Set admin_pin to the PIN workers must NOT know (4-32 characters). Changing it takes effect immediately.');
alter table public.app_settings enable row level security;   -- no policies: no client can read or write it
revoke all on public.app_settings from anon, authenticated;

create or replace function private.app_settings_touch()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function private.app_settings_touch();

-- Wrong-PIN counter (per account) and unlocks (per account + sign-in session = per laptop).
create table private.admin_pin_attempts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  failed         int not null default 0,
  last_failed_at timestamptz,
  locked_until   timestamptz
);
create table private.admin_unlocks (
  user_id        uuid not null references auth.users(id) on delete cascade,
  session_id     text not null,
  unlocked_until timestamptz not null,
  primary key (user_id, session_id)
);
revoke all on private.admin_pin_attempts, private.admin_unlocks from public, anon, authenticated;

create or replace function private.current_session()
returns text language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'session_id', '');
$$;

create or replace function private.admin_unlocked()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.admin_unlocks u
    where u.user_id = (select auth.uid())
      and u.session_id = (select private.current_session())
      and u.unlocked_until > now());
$$;

-- Admin accounts keep gate/weigh/screen rights at all times, but admin-only rights (setup, delete,
-- roles, hard deletes) now need a PIN unlock on that sign-in session.
create or replace function private.has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.user_id = (select auth.uid())
      and case when sr.role = 'admin'
               then (not ('admin' = any (p_roles))) or (select private.admin_unlocked())
               else sr.role = any (p_roles) end);
$$;

create or replace function private.verify_admin_pin(p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_sid text := private.current_session();
  v_pin text; a private.admin_pin_attempts; v_until timestamptz;
begin
  if v_uid is null or not exists (select 1 from public.staff_roles where user_id = v_uid and role = 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  if v_sid = '' then return jsonb_build_object('ok', false, 'reason', 'no_session'); end if;
  select * into a from private.admin_pin_attempts where user_id = v_uid for update;
  if a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', a.locked_until);
  end if;
  select admin_pin into v_pin from public.app_settings where id = 1;
  if v_pin is null or btrim(v_pin) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_pin');
  end if;
  if btrim(coalesce(p_pin, '')) = btrim(v_pin) then
    delete from private.admin_pin_attempts where user_id = v_uid;
    v_until := now() + interval '30 minutes';
    insert into private.admin_unlocks (user_id, session_id, unlocked_until) values (v_uid, v_sid, v_until)
      on conflict (user_id, session_id) do update set unlocked_until = excluded.unlocked_until;
    delete from private.admin_unlocks where unlocked_until < now() - interval '1 day';
    return jsonb_build_object('ok', true, 'unlocked_until', v_until);
  end if;
  insert into private.admin_pin_attempts as x (user_id, failed, last_failed_at) values (v_uid, 1, now())
    on conflict (user_id) do update set
      failed = case when x.last_failed_at < now() - interval '15 minutes' then 1 else x.failed + 1 end,
      last_failed_at = now(), locked_until = null
    returning * into a;
  if a.failed >= 5 then
    update private.admin_pin_attempts set failed = 0, locked_until = now() + interval '5 minutes'
      where user_id = v_uid returning locked_until into v_until;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', v_until);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'wrong', 'remaining', 5 - a.failed);
end $$;

-- Status / keep-alive while the laptop is in Admin mode (extends only an existing unlock).
create or replace function private.admin_unlock_status(p_extend boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz;
begin
  if p_extend then
    update private.admin_unlocks set unlocked_until = now() + interval '30 minutes'
      where user_id = auth.uid() and session_id = private.current_session() and unlocked_until > now()
      returning unlocked_until into v_until;
  else
    select unlocked_until into v_until from private.admin_unlocks
      where user_id = auth.uid() and session_id = private.current_session() and unlocked_until > now();
  end if;
  return jsonb_build_object('unlocked', v_until is not null, 'unlocked_until', v_until);
end $$;

create or replace function private.lock_admin()
returns void language sql volatile security definer set search_path = '' as $$
  delete from private.admin_unlocks where user_id = auth.uid() and session_id = private.current_session();
$$;

create or replace function public.verify_admin_pin(p_pin text)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select private.verify_admin_pin(p_pin); $$;
create or replace function public.admin_unlock_status(p_extend boolean default false)
returns jsonb language sql volatile security invoker set search_path = '' as $$ select private.admin_unlock_status(p_extend); $$;
create or replace function public.lock_admin()
returns void language sql volatile security invoker set search_path = '' as $$ select private.lock_admin(); $$;

revoke all on function private.current_session(), private.admin_unlocked(), private.verify_admin_pin(text),
  private.admin_unlock_status(boolean), private.lock_admin(), private.app_settings_touch() from public, anon, authenticated;
grant execute on function private.current_session(), private.admin_unlocked(), private.verify_admin_pin(text),
  private.admin_unlock_status(boolean), private.lock_admin() to authenticated;
revoke all on function public.verify_admin_pin(text), public.admin_unlock_status(boolean), public.lock_admin() from public, anon;
grant execute on function public.verify_admin_pin(text), public.admin_unlock_status(boolean), public.lock_admin() to authenticated;
