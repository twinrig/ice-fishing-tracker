-- Ice Fishing Tournament Tracker: initial schema, RLS, leaderboard RPCs, realtime
-- Weights are stored as total ounces (numeric). 1 lb = 16 oz.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------
create table public.tournaments (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 120),
  year           int  not null check (year between 2020 and 2100),
  event_date     date,
  status         text not null default 'setup' check (status in ('setup','active','closed')),
  public_visible boolean not null default true,
  age_groups     text[] not null default array['Youth','Adult','Senior'],
  next_seq       int  not null default 1 check (next_seq between 1 and 100000),
  data_version   bigint not null default 1,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
comment on column public.tournaments.next_seq is 'Next participant sequence number (the ##### in yyyy_#####).';
comment on column public.tournaments.data_version is 'Bumped on every change that affects the leaderboard; lets public viewers skip unchanged polls.';

create table public.species (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  unique (tournament_id, name),
  unique (id, tournament_id)
);

create table public.participants (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references public.tournaments(id) on delete cascade,
  participant_code text not null check (participant_code ~ '^[0-9]{4}_[0-9]{5}$'),
  display_name     text not null check (length(btrim(display_name)) between 1 and 120),
  age_group        text check (age_group is null or length(age_group) <= 40),
  email            text check (email is null or length(email) <= 254),
  phone            text check (phone is null or length(phone) <= 40),
  source           text not null default 'walkup' check (source in ('preregistered','walkup','import')),
  check_in_status  text not null default 'not_arrived' check (check_in_status in ('not_arrived','arrived')),
  checked_in_at    timestamptz,
  checked_in_by    uuid,
  notes            text check (notes is null or length(notes) <= 500),
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (tournament_id, participant_code),
  unique (id, tournament_id)
);

create table public.catches (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  participant_id uuid not null,
  species_id     uuid not null,
  weight_oz      numeric(7,2) not null check (weight_oz > 0 and weight_oz <= 1600),
  length_in      numeric(5,2) check (length_in is null or (length_in > 0 and length_in < 100)),
  station        text check (station is null or length(station) <= 40),
  staff_initials text check (staff_initials is null or length(staff_initials) <= 10),
  recorded_by    uuid references auth.users(id) on delete set null,
  weighed_at     timestamptz not null default now(),
  source         text not null default 'station' check (source in ('station','import')),
  status         text not null default 'active' check (status in ('active','voided')),
  void_reason    text check (void_reason is null or length(void_reason) <= 200),
  voided_at      timestamptz,
  voided_by      uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  foreign key (participant_id, tournament_id) references public.participants(id, tournament_id) on delete cascade,
  foreign key (species_id, tournament_id) references public.species(id, tournament_id) on delete restrict
);
comment on column public.catches.weight_oz is 'Total weight in ounces (lbs*16 + oz).';

create table public.leaderboard_configs (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 80),
  board_type    text not null check (board_type in ('overall','species','age_group')),
  scoring       text not null default 'total_weight' check (scoring in ('total_weight','biggest_fish')),
  species_id    uuid,
  age_group     text,
  top_n         int  not null default 10 check (top_n between 1 and 100),
  sort_order    int  not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  foreign key (species_id, tournament_id) references public.species(id, tournament_id) on delete cascade
);
comment on table public.leaderboard_configs is 'species/age_group boards with a null species_id/age_group expand to one board per species/age group.';

create table public.staff_roles (
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('admin','gate','weigh','screen')),
  display_name text check (display_name is null or length(display_name) <= 80),
  created_at   timestamptz not null default now(),
  primary key (user_id, role)
);

------------------------------------------------------------------------------
-- Indexes (FKs + hot paths)
------------------------------------------------------------------------------
create index catches_board_idx on public.catches (tournament_id, status) include (participant_id, species_id, weight_oz);
create index catches_participant_idx on public.catches (participant_id, tournament_id);
create index catches_species_idx on public.catches (species_id, tournament_id);
create index catches_recorded_by_idx on public.catches (recorded_by);
create index leaderboard_configs_tournament_idx on public.leaderboard_configs (tournament_id, sort_order);
create index leaderboard_configs_species_idx on public.leaderboard_configs (species_id, tournament_id) where species_id is not null;
create index participants_name_idx on public.participants (tournament_id, display_name);

------------------------------------------------------------------------------
-- Role helpers (private schema = not exposed through the API)
------------------------------------------------------------------------------
create or replace function private.has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.user_id = (select auth.uid())
      and (sr.role = 'admin' or sr.role = any (p_roles))
  );
$$;

create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_roles sr where sr.user_id = (select auth.uid()));
$$;

------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------
create or replace function private.tournaments_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.name, new.year, new.event_date, new.status, new.public_visible, new.age_groups)
     is distinct from (old.name, old.year, old.event_date, old.status, old.public_visible, old.age_groups) then
    new.updated_at := now();
    new.updated_by := auth.uid();
    new.data_version := greatest(new.data_version, old.data_version + 1);
  end if;
  return new;
