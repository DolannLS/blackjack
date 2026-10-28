-- Casino : défis quotidiens et récompense de connexion.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après catalogue.sql). Peut être relancé.

-- Les journées vont de minuit à minuit, heure de Paris.
create or replace function public.paris_day(ts timestamptz) returns date
language sql stable as $$ select (ts at time zone 'Europe/Paris')::date $$;
create or replace function public.day_bound(d date) returns timestamptz
language sql stable as $$ select d::timestamp at time zone 'Europe/Paris' $$;

-- ============ Connexion quotidienne ============
-- Jours 1 à 3 : 5 couronnes, jours 4 à 6 : 20, jour 7 : 50. Après le 7ᵉ jour, ou si un jour est manqué, on repart au jour 1.
create table if not exists public.daily_login (
  user_id uuid primary key references public.profiles on delete cascade,
  last_day date not null,
  streak int not null
);
alter table public.daily_login enable row level security;
drop policy if exists "ma connexion" on public.daily_login;
create policy "ma connexion" on public.daily_login for select to authenticated using (user_id = auth.uid());

create or replace function public.login_reward(day_in_streak int) returns int
language sql immutable as $$ select case when day_in_streak <= 3 then 5 when day_in_streak <= 6 then 20 else 50 end $$;

-- ============ Défis du jour ============
-- 3 défis tirés chaque jour dans cette liste, les mêmes pour tout le monde. Bonus de 50 couronnes pour les 3.
create table if not exists public.challenge_defs (
  id text primary key,
  label text not null,
  target numeric not null,
  crowns int not null
);
alter table public.challenge_defs enable row level security;
drop policy if exists "défis publics" on public.challenge_defs;
create policy "défis publics" on public.challenge_defs for select to authenticated using (true);
insert into public.challenge_defs (id, label, target, crowns) values
  ('play10',      'Joue 10 parties, tous jeux confondus',                10,   15),
  ('play25',      'Joue 25 parties, tous jeux confondus',                25,   30),
  ('bj_win3',     'Gagne 3 mains de blackjack',                          3,    20),
  ('bj_bj',       'Fais un blackjack',                                   1,    30),
  ('rl_win5',     'Gagne 5 lancers à la roulette',                       5,    20),
  ('rl_big',      'Gagne au moins 5 fois ta mise sur un lancer de roulette', 1, 40),
  ('pk_win2',     'Remporte 2 mains de Texas Hold''em',                  2,    25),
  ('pk_brelan',   'Fais un brelan ou mieux au Texas Hold''em',           1,    30),
  ('vp_play10',   'Joue 10 mains de vidéo poker',                        10,   20),
  ('vp_2p',       'Obtiens une double paire ou mieux au vidéo poker',    1,    25),
  ('stake1000',   'Mise 1 000 jetons au total',                          1000, 20),
  ('net300',      'Gagne 300 jetons nets dans la journée',               300,  40),
  ('three_games', 'Joue au blackjack, à la roulette et au poker',        3,    25),
  ('online3',     'Joue 3 mains de poker en ligne',                      3,    30)
on conflict (id) do update set label = excluded.label, target = excluded.target, crowns = excluded.crowns;

create table if not exists public.challenge_claims (
  user_id uuid not null references public.profiles on delete cascade,
  day date not null,
  challenge text not null,
  crowns int not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, day, challenge)
);
alter table public.challenge_claims enable row level security;
drop policy if exists "mes défis" on public.challenge_claims;
create policy "mes défis" on public.challenge_claims for select to authenticated using (user_id = auth.uid());

create or replace function public.daily_challenges(d date) returns setof public.challenge_defs
language sql stable set search_path = public as $$
  select * from challenge_defs order by md5(id || d::text) limit 3;
$$;

-- Progression d'un défi, calculée sur les parties reçues par le serveur ce jour-là.
create or replace function public.challenge_progress(uid uuid, cid text, d date) returns numeric
language sql stable security definer set search_path = public as $$
  with g as (select * from games where user_id = uid and received_at >= day_bound(d) and received_at < day_bound(d + 1))
  select (case cid
    when 'play10'      then (select count(*) from g)
    when 'play25'      then (select count(*) from g)
    when 'bj_win3'     then (select count(*) from g where game = 'blackjack' and payout > stake)
    when 'bj_bj'       then (select count(*) from g where game = 'blackjack' and detail ilike 'blackjack%')
    when 'rl_win5'     then (select count(*) from g where game = 'roulette' and payout > stake)
    when 'rl_big'      then (select count(*) from g where game = 'roulette' and payout >= stake * 5)
    when 'pk_win2'     then (select count(*) from g where game = 'holdem' and payout > stake)
    when 'pk_brelan'   then (select count(*) from g where game in ('holdem', 'online') and detail ~* '^(brelan|quinte|couleur|full|carré)')
    when 'vp_play10'   then (select count(*) from g where game = 'videopoker')
    when 'vp_2p'       then (select count(*) from g where game = 'videopoker' and payout >= stake * 2)
    when 'stake1000'   then (select coalesce(sum(stake), 0) from g)
    when 'net300'      then (select greatest(0, coalesce(sum(payout - stake), 0)) from g)
    when 'three_games' then (select count(distinct case when game in ('holdem', 'videopoker', 'online') then 'poker' else game end) from g)
    when 'online3'     then (select count(*) from g where game = 'online')
    else 0 end)::numeric;
$$;

-- Appelée à l'ouverture de l'app et après chaque envoi de parties :
-- verse la connexion du jour (une fois) et les défis réussis, puis renvoie l'état de la journée.
create or replace function public.daily_status() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); d date := paris_day(now()); dl daily_login; s int; gain int := 0;
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

revoke all on function public.challenge_progress(uuid, text, date) from public, anon, authenticated;
revoke all on function public.daily_status() from public, anon;
grant execute on function public.daily_status() to authenticated;
