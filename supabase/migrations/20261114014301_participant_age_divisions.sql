-- Club changes: participant age + automatic Age/Division assignment from per-tournament age ranges.
--
-- tournaments.age_groups (text[])        ordered Age/Division names (unchanged)
-- tournaments.age_group_ranges (jsonb)   {"<name>": {"min": int|null, "max": int|null}, ...}
-- participants.age (int)                 whole years
-- participants.age_group_override (bool) true = Age/Division was picked by hand, don't auto-assign
--
-- Rule: when override is false, age_group = first Age/Division (in age_groups order) whose
-- min <= age <= max (a missing bound is open-ended; a division with no bounds never matches).
-- Blank age or no match -> age_group is null (the app flags it).

alter table public.tournaments
  add column age_group_ranges jsonb not null default '{}'::jsonb
    check (jsonb_typeof(age_group_ranges) = 'object');
comment on column public.tournaments.age_group_ranges is
  'Age/Division ranges: {"Youth": {"min": 0, "max": 12}, ...}. Keys match age_groups.';

alter table public.participants
  add column age int check (age is null or age between 0 and 120),
  add column age_group_override boolean not null default false;
comment on column public.participants.age is 'Age in whole years.';
comment on column public.participants.age_group_override is 'true = Age/Division set manually; false = assigned from age automatically.';

-- Existing participants were given their Age/Division by hand (no ages yet): keep them as manual.
update public.participants set age_group_override = true where age_group is not null;

create or replace function private.division_for_age(p_tournament_id uuid, p_age int)
returns text language sql stable security definer set search_path = '' as $$
  select g.name
  from public.tournaments t
  cross join lateral unnest(t.age_groups) with ordinality as g(name, ord)
  cross join lateral (select t.age_group_ranges -> g.name as r) rr
  where t.id = p_tournament_id
    and p_age is not null
    and rr.r is not null
    and (rr.r ->> 'min' is not null or rr.r ->> 'max' is not null)
    and (rr.r ->> 'min' is null or p_age >= (rr.r ->> 'min')::int)
    and (rr.r ->> 'max' is null or p_age <= (rr.r ->> 'max')::int)
  order by g.ord
  limit 1;
$$;

create or replace function private.participants_assign_division()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.age_group_override then
    new.age_group := private.division_for_age(new.tournament_id, new.age);
  end if;
  return new;
end $$;
create trigger participants_assign_division before insert or update on public.participants
  for each row execute function private.participants_assign_division();

-- When a tournament's Age/Division names or ranges change, re-assign its automatic participants.
create or replace function private.tournaments_reassign_divisions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.participants p
     set age_group = private.division_for_age(p.tournament_id, p.age)
   where p.tournament_id = new.id
     and not p.age_group_override
     and p.age_group is distinct from private.division_for_age(p.tournament_id, p.age);
  return null;
end $$;
create trigger tournaments_reassign_divisions after update of age_groups, age_group_ranges on public.tournaments
  for each row when (old.age_groups is distinct from new.age_groups or old.age_group_ranges is distinct from new.age_group_ranges)
  execute function private.tournaments_reassign_divisions();

-- Default board name for new tournaments
create or replace function private.tournaments_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.leaderboard_configs (tournament_id, title, board_type, scoring, top_n, sort_order) values
    (new.id, 'Overall – Total Weight', 'overall',   'total_weight', 10, 10),
    (new.id, 'Big Fish',               'overall',   'biggest_fish', 10, 20),
    (new.id, 'Species',                'species',   'total_weight',  5, 30),
    (new.id, 'Age/Division',           'age_group', 'total_weight',  5, 40);
  return null;
end $$;

-- data_version bump when ranges change (public boards refresh)
create or replace function private.tournaments_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.name, new.year, new.event_date, new.status, new.public_visible, new.age_groups, new.age_group_ranges)
     is distinct from (old.name, old.year, old.event_date, old.status, old.public_visible, old.age_groups, old.age_group_ranges) then
    new.updated_at := now();
    new.updated_by := auth.uid();
    new.data_version := greatest(new.data_version, old.data_version + 1);
  end if;
  return new;
end $$;

revoke all on function private.division_for_age(uuid, int) from public, anon, authenticated;
revoke all on function private.participants_assign_division() from public, anon, authenticated;
revoke all on function private.tournaments_reassign_divisions() from public, anon, authenticated;
revoke all on function private.tournaments_after_insert() from public, anon, authenticated;
revoke all on function private.tournaments_before_update() from public, anon, authenticated;
