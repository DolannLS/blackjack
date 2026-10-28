-- Casino : saisons mensuelles et rangs, profils publics, réglages du compte, activité en direct.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après boutique.sql). Peut être relancé.

-- ============ Objets gagnés en saison (non vendus) ============
insert into public.shop_items (id, kind, name, price, sort) values
  ('joueur-du-dimanche',    'title',  'Joueur du dimanche',   null, 200),
  ('main-de-fer',           'title',  'Main de fer',          null, 210),
  ('joueur-d-argent',       'title',  'Joueur d''argent',     null, 220),
  ('mise-de-platine',       'title',  'Mise de platine',      null, 230),
  ('coeur-de-diamant',      'title',  'Cœur de diamant',      null, 240),
  ('alexandrite',           'title',  'Alexandrite',          null, 250),
  ('top-100',               'title',  'Top 100',              null, 260),
  ('champion-saison',       'title',  'Champion de la saison', null, 270),
  ('cadre-platine',         'frame',  'Platine',              null, 200),
  ('cadre-diamant',         'frame',  'Diamant',              null, 210),
  ('cadre-alexandrite',     'frame',  'Alexandrite',          null, 220),
  ('cadre-champion-saison', 'frame',  'Couronne de saison',   null, 230),
  ('saison-diamant',        'banner', 'Éclat de diamant',     null, 200),
  ('saison-alexandrite',    'banner', 'Alexandrite',          null, 210),
  ('saison-top100',         'banner', 'Élite Top 100',        null, 220),
  ('saison-champion',       'banner', 'Trône de la saison',   null, 230)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- ============ Saisons : un mois calendaire, heure de Paris ============
create or replace function public.season_start(ts timestamptz) returns date
language sql stable as $$ select date_trunc('month', ts at time zone 'Europe/Paris')::date $$;
create or replace function public.season_next(s date) returns date
language sql immutable as $$ select (s + interval '1 month')::date $$;

-- Rangs, du plus bas au plus haut. Top 100 : les 100 meilleurs, à partir de 2 000 points.
create table if not exists public.season_tiers (
  id text primary key,
  name text not null,
  min_points int not null,
  sort int not null,
  crowns int not null,
  items text[] not null default '{}'
);
alter table public.season_tiers enable row level security;
drop policy if exists "rangs publics" on public.season_tiers;
create policy "rangs publics" on public.season_tiers for select to authenticated using (true);
insert into public.season_tiers (id, name, min_points, sort, crowns, items) values
  ('bronze',      'Bronze',      20,   1, 100,  '{joueur-du-dimanche}'),
  ('fer',         'Fer',         100,  2, 200,  '{main-de-fer}'),
  ('argent',      'Argent',      250,  3, 400,  '{joueur-d-argent}'),
  ('platine',     'Platine',     500,  4, 700,  '{mise-de-platine,cadre-platine}'),
  ('diamant',     'Diamant',     1000, 5, 1200, '{coeur-de-diamant,cadre-diamant,saison-diamant}'),
  ('alexandrite', 'Alexandrite', 2000, 6, 2000, '{alexandrite,cadre-alexandrite,saison-alexandrite}'),
  ('top-100',     'Top 100',     2000, 7, 3000, '{top-100,saison-top100}')
on conflict (id) do update set name = excluded.name, min_points = excluded.min_points, sort = excluded.sort, crowns = excluded.crowns, items = excluded.items;

-- Points de saison : 1 par partie + 1 par tranche de 50 jetons gagnés. Perdre ne retire rien.
create or replace function public.season_stats(s date)
returns table (user_id uuid, points numeric, games bigint, net numeric, rank bigint)
language sql stable security definer set search_path = public as $$
  with st as (
    select g.user_id,
           floor(sum(1 + greatest(0, g.payout - g.stake) / 50.0)) as points,
           count(*) as games,
           sum(g.payout - g.stake) as net
    from games g
    where g.received_at >= week_bound(s) and g.received_at < week_bound(season_next(s))
    group by g.user_id
  )
  select st.user_id, st.points, st.games, st.net, rank() over (order by st.points desc, st.games desc) from st;
$$;

create or replace function public.tier_for(points numeric, rank bigint) returns text
language sql stable set search_path = public as $$
  select case
    when points >= 2000 and rank <= 100 then 'top-100'
    else (select id from season_tiers where id <> 'top-100' and min_points <= points order by sort desc limit 1)
  end;
$$;

create table if not exists public.season_results (
  season date primary key,
  settled_at timestamptz not null default now()
);
alter table public.season_results enable row level security;

