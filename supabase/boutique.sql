-- Casino : boutique, couronnes et récompenses hebdomadaires.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après schema.sql et invitations.sql).
-- Peut être relancé sans risque.

-- Profil : couronnes (monnaie de la boutique) et personnalisation équipée.
alter table public.profiles add column if not exists crowns int not null default 150 check (crowns >= 0);
alter table public.profiles add column if not exists banner text not null default 'tapis';
alter table public.profiles add column if not exists frame text not null default 'aucun';
alter table public.profiles add column if not exists title text not null default 'sans-titre';

-- Heure de réception côté serveur : c'est elle qui compte pour la semaine (impossible à antidater).
alter table public.games add column if not exists received_at timestamptz not null default now();
create index if not exists games_received on public.games (received_at);
create or replace function public.stamp_received() returns trigger
language plpgsql as $$ begin new.received_at := now(); return new; end $$;
drop trigger if exists games_stamp_received on public.games;
create trigger games_stamp_received before insert on public.games
  for each row execute function public.stamp_received();

-- Catalogue. price = null : objet exclusif, gagné uniquement en récompense.
create table if not exists public.shop_items (
  id text primary key,
  kind text not null check (kind in ('banner', 'frame', 'title')),
  name text not null,
  price int check (price >= 0),
  sort int not null default 0
);
alter table public.shop_items enable row level security;
drop policy if exists "catalogue public" on public.shop_items;
create policy "catalogue public" on public.shop_items for select to authenticated using (true);

insert into public.shop_items (id, kind, name, price, sort) values
  ('tapis',          'banner', 'Tapis vert',          0,    0),
  ('nuit-etoilee',   'banner', 'Nuit étoilée',        400,  10),
  ('velours',        'banner', 'Velours rouge',       400,  20),
  ('riviera',        'banner', 'Riviera',             500,  30),
  ('coucher',        'banner', 'Coucher de soleil',   600,  40),
  ('art-deco',       'banner', 'Art déco',            700,  50),
  ('cartes',         'banner', 'Jeu de cartes',       800,  60),
  ('jetons',         'banner', 'Pile de jetons',      800,  70),
  ('marbre',         'banner', 'Marbre',              1000, 80),
  ('aurore',         'banner', 'Aurore boréale',      1500, 90),
  ('or-champion',    'banner', 'Or du champion',      null, 100),
  ('argent-podium',  'banner', 'Argent du podium',    null, 110),
  ('bronze-podium',  'banner', 'Bronze du podium',    null, 120),
  ('aucun',          'frame',  'Sans cadre',          0,    0),
  ('laiton',         'frame',  'Laiton',              300,  10),
  ('emeraude',       'frame',  'Émeraude',            500,  20),
  ('rubis',          'frame',  'Rubis',               500,  30),
  ('saphir',         'frame',  'Saphir',              500,  40),
  ('prisme',         'frame',  'Prisme',              900,  50),
  ('flammes',        'frame',  'Flammes',             1200, 60),
  ('couronne',       'frame',  'Couronne',            null, 100),
  ('sans-titre',     'title',  'Sans titre',          0,    0),
  ('chanceux',       'title',  'Chanceux',            150,  10),
  ('flambeur',       'title',  'Flambeur',            250,  20),
  ('requin',         'title',  'Requin',              400,  30),
  ('as-du-bluff',    'title',  'As du bluff',         400,  40),
  ('compteur',       'title',  'Compteur de cartes',  400,  50),
  ('high-roller',    'title',  'High roller',         800,  60),
  ('legende',        'title',  'Légende du casino',   1500, 70),
  ('champion',       'title',  'Champion de la semaine', null, 100),
  ('podium',         'title',  'Sur le podium',       null, 110)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- Objets possédés.
