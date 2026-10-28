-- Casino : casier, boutique tournante, récompenses de saison numérotées, rang Or,
-- couronne de la semaine qui change de main, photo de profil, recherche de joueurs, rareté des objets.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après saisons.sql). Peut être relancé.

-- ============ Catalogue ============
alter table public.profiles add column if not exists avatar_url text;
alter table public.shop_items add column if not exists season int;
alter table public.shop_items add column if not exists tier text;

-- Plus d'objets à vendre : la boutique en présente une partie différente chaque semaine.
insert into public.shop_items (id, kind, name, price, sort) values
  ('vegas',        'banner', 'Néons de Vegas',      700,  91),
  ('monaco',       'banner', 'Monaco',              900,  92),
  ('jade',         'banner', 'Jade',                500,  93),
  ('braise',       'banner', 'Braise',              600,  94),
  ('glacier',      'banner', 'Glacier',             600,  95),
  ('cuir',         'banner', 'Cuir club',           500,  96),
  ('pop',          'banner', 'Pop',                 400,  97),
  ('damier',       'banner', 'Damier',              450,  98),
  ('feutre-bleu',  'banner', 'Feutre bleu',         350,  99),
  ('sakura',       'banner', 'Sakura',              650,  100),
  ('or-rose',      'frame',  'Or rose',             450,  70),
  ('onyx',         'frame',  'Onyx',                400,  71),
  ('perle',        'frame',  'Perle',               600,  72),
  ('turquoise',    'frame',  'Turquoise',           500,  73),
  ('ambre',        'frame',  'Ambre',               500,  74),
  ('beau-joueur',  'title',  'Beau joueur',         150,  80),
  ('roi-du-tapis', 'title',  'Roi du tapis',        700,  81),
  ('tete-brulee',  'title',  'Tête brûlée',         300,  82),
  ('gros-poisson', 'title',  'Gros poisson',        350,  83),
  ('main-chaude',  'title',  'Main chaude',         300,  84),
  ('sang-froid',   'title',  'Sang-froid',          450,  85),
  ('pro-du-split', 'title',  'Pro du split',        350,  86),
  ('roi-roulette', 'title',  'Roi de la roulette',  600,  87)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- Fin des récompenses de podium hebdomadaire (bannières Or/Argent/Bronze du podium, titre « Sur le podium »)
-- et remplacement des anciens objets de saison fixes par des objets numérotés par saison.
update public.profiles set banner = 'tapis'
  where banner in ('or-champion', 'argent-podium', 'bronze-podium', 'saison-diamant', 'saison-alexandrite', 'saison-top100', 'saison-champion');
update public.profiles set frame = 'aucun'
  where frame in ('cadre-platine', 'cadre-diamant', 'cadre-alexandrite', 'cadre-champion-saison');
update public.profiles set title = 'sans-titre'
  where title in ('podium', 'joueur-du-dimanche', 'main-de-fer', 'joueur-d-argent', 'mise-de-platine', 'coeur-de-diamant', 'alexandrite', 'top-100', 'champion-saison');
delete from public.inventory where item_id in (
  'or-champion', 'argent-podium', 'bronze-podium', 'podium',
  'joueur-du-dimanche', 'main-de-fer', 'joueur-d-argent', 'mise-de-platine', 'coeur-de-diamant', 'alexandrite', 'top-100', 'champion-saison',
  'cadre-platine', 'cadre-diamant', 'cadre-alexandrite', 'cadre-champion-saison',
  'saison-diamant', 'saison-alexandrite', 'saison-top100', 'saison-champion');
delete from public.shop_items where id in (
  'or-champion', 'argent-podium', 'bronze-podium', 'podium',
  'joueur-du-dimanche', 'main-de-fer', 'joueur-d-argent', 'mise-de-platine', 'coeur-de-diamant', 'alexandrite', 'top-100', 'champion-saison',
  'cadre-platine', 'cadre-diamant', 'cadre-alexandrite', 'cadre-champion-saison',
  'saison-diamant', 'saison-alexandrite', 'saison-top100', 'saison-champion');

-- ============ Rangs : Or entre Argent et Platine ============
insert into public.season_tiers (id, name, min_points, sort, crowns, items) values
  ('bronze',      'Bronze',      20,   1, 100,  '{}'),
  ('fer',         'Fer',         100,  2, 200,  '{}'),
  ('argent',      'Argent',      250,  3, 350,  '{}'),
  ('or',          'Or',          400,  4, 550,  '{}'),
  ('platine',     'Platine',     600,  5, 800,  '{}'),
  ('diamant',     'Diamant',     1000, 6, 1200, '{}'),
  ('alexandrite', 'Alexandrite', 2000, 7, 2000, '{}'),
  ('top-100',     'Top 100',     2000, 8, 3000, '{}')
