-- Casino : corriger le gain total d'un joueur dans le classement « Depuis toujours ».
-- À coller dans Supabase → SQL Editor → New query, puis « Run ». Peut être relancé.
-- La correction ne touche que le total affiché « Depuis toujours » et le profil :
-- ni le classement de la semaine, ni les points de saison, ni les défis, ni les couronnes.

create table if not exists public.net_adjust (
  user_id uuid primary key references public.profiles on delete cascade,
  amount numeric(12, 2) not null,
  updated_at timestamptz not null default now()
);
alter table public.net_adjust enable row level security;
-- aucune règle d'accès : seules les fonctions du serveur lisent cette table

create or replace function public.leaderboard(scope text default 'all', max_rows int default 50, period text default 'all')
returns table (username text, net numeric, games bigint, best numeric, is_me boolean, is_friend boolean,
               rank bigint, banner text, frame text, title text, eligible boolean, avatar_url text)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  t as (select case when period = 'week' then week_bound(week_start(now())) else '-infinity'::timestamptz end as t0),
  stats as (
    select p.id, p.username, p.banner, p.frame, p.title, p.avatar_url,
           coalesce(sum(g.payout - g.stake), 0)
             + case when period = 'all' then coalesce((select a.amount from net_adjust a where a.user_id = p.id), 0) else 0 end as net,
           count(g.id) as games,
           coalesce(max(g.payout - g.stake), 0) as best
    from profiles p
    left join games g on g.user_id = p.id and g.received_at >= (select t0 from t)
    where scope = 'all' or p.id = auth.uid() or p.id in (select friend_id from mine)
    group by p.id
  ),
  shown as (
    select s.*, (period <> 'week' or s.games >= 10) as eligible
    from stats s
    where s.games > 0 or s.id = auth.uid() or scope = 'friends'
  ),
  ranked as (
    select x.*, case when x.eligible then rank() over (partition by x.eligible order by x.net desc, x.games desc) end as rank
    from shown x
  )
  select r.username, r.net, r.games, r.best, r.id = auth.uid(), r.id in (select friend_id from mine),
         r.rank, r.banner, r.frame, r.title, r.eligible, r.avatar_url
  from ranked r
  where (r.rank is not null and r.rank <= max_rows) or r.id = auth.uid() or (r.rank is null and scope = 'friends')
  order by r.eligible desc, r.rank nulls last, r.net desc;
$$;

create or replace function public.public_profile(name text) returns json
language plpgsql stable security definer set search_path = public as $$
declare p profiles; out json;
begin
  if auth.uid() is null then return null; end if;
  select * into p from profiles where lower(username) = lower(trim(name));
  if not found then return null; end if;
  select json_build_object(
    'username', p.username, 'banner', p.banner, 'frame', p.frame, 'title', p.title, 'avatar_url', p.avatar_url,
    'since', p.created_at, 'is_me', p.id = auth.uid(),
    'is_friend', exists (select 1 from friends where user_id = auth.uid() and friend_id = p.id),
    'stats', (select json_build_object(
                'games', count(*), 'net', coalesce(sum(payout - stake), 0) + coalesce((select a.amount from net_adjust a where a.user_id = p.id), 0),
                'wins', count(*) filter (where payout > stake),
                'best', coalesce(max(payout - stake), 0),
                'staked', coalesce(sum(stake), 0))
              from games where user_id = p.id),
    'by_game', (select coalesce(json_agg(x order by x.games desc), '[]'::json) from (
                  select game, count(*) as games, sum(payout - stake) as net, count(*) filter (where payout > stake) as wins
                  from games where user_id = p.id group by game) x),
    'week', (select json_build_object('net', net, 'games', games, 'rank', rank) from week_stats(week_start(now())) where user_id = p.id),
    'season', season_status_for(p.id),
    'trophies', json_build_object(
                  'week_wins', (select count(*) from rewards where user_id = p.id and rank = 1),
                  'week_podiums', (select count(*) from rewards where user_id = p.id and rank <= 3),
                  'best_week', (select min(rank) from rewards where user_id = p.id),
                  'seasons', (select coalesce(json_agg(json_build_object('season', season, 'tier', tier, 'rank', rank, 'champion', champion) order by season desc), '[]'::json)
                              from season_rewards where user_id = p.id))
  ) into out;
  return out;
end $$;

-- ============ La correction ============
-- Met le total « Depuis toujours » de DolannLS à +10 000 tout de suite.
-- Les parties jouées ensuite continueront de s'ajouter ou de se retrancher normalement.
insert into public.net_adjust (user_id, amount)
select p.id, 10000 - coalesce((select sum(g.payout - g.stake) from public.games g where g.user_id = p.id), 0)
from public.profiles p
where lower(p.username) = lower('DolannLS')
on conflict (user_id) do update set amount = excluded.amount, updated_at = now();

-- Vérification : doit afficher DolannLS avec 10000
select p.username,
       coalesce((select sum(g.payout - g.stake) from public.games g where g.user_id = p.id), 0)
         + coalesce((select a.amount from public.net_adjust a where a.user_id = p.id), 0) as total_depuis_toujours
from public.profiles p
where lower(p.username) = lower('DolannLS');
