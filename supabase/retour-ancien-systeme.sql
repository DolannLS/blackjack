-- Casino : revenir à l'ancien système de points (si le nouveau ne plaît pas aux joueurs).
-- À coller dans Supabase → SQL Editor → New query, puis « Run ».
-- Remet l'ancien calcul des points de saison et arrête le suivi du solde sur le serveur.
-- L'app doit aussi revenir à sa version précédente (demander à Claude).

-- Points : 1 par partie, plus 1 par tranche de 50 jetons gagnés sur une partie
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
revoke all on function public.season_stats(date) from public, anon, authenticated;

-- Le solde n'est plus suivi par le serveur
drop trigger if exists games_apply_chips on public.games;
update public.profiles set chips = null, last_refill = null;