on conflict (id) do update set name = excluded.name, min_points = excluded.min_points, sort = excluded.sort, crowns = excluded.crowns, items = excluded.items;

-- ============ Saisons numérotées : chaque saison a ses propres objets, pour chaque rang ============
-- Saison 1 = octobre 2026.
create or replace function public.season_number(s date) returns int
language sql immutable as $$ select (extract(year from s)::int - 2026) * 12 + extract(month from s)::int - 10 + 1 $$;

-- Bannière, cadre et titre d'un rang pour une saison (créés à la clôture).
create or replace function public.season_items(s date, tier text) returns text[]
language plpgsql security definer set search_path = public as $$
declare n int := season_number(s); tname text; base text; k int;
begin
  tname := case when tier = 'champion' then 'Champion' else (select name from season_tiers where id = tier) end;
  k := case when tier = 'champion' then 99 else (select sort from season_tiers where id = tier) end;
  base := case tier
    when 'bronze' then 'Joueur du dimanche' when 'fer' then 'Main de fer' when 'argent' then 'Joueur d''argent'
    when 'or' then 'Main en or' when 'platine' then 'Mise de platine' when 'diamant' then 'Cœur de diamant'
    when 'alexandrite' then 'Alexandrite' when 'top-100' then 'Top 100' else 'Champion de la saison' end;
  insert into shop_items (id, kind, name, price, sort, season, tier) values
    ('s' || n || '-' || tier,           'banner', 'Saison ' || n || ' · ' || tname, null, 1000 + n * 100 + k, n, tier),
    ('s' || n || '-' || tier || '-cadre', 'frame',  'Saison ' || n || ' · ' || tname, null, 1000 + n * 100 + k, n, tier),
    ('s' || n || '-' || tier || '-titre', 'title',  base || ' · S' || n,            null, 1000 + n * 100 + k, n, tier)
  on conflict (id) do nothing;
  return array['s' || n || '-' || tier, 's' || n || '-' || tier || '-cadre', 's' || n || '-' || tier || '-titre'];
end $$;

-- Clôture des saisons : chaque joueur classé reçoit les objets de SON rang (+ couronnes), le champion en plus les siens.
create or replace function public.settle_seasons() returns int
language plpgsql security definer set search_path = public as $$
declare
  s date; cur date := season_start(now()); n int := 0; rec record; t season_tiers; its text[]; c int; champ boolean;
begin
  perform pg_advisory_xact_lock(434343);
  select season_start(min(received_at)) into s from games;
  if s is null then return 0; end if;
  while s < cur loop
    if not exists (select 1 from season_results where season = s) then
      for rec in select * from season_stats(s) where points >= 20 loop
        select * into t from season_tiers where id = tier_for(rec.points, rec.rank);
        its := season_items(s, t.id);
        c := t.crowns;
        champ := rec.rank = 1 and rec.points >= 250;
        if champ then
          c := c + 5000;
          its := its || season_items(s, 'champion');
        end if;
        insert into season_rewards (user_id, season, tier, rank, points, champion, crowns, items)
          values (rec.user_id, s, t.id, rec.rank, rec.points, champ, c, its);
        update profiles set crowns = crowns + c where id = rec.user_id;
        insert into inventory (user_id, item_id, source) select rec.user_id, unnest(its), 'saison ' || season_number(s) on conflict do nothing;
      end loop;
      insert into season_results (season) values (s);
      n := n + 1;
    end if;
    s := season_next(s);
  end loop;
  return n;
end $$;

-- ============ Semaine : couronnes au classement, cadre Couronne + titre Champion au seul n°1 ============
-- Le cadre et le titre passent au nouveau n°1 chaque lundi ; l'ancien les perd.
create or replace function public.settle_weeks() returns int
language plpgsql security definer set search_path = public as $$
declare
  w date; cur date := week_start(now()); n int := 0; rec record; c int; winners uuid[];
begin
  perform pg_advisory_xact_lock(424242);
  select week_start(min(received_at)) into w from games;
  if w is null then return 0; end if;
  while w < cur loop
    if not exists (select 1 from weekly_results where week_start = w) then
      winners := '{}';
      for rec in select * from week_stats(w) where rank is not null loop
        c := case when rec.rank = 1 then 1000 when rec.rank = 2 then 600 when rec.rank = 3 then 400 when rec.rank <= 10 then 200 else 50 end;
        insert into rewards (user_id, week_start, rank, net, crowns, items)
          values (rec.user_id, w, rec.rank, rec.net, c, case when rec.rank = 1 then array['couronne', 'champion'] else array[]::text[] end);
        update profiles set crowns = crowns + c where id = rec.user_id;
        if rec.rank = 1 then winners := winners || rec.user_id; end if;
      end loop;
      -- hand the crown over
      update profiles set frame = 'aucun' where frame = 'couronne' and not (id = any (winners));
      update profiles set title = 'sans-titre' where title = 'champion' and not (id = any (winners));
      delete from inventory where item_id in ('couronne', 'champion') and not (user_id = any (winners));
      insert into inventory (user_id, item_id, source)
        select u, x, 'champion de la semaine' from unnest(winners) u, unnest(array['couronne', 'champion']) x
      on conflict do nothing;
      insert into weekly_results (week_start) values (w);
      n := n + 1;
    end if;
    w := w + 7;
  end loop;
  return n;