end $$;
create trigger tournaments_before_update before update on public.tournaments
  for each row execute function private.tournaments_before_update();

create or replace function private.tournaments_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.leaderboard_configs (tournament_id, title, board_type, scoring, top_n, sort_order) values
    (new.id, 'Overall – Total Weight', 'overall',   'total_weight', 10, 10),
    (new.id, 'Big Fish',               'overall',   'biggest_fish', 10, 20),
    (new.id, 'Species',                'species',   'total_weight',  5, 30),
    (new.id, 'Age Group',              'age_group', 'total_weight',  5, 40);
  return null;
end $$;
create trigger tournaments_after_insert after insert on public.tournaments
  for each row execute function private.tournaments_after_insert();

-- Assigns yyyy_##### codes server-side so several gate laptops never collide.
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
  if new.check_in_status = 'arrived' and new.checked_in_at is null then
    new.checked_in_at := now();
  end if;
  if new.check_in_status = 'arrived' then
    new.checked_in_by := coalesce(auth.uid(), new.checked_in_by);
  end if;
  return new;
end $$;
create trigger participants_before_insert before insert on public.participants
  for each row execute function private.participants_before_insert();

create or replace function private.participants_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.tournament_id <> old.tournament_id then
    raise exception 'tournament_id cannot be changed';
  end if;
  if new.participant_code <> old.participant_code and not private.has_role(array['admin']) then
    raise exception 'Only an admin can change a participant code' using errcode = '42501';
  end if;
  if new.check_in_status = 'arrived' and old.check_in_status <> 'arrived' then
    new.checked_in_at := coalesce(new.checked_in_at, now());
    new.checked_in_by := auth.uid();
  elsif new.check_in_status = 'not_arrived' then
    new.checked_in_at := null;
    new.checked_in_by := null;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger participants_before_update before update on public.participants
  for each row execute function private.participants_before_update();

create or replace function private.catches_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_by := coalesce(auth.uid(), new.recorded_by);
  else
    if new.tournament_id <> old.tournament_id then
      raise exception 'tournament_id cannot be changed';
    end if;
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
create trigger catches_before_write before insert or update on public.catches
  for each row execute function private.catches_before_write();

-- Bump tournaments.data_version whenever leaderboard inputs change.
create or replace function private.bump_tournament_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_tid uuid;
begin
  if tg_op = 'DELETE' then v_tid := old.tournament_id; else v_tid := new.tournament_id; end if;
  update public.tournaments set data_version = data_version + 1 where id = v_tid;
  return null;
end $$;
create trigger catches_bump after insert or update or delete on public.catches
  for each row execute function private.bump_tournament_version();
create trigger participants_bump after insert or update of display_name, age_group or delete on public.participants
  for each row execute function private.bump_tournament_version();
create trigger species_bump after insert or update or delete on public.species
  for each row execute function private.bump_tournament_version();
create trigger leaderboard_configs_bump after insert or update or delete on public.leaderboard_configs
  for each row execute function private.bump_tournament_version();

------------------------------------------------------------------------------
-- Leaderboard (public, read-only, no contact info)
------------------------------------------------------------------------------
create or replace function private.board_rows(
  p_tournament_id uuid, p_scoring text, p_species_id uuid, p_age_group text, p_top_n int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', r.rnk, 'name', r.display_name, 'group', r.age_group, 'fish', r.fish, 'oz', r.score)
         order by r.rnk, r.display_name), '[]'::jsonb)
  from (
    select rank() over (order by a.score desc) as rnk, p.display_name, p.age_group, a.fish, a.score
    from (
      select c.participant_id, count(*)::int as fish,
             case when p_scoring = 'biggest_fish' then max(c.weight_oz) else sum(c.weight_oz) end as score
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
    if c.board_type = 'species' and c.species_id is null then
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

create or replace function private.public_tournaments()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'year', year, 'status', status)
                            order by (status = 'active') desc, year desc, created_at desc), '[]'::jsonb)
  from public.tournaments where public_visible;
$$;

-- Gate laptops reserve a block of codes so they can print badges while offline.
create or replace function private.reserve_codes(p_tournament_id uuid, p_count int)
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_year int; v_start int;
begin
  if not private.has_role(array['gate']) then
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

