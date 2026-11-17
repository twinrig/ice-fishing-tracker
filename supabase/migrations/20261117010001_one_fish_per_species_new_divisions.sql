-- Organizer's rules (Nov 2026):
--  * Everybody is in Overall. Age categories: '12 & Under' (max 12) and '13-17' (13..17). Adults (18+) have no
--    Age/Division and appear only on Overall.
--  * One fish per species per angler (only one ACTIVE ticket per tournament + angler + species).
--  * Leaderboards: Overall, Species (grouped), Age (grouped).

-- 1) One fish per species ---------------------------------------------------------------------------------------
-- New status 'held': a weigh-in that synced (e.g. from an offline laptop) while the angler already had an active
-- ticket for that species. It is kept (never lost), doesn't count, and staff pick which one counts.
alter table public.catches drop constraint catches_status_check;
alter table public.catches add constraint catches_status_check check (status in ('active', 'voided', 'held'));
alter table public.catches add column replaces uuid;
comment on column public.catches.replaces is
  'Set at weigh-in when this fish replaces the angler''s earlier ticket for the same species; the server voids that ticket ("Replaced by #N").';
comment on column public.catches.status is
  'active = counts; voided = cancelled; held = duplicate species for this angler, waiting for staff to pick which ticket counts.';

create unique index catches_one_fish_per_species on public.catches (tournament_id, participant_id, species_id)
  where status = 'active';

create or replace function private.catches_one_per_species()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_other public.catches%rowtype;
  v_species text;
begin
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active'
     and new.participant_id = old.participant_id and new.species_id = old.species_id then
    return new;
  end if;
  -- serialize weigh-ins for the same angler + species so two laptops syncing at once can't both win
  perform pg_advisory_xact_lock(hashtextextended(new.tournament_id::text || '/' || new.participant_id::text || '/' || new.species_id::text, 0));

  if tg_op = 'INSERT' and new.replaces is not null then
    update public.catches
       set status = 'voided', void_reason = 'Replaced by #' || new.ticket_no
     where id = new.replaces and tournament_id = new.tournament_id and participant_id = new.participant_id
       and species_id = new.species_id and status = 'active';
  end if;

  select * into v_other from public.catches
   where tournament_id = new.tournament_id and participant_id = new.participant_id
     and species_id = new.species_id and status = 'active' and id <> new.id
   order by ticket_no limit 1;
  if not found then return new; end if;

  if tg_op = 'INSERT' then
    new.status := 'held';
    new.void_reason := format('One fish per species: this angler already has #%s (%s lbs). Pick which ticket counts.',
                              v_other.ticket_no, v_other.weight_lbs);
    return new;
  end if;
  select s.name into v_species from public.species s where s.id = new.species_id;
  raise exception 'This angler already has an active % ticket (#%). Only one fish per species counts – void that ticket first.',
    coalesce(v_species, 'same-species'), v_other.ticket_no using errcode = '23505';
end $$;
create trigger catches_one_per_species before insert or update on public.catches
  for each row execute function private.catches_one_per_species();
revoke all on function private.catches_one_per_species() from public, anon, authenticated;

-- history: held/voided -> active is a "restore"
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
               when new.status = 'active' and old.status <> 'active' then 'restore'
               else 'edit' end,
          ch);
  return null;
end $$;
revoke all on function private.catches_log_change() from public, anon, authenticated;

-- 2) Age/Divisions: 12 & Under, 13-17; adults have none ------------------------------------------------------------
alter table public.tournaments alter column age_groups set default array['12 & Under', '13-17'];
alter table public.tournaments alter column age_group_ranges
  set default '{"12 & Under": {"min": null, "max": 12}, "13-17": {"min": 13, "max": 17}}'::jsonb;

-- 3) Default boards for new tournaments: Overall, Species (grouped), Age (grouped) --------------------------------
create or replace function private.tournaments_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.leaderboard_configs (tournament_id, title, board_type, scoring, top_n, sort_order, split_mode) values
    (new.id, 'Overall', 'overall',   'total_weight', 10, 10, 'tabs'),
    (new.id, 'Species', 'species',   'biggest_fish', 5,  20, 'grouped'),
    (new.id, 'Age',     'age_group', 'total_weight', 5,  30, 'grouped');
  return null;
end $$;
revoke all on function private.tournaments_after_insert() from public, anon, authenticated;
-- Test tournaments (Ice Fish Fest, New Tourny2): new divisions + the three boards.
do $$
declare ids uuid[] := array['8dcf2cdc-58f9-496e-b382-b0075ecb9702', 'ac2d7a86-45c3-4c02-8fec-df37c22f195c']::uuid[];
begin
  -- hand-set divisions that no longer exist go back to automatic (from age)
  update public.participants set age_group_override = false
   where tournament_id = any (ids) and age_group_override
     and (age_group is null or age_group not in ('12 & Under', '13-17'));
  update public.tournaments
     set age_groups = array['12 & Under', '13-17'],
         age_group_ranges = '{"12 & Under": {"min": null, "max": 12}, "13-17": {"min": 13, "max": 17}}'::jsonb
   where id = any (ids);
  delete from public.leaderboard_configs where tournament_id = any (ids);
  insert into public.leaderboard_configs (tournament_id, title, board_type, scoring, top_n, sort_order, split_mode)
  select t, v.title, v.bt, v.sc, v.top, v.so, v.sm from unnest(ids) t
  cross join (values ('Overall', 'overall', 'total_weight', 10, 10, 'tabs'),
                     ('Species', 'species', 'biggest_fish', 5, 20, 'grouped'),
                     ('Age', 'age_group', 'total_weight', 5, 30, 'grouped')) v(title, bt, sc, top, so, sm);
end $$;
