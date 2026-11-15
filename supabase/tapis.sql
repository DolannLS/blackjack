-- Casino : tapis de poker à personnaliser (Texas Hold'em contre les bots et poker en ligne).
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après nouveautes.sql). Peut être relancé.

-- ============ Un nouveau type d'objet : le tapis ============
alter table public.profiles add column if not exists felt text not null default 'ft-vert';
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.shop_items'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.shop_items drop constraint %I', c);
  end loop;
end $$;
alter table public.shop_items add constraint shop_items_kind_check check (kind in ('banner', 'frame', 'title', 'felt'));

-- ============ 18 tapis, dont le feutre vert offert à tous ============
insert into public.shop_items (id, kind, name, price, sort) values
  ('ft-vert', 'felt', 'Feutre vert', 0, 400),
  ('ft-bleu-nuit', 'felt', 'Feutre bleu nuit', 400, 401),
  ('ft-bordeaux', 'felt', 'Feutre bordeaux', 400, 402),
  ('ft-noir', 'felt', 'Feutre noir', 500, 403),
  ('ft-violet', 'felt', 'Feutre violet', 450, 404),
  ('ft-turquoise', 'felt', 'Feutre turquoise', 450, 405),
  ('ft-sable', 'felt', 'Feutre sable', 350, 406),
  ('ft-anthracite', 'felt', 'Feutre anthracite', 400, 407),
  ('ft-rose', 'felt', 'Feutre rose', 350, 408),
  ('ft-vegas', 'felt', 'Néons de Las Vegas', 1200, 409),
  ('ft-monaco', 'felt', 'Salon de Monaco', 1500, 410),
  ('ft-carbone', 'felt', 'Fibre de carbone', 900, 411),
  ('ft-marbre', 'felt', 'Marbre et or', 1400, 412),
  ('ft-large', 'felt', 'Grand large', 800, 413),
  ('ft-voie-lactee', 'felt', 'Voie lactée', 1600, 414),
  ('ft-damier', 'felt', 'Damier royal', 700, 415),
  ('ft-cuir', 'felt', 'Cuir capitonné', 1000, 416),
  ('ft-chene', 'felt', 'Table en chêne', 600, 417)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- ============ Équiper un tapis ============
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
    title  = case when it.kind = 'title'  then item else title end,
    felt   = case when it.kind = 'felt'   then item else felt end
  where id = auth.uid();
end $$;

-- ============ Vitrine de la semaine : 8 bannières, 5 cadres, 7 titres et 3 tapis ============
create or replace function public.shop_rotation(w date) returns table (item_id text)
language sql stable set search_path = public as $$
  select id from (
    select id, kind, row_number() over (partition by kind order by md5(id || w::text)) as rn
    from shop_items where price > 0
  ) x
  where (kind = 'banner' and rn <= 8) or (kind = 'frame' and rn <= 5) or (kind = 'title' and rn <= 7) or (kind = 'felt' and rn <= 3);
$$;

-- ============ Le profil renvoie le tapis équipé ============
create or replace function public.my_profile() returns json
language plpgsql security definer set search_path = public as $$
declare out json;
begin
  if auth.uid() is null then return null; end if;
  perform bots_tick();
  perform settle_weeks();
  perform settle_seasons();
  select json_build_object(
    'username', p.username, 'crowns', p.crowns, 'banner', p.banner, 'frame', p.frame, 'title', p.title, 'felt', p.felt, 'avatar_url', p.avatar_url,
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

revoke all on function public.equip(text) from public, anon;
grant execute on function public.equip(text) to authenticated;
revoke all on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;
