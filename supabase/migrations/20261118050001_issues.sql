-- Built-in "Report an issue" (instead of GitHub Issues).
--  * Any signed-in staff account (any staff_roles role) can report an issue and see its own reports.
--  * Admins (in Admin mode, PIN-unlocked) can see and update all issues.
--  * No anonymous access (the public site can't post). Max 10 reports per hour / 30 per day per account.
--  * The Supabase dashboard (Table Editor) can view and edit everything as usual.
create table public.issues (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text not null check (length(btrim(title)) between 3 and 120),
  description text not null default '' check (length(description) <= 4000),
  type text not null default 'bug' check (type in ('bug', 'feature', 'question')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'wont_fix')),
  reporter_name text check (reporter_name is null or length(reporter_name) <= 120),
  reporter_email text check (reporter_email is null or length(reporter_email) <= 254),
  reported_by uuid references auth.users (id) on delete set null,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 8000),
  admin_notes text check (admin_notes is null or length(admin_notes) <= 4000),
  updated_by uuid
);
comment on table public.issues is 'Issues reported from the app (Report an issue). context = view/mode, tournament, user agent, app version captured automatically.';
create index issues_created_at_idx on public.issues (created_at desc);
create index issues_reported_by_idx on public.issues (reported_by, created_at desc);
create index issues_status_idx on public.issues (status);

create or replace function private.issues_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_hour int; v_day int;
begin
  if tg_op = 'INSERT' then
    if v_uid is null then return new; end if; -- dashboard / SQL editor: keep values as given
    -- Reports from the app: the reporter is always the signed-in account; triage fields start fresh.
    new.reported_by := v_uid;
    new.reporter_email := coalesce((select auth.jwt()) ->> 'email', new.reporter_email);
    new.reporter_name := nullif(btrim(coalesce(new.reporter_name, '')), '');
    new.status := 'open'; new.admin_notes := null; new.created_at := now(); new.updated_at := now(); new.updated_by := null;
    perform pg_advisory_xact_lock(hashtextextended('issues/' || v_uid::text, 0));
    select count(*) filter (where created_at > now() - interval '1 hour'), count(*)
      into v_hour, v_day
      from public.issues where reported_by = v_uid and created_at > now() - interval '1 day';
    if v_hour >= 10 or v_day >= 30 then
      raise exception 'Too many reports from this account – please wait a while and try again.' using errcode = '54000';
    end if;
    return new;
  end if;
  new.id := old.id; new.created_at := old.created_at;
  if v_uid is not null then
    new.reported_by := old.reported_by; new.reporter_email := old.reporter_email; new.context := old.context;
  end if;
  new.updated_at := now(); new.updated_by := v_uid;
  return new;
end $$;
revoke all on function private.issues_before_write() from public, anon, authenticated;
create trigger issues_before_write before insert or update on public.issues
  for each row execute function private.issues_before_write();

alter table public.issues enable row level security;
revoke all on public.issues from anon, authenticated;
grant select, insert, update on public.issues to authenticated;

create policy "staff report issues" on public.issues for insert to authenticated
  with check ((select private.is_staff()) and reported_by = (select auth.uid()));
create policy "staff read own issues, admins read all" on public.issues for select to authenticated
  using (((select private.is_staff()) and reported_by = (select auth.uid())) or (select private.has_role(array['admin'])));
create policy "admins update issues" on public.issues for update to authenticated
  using ((select private.has_role(array['admin']))) with check ((select private.has_role(array['admin'])));