create table if not exists public.season_rewards (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  season date not null,
  tier text not null references public.season_tiers,
  rank int not null,
  points numeric(12, 0) not null,
  champion boolean not null default false,
  crowns int not null,
  items text[] not null default '{}',
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, season)
);
alter table public.season_rewards enable row level security;
drop policy if exists "mes récompenses de saison" on public.season_rewards;
create policy "mes récompenses de saison" on public.season_rewards for select to authenticated using (user_id = auth.uid());

-- Clôture des saisons terminées. Champion : 1er de la saison, à partir du rang Argent.
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
        select coalesce(array_agg(x), '{}') into its
          from (select unnest(items) as x from season_tiers where sort <= t.sort) z;
        c := t.crowns;
        champ := rec.rank = 1 and rec.points >= 250;
        if champ then
          c := c + 5000;
          its := its || array['champion-saison', 'saison-champion', 'cadre-champion-saison'];
        end if;
        insert into season_rewards (user_id, season, tier, rank, points, champion, crowns, items)
          values (rec.user_id, s, t.id, rec.rank, rec.points, champ, c, its);
        update profiles set crowns = crowns + c where id = rec.user_id;
        insert into inventory (user_id, item_id, source) select rec.user_id, unnest(its), 'saison' on conflict do nothing;
      end loop;
      insert into season_results (season) values (s);
      n := n + 1;
    end if;
    s := season_next(s);
  end loop;
  return n;
end $$;

-- Ma saison en cours.
create or replace function public.season_status_for(uid uuid) returns json
language sql stable security definer set search_path = public as $$
  with st as (select * from season_stats(season_start(now()))),
  me as (select * from st where user_id = uid),
  tier as (select tier_for(coalesce((select points from me), 0), coalesce((select rank from me), 999999)) as id),
  nxt as (
    select id, name, min_points from season_tiers
    where id <> 'top-100' and min_points > coalesce((select points from me), 0)
    order by sort limit 1
  )
  select json_build_object(
    'season', season_start(now()),
    'season_end', week_bound(season_next(season_start(now()))),
    'points', coalesce((select points from me), 0),
    'games', coalesce((select games from me), 0),
    'rank', (select rank from me),
    'players', (select count(*) from st),
    'tier', (select id from tier),
    'next_tier', (select id from nxt),
    'next_points', (select min_points from nxt)
  );
$$;

-- Classement de la saison (points).
create or replace function public.season_board(scope text default 'all', max_rows int default 50)
returns table (username text, points numeric, games bigint, net numeric, rank bigint, tier text,
               is_me boolean, is_friend boolean, banner text, frame text, title text)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  st as (select * from season_stats(season_start(now())))
  select p.username, coalesce(st.points, 0), coalesce(st.games, 0), coalesce(st.net, 0), st.rank,
         case when st.points is null then null else tier_for(st.points, st.rank) end,
         p.id = auth.uid(), p.id in (select friend_id from mine), p.banner, p.frame, p.title
  from profiles p
  left join st on st.user_id = p.id
  where (scope = 'all' and (st.rank <= max_rows or p.id = auth.uid()))
     or (scope = 'friends' and (p.id = auth.uid() or p.id in (select friend_id from mine)))
  order by st.rank nulls last, p.username;
$$;

-- ============ Profil public d'un joueur ============
create or replace function public.public_profile(name text) returns json
language plpgsql stable security definer set search_path = public as $$
declare p profiles; out json;
begin
  if auth.uid() is null then return null; end if;
  select * into p from profiles where lower(username) = lower(trim(name));
  if not found then return null; end if;
  select json_build_object(
    'username', p.username, 'banner', p.banner, 'frame', p.frame, 'title', p.title,
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

-- ============ Réglages du compte ============
-- Le pseudo sert d'identifiant de connexion : on met à jour le profil et l'identifiant ensemble.
create or replace function public.rename_account(new_name text) returns text
language plpgsql security definer set search_path = public as $$
declare mail text;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  new_name := trim(new_name);
  if new_name !~ '^[A-Za-z0-9_-]{3,16}$' then raise exception 'pseudo_invalide'; end if;
  if exists (select 1 from profiles where lower(username) = lower(new_name) and id <> auth.uid()) then raise exception 'pseudo_pris'; end if;
  mail := lower(new_name) || '@joueurs.casino-app.fr';
  update profiles set username = new_name where id = auth.uid();
  update auth.users
     set email = mail,
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('username', new_name, 'email', mail),
         updated_at = now()
   where id = auth.uid();
  update auth.identities
     set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', mail), updated_at = now()
   where user_id = auth.uid() and provider = 'email';
  return new_name;
end $$;

create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- ============ Joueurs automatiques (temporaires) ============
-- Des joueurs simulés jouent en continu pour animer les classements.
-- Pour les retirer : lancer supabase/supprimer_bots.sql.
alter table public.profiles add column if not exists is_bot boolean not null default false;
create table if not exists public.bot_state (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  last_tick timestamptz not null default now()
);
alter table public.bot_state enable row level security;
insert into public.bot_state (id) values (1) on conflict do nothing;

-- Les parties des bots gardent leur heure simulée ; celles des joueurs sont horodatées par le serveur.
create or replace function public.stamp_received() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('casino.bots', true), '') <> 'on' then new.received_at := now(); end if;
  return new;
