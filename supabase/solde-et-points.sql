-- Casino : nouveau système de solde et de points (à tester avec les joueurs).
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après roue.sql). Peut être relancé.
-- Pour revenir à l'ancien système : lancer retour-ancien-systeme.sql.

-- ============ 1. Points de saison plus justes ============
-- Par jour (heure de Paris) : 1 point par partie, 30 au plus, puis 1 point par tranche de 50 jetons
-- de gain net de la journée (gains moins pertes). Une journée perdante ne rapporte que la participation.
create or replace function public.season_stats(s date)
returns table (user_id uuid, points numeric, games bigint, net numeric, rank bigint)
language sql stable security definer set search_path = public as $$
  with per_day as (
    select g.user_id, paris_day(g.received_at) as d, count(*) as n, sum(g.payout - g.stake) as net
    from games g
    where g.received_at >= week_bound(s) and g.received_at < week_bound(season_next(s))
    group by g.user_id, paris_day(g.received_at)
  ),
  st as (
    select user_id, sum(least(n, 30) + floor(greatest(0, net) / 50.0))::numeric as points, sum(n)::bigint as games, sum(net) as net
    from per_day group by user_id
  )
  select st.user_id, st.points, st.games, st.net, rank() over (order by st.points desc, st.games desc) from st;
$$;
revoke all on function public.season_stats(date) from public, anon, authenticated;

-- ============ 2. Le solde de jetons est gardé sur le compte ============
-- Même solde sur tous les appareils. Il suit les parties envoyées (sauf le poker en ligne, qui a ses jetons de table).
alter table public.profiles add column if not exists chips numeric(14, 2);
alter table public.profiles add column if not exists last_refill date;

create or replace function public.apply_game_chips() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.game <> 'online' then
    update profiles set chips = greatest(0, chips + new.payout - new.stake) where id = new.user_id and chips is not null;
  end if;
  return new;
end $$;
drop trigger if exists games_apply_chips on public.games;
create trigger games_apply_chips after insert on public.games
  for each row execute function public.apply_game_chips();

-- La première fois, le solde que le joueur avait sur son téléphone est repris (1 million au plus).
create or replace function public.init_chips(amount numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare out numeric;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  update profiles set chips = least(1000000, greatest(0, coalesce(amount, 1000)))
    where id = auth.uid() and chips is null;
  select chips into out from profiles where id = auth.uid();
  return out;
end $$;

-- ============ 3. Une recharge gratuite par jour ============
-- Seulement quand il reste moins de 5 jetons. Le compteur repart à minuit (heure de Paris).
create or replace function public.refill_chips() returns numeric
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select * into p from profiles where id = auth.uid() for update;
  if coalesce(p.chips, 0) >= 5 then raise exception 'pas_a_sec'; end if;
  if p.last_refill = paris_day(now()) then raise exception 'deja_recharge'; end if;
  update profiles set chips = 1000, last_refill = paris_day(now()) where id = auth.uid();
  return 1000;
end $$;

-- La roue verse aussi ses jetons sur le compte
create or replace function public.spin_wheel() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); d date := paris_day(now()); total int; pick int; acc int := 0; p wheel_prizes; c int; it text;
begin
  if uid is null then raise exception 'auth'; end if;
  perform pg_advisory_xact_lock(hashtext('wheel' || uid::text));
  if exists (select 1 from wheel_spins where user_id = uid and day = d) then raise exception 'deja_tourne'; end if;
  select sum(weight) into total from wheel_prizes;
  pick := floor(random() * total)::int;
  for p in select * from wheel_prizes order by id loop
    acc := acc + p.weight;
    exit when pick < acc;
  end loop;
  c := p.crowns; it := p.item;
  if it is not null and exists (select 1 from inventory where user_id = uid and item_id = it) then
    c := c + 300; it := null;
  end if;
  insert into wheel_spins (user_id, day, prize, crowns, chips, item) values (uid, d, p.id, c, p.chips, it);
  if c > 0 then update profiles set crowns = crowns + c where id = uid; end if;
  if p.chips > 0 then update profiles set chips = coalesce(chips, 1000) + p.chips where id = uid; end if;
  if it is not null then insert into inventory (user_id, item_id, source) values (uid, it, 'roue du jour') on conflict do nothing; end if;
  return json_build_object('prize', p.id, 'label', p.label, 'crowns', c, 'chips', p.chips, 'item', it,
                           'total_crowns', (select crowns from profiles where id = uid), 'total_chips', (select chips from profiles where id = uid), 'next_at', day_bound(d + 1));
end $$;
-- Le profil renvoie le solde et la recharge du jour
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
    'season_rewards', (select coalesce(json_agg(r order by r.season desc), '[]'::json)
                from (select season, tier, rank, points, champion, crowns, items from season_rewards where user_id = p.id and not seen) r),
    'season', season_status_for(p.id),
    'week_start', week_start(now()),
    'week_end', week_bound(week_start(now()) + 7)
  ) into out from profiles p where p.id = auth.uid();
  return out;
end $$;

revoke all on function public.apply_game_chips() from public, anon, authenticated;
revoke all on function public.init_chips(numeric) from public, anon;
revoke all on function public.refill_chips() from public, anon;
revoke all on function public.spin_wheel() from public, anon;
revoke all on function public.my_profile() from public, anon;
grant execute on function public.init_chips(numeric) to authenticated;
grant execute on function public.refill_chips() to authenticated;
grant execute on function public.spin_wheel() to authenticated;
grant execute on function public.my_profile() to authenticated;