end $$;

-- ============ Boutique tournante ============
-- 6 bannières, 4 cadres et 5 titres tirés chaque semaine (le même tirage pour tout le monde).
create or replace function public.shop_rotation(w date) returns table (item_id text)
language sql stable set search_path = public as $$
  select id from (
    select id, kind, row_number() over (partition by kind order by md5(id || w::text)) as rn
    from shop_items where price > 0
  ) x
  where (kind = 'banner' and rn <= 6) or (kind = 'frame' and rn <= 4) or (kind = 'title' and rn <= 5);
$$;

create or replace function public.shop_week() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'week_start', week_start(now()),
    'week_end', week_bound(week_start(now()) + 7),
    'items', (select coalesce(json_agg(item_id), '[]'::json) from shop_rotation(week_start(now())))
  );
$$;

create or replace function public.buy_item(item text) returns int
language plpgsql security definer set search_path = public as $$
declare it shop_items; left_crowns int;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select * into it from shop_items where id = item;
  if not found then raise exception 'introuvable'; end if;
  if it.price is null then raise exception 'exclusif'; end if;
  if it.price = 0 or exists (select 1 from inventory where user_id = auth.uid() and item_id = item) then raise exception 'possede'; end if;
  if not exists (select 1 from shop_rotation(week_start(now())) r where r.item_id = item) then raise exception 'hors_rotation'; end if;
  update profiles set crowns = crowns - it.price where id = auth.uid() and crowns >= it.price returning crowns into left_crowns;
  if left_crowns is null then raise exception 'solde'; end if;
  insert into inventory (user_id, item_id) values (auth.uid(), item);
  return left_crowns;
end $$;

-- ============ Rareté et casier ============
-- Nombre de joueurs qui possèdent chaque objet (les objets gratuits appartiennent à tout le monde).
create or replace function public.item_stats() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'players', (select count(*) from profiles),
    'holders', (select coalesce(json_object_agg(item_id, n), '{}'::json) from (select item_id, count(*) as n from inventory group by item_id) x)
  );
$$;

-- Tous mes objets, gratuits compris, avec leur rareté.
create or replace function public.locker() returns json
language sql stable security definer set search_path = public as $$
  with mine as (
    select s.id, s.kind, s.name, s.price, s.season, s.tier, i.source, i.acquired_at
    from inventory i join shop_items s on s.id = i.item_id
    where i.user_id = auth.uid()
    union all
    select s.id, s.kind, s.name, s.price, s.season, s.tier, 'gratuit', null
    from shop_items s where s.price = 0
  ),
  counts as (select item_id, count(*) as n from inventory group by item_id)
  select json_build_object(
    'players', (select count(*) from profiles),
    'items', (select coalesce(json_agg(json_build_object(
                'id', m.id, 'kind', m.kind, 'name', m.name, 'price', m.price, 'season', m.season, 'tier', m.tier,
                'source', m.source, 'acquired_at', m.acquired_at, 'holders', coalesce(c.n, 0)
              ) order by m.kind, m.acquired_at desc nulls last), '[]'::json)
              from mine m left join counts c on c.item_id = m.id)
  );
$$;

-- ============ Recherche de joueurs ============
create or replace function public.search_players(q text) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select p.username, p.banner, p.frame, p.title, p.avatar_url,
           exists (select 1 from friends f where f.user_id = auth.uid() and f.friend_id = p.id) as is_friend
    from profiles p
    where length(trim(q)) >= 1 and p.username ilike '%' || replace(replace(trim(q), '%', ''), '_', '\_') || '%'
    order by (lower(p.username) like lower(trim(q)) || '%') desc, length(p.username), p.username
    limit 12
  ) x;
$$;

