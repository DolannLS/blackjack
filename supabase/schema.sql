-- Casino : comptes, historique des parties et classements.
-- À coller tel quel dans Supabase → SQL Editor → New query, puis « Run ».

-- Profils : un pseudo par compte, visible par tous.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_-]{3,16}$'),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));
alter table public.profiles enable row level security;
drop policy if exists "pseudos visibles" on public.profiles;
create policy "pseudos visibles" on public.profiles for select to authenticated using (true);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Parties : une ligne par main ou par lancer. Seul le joueur voit son historique.
create table if not exists public.games (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  game text not null check (game in ('blackjack', 'roulette', 'holdem', 'videopoker', 'online')),
  stake numeric(12, 2) not null check (stake >= 0 and stake <= 1000000),
  payout numeric(12, 2) not null check (payout >= 0 and payout <= stake * 801),
  detail text check (char_length(detail) <= 80),
  played_at timestamptz not null default now(),
  client_id text not null unique
);
create index if not exists games_user_time on public.games (user_id, played_at desc);
alter table public.games enable row level security;
drop policy if exists "voir mes parties" on public.games;
create policy "voir mes parties" on public.games for select to authenticated using (user_id = auth.uid());
drop policy if exists "ajouter mes parties" on public.games;
create policy "ajouter mes parties" on public.games for insert to authenticated
  with check (user_id = auth.uid() and played_at <= now() + interval '5 minutes');

-- Amis : chacun gère sa propre liste.
create table if not exists public.friends (
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  friend_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
alter table public.friends enable row level security;
drop policy if exists "mes amis" on public.friends;
create policy "mes amis" on public.friends for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.add_friend(friend_name text) returns text
language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then return 'auth'; end if;
  select id into fid from profiles where lower(username) = lower(trim(friend_name));
  if fid is null then return 'introuvable'; end if;
  if fid = auth.uid() then return 'soi'; end if;
  insert into friends (user_id, friend_id) values (auth.uid(), fid) on conflict do nothing;
  return 'ok';
end $$;

create or replace function public.remove_friend(friend_name text) returns void
language sql security definer set search_path = public as $$
  delete from friends
  where user_id = auth.uid()
    and friend_id = (select id from profiles where lower(username) = lower(trim(friend_name)));
$$;

-- Classement par gains nets (total rendu − total misé), tous jeux confondus.
-- scope = 'friends' : moi + mes amis ; scope = 'all' : tous les joueurs ayant joué.
create or replace function public.leaderboard(scope text default 'all', max_rows int default 50)
returns table (username text, net numeric, games bigint, best numeric, is_me boolean, is_friend boolean, rank bigint)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  stats as (
    select p.id, p.username,
           coalesce(sum(g.payout - g.stake), 0) as net,
           count(g.id) as games,
           coalesce(max(g.payout - g.stake), 0) as best
    from profiles p
    left join games g on g.user_id = p.id
    where scope = 'all' or p.id = auth.uid() or p.id in (select friend_id from mine)
    group by p.id, p.username
  ),
  ranked as (
    select s.*, rank() over (order by s.net desc, s.games desc) as rank
    from stats s
    where s.games > 0 or s.id = auth.uid() or scope = 'friends'
  )
  select r.username, r.net, r.games, r.best, r.id = auth.uid(), r.id in (select friend_id from mine), r.rank
  from ranked r
  where r.rank <= max_rows or r.id = auth.uid()
  order by r.rank;
$$;

revoke all on function public.add_friend(text) from public, anon;
revoke all on function public.remove_friend(text) from public, anon;
revoke all on function public.leaderboard(text, int) from public, anon;
grant execute on function public.add_friend(text) to authenticated;
grant execute on function public.remove_friend(text) to authenticated;
grant execute on function public.leaderboard(text, int) to authenticated;
