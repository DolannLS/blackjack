-- Casino : 58 nouveaux objets en boutique et récompenses de saison cumulées.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après casier.sql). Peut être relancé.

-- ============ 24 bannières, 14 cadres, 20 titres de plus ============
insert into public.shop_items (id, kind, name, price, sort) values
  ('ocean-profond', 'banner', 'Océan profond', 600, 200),
  ('lagon', 'banner', 'Lagon', 500, 201),
  ('desert', 'banner', 'Désert', 450, 202),
  ('foret', 'banner', 'Forêt', 450, 203),
  ('volcan', 'banner', 'Volcan', 900, 204),
  ('cosmos', 'banner', 'Cosmos', 1400, 205),
  ('neige', 'banner', 'Neige', 400, 206),
  ('automne', 'banner', 'Automne', 450, 207),
  ('lavande', 'banner', 'Lavande', 500, 208),
  ('menthe', 'banner', 'Menthe glaciale', 500, 209),
  ('rubis-royal', 'banner', 'Rubis royal', 1100, 210),
  ('saphir-nuit', 'banner', 'Saphir de nuit', 1100, 211),
  ('emeraude-casino', 'banner', 'Émeraude du casino', 1200, 212),
  ('retro-80', 'banner', 'Rétro 80', 900, 213),
  ('synthwave', 'banner', 'Synthwave', 1000, 214),
  ('tartan', 'banner', 'Tartan', 550, 215),
  ('pied-de-poule', 'banner', 'Pied-de-poule', 600, 216),
  ('bayadere', 'banner', 'Bayadère', 450, 217),
  ('mosaique', 'banner', 'Mosaïque', 700, 218),
  ('ondes', 'banner', 'Ondes', 550, 219),
  ('eclair', 'banner', 'Éclair', 800, 220),
  ('roue', 'banner', 'Roue de roulette', 1000, 221),
  ('des', 'banner', 'Coup de dés', 650, 222),
  ('tapis-rouge', 'banner', 'Tapis rouge', 1800, 223),
  ('argent-poli', 'frame', 'Argent poli', 300, 200),
  ('bronze-antique', 'frame', 'Bronze antique', 300, 201),
  ('cuivre', 'frame', 'Cuivre', 350, 202),
  ('jade-imperial', 'frame', 'Jade impérial', 600, 203),
  ('amethyste', 'frame', 'Améthyste', 600, 204),
  ('grenat', 'frame', 'Grenat', 550, 205),
  ('citrine', 'frame', 'Citrine', 550, 206),
  ('opale', 'frame', 'Opale', 1100, 207),
  ('neon-rose', 'frame', 'Néon rose', 800, 208),
  ('neon-cyan', 'frame', 'Néon cyan', 800, 209),
  ('galaxie', 'frame', 'Galaxie', 1400, 210),
  ('arc-or', 'frame', 'Arc doré', 700, 211),
  ('pointilles', 'frame', 'Pointillés', 300, 212),
  ('electrique', 'frame', 'Électrique', 1300, 213),
  ('la-bankroll', 'title', 'La Bankroll', 600, 200),
  ('croupier-fou', 'title', 'Croupier fou', 300, 201),
  ('maitre-du-bluff', 'title', 'Maître du bluff', 700, 202),
  ('jamais-deux', 'title', 'Jamais deux sans trois', 350, 203),
  ('coup-de-poker', 'title', 'Coup de poker', 300, 204),
  ('coeur-de-pierre', 'title', 'Cœur de pierre', 450, 205),
  ('tapis-volant', 'title', 'Tapis volant', 400, 206),
  ('roi-de-coeur', 'title', 'Roi de cœur', 500, 207),
  ('reine-de-pique', 'title', 'Reine de pique', 500, 208),
  ('valet-de-carreau', 'title', 'Valet de carreau', 400, 209),
  ('as-de-trefle', 'title', 'As de trèfle', 600, 210),
  ('mains-d-argent', 'title', 'Mains d''argent', 450, 211),
  ('joueur-nocturne', 'title', 'Joueur nocturne', 250, 212),
  ('chasseur-jackpot', 'title', 'Chasseur de jackpot', 800, 213),
  ('rien-ne-va-plus', 'title', 'Rien ne va plus', 350, 214),
  ('faites-vos-jeux', 'title', 'Faites vos jeux', 200, 215),
  ('banco', 'title', 'Banco', 300, 216),
  ('double-ou-rien', 'title', 'Double ou rien', 550, 217),
  ('oeil-de-lynx', 'title', 'Œil de lynx', 450, 218),
  ('sans-peur', 'title', 'Sans peur', 900, 219)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- ============ Fin de saison : son rang + tous les rangs en dessous ============
-- Chaque joueur classé reçoit la bannière, le cadre, le titre et les couronnes de son rang
-- et de chacun des rangs inférieurs de la saison. Le champion reçoit en plus son propre ensemble.
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
        champ := rec.rank = 1 and rec.points >= 250;
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