end $$;

create or replace function public.bots_seed() returns int
language plpgsql security definer set search_path = public as $$
declare
  names text[] := array['Lucie_M', 'MarcoB', 'Ines92', 'Hugo_Roi', 'Zoe_Ace', 'Karim77', 'Julie-B', 'Thomas_K',
                        'LeaFox', 'Nico_Bluff', 'EmmaR', 'Sam-Lucky', 'Chloe_V', 'Max_Poker', 'Yasmine_D', 'Paulo_21'];
  banners text[] := array['tapis', 'nuit-etoilee', 'velours', 'riviera', 'coucher', 'art-deco', 'cartes', 'jetons', 'marbre', 'aurore'];
  frames text[] := array['aucun', 'laiton', 'emeraude', 'rubis', 'saphir', 'prisme', 'flammes'];
  titles text[] := array['sans-titre', 'chanceux', 'flambeur', 'requin', 'as-du-bluff', 'compteur', 'high-roller'];
  n text; uid uuid; made int := 0;
begin
  foreach n in array names loop
    if not exists (select 1 from profiles where lower(username) = lower(n)) then
      uid := gen_random_uuid();
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
      values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              lower(n) || '@bots.casino-app.fr', jsonb_build_object('username', n), '{"bot": true}'::jsonb,
              now() - (random() * interval '20 days'), now());
      update profiles set is_bot = true,
        banner = banners[1 + floor(random() * array_length(banners, 1))::int],
        frame = frames[1 + floor(random() * array_length(frames, 1))::int],
        title = titles[1 + floor(random() * array_length(titles, 1))::int],
        created_at = now() - (random() * interval '20 days')
      where id = uid;
      made := made + 1;
    end if;
  end loop;
  update bot_state set enabled = true;
  return made;
end $$;