-- Public API wrappers (security invoker; the privileged work lives in private.*)
create or replace function public.get_leaderboard(p_tournament_id uuid default null, p_known_version bigint default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.leaderboard(p_tournament_id, p_known_version);
$$;

create or replace function public.list_public_tournaments()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.public_tournaments();
$$;

create or replace function public.reserve_participant_codes(p_tournament_id uuid, p_count int default 25)
returns text[] language sql volatile security invoker set search_path = '' as $$
  select private.reserve_codes(p_tournament_id, p_count);
$$;

------------------------------------------------------------------------------
-- Privileges
------------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.leaderboard(uuid, bigint) to anon, authenticated;
grant execute on function private.public_tournaments() to anon, authenticated;
grant execute on function private.has_role(text[]) to authenticated;
grant execute on function private.is_staff() to authenticated;
grant execute on function private.reserve_codes(uuid, int) to authenticated;

revoke all on function public.get_leaderboard(uuid, bigint) from public;
revoke all on function public.list_public_tournaments() from public;
revoke all on function public.reserve_participant_codes(uuid, int) from public, anon;
grant execute on function public.get_leaderboard(uuid, bigint) to anon, authenticated;
grant execute on function public.list_public_tournaments() to anon, authenticated;
grant execute on function public.reserve_participant_codes(uuid, int) to authenticated;

-- anon never touches tables directly; only the leaderboard RPCs above.
revoke all on public.tournaments, public.species, public.participants, public.catches,
              public.leaderboard_configs, public.staff_roles from anon;

------------------------------------------------------------------------------
-- Row Level Security
------------------------------------------------------------------------------
alter table public.tournaments         enable row level security;
alter table public.species             enable row level security;
alter table public.participants        enable row level security;
alter table public.catches             enable row level security;
alter table public.leaderboard_configs enable row level security;
alter table public.staff_roles         enable row level security;

-- tournaments / species / leaderboard_configs: any staff reads, admin writes
create policy "staff read tournaments" on public.tournaments for select to authenticated
  using ((select private.is_staff()));
create policy "admin insert tournaments" on public.tournaments for insert to authenticated
  with check ((select private.has_role(array['admin'])));
create policy "admin update tournaments" on public.tournaments for update to authenticated
  using ((select private.has_role(array['admin']))) with check ((select private.has_role(array['admin'])));
create policy "admin delete tournaments" on public.tournaments for delete to authenticated
  using ((select private.has_role(array['admin'])));

create policy "staff read species" on public.species for select to authenticated
  using ((select private.is_staff()));
create policy "admin insert species" on public.species for insert to authenticated
  with check ((select private.has_role(array['admin'])));
create policy "admin update species" on public.species for update to authenticated
  using ((select private.has_role(array['admin']))) with check ((select private.has_role(array['admin'])));
create policy "admin delete species" on public.species for delete to authenticated
  using ((select private.has_role(array['admin'])));

create policy "staff read leaderboard configs" on public.leaderboard_configs for select to authenticated
  using ((select private.is_staff()));
create policy "admin insert leaderboard configs" on public.leaderboard_configs for insert to authenticated
  with check ((select private.has_role(array['admin'])));
create policy "admin update leaderboard configs" on public.leaderboard_configs for update to authenticated
  using ((select private.has_role(array['admin']))) with check ((select private.has_role(array['admin'])));
create policy "admin delete leaderboard configs" on public.leaderboard_configs for delete to authenticated
  using ((select private.has_role(array['admin'])));

-- participants: gate/weigh/admin read (contact info), gate+admin write, admin delete
create policy "gate weigh read participants" on public.participants for select to authenticated
  using ((select private.has_role(array['gate','weigh'])));
create policy "gate insert participants" on public.participants for insert to authenticated
  with check ((select private.has_role(array['gate'])));
create policy "gate update participants" on public.participants for update to authenticated
  using ((select private.has_role(array['gate']))) with check ((select private.has_role(array['gate'])));
create policy "admin delete participants" on public.participants for delete to authenticated
  using ((select private.has_role(array['admin'])));

-- catches: gate/weigh/admin read, weigh+admin insert, admin (or the weigh user who recorded it) update, admin delete
create policy "gate weigh read catches" on public.catches for select to authenticated
  using ((select private.has_role(array['gate','weigh'])));
create policy "weigh insert catches" on public.catches for insert to authenticated
  with check ((select private.has_role(array['weigh'])));
create policy "weigh update own catches" on public.catches for update to authenticated
  using ((select private.has_role(array['admin']))
         or ((select private.has_role(array['weigh'])) and recorded_by = (select auth.uid())))
  with check ((select private.has_role(array['admin']))
         or ((select private.has_role(array['weigh'])) and recorded_by = (select auth.uid())));
create policy "admin delete catches" on public.catches for delete to authenticated
  using ((select private.has_role(array['admin'])));

-- staff_roles: you see your own roles; admin manages all
create policy "read own or admin roles" on public.staff_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_role(array['admin'])));
create policy "admin insert roles" on public.staff_roles for insert to authenticated
  with check ((select private.has_role(array['admin'])));
create policy "admin update roles" on public.staff_roles for update to authenticated
  using ((select private.has_role(array['admin']))) with check ((select private.has_role(array['admin'])));
create policy "admin delete roles" on public.staff_roles for delete to authenticated
  using ((select private.has_role(array['admin'])));

------------------------------------------------------------------------------
-- Realtime for staff stations (RLS-filtered)
------------------------------------------------------------------------------
alter publication supabase_realtime add table public.catches, public.participants;
