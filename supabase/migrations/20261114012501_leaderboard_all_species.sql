-- Leaderboard "All" species option: a species board can rank across all species combined.
-- all_species = true  -> one board, every species counted (species_id must be null)
-- all_species = false, species_id null -> one board per species (unchanged behaviour)
alter table public.leaderboard_configs
  add column all_species boolean not null default false,
  add constraint leaderboard_configs_all_species_check check (not all_species or species_id is null);
comment on column public.leaderboard_configs.all_species is 'Species board ranking across all species combined (species_id must be null).';

create or replace function private.leaderboard(p_tournament_id uuid, p_known_version bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments%rowtype;
  c public.leaderboard_configs%rowtype;
  s record;
  g text;
  v_boards jsonb := '[]'::jsonb;
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

  for c in select * from public.leaderboard_configs
           where tournament_id = t.id and enabled order by sort_order, created_at loop
    if c.board_type = 'species' and c.species_id is null and not c.all_species then
      for s in select sp.id, sp.name from public.species sp
               where sp.tournament_id = t.id order by sp.sort_order, sp.name loop
        v_boards := v_boards || jsonb_build_array(jsonb_build_object(
          'title', c.title || ' – ' || s.name, 'scoring', c.scoring,
          'rows', private.board_rows(t.id, c.scoring, s.id, null, c.top_n)));
      end loop;
    elsif c.board_type = 'age_group' and c.age_group is null then
      foreach g in array t.age_groups loop
        v_boards := v_boards || jsonb_build_array(jsonb_build_object(
          'title', c.title || ' – ' || g, 'scoring', c.scoring,
          'rows', private.board_rows(t.id, c.scoring, null, g, c.top_n)));
      end loop;
    else
      -- overall, a single species, or species = All (species_id null -> every species)
      v_boards := v_boards || jsonb_build_array(jsonb_build_object(
        'title', c.title, 'scoring', c.scoring,
        'rows', private.board_rows(t.id, c.scoring, c.species_id, c.age_group, c.top_n)));
    end if;
  end loop;

  return jsonb_build_object(
    'v', t.data_version,
    'tournament', jsonb_build_object('id', t.id, 'name', t.name, 'year', t.year, 'status', t.status),
    'generated_at', now(),
    'boards', v_boards);
end $$;
revoke all on function private.leaderboard(uuid, bigint) from public;
grant execute on function private.leaderboard(uuid, bigint) to anon, authenticated;
