-- Club clarification: "All" on a species / age-group board means ONE board (one public tab, one TV slide)
-- with a separate ranked section per species / age group.
-- split_mode (only used when the board's species_id / age_group is empty):
--   'tabs'     -> one board per species / age group (original "Each" behaviour)
--   'grouped'  -> one board, sections per species / age group ("All ..., grouped on one board")
--   'combined' -> one board, single ranking across all of them ("Any ..., combined ranking")
alter table public.leaderboard_configs
  add column split_mode text not null default 'tabs'
    check (split_mode in ('tabs','grouped','combined'));
-- The existing "All species" boards were meant to be grouped (per the club's clarification).
update public.leaderboard_configs set split_mode = 'grouped' where all_species;
alter table public.leaderboard_configs
  drop constraint if exists leaderboard_configs_all_species_check,
  drop column all_species,
  add constraint leaderboard_configs_split_scope_check
    check (split_mode = 'tabs' or (board_type <> 'overall' and species_id is null and age_group is null));
comment on column public.leaderboard_configs.split_mode is
  'tabs = one board per species/age group; grouped = one board with a section per species/age group; combined = one board, single ranking.';

create or replace function private.leaderboard(p_tournament_id uuid, p_known_version bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t public.tournaments%rowtype;
  c public.leaderboard_configs%rowtype;
  s record;
  g text;
  v_groups jsonb;
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
    if c.board_type = 'species' and c.species_id is null and c.split_mode = 'tabs' then
      for s in select sp.id, sp.name from public.species sp
               where sp.tournament_id = t.id order by sp.sort_order, sp.name loop
        v_boards := v_boards || jsonb_build_array(jsonb_build_object(
          'title', c.title || ' – ' || s.name, 'scoring', c.scoring,
          'rows', private.board_rows(t.id, c.scoring, s.id, null, c.top_n)));
      end loop;
    elsif c.board_type = 'species' and c.species_id is null and c.split_mode = 'grouped' then
      v_groups := '[]'::jsonb;
      for s in select sp.id, sp.name from public.species sp
               where sp.tournament_id = t.id order by sp.sort_order, sp.name loop
        v_groups := v_groups || jsonb_build_array(jsonb_build_object(
          'name', s.name, 'rows', private.board_rows(t.id, c.scoring, s.id, null, c.top_n)));
      end loop;
      v_boards := v_boards || jsonb_build_array(jsonb_build_object(
        'title', c.title, 'scoring', c.scoring, 'rows', '[]'::jsonb, 'groups', v_groups));
    elsif c.board_type = 'age_group' and c.age_group is null and c.split_mode = 'tabs' then
      foreach g in array t.age_groups loop
        v_boards := v_boards || jsonb_build_array(jsonb_build_object(
          'title', c.title || ' – ' || g, 'scoring', c.scoring,
          'rows', private.board_rows(t.id, c.scoring, null, g, c.top_n)));
      end loop;
    elsif c.board_type = 'age_group' and c.age_group is null and c.split_mode = 'grouped' then
      v_groups := '[]'::jsonb;
      foreach g in array t.age_groups loop
        v_groups := v_groups || jsonb_build_array(jsonb_build_object(
          'name', g, 'rows', private.board_rows(t.id, c.scoring, null, g, c.top_n)));
      end loop;
      v_boards := v_boards || jsonb_build_array(jsonb_build_object(
        'title', c.title, 'scoring', c.scoring, 'rows', '[]'::jsonb, 'groups', v_groups));
    else
      -- overall, a single species / age group, or 'combined' (null filter = everything in one ranking)
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