-- Fait jouer les bots pour le temps écoulé depuis le dernier passage (appelé par l'app, au plus une fois par minute).
create or replace function public.bots_tick() returns int
language plpgsql security definer set search_path = public as $$
declare st bot_state; t0 timestamptz; t1 timestamptz := now(); made int;
begin
  select * into st from bot_state where id = 1 for update skip locked;
  if not found or not st.enabled or st.last_tick > now() - interval '60 seconds' then return 0; end if;
  t0 := greatest(st.last_tick, now() - interval '18 hours');
  update bot_state set last_tick = t1 where id = 1;
  perform set_config('casino.bots', 'on', true);
  with bots as (
    select p.id,
           -- each bot has its own pace (games per hour) and a small edge or handicap
           1 + (abs(hashtext(p.id::text)) % 5) as per_hour,
           ((abs(hashtext(p.id::text || 'luck')) % 9) - 4) / 100.0 as luck,
           (array[10, 25, 25, 50, 50, 100, 200])[1 + abs(hashtext(p.id::text || 'stake')) % 7] as base_stake
    from profiles p where p.is_bot
  ),
  slots as (
    select b.*, t0 + random() * (t1 - t0) as at, random() as r, random() as r2, random() as pick
    from bots b,
         generate_series(1, greatest(0, floor(b.per_hour * extract(epoch from (t1 - t0)) / 3600.0 + random())::int))
  ),
  awake as (
    -- quieter at night (Paris time)
    select * from slots
    where extract(hour from at at time zone 'Europe/Paris') between 8 and 23 or random() < .15
  ),
  played as (
    select id, at, r, r2, luck,
           case when pick < .35 then 'blackjack' when pick < .6 then 'roulette' when pick < .78 then 'videopoker'
                when pick < .93 then 'holdem' else 'online' end as game,
           greatest(5, round(base_stake * (0.5 + random() * 1.5) / 5) * 5) as stake
    from awake
  ),
  results as (
    select id, at, game, stake,
      case game
        when 'blackjack' then case when r < .43 + luck then case when r2 < .1 then stake * 2.5 else stake * 2 end
                                   when r < .52 + luck then stake else 0 end
        when 'roulette' then case when r2 < .25 then case when r < 1 / 37.0 + luck / 4 then stake * 36 else 0 end
                                  else case when r < 18 / 37.0 + luck then stake * 2 when r < 19 / 37.0 + luck then stake / 2 else 0 end end
        when 'videopoker' then case when r < .00003 then stake * 800 when r < .00013 then stake * 50 when r < .0025 then stake * 25
                                    when r < .014 then stake * 9 when r < .025 then stake * 6 when r < .036 then stake * 4
                                    when r < .11 + luck then stake * 3 when r < .24 + luck then stake * 2 when r < .45 + luck then stake else 0 end
        else case when r < .3 + luck then stake * (2 + floor(r2 * 4)) else 0 end
      end as payout, r2
    from played
  )
  insert into games (user_id, game, stake, payout, detail, played_at, received_at, client_id)
  select id, game, stake, payout,
    case game
      when 'blackjack' then case when payout = stake * 2.5 then 'Blackjack' when payout > stake then 'Gagné ' || (17 + floor(r2 * 5))::int
                                 when payout = stake then 'Égalité' else 'Perdu ' || (12 + floor(r2 * 10))::int end
      when 'roulette' then (floor(r2 * 37))::int || case when floor(r2 * 37) = 0 then ' vert' when floor(r2 * 37)::int in (1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36) then ' rouge' else ' noir' end
      when 'videopoker' then case when payout = 0 then 'Pas de main payante' when payout = stake then 'Paire de valets ou mieux'
                                  when payout = stake * 2 then 'Double paire' when payout = stake * 3 then 'Brelan' when payout = stake * 4 then 'Quinte'
                                  when payout = stake * 6 then 'Couleur' when payout = stake * 9 then 'Full' when payout = stake * 25 then 'Carré'
                                  when payout = stake * 50 then 'Quinte flush' else 'Quinte flush royale' end
      else case when payout > 0 then (array['Paire de Rois', 'Double paire', 'Brelan de 7', 'Quinte au Valet', 'Couleur', 'Full aux Dames'])[1 + floor(r2 * 6)::int]
                else (array['Couché', 'Paire de 4', 'Hauteur As'])[1 + floor(r2 * 3)::int] end
    end,
    at, at, 'bot-' || gen_random_uuid()
  from results;
  get diagnostics made = row_count;
  return made;
end $$;

-- ============ Activité en direct ============
create or replace function public.live_feed(max_rows int default 15) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select p.username, p.banner, p.frame, g.game, g.payout - g.stake as net, g.detail, g.played_at
    from games g join profiles p on p.id = g.user_id
    where g.played_at > now() - interval '24 hours' and g.played_at <= now()
      and (g.payout - g.stake >= 100 or g.payout >= g.stake * 5)
    order by g.played_at desc
    limit max_rows
  ) x;
$$;

-- ============ Mon profil (avec saison) ============
create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform bots_tick();
  perform settle_weeks();
  perform settle_seasons();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title,
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

create or replace function public.mark_rewards_seen() returns void
language plpgsql security definer set search_path = public as $$
begin
  update rewards set seen = true where user_id = auth.uid() and not seen;
  update season_rewards set seen = true where user_id = auth.uid() and not seen;
end $$;

-- ============ Droits ============
revoke all on function public.season_stats(date) from public, anon, authenticated;
revoke all on function public.settle_seasons() from public, anon, authenticated;
revoke all on function public.season_status_for(uuid) from public, anon, authenticated;
revoke all on function public.bots_seed() from public, anon, authenticated;
revoke all on function public.season_board(text, int) from public, anon;
revoke all on function public.public_profile(text) from public, anon;
revoke all on function public.rename_account(text) from public, anon;
revoke all on function public.delete_account() from public, anon;
revoke all on function public.bots_tick() from public, anon;
revoke all on function public.live_feed(int) from public, anon;
revoke all on function public.my_profile() from public, anon;
revoke all on function public.mark_rewards_seen() from public, anon;
grant execute on function public.season_board(text, int) to authenticated;
grant execute on function public.public_profile(text) to authenticated;
grant execute on function public.rename_account(text) to authenticated;
grant execute on function public.delete_account() to authenticated;
grant execute on function public.bots_tick() to authenticated;
grant execute on function public.live_feed(int) to authenticated;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.mark_rewards_seen() to authenticated;

-- Crée les joueurs automatiques et lance une première partie de rattrapage.
select public.bots_seed();
