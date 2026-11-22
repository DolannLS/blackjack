-- Casino : plus de jetons pour rejouer.
-- 1. +500 jetons à la première connexion de chaque jour.
-- 2. Recharge de 2 000 jetons toutes les 2 heures, 3 fois par jour au plus, quand il reste moins de 5 jetons.
-- 3. Échange de couronnes contre des jetons : 100 couronnes = 1 000 jetons.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après maj-17-novembre.sql). Peut être relancé.

alter table public.profiles add column if not exists refill_at timestamptz;
alter table public.profiles add column if not exists refill_day date;
alter table public.profiles add column if not exists refill_count int not null default 0;

-- ============ 1. Bonus de jetons à la connexion du jour ============
create or replace function public.daily_status() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); d date := paris_day(now()); dl daily_login; s int; gain int := 0; chips_gift int := 0;
  rec record; prog numeric; got int; newly jsonb := '[]'::jsonb; done int;
begin
  if uid is null then return null; end if;
  perform pg_advisory_xact_lock(hashtext('daily' || uid::text));

  -- connexion du jour
  select * into dl from daily_login where user_id = uid;
  if not found or dl.last_day < d then
    s := case when found and dl.last_day = d - 1 and dl.streak < 7 then dl.streak + 1 else 1 end;
    gain := login_reward(s);
    insert into daily_login (user_id, last_day, streak) values (uid, d, s)
      on conflict (user_id) do update set last_day = excluded.last_day, streak = excluded.streak;
    update profiles set crowns = crowns + gain where id = uid;
    -- and 500 chips to start the day (on the account once its balance is known, otherwise on the phone)
    chips_gift := 500;
    update profiles set chips = chips + chips_gift where id = uid and chips is not null;
  else
    s := dl.streak;
  end if;

  -- défis réussis
  for rec in select * from daily_challenges(d) loop
    prog := challenge_progress(uid, rec.id, d);
    if prog >= rec.target then
      insert into challenge_claims (user_id, day, challenge, crowns) values (uid, d, rec.id, rec.crowns)
        on conflict do nothing;
      get diagnostics got = row_count;
      if got > 0 then
        update profiles set crowns = crowns + rec.crowns where id = uid;
        newly := newly || jsonb_build_object('label', rec.label, 'crowns', rec.crowns);
      end if;
    end if;
  end loop;
  select count(*) into done from challenge_claims where user_id = uid and day = d and challenge <> 'bonus';
  if done >= 3 then
    insert into challenge_claims (user_id, day, challenge, crowns) values (uid, d, 'bonus', 50) on conflict do nothing;
    get diagnostics got = row_count;
    if got > 0 then
      update profiles set crowns = crowns + 50 where id = uid;
      newly := newly || jsonb_build_object('label', 'Les 3 défis du jour', 'crowns', 50);
    end if;
  end if;

  return json_build_object(
    'day', d,
    'resets_at', day_bound(d + 1),
    'streak', s,
    'login_gain', gain,
    'login_chips', chips_gift,
    'chips', (select chips from profiles where id = uid),
    'login_next', login_reward(case when s >= 7 then 1 else s + 1 end),
    'newly', newly,
    'crowns', (select crowns from profiles where id = uid),
    'challenges', (select coalesce(json_agg(json_build_object(
                     'id', c.id, 'label', c.label, 'target', c.target, 'crowns', c.crowns,
                     'progress', least(c.target, challenge_progress(uid, c.id, d)),
                     'claimed', exists (select 1 from challenge_claims k where k.user_id = uid and k.day = d and k.challenge = c.id)
                   ) order by md5(c.id || d::text)), '[]'::json) from daily_challenges(d) c),
    'bonus', json_build_object('crowns', 50, 'claimed',
               exists (select 1 from challenge_claims k where k.user_id = uid and k.day = d and k.challenge = 'bonus'))
  );
end $$;

-- ============ 2. Recharge toutes les 2 heures, 3 par jour ============
create or replace function public.refill_chips() returns numeric
language plpgsql security definer set search_path = public as $$
declare p profiles; today date := paris_day(now()); used int;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select * into p from profiles where id = auth.uid() for update;
  if coalesce(p.chips, 0) >= 5 then raise exception 'pas_a_sec'; end if;
  used := case when p.refill_day = today then p.refill_count else 0 end;
  if used >= 3 then raise exception 'deja_recharge'; end if;
  if p.refill_at > now() - interval '2 hours' then
    raise exception 'trop_tot:%', ceil(extract(epoch from (p.refill_at + interval '2 hours' - now())) / 60)::int;
  end if;
  update profiles set chips = 2000, refill_at = now(), refill_day = today, refill_count = used + 1, last_refill = today where id = auth.uid();
  return 2000;
end $$;

-- ============ 3. Couronnes contre jetons ============
create or replace function public.buy_chips(packs int) returns json
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  if packs not in (1, 3, 5, 10) then raise exception 'pack_inconnu'; end if;
  select * into p from profiles where id = auth.uid() for update;
  if p.chips is null then raise exception 'solde_inconnu'; end if;
  if p.crowns < packs * 100 then raise exception 'solde'; end if;
  update profiles set crowns = crowns - packs * 100, chips = chips + packs * 1000 where id = auth.uid() returning * into p;
  return json_build_object('crowns', p.crowns, 'chips', p.chips);
end $$;

-- Le profil dit combien de recharges il reste et quand vient la prochaine
create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform bots_tick();
  perform settle_weeks();
  perform settle_seasons();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title, 'felt', p.felt, 'chips', p.chips, 'refilled_today', coalesce(p.refill_day = paris_day(now()) and p.refill_count >= 3, false),
    'refills_left', case when p.refill_day = paris_day(now()) then greatest(0, 3 - p.refill_count) else 3 end,
    'refill_next', case when p.refill_at > now() - interval '2 hours' then p.refill_at + interval '2 hours' end, 'avatar_url', p.avatar_url,
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

revoke all on function public.daily_status() from public, anon;
revoke all on function public.refill_chips() from public, anon;
revoke all on function public.buy_chips(int) from public, anon;
revoke all on function public.my_profile() from public, anon;
grant execute on function public.daily_status() to authenticated;
grant execute on function public.refill_chips() to authenticated;
grant execute on function public.buy_chips(int) to authenticated;
grant execute on function public.my_profile() to authenticated;
