-- Weigh tickets: short per-tournament ticket numbers, notes, editing by weigh/admin staff, and a change history.

-- 1) Ticket numbers (#1, #2, … per tournament) and an optional note.
alter table public.tournaments add column next_ticket int not null default 1 check (next_ticket between 1 and 1000000);
alter table public.catches
  add column ticket_no int,
  add column note text check (note is null or length(note) <= 200);
comment on column public.catches.ticket_no is 'Short per-tournament ticket number, assigned by the server when the weigh-in syncs.';

-- Number existing weigh-ins in the order they were recorded (triggers off so nothing else on those rows changes).
alter table public.catches disable trigger user;
with n as (select id, row_number() over (partition by tournament_id order by created_at, id) as rn from public.catches)
update public.catches c set ticket_no = n.rn from n where n.id = c.id;
alter table public.catches enable trigger user;
update public.tournaments t
  set next_ticket = coalesce((select max(c.ticket_no) from public.catches c where c.tournament_id = t.id), 0) + 1;
alter table public.catches add constraint catches_ticket_no_unique unique (tournament_id, ticket_no);

create or replace function private.catches_assign_ticket()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Always server-assigned (a client can't pick its own number).
  update public.tournaments set next_ticket = next_ticket + 1
    where id = new.tournament_id
    returning next_ticket - 1 into new.ticket_no;
  return new;
end $$;
create trigger catches_assign_ticket before insert on public.catches
  for each row execute function private.catches_assign_ticket();

-- 2) On edits, keep the identity/provenance columns fixed.
create or replace function private.catches_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_by := coalesce(auth.uid(), new.recorded_by);
  else
    if new.tournament_id <> old.tournament_id then
      raise exception 'tournament_id cannot be changed';
    end if;
    new.ticket_no := old.ticket_no; new.recorded_by := old.recorded_by; new.weighed_at := old.weighed_at;
    new.source := old.source; new.created_at := old.created_at; new.station := old.station;
    if new.status = 'voided' and old.status <> 'voided' then
      new.voided_at := now();
      new.voided_by := auth.uid();
    elsif new.status = 'active' then
      new.voided_at := null; new.voided_by := null; new.void_reason := null;
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;

-- 3) Weigh staff (and admins) may edit any ticket in the tournament, not just their own.
drop policy if exists "weigh update own catches" on public.catches;
create policy "weigh update catches" on public.catches for update to authenticated
  using ((select private.has_role(array['weigh'])))
  with check ((select private.has_role(array['weigh'])));

-- 4) Change history (written only by the trigger below).
create table public.catch_history (
  id               bigint generated always as identity primary key,
  catch_id         uuid not null,
  tournament_id    uuid not null references public.tournaments(id) on delete cascade,
  changed_at       timestamptz not null default now(),
  changed_by       uuid,
  changed_by_email text,
  action           text not null check (action in ('edit', 'void', 'restore')),
  changes          jsonb not null
);
create index catch_history_catch_idx on public.catch_history (catch_id, changed_at);
create index catch_history_tournament_idx on public.catch_history (tournament_id);
alter table public.catch_history enable row level security;
revoke all on public.catch_history from anon;
revoke insert, update, delete, truncate on public.catch_history from authenticated;
grant select on public.catch_history to authenticated;
create policy "weigh read catch history" on public.catch_history for select to authenticated
  using ((select private.has_role(array['weigh'])));

create or replace function private.catches_log_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  o jsonb := to_jsonb(old); n jsonb := to_jsonb(new); ch jsonb := '{}'::jsonb; k text;
begin
  foreach k in array array['participant_id', 'species_id', 'weight_lbs', 'status', 'void_reason', 'note'] loop
    if (o -> k) is distinct from (n -> k) then
      ch := ch || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
    end if;
  end loop;
  if ch = '{}'::jsonb then return null; end if;
  insert into public.catch_history (catch_id, tournament_id, changed_by, changed_by_email, action, changes)
  values (new.id, new.tournament_id, auth.uid(), (select auth.jwt()) ->> 'email',
          case when new.status = 'voided' and old.status <> 'voided' then 'void'
               when new.status = 'active' and old.status = 'voided' then 'restore'
               else 'edit' end,
          ch);
  return null;
end $$;
create trigger catches_log_change after update on public.catches
  for each row execute function private.catches_log_change();

revoke all on function private.catches_assign_ticket() from public, anon, authenticated;
revoke all on function private.catches_log_change() from public, anon, authenticated;
