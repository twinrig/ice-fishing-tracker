-- Club changes (2026-11-14):
--  1. Remove angler check-in (status/time/by columns and trigger logic)
--  2. Weight is one decimal-pounds field (weight_lbs numeric(6,2)); convert existing ounces
--  3. Remove fish length
--  4. Remove staff initials (recorded_by + station are still captured automatically)

------------------------------------------------------------------------------
-- 1. Check-in
------------------------------------------------------------------------------
create or replace function private.participants_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_year int; v_seq int;
begin
  if new.participant_code is null or btrim(new.participant_code) = '' then
    update public.tournaments set next_seq = next_seq + 1
      where id = new.tournament_id
      returning year, next_seq - 1 into v_year, v_seq;
    if v_year is null then
      raise exception 'Unknown tournament %', new.tournament_id;
    end if;
    new.participant_code := v_year::text || '_' || lpad(v_seq::text, 5, '0');
  elsif split_part(new.participant_code, '_', 2) ~ '^[0-9]{5}$' then
    update public.tournaments
      set next_seq = greatest(next_seq, split_part(new.participant_code, '_', 2)::int + 1)
      where id = new.tournament_id
        and next_seq <= split_part(new.participant_code, '_', 2)::int;
  end if;
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end $$;

create or replace function private.participants_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.tournament_id <> old.tournament_id then
    raise exception 'tournament_id cannot be changed';
  end if;
  if new.participant_code <> old.participant_code and not private.has_role(array['admin']) then
    raise exception 'Only an admin can change a participant code' using errcode = '42501';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

alter table public.participants
  drop column if exists check_in_status,
  drop column if exists checked_in_at,
  drop column if exists checked_in_by;

------------------------------------------------------------------------------
-- 2-4. Catches: decimal pounds, no length, no initials
------------------------------------------------------------------------------
alter table public.catches add column weight_lbs numeric(6,2);
update public.catches set weight_lbs = round(weight_oz / 16.0, 2);
-- anything that rounds to 0.00 lb becomes the smallest legal value
update public.catches set weight_lbs = 0.01 where weight_lbs <= 0;
alter table public.catches
  alter column weight_lbs set not null,
  add constraint catches_weight_lbs_check check (weight_lbs > 0 and weight_lbs <= 500);
comment on column public.catches.weight_lbs is 'Fish weight in decimal pounds (e.g. 2.35).';

drop index if exists public.catches_board_idx;
alter table public.catches
  drop column weight_oz,
  drop column if exists length_in,
  drop column if exists staff_initials;
create index catches_board_idx on public.catches (tournament_id, status) include (participant_id, species_id, weight_lbs);

-- Leaderboard rows now report 'lbs' instead of 'oz'
create or replace function private.board_rows(
  p_tournament_id uuid, p_scoring text, p_species_id uuid, p_age_group text, p_top_n int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', r.rnk, 'name', r.display_name, 'group', r.age_group, 'fish', r.fish, 'lbs', r.score)
         order by r.rnk, r.display_name), '[]'::jsonb)
  from (
    select rank() over (order by a.score desc) as rnk, p.display_name, p.age_group, a.fish, a.score
    from (
      select c.participant_id, count(*)::int as fish,
             case when p_scoring = 'biggest_fish' then max(c.weight_lbs) else sum(c.weight_lbs) end as score
      from public.catches c
      where c.tournament_id = p_tournament_id
        and c.status = 'active'
        and (p_species_id is null or c.species_id = p_species_id)
      group by c.participant_id
    ) a
    join public.participants p on p.id = a.participant_id
    where p_age_group is null or p.age_group = p_age_group
    order by a.score desc, p.display_name
    limit p_top_n
  ) r;
$$;
revoke all on function private.board_rows(uuid, text, uuid, text, int) from public, anon, authenticated;
revoke all on function private.participants_before_insert() from public, anon, authenticated;
revoke all on function private.participants_before_update() from public, anon, authenticated;

-- Make cached public leaderboards refetch
update public.tournaments set data_version = data_version + 1;
