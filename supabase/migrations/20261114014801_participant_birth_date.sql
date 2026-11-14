-- Optional birth date on participants. When present, age is computed in whole years
-- as of the tournament's event_date (or today if the tournament has no event date),
-- then the Age/Division is assigned from age as before.

alter table public.participants
  add column birth_date date check (birth_date is null or birth_date between date '1900-01-01' and date '2100-12-31');
comment on column public.participants.birth_date is 'Optional. When set, age is computed from it as of tournaments.event_date (or today).';

create or replace function private.age_on(p_birth date, p_as_of date)
returns int language sql immutable set search_path = '' as $$
  select case when p_birth is null or p_birth > p_as_of then null
              else extract(year from age(p_as_of, p_birth))::int end;
$$;

create or replace function private.participant_age(p_tournament_id uuid, p_birth date, p_age int)
returns int language sql stable security definer set search_path = '' as $$
  select case when p_birth is null then p_age
              else private.age_on(p_birth, coalesce((select t.event_date from public.tournaments t where t.id = p_tournament_id), current_date))
         end;
$$;

-- Age first (from birth date), then Age/Division (unless set by hand).
create or replace function private.participants_assign_division()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.birth_date is not null then
    new.age := private.participant_age(new.tournament_id, new.birth_date, new.age);
    if new.age is not null and new.age > 120 then new.age := null; end if;
  end if;
  if not new.age_group_override then
    new.age_group := private.division_for_age(new.tournament_id, new.age);
  end if;
  return new;
end $$;

-- Re-run when Age/Division names/ranges OR the event date change.
create or replace function private.tournaments_reassign_divisions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.participants p
     set age = private.participant_age(p.tournament_id, p.birth_date, p.age)
   where p.tournament_id = new.id
     and p.birth_date is not null
     and p.age is distinct from private.participant_age(p.tournament_id, p.birth_date, p.age);
  update public.participants p
     set age_group = private.division_for_age(p.tournament_id, p.age)
   where p.tournament_id = new.id
     and not p.age_group_override
     and p.age_group is distinct from private.division_for_age(p.tournament_id, p.age);
  return null;
end $$;
drop trigger if exists tournaments_reassign_divisions on public.tournaments;
create trigger tournaments_reassign_divisions after update of age_groups, age_group_ranges, event_date on public.tournaments
  for each row when (old.age_groups is distinct from new.age_groups
                     or old.age_group_ranges is distinct from new.age_group_ranges
                     or old.event_date is distinct from new.event_date)
  execute function private.tournaments_reassign_divisions();

revoke all on function private.age_on(date, date) from public, anon, authenticated;
revoke all on function private.participant_age(uuid, date, int) from public, anon, authenticated;
revoke all on function private.participants_assign_division() from public, anon, authenticated;
revoke all on function private.tournaments_reassign_divisions() from public, anon, authenticated;
