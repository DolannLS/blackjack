-- Casino : mise à jour du 17 novembre 2026.
-- Cadeau d'excuse (500 couronnes), coup de pouce au classement, messages aux joueurs, support et idées.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après prestige.sql). Peut être relancé sans donner deux fois.

-- ============ Messages et cadeaux aux joueurs ============
create table if not exists public.gifts (
  user_id uuid not null references public.profiles on delete cascade,
  gift_id text not null,
  title text not null,
  message text not null,
  crowns int not null default 0,
  net_boost numeric(12, 2) not null default 0,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, gift_id)
);
alter table public.gifts enable row level security;
drop policy if exists "mes cadeaux" on public.gifts;
create policy "mes cadeaux" on public.gifts for select to authenticated using (user_id = auth.uid());

-- ============ Correction du total « Depuis toujours » (déjà utilisée pour DolannLS) ============
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

-- ============ Le cadeau : 500 couronnes à chaque joueur ayant joué au moins une partie ============
-- Et +15 000 au classement « Depuis toujours » pour ceux qui sont sous les −10 000.
do $$
declare r record; boost numeric; total numeric;
begin
  for r in select p.id from profiles p
           where not coalesce(p.is_bot, false) and exists (select 1 from games g where g.user_id = p.id)
             and not exists (select 1 from gifts x where x.user_id = p.id and x.gift_id = 'maj-2026-11-17')
  loop
    select coalesce((select sum(payout - stake) from games where user_id = r.id), 0)
         + coalesce((select amount from net_adjust where user_id = r.id), 0) into total;
    boost := case when total < -10000 then 15000 else 0 end;
    insert into gifts (user_id, gift_id, title, message, crowns, net_boost) values (r.id, 'maj-2026-11-17',
      'Désolé pour le changement des points',
      'Le système de points et de solde a changé ces derniers jours, et ça a pu chambouler ta progression. Pour nous excuser, voici 500 couronnes. Merci de jouer et de nous aider à améliorer le casino !',
      500, boost);
    update profiles set crowns = crowns + 500 where id = r.id;
    if boost > 0 then
      insert into net_adjust (user_id, amount) values (r.id, boost)
        on conflict (user_id) do update set amount = net_adjust.amount + excluded.amount, updated_at = now();
    end if;
  end loop;
end $$;

create or replace function public.mark_gift_seen(gift text) returns void
language sql security definer set search_path = public as $$
  update gifts set seen = true where user_id = auth.uid() and gift_id = gift;
$$;

-- Le profil renvoie les messages pas encore lus
create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform bots_tick();
  perform settle_weeks();
  perform settle_seasons();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title, 'felt', p.felt, 'chips', p.chips, 'refilled_today', coalesce(p.last_refill = paris_day(now()), false), 'avatar_url', p.avatar_url,
    'season_number', season_number(season_start(now())),
    'owned', (select coalesce(json_agg(i.item_id), '[]'::json) from inventory i where i.user_id = p.id),
    'rewards', (select coalesce(json_agg(r order by r.week_start desc), '[]'::json)
                from (select week_start, rank, net, crowns, items from rewards where user_id = p.id and not seen) r),
    'gifts', (select coalesce(json_agg(json_build_object('id', g.gift_id, 'title', g.title, 'message', g.message, 'crowns', g.crowns, 'net_boost', g.net_boost) order by g.created_at), '[]'::json)
                from gifts g where g.user_id = p.id and not g.seen),
    'season_rewards', (select coalesce(json_agg(r order by r.season desc), '[]'::json)
                from (select season, tier, rank, points, champion, crowns, items from season_rewards where user_id = p.id and not seen) r),
    'season', season_status_for(p.id),
    'week_start', week_start(now()),
    'week_end', week_bound(week_start(now()) + 7)
  ) into out from profiles p where p.id = auth.uid();
  return out;
end $$;

-- ============ Support technique, idées et bugs ============
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles on delete set null,
  username text,
  kind text not null check (kind in ('support', 'bug', 'idee', 'autre')),
  message text not null check (char_length(message) between 5 and 2000),
  contact text check (char_length(contact) <= 120),
  page text check (char_length(page) <= 60),
  device text check (char_length(device) <= 200),
  status text not null default 'nouveau' check (status in ('nouveau', 'en cours', 'résolu', 'refusé')),
  reply text,
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
-- aucune règle : les joueurs passent par les fonctions ci-dessous, toi tu lis et réponds dans le Table Editor

create or replace function public.send_feedback(kind text, message text, contact text default null, page text default null, device text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); out bigint;
begin
  if (select count(*) from feedback f where f.user_id is not distinct from uid and f.created_at > now() - interval '1 hour') >= (case when uid is null then 3 else 6 end) then
    raise exception 'trop_de_messages';
  end if;
  insert into feedback (user_id, username, kind, message, contact, page, device)
    values (uid, (select username from profiles where id = uid), kind, left(trim(message), 2000), left(contact, 120), left(page, 60), left(device, 200))
    returning id into out;
  return out;
end $$;

create or replace function public.my_feedback() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'message', message, 'status', status, 'reply', reply, 'created_at', created_at) order by created_at desc), '[]'::json)
  from (select * from feedback where user_id = auth.uid() order by created_at desc limit 20) f;
$$;

revoke all on function public.mark_gift_seen(text) from public, anon;
revoke all on function public.my_profile() from public, anon;
revoke all on function public.send_feedback(text, text, text, text, text) from public;
revoke all on function public.my_feedback() from public, anon;
grant execute on function public.mark_gift_seen(text) to authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.send_feedback(text, text, text, text, text) to anon, authenticated;
grant execute on function public.my_feedback() to authenticated;
