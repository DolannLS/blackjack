-- Casino : rangs de saison plus durs à atteindre, et la machine à sous.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après tapis.sql). Peut être relancé.
-- Les nouveaux paliers s'appliquent à la saison en cours : le rang de chacun est recalculé.

-- ============ La machine à sous enregistre ses parties ============
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.games'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%blackjack%'
  loop
    execute format('alter table public.games drop constraint %I', c);
  end loop;
end $$;
alter table public.games add constraint games_game_check
  check (game in ('blackjack', 'roulette', 'holdem', 'videopoker', 'online', 'slots'));

-- ============ Paliers des rangs ============

update public.season_tiers set min_points = x.pts
from (values ('bronze', 50), ('fer', 250), ('argent', 600), ('or', 1000), ('platine', 1600),
             ('diamant', 2500), ('alexandrite', 4000), ('top-100', 4000)) as x(id, pts)
where season_tiers.id = x.id;

-- Top 100 : les 100 meilleurs, à partir de 4 000 points
create or replace function public.tier_for(points numeric, rank bigint) returns text
language sql stable set search_path = public as $$
  select case
    when points >= 4000 and rank <= 100 then 'top-100'
    else (select id from season_tiers where id <> 'top-100' and min_points <= points order by sort desc limit 1)
  end;
$$;

-- Champion de la saison : 1er, avec au moins le rang Argent (600 points)
create or replace function public.settle_seasons() returns int
language plpgsql security definer set search_path = public as $$
declare
  s date; cur date := season_start(now()); n int := 0; rec record; t season_tiers; lt season_tiers; its text[]; c int; champ boolean;
begin
  perform pg_advisory_xact_lock(434343);
  select season_start(min(received_at)) into s from games;
  if s is null then return 0; end if;
  while s < cur loop
    if not exists (select 1 from season_results where season = s) then
      for rec in select * from season_stats(s) where points >= 20 loop
        select * into t from season_tiers where id = tier_for(rec.points, rec.rank);
        its := '{}'; c := 0;
        for lt in select * from season_tiers where sort <= t.sort order by sort loop
          its := its || season_items(s, lt.id);
          c := c + lt.crowns;
        end loop;
        champ := rec.rank = 1 and rec.points >= 600;
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
revoke all on function public.settle_seasons() from public, anon, authenticated;
