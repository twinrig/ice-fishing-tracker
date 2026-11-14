-- Admin-only "delete tournament" with typed-name confirmation, done in one transaction.
create or replace function private.delete_tournament(p_tournament_id uuid, p_confirm_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  t public.tournaments;
  n_c int; n_p int; n_l int; n_s int;
begin
  if not private.has_role(array['admin']) then
    raise exception 'Only admins can delete tournaments' using errcode = '42501';
  end if;
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then
    raise exception 'Tournament not found (already deleted?)' using errcode = 'P0002';
  end if;
  if btrim(coalesce(p_confirm_name, '')) <> btrim(t.name) then
    raise exception 'The typed name does not match the tournament name' using errcode = '22023';
  end if;
  -- Children first (catches -> species is ON DELETE RESTRICT), then the tournament itself.
  delete from public.catches where tournament_id = t.id;             get diagnostics n_c = row_count;
  delete from public.participants where tournament_id = t.id;        get diagnostics n_p = row_count;
  delete from public.leaderboard_configs where tournament_id = t.id; get diagnostics n_l = row_count;
  delete from public.species where tournament_id = t.id;             get diagnostics n_s = row_count;
  delete from public.tournaments where id = t.id;
  return jsonb_build_object('id', t.id, 'name', t.name, 'catches', n_c, 'participants', n_p,
                            'leaderboards', n_l, 'species', n_s);
end $$;

create or replace function public.delete_tournament(p_tournament_id uuid, p_confirm_name text)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.delete_tournament(p_tournament_id, p_confirm_name);
$$;

revoke all on function private.delete_tournament(uuid, text) from public, anon, authenticated;
grant execute on function private.delete_tournament(uuid, text) to authenticated;
revoke all on function public.delete_tournament(uuid, text) from public, anon;
grant execute on function public.delete_tournament(uuid, text) to authenticated;

-- Let open staff stations hear that a tournament was deleted (they subscribe to DELETE events only).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tournaments') then
    alter publication supabase_realtime add table public.tournaments;
  end if;
end $$;
