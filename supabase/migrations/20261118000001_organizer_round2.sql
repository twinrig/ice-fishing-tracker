-- Organizer notes, round 2 (Nov 2026):
--  * Every weigh-in counts (an angler may weigh several fish of the same species). Each leaderboard uses ONE fish
--    per angler: Overall and Youth Divisions = the angler's single biggest fish (any species); each Species =
--    the angler's biggest fish of that species. Kids appear in Overall AND their youth division.
--  * Fixed leaderboards: Overall, Youth Divisions (one section per age division), Species (one section per species).
--    Rows show the species and weight of the counted fish; no division label. (leaderboard_configs is no longer used.)
--  * Overall is implicit (everyone) – never an age division. Youth divisions: 'Teenage 13 to 17', 'Kids 12 & Under'.
--  * Divisions are always automatic from age / birth date (no hand-set division).
--  * Participants get hole_tickets (1 or 2). Tournaments get big-screen scroll settings and an optional header image.

-- 1) Every weigh-in counts: drop the one-fish-per-species rule and release any held tickets -------------------------
drop trigger if exists catches_one_per_species on public.catches;
drop function if exists private.catches_one_per_species();
drop index if exists public.catches_one_fish_per_species;
update public.catches set status = 'active', void_reason = null where status = 'held';
comment on column public.catches.status is 'active = counts; voided = cancelled. (held is no longer used.)';
comment on column public.catches.replaces is 'Legacy (Nov 2026 one-fish-per-species rule); no longer set.';

-- 2) Participants: hole tickets; divisions always automatic -------------------------------------------------------
alter table public.participants add column if not exists hole_tickets smallint
  check (hole_tickets is null or hole_tickets in (1, 2));
comment on column public.participants.hole_tickets is 'Ticket bought at sign-up: 1 = one-hole ticket, 2 = two-hole ticket.';

create or replace function private.participants_assign_division()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.birth_date is not null then
    new.age := private.participant_age(new.tournament_id, new.birth_date, new.age);
    if new.age is not null and new.age > 120 then new.age := null; end if;
  end if;
  new.age_group_override := false; -- divisions are always worked out from age (Overall is everyone)
  new.age_group := private.division_for_age(new.tournament_id, new.age);
  return new;
end $$;
revoke all on function private.participants_assign_division() from public, anon, authenticated;

-- 3) Tournaments: big-screen scrolling + header image -------------------------------------------------------------
alter table public.tournaments
  add column if not exists screen_scroll_speed int not null default 40 check (screen_scroll_speed between 5 and 400),
  add column if not exists screen_pause_seconds int not null default 5 check (screen_pause_seconds between 0 and 120),
  add column if not exists header_image_url text
    check (header_image_url is null or (length(header_image_url) <= 500 and header_image_url ~* '^(https://|assets/)'));
comment on column public.tournaments.screen_scroll_speed is 'Big screen: scroll speed in pixels per second.';
comment on column public.tournaments.screen_pause_seconds is 'Big screen: pause at the top and bottom, in seconds.';
comment on column public.tournaments.header_image_url is 'Optional header graphic (https://… or assets/…); blank = assets/header.png, else the text title.';

create or replace function private.tournaments_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.name, new.year, new.event_date, new.status, new.public_visible, new.age_groups, new.age_group_ranges,
      new.screen_scroll_speed, new.screen_pause_seconds, new.header_image_url)
     is distinct from (old.name, old.year, old.event_date, old.status, old.public_visible, old.age_groups, old.age_group_ranges,
      old.screen_scroll_speed, old.screen_pause_seconds, old.header_image_url) then
    new.updated_at := now();
    new.updated_by := auth.uid();
    new.data_version := greatest(new.data_version, old.data_version + 1);
  end if;
  return new;
end $$;
revoke all on function private.tournaments_before_update() from public, anon, authenticated;

-- 4) Youth divisions: defaults, and never an "Overall" age group -----------------------------------------------------
alter table public.tournaments alter column age_groups set default array['Teenage 13 to 17', 'Kids 12 & Under'];
alter table public.tournaments alter column age_group_ranges
  set default '{"Teenage 13 to 17": {"min": 13, "max": 17}, "Kids 12 & Under": {"min": null, "max": 12}}'::jsonb;

