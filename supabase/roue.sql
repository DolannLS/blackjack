-- Casino : la roue du jour, un tour gratuit par jour (minuit à minuit, heure de Paris).
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après rangs-et-machine.sql). Peut être relancé.
-- Le tirage est fait par le serveur : impossible de choisir sa récompense en modifiant l'app.

-- La super récompense : une bannière exclusive, uniquement à la roue
insert into public.shop_items (id, kind, name, price, sort) values
  ('roue-fortune', 'banner', 'Roue de la fortune', null, 500)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- Les cases de la roue. weight = chances sur 1 000.
create table if not exists public.wheel_prizes (
  id text primary key,
  label text not null,
  crowns int not null default 0,
  chips int not null default 0,
  item text references public.shop_items,
  weight int not null check (weight > 0)
);
alter table public.wheel_prizes enable row level security;
drop policy if exists "roue publique" on public.wheel_prizes;
create policy "roue publique" on public.wheel_prizes for select to authenticated using (true);
insert into public.wheel_prizes (id, label, crowns, chips, item, weight) values
  ('perdu',  'Perdu',                    0,    0, null,           120),
  ('c10',    '10 couronnes',            10,    0, null,           250),
  ('c25',    '25 couronnes',            25,    0, null,           200),
  ('c50',    '50 couronnes',            50,    0, null,           110),
  ('c100',   '100 couronnes',          100,    0, null,            50),
  ('c250',   '250 couronnes',          250,    0, null,            15),
  ('c1000',  'Jackpot : 1 000 couronnes', 1000, 0, null,            5),
  ('j200',   '200 jetons',               0,  200, null,           140),
  ('j500',   '500 jetons',               0,  500, null,            70),
  ('j1000',  '1 000 jetons',             0, 1000, null,            30),
  ('objet',  'Bannière Roue de la fortune', 0, 0, 'roue-fortune',  10)
on conflict (id) do update set label = excluded.label, crowns = excluded.crowns, chips = excluded.chips, item = excluded.item, weight = excluded.weight;

create table if not exists public.wheel_spins (
  user_id uuid not null references public.profiles on delete cascade,
  day date not null,
  prize text not null,
  crowns int not null,
  chips int not null,
  item text,
  spun_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.wheel_spins enable row level security;
drop policy if exists "mes tours" on public.wheel_spins;
create policy "mes tours" on public.wheel_spins for select to authenticated using (user_id = auth.uid());

create or replace function public.wheel_status() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'day', paris_day(now()),
    'next_at', day_bound(paris_day(now()) + 1),
    'today', (select json_build_object('prize', prize, 'crowns', crowns, 'chips', chips, 'item', item)
              from wheel_spins where user_id = auth.uid() and day = paris_day(now())),
    'prizes', (select json_agg(json_build_object('id', id, 'label', label, 'crowns', crowns, 'chips', chips, 'item', item, 'weight', weight) order by weight desc) from wheel_prizes)
  );
$$;

-- Un tour par jour. La bannière exclusive déjà gagnée est remplacée par 300 couronnes.
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
  if it is not null then insert into inventory (user_id, item_id, source) values (uid, it, 'roue du jour') on conflict do nothing; end if;
  return json_build_object('prize', p.id, 'label', p.label, 'crowns', c, 'chips', p.chips, 'item', it,
                           'total_crowns', (select crowns from profiles where id = uid), 'next_at', day_bound(d + 1));
end $$;

revoke all on function public.wheel_status() from public, anon;
revoke all on function public.spin_wheel() from public, anon;
grant execute on function public.wheel_status() to authenticated;
grant execute on function public.spin_wheel() to authenticated;
