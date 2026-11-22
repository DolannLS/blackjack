-- Casino : recharge gratuite de 2 000 jetons (au lieu de 1 000), toutes les 3 heures (au lieu de 4), 3 fois par jour.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après jetons.sql). Peut être relancé.

create or replace function public.refill_chips() returns numeric
language plpgsql security definer set search_path = public as $$
declare p profiles; today date := paris_day(now()); used int;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select * into p from profiles where id = auth.uid() for update;
  if coalesce(p.chips, 0) >= 5 then raise exception 'pas_a_sec'; end if;
  used := case when p.refill_day = today then p.refill_count else 0 end;
  if used >= 3 then raise exception 'deja_recharge'; end if;
  if p.refill_at > now() - interval '3 hours' then
    raise exception 'trop_tot:%', ceil(extract(epoch from (p.refill_at + interval '3 hours' - now())) / 60)::int;
  end if;
  update profiles set chips = 2000, refill_at = now(), refill_day = today, refill_count = used + 1, last_refill = today where id = auth.uid();
  return 2000;
end $$;

-- Le profil annonce la prochaine recharge avec le nouveau délai
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
    'refill_next', case when p.refill_at > now() - interval '3 hours' then p.refill_at + interval '3 hours' end, 'avatar_url', p.avatar_url,
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

revoke all on function public.refill_chips() from public, anon;
revoke all on function public.my_profile() from public, anon;
grant execute on function public.refill_chips() to authenticated;
grant execute on function public.my_profile() to authenticated;