create table if not exists public.inventory (
  user_id uuid not null references public.profiles on delete cascade,
  item_id text not null references public.shop_items,
  source text not null default 'achat',
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.inventory enable row level security;
drop policy if exists "mon inventaire" on public.inventory;
create policy "mon inventaire" on public.inventory for select to authenticated using (user_id = auth.uid());

-- Semaines déjà clôturées et récompenses versées.
create table if not exists public.weekly_results (
  week_start date primary key,
  settled_at timestamptz not null default now()
);
alter table public.weekly_results enable row level security;

create table if not exists public.rewards (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  week_start date not null,
  rank int not null,
  net numeric(12, 2) not null,
  crowns int not null,
  items text[] not null default '{}',
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);
alter table public.rewards enable row level security;
drop policy if exists "mes récompenses" on public.rewards;
create policy "mes récompenses" on public.rewards for select to authenticated using (user_id = auth.uid());

-- Les semaines commencent le lundi à 0 h, heure de Paris.
create or replace function public.week_start(ts timestamptz) returns date
language sql stable as $$ select date_trunc('week', ts at time zone 'Europe/Paris')::date $$;
create or replace function public.week_bound(w date) returns timestamptz
language sql stable as $$ select w::timestamp at time zone 'Europe/Paris' $$;

-- Résultats d'une semaine : seuls les joueurs avec au moins 10 parties sont classés.
create or replace function public.week_stats(w date)
returns table (user_id uuid, net numeric, games bigint, rank bigint)
language sql stable security definer set search_path = public as $$
  with s as (
    select g.user_id, sum(g.payout - g.stake) as net, count(*) as games
    from games g
    where g.received_at >= week_bound(w) and g.received_at < week_bound(w + 7)
    group by g.user_id
  ),
  r as (select s.user_id, rank() over (order by s.net desc, s.games desc) as rank from s where s.games >= 10)
  select s.user_id, s.net, s.games, r.rank from s left join r using (user_id);
$$;

-- Verse les récompenses des semaines terminées. Appelée à l'ouverture de l'app : pas de tâche planifiée à gérer.
create or replace function public.settle_weeks() returns int
language plpgsql security definer set search_path = public as $$
declare
  w date; cur date := week_start(now()); n int := 0; rec record; c int; its text[];
begin
  perform pg_advisory_xact_lock(424242);
  select week_start(min(received_at)) into w from games;
  if w is null then return 0; end if;
  while w < cur loop
    if not exists (select 1 from weekly_results where week_start = w) then
      for rec in select * from week_stats(w) where rank is not null loop
        c := case when rec.rank = 1 then 1000 when rec.rank = 2 then 600 when rec.rank = 3 then 400 when rec.rank <= 10 then 200 else 50 end;
        its := case rec.rank
                 when 1 then array['or-champion', 'couronne', 'champion']
                 when 2 then array['argent-podium', 'podium']
                 when 3 then array['bronze-podium', 'podium']
                 else array[]::text[] end;
        insert into rewards (user_id, week_start, rank, net, crowns, items) values (rec.user_id, w, rec.rank, rec.net, c, its);
        update profiles set crowns = crowns + c where id = rec.user_id;
        insert into inventory (user_id, item_id, source) select rec.user_id, unnest(its), 'récompense' on conflict do nothing;
      end loop;
      insert into weekly_results (week_start) values (w);
      n := n + 1;
    end if;
    w := w + 7;
  end loop;
  return n;
end $$;

-- Mon profil complet (et clôture des semaines passées au passage).
create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform settle_weeks();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title,
    'owned', (select coalesce(json_agg(i.item_id), '[]'::json) from inventory i where i.user_id = p.id),
    'rewards', (select coalesce(json_agg(r order by r.week_start desc), '[]'::json)
                from (select week_start, rank, net, crowns, items from rewards where user_id = p.id and not seen) r),
    'week_start', week_start(now()),
    'week_end', week_bound(week_start(now()) + 7)
  ) into out from profiles p where p.id = auth.uid();
  return out;
end $$;

create or replace function public.mark_rewards_seen() returns void
language sql security definer set search_path = public as $$
  update rewards set seen = true where user_id = auth.uid() and not seen;
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
  update profiles set crowns = crowns - it.price where id = auth.uid() and crowns >= it.price returning crowns into left_crowns;
  if left_crowns is null then raise exception 'solde'; end if;
  insert into inventory (user_id, item_id) values (auth.uid(), item);
  return left_crowns;
end $$;

create or replace function public.equip(item text) returns void
language plpgsql security definer set search_path = public as $$
declare it shop_items;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select * into it from shop_items where id = item;
  if not found then raise exception 'introuvable'; end if;
  if coalesce(it.price, -1) <> 0 and not exists (select 1 from inventory where user_id = auth.uid() and item_id = item) then
    raise exception 'non_possede';
  end if;
  update profiles set
    banner = case when it.kind = 'banner' then item else banner end,
    frame  = case when it.kind = 'frame'  then item else frame end,
    title  = case when it.kind = 'title'  then item else title end
  where id = auth.uid();
end $$;

-- Classement : depuis toujours ou semaine en cours, avec la personnalisation de chacun.
drop function if exists public.leaderboard(text, int);
create or replace function public.leaderboard(scope text default 'all', max_rows int default 50, period text default 'all')
returns table (username text, net numeric, games bigint, best numeric, is_me boolean, is_friend boolean,
               rank bigint, banner text, frame text, title text, eligible boolean)
language sql stable security definer set search_path = public as $$
  with mine as (select friend_id from friends where user_id = auth.uid()),
  t as (select case when period = 'week' then week_bound(week_start(now())) else '-infinity'::timestamptz end as t0),
  stats as (
    select p.id, p.username, p.banner, p.frame, p.title,
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
         r.rank, r.banner, r.frame, r.title, r.eligible
  from ranked r
  where (r.rank is not null and r.rank <= max_rows) or r.id = auth.uid() or (r.rank is null and scope = 'friends')
  order by r.eligible desc, r.rank nulls last, r.net desc;
$$;

revoke all on function public.week_stats(date) from public, anon, authenticated;
revoke all on function public.settle_weeks() from public, anon, authenticated;
revoke all on function public.my_profile() from public, anon;
revoke all on function public.mark_rewards_seen() from public, anon;
revoke all on function public.buy_item(text) from public, anon;
revoke all on function public.equip(text) from public, anon;
revoke all on function public.leaderboard(text, int, text) from public, anon;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.mark_rewards_seen() to authenticated;
grant execute on function public.buy_item(text) to authenticated;
grant execute on function public.equip(text) to authenticated;
grant execute on function public.leaderboard(text, int, text) to authenticated;
