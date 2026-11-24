-- Casino : le total « Depuis toujours » du classement ne descend jamais sous −10 000.
-- Ceux qui sont plus bas remontent à −10 000. Ensuite, une perte qui ferait passer sous −10 000 est absorbée,
-- et chaque gain fait remonter tout de suite à partir de −10 000.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après maj-17-novembre.sql). Peut être relancé.

create table if not exists public.net_adjust (
  user_id uuid primary key references public.profiles on delete cascade,
  amount numeric(12, 2) not null,
  updated_at timestamptz not null default now()
);
alter table public.net_adjust enable row level security;

-- Remonte un joueur à −10 000 s'il est plus bas
create or replace function public.apply_net_floor(uid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare total numeric;
begin
  select coalesce((select sum(payout - stake) from games where user_id = uid), 0)
       + coalesce((select amount from net_adjust where user_id = uid), 0) into total;
  if total < -10000 then
    insert into net_adjust (user_id, amount) values (uid, -10000 - total)
      on conflict (user_id) do update set amount = net_adjust.amount + excluded.amount, updated_at = now();
  end if;
end $$;

-- Après chaque partie reçue
create or replace function public.games_net_floor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform apply_net_floor(new.user_id);
  return new;
end $$;
drop trigger if exists games_net_floor on public.games;
create trigger games_net_floor after insert on public.games
  for each row execute function public.games_net_floor();

-- Tout de suite pour ceux qui sont déjà sous −10 000
do $$
declare r record;
begin
  for r in select distinct user_id from games loop
    perform apply_net_floor(r.user_id);
  end loop;
end $$;

revoke all on function public.apply_net_floor(uuid) from public, anon, authenticated;
revoke all on function public.games_net_floor() from public, anon, authenticated;

-- Vérification : le total le plus bas doit être −10 000 ou plus
select min(coalesce(g.net, 0) + coalesce(a.amount, 0)) as total_le_plus_bas
from (select user_id, sum(payout - stake) as net from public.games group by user_id) g
left join public.net_adjust a on a.user_id = g.user_id;