update public.participants set age_group_override = false where age_group_override;
-- Remove any "Overall" age group (Overall is implicit) and rename the previous default names.
update public.tournaments t
   set age_groups = x.groups, age_group_ranges = x.ranges
  from (
    select t2.id,
           coalesce(array_agg(n.new_name order by n.ord) filter (where n.new_name is not null), '{}') as groups,
           coalesce(jsonb_object_agg(n.new_name, t2.age_group_ranges -> n.old_name) filter (where n.new_name is not null), '{}'::jsonb) as ranges
      from public.tournaments t2
      cross join lateral unnest(t2.age_groups) with ordinality as g(old_name, ord)
      cross join lateral (select g.old_name, g.ord,
             case when lower(btrim(g.old_name)) = 'overall' then null
                  when g.old_name = '13-17' then 'Teenage 13 to 17'
                  when g.old_name = '12 & Under' then 'Kids 12 & Under'
                  else g.old_name end as new_name) n
     group by t2.id
  ) x
 where t.id = x.id and (t.age_groups is distinct from x.groups or t.age_group_ranges is distinct from x.ranges);
-- (tournaments_reassign_divisions re-places everyone in the changed tournaments)

create or replace function private.tournaments_check_divisions()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from unnest(new.age_groups) g where lower(btrim(g)) = 'overall') then
    raise exception 'Overall is automatic (everyone is in it) – don''t add it as an age division.' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.tournaments_check_divisions() from public, anon, authenticated;
drop trigger if exists tournaments_check_divisions on public.tournaments;
create trigger tournaments_check_divisions before insert or update of age_groups on public.tournaments
  for each row execute function private.tournaments_check_divisions();

-- 5) Leaderboards: each angler's best fish per board ----------------------------------------------------------------
create or replace function private.best_fish_rows(p_tournament_id uuid, p_species_id uuid, p_age_group text, p_top_n int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('rank', r.rnk, 'name', r.display_name, 'species', r.species, 'lbs', r.weight_lbs)
                            order by r.rnk, r.display_name), '[]'::jsonb)
  from (
    select rank() over (order by b.weight_lbs desc) as rnk, p.display_name, s.name as species, b.weight_lbs
    from (
      select distinct on (c.participant_id) c.participant_id, c.species_id, c.weight_lbs
        from public.catches c
       where c.tournament_id = p_tournament_id and c.status = 'active'
         and (p_species_id is null or c.species_id = p_species_id)
       order by c.participant_id, c.weight_lbs desc, c.weighed_at, c.ticket_no
    ) b
    join public.participants p on p.id = b.participant_id
    left join public.species s on s.id = b.species_id
    where p_age_group is null or p.age_group = p_age_group
    order by b.weight_lbs desc, p.display_name
    limit p_top_n
  ) r;
$$;
revoke all on function private.best_fish_rows(uuid, uuid, text, int) from public, anon, authenticated;

create or replace function private.leaderboard(p_tournament_id uuid, p_known_version bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments%rowtype;
  s record;
  g text;
  v_youth jsonb := '[]'::jsonb;
  v_species jsonb := '[]'::jsonb;
begin
  if p_tournament_id is null then
    select * into t from public.tournaments
      where public_visible
      order by (status = 'active') desc, year desc, created_at desc limit 1;
  else
    select * into t from public.tournaments where id = p_tournament_id and public_visible;
  end if;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if p_known_version is not null and p_known_version = t.data_version then
    return jsonb_build_object('v', t.data_version, 'unchanged', true);
  end if;

  foreach g in array coalesce(t.age_groups, '{}') loop
    v_youth := v_youth || jsonb_build_array(jsonb_build_object('name', g, 'rows', private.best_fish_rows(t.id, null, g, null)));
  end loop;
  for s in select sp.id, sp.name from public.species sp where sp.tournament_id = t.id order by sp.sort_order, sp.name loop
    v_species := v_species || jsonb_build_array(jsonb_build_object('name', s.name, 'rows', private.best_fish_rows(t.id, s.id, null, null)));
  end loop;

  return jsonb_build_object(
    'v', t.data_version,
    'tournament', jsonb_build_object('id', t.id, 'name', t.name, 'year', t.year, 'status', t.status,
                                     'header_image_url', t.header_image_url,
                                     'screen', jsonb_build_object('scroll_speed', t.screen_scroll_speed, 'pause_seconds', t.screen_pause_seconds)),
    'generated_at', now(),
    'boards', jsonb_build_array(
      jsonb_build_object('key', 'overall', 'title', 'Overall', 'rows', private.best_fish_rows(t.id, null, null, null)),
      jsonb_build_object('key', 'youth', 'title', 'Youth Divisions', 'rows', '[]'::jsonb, 'groups', v_youth),
      jsonb_build_object('key', 'species', 'title', 'Species', 'rows', '[]'::jsonb, 'groups', v_species)));
end $$;
revoke all on function private.leaderboard(uuid, bigint) from public;
grant execute on function private.leaderboard(uuid, bigint) to anon, authenticated;