-- ============ Photo de profil ============
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Chacun écrit seulement dans son propre dossier avatars/<son id>/.
drop policy if exists "avatars lecture" on storage.objects;
create policy "avatars lecture" on storage.objects for select using (bucket_id = 'avatars');
drop policy if exists "avatars ajout" on storage.objects;
create policy "avatars ajout" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars remplacement" on storage.objects;
create policy "avatars remplacement" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars suppression" on storage.objects;
create policy "avatars suppression" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.set_avatar(url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  if url is not null and url not like '%/storage/v1/object/public/avatars/' || auth.uid()::text || '/%' then raise exception 'photo_invalide'; end if;
  update profiles set avatar_url = url where id = auth.uid();
end $$;

-- ============ Fonctions qui renvoient maintenant la photo ============
drop function if exists public.leaderboard(text, int, text);
drop function if exists public.season_board(text, int);

create or replace function public.leaderboard(scope text default 'all', max_rows int default 50, period text default 'all')
returns table (username text, net numeric, games bigint, best numeric, is_me boolean, is_friend boolean,
               rank bigint, banner text, frame text, title text, eligible boolean, avatar_url text)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  t as (select case when period = 'week' then week_bound(week_start(now())) else '-infinity'::timestamptz end as t0),
  stats as (
    select p.id, p.username, p.banner, p.frame, p.title, p.avatar_url,
           coalesce(sum(g.payout - g.stake), 0) as net,
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

create or replace function public.season_board(scope text default 'all', max_rows int default 50)
returns table (username text, points numeric, games bigint, net numeric, rank bigint, tier text,
               is_me boolean, is_friend boolean, banner text, frame text, title text, avatar_url text)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  st as (select * from season_stats(season_start(now())))
  select p.username, coalesce(st.points, 0), coalesce(st.games, 0), coalesce(st.net, 0), st.rank,
         case when st.points is null then null else tier_for(st.points, st.rank) end,
         p.id = auth.uid(), p.id in (select friend_id from mine), p.banner, p.frame, p.title, p.avatar_url
  from profiles p
  left join st on st.user_id = p.id
  where (scope = 'all' and (st.rank <= max_rows or p.id = auth.uid()))
     or (scope = 'friends' and (p.id = auth.uid() or p.id in (select friend_id from mine)))
  order by st.rank nulls last, p.username;
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
                'games', count(*), 'net', coalesce(sum(payout - stake), 0),
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

create or replace function public.live_feed(max_rows int default 15) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select p.username, p.banner, p.frame, p.avatar_url, g.game, g.payout - g.stake as net, g.detail, g.played_at
    from games g join profiles p on p.id = g.user_id
    where g.played_at > now() - interval '24 hours' and g.played_at <= now()
      and (g.payout - g.stake >= 100 or g.payout >= g.stake * 5)
    order by g.played_at desc
    limit max_rows
  ) x;
$$;

create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform bots_tick();
  perform settle_weeks();
  perform settle_seasons();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title, 'avatar_url', p.avatar_url,
    'season_number', season_number(season_start(now())),
    'owned', (select coalesce(json_agg(i.item_id), '[]'::json) from inventory i where i.user_id = p.id),
    'rewards', (select coalesce(json_agg(r order by r.week_start desc), '[]'::json)
                from (select week_start, rank, net, crowns, items from rewards where user_id = p.id and not seen) r),
    'season_rewards', (select coalesce(json_agg(r order by r.season desc), '[]'::json)
                from (select season, tier, rank, points, champion, crowns, items from season_rewards where user_id = p.id and not seen) r),
    'season', season_status_for(p.id),
    'week_start', week_start(now()),
    'week_end', week_bound(week_start(now()) + 7)
  ) into out from profiles p where p.id = auth.uid();
  return out;
end $$;

-- ============ Droits ============
revoke all on function public.season_items(date, text) from public, anon, authenticated;
revoke all on function public.settle_seasons() from public, anon, authenticated;
revoke all on function public.settle_weeks() from public, anon, authenticated;
revoke all on function public.shop_week() from public, anon;
revoke all on function public.buy_item(text) from public, anon;
revoke all on function public.item_stats() from public, anon;
revoke all on function public.locker() from public, anon;
revoke all on function public.search_players(text) from public, anon;
revoke all on function public.set_avatar(text) from public, anon;
revoke all on function public.leaderboard(text, int, text) from public, anon;
revoke all on function public.season_board(text, int) from public, anon;
revoke all on function public.public_profile(text) from public, anon;
revoke all on function public.live_feed(int) from public, anon;
revoke all on function public.my_profile() from public, anon;
grant execute on function public.shop_week() to authenticated;
grant execute on function public.buy_item(text) to authenticated;
grant execute on function public.item_stats() to authenticated;
grant execute on function public.locker() to authenticated;
grant execute on function public.search_players(text) to authenticated;
grant execute on function public.set_avatar(text) to authenticated;
grant execute on function public.leaderboard(text, int, text) to authenticated;
grant execute on function public.season_board(text, int) to authenticated;
grant execute on function public.public_profile(text) to authenticated;
grant execute on function public.live_feed(int) to authenticated;
grant execute on function public.my_profile() to authenticated;
