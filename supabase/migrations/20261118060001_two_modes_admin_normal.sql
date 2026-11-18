-- Security simplification (issue e5208d53): two modes, Admin and Normal.
--  * admin  = everything (admin-only actions still need Admin mode, i.e. the PIN unlock, as before).
--  * normal = all the working screens: registration / participants, weigh-in incl. ticket edits, leaderboard,
--             big screen, and reporting issues (own reports only). No Setup, no Issues management.
-- Old gate / weigh / screen roles become normal. An admin account in Normal mode has all normal rights.

alter table public.staff_roles drop constraint staff_roles_role_check;
-- collapse old roles (a user may have had several) into one 'normal' row
insert into public.staff_roles (user_id, role, display_name, created_at)
select user_id, 'normal', max(display_name), min(created_at)
  from public.staff_roles where role in ('gate', 'weigh', 'screen') group by user_id
on conflict (user_id, role) do nothing;
delete from public.staff_roles where role in ('gate', 'weigh', 'screen');
alter table public.staff_roles add constraint staff_roles_role_check check (role in ('admin', 'normal'));
comment on column public.staff_roles.role is 'admin = everything (Admin mode needs the PIN); normal = registration, weigh-in, leaderboards, big screen, report issues.';

-- participants / catches / history: normal (and admin) staff
drop policy "gate weigh read participants" on public.participants;
drop policy "gate insert participants" on public.participants;
drop policy "gate update participants" on public.participants;
create policy "staff read participants" on public.participants for select to authenticated
  using ((select private.has_role(array['normal'])));
create policy "staff insert participants" on public.participants for insert to authenticated
  with check ((select private.has_role(array['normal'])));
create policy "staff update participants" on public.participants for update to authenticated
  using ((select private.has_role(array['normal']))) with check ((select private.has_role(array['normal'])));

drop policy "gate weigh read catches" on public.catches;
drop policy "weigh insert catches" on public.catches;
drop policy "weigh update catches" on public.catches;
create policy "staff read catches" on public.catches for select to authenticated
  using ((select private.has_role(array['normal'])));
create policy "staff insert catches" on public.catches for insert to authenticated
  with check ((select private.has_role(array['normal'])));
create policy "staff update catches" on public.catches for update to authenticated
  using ((select private.has_role(array['normal']))) with check ((select private.has_role(array['normal'])));

drop policy "weigh read catch history" on public.catch_history;
create policy "staff read catch history" on public.catch_history for select to authenticated
  using ((select private.has_role(array['normal'])));

-- badge-number reservations for offline walk-ups
create or replace function private.reserve_codes(p_tournament_id uuid, p_count integer)
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_year int; v_start int;
begin
  if not private.has_role(array['normal']) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 200 then
    raise exception 'p_count must be between 1 and 200';
  end if;
  update public.tournaments set next_seq = next_seq + p_count
    where id = p_tournament_id and next_seq + p_count <= 100000
    returning year, next_seq - p_count into v_year, v_start;
  if v_year is null then
    raise exception 'Unknown tournament or out of participant numbers';
  end if;
  return array(select v_year::text || '_' || lpad(n::text, 5, '0')
               from generate_series(v_start, v_start + p_count - 1) n);
end $$;
