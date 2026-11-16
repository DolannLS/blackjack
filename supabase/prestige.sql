-- Casino : collection Prestige, 42 objets illustrés et animés, et une vitrine plus grande.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après solde-et-points.sql). Peut être relancé.

insert into public.shop_items (id, kind, name, price, sort) values
  ('vegas-skyline', 'banner', 'Skyline de Las Vegas', 2200, 600),
  ('pluie-cartes', 'banner', 'Pluie de cartes', 2400, 601),
  ('roulette-live', 'banner', 'Roulette en marche', 2600, 602),
  ('aurore-vivante', 'banner', 'Aurore vivante', 1800, 603),
  ('dragon-imperial', 'banner', 'Dragon impérial', 3000, 604),
  ('monte-carlo', 'banner', 'Nuit à Monte-Carlo', 2200, 605),
  ('orage-electrique', 'banner', 'Orage électrique', 2000, 606),
  ('neon-777', 'banner', 'Néon 777', 2500, 607),
  ('tresor', 'banner', 'Trésor du casino', 2400, 608),
  ('galaxie-spirale', 'banner', 'Galaxie spirale', 2200, 609),
  ('feu-artifice', 'banner', 'Feu d''artifice', 2600, 610),
  ('koi', 'banner', 'Bassin des carpes koï', 2000, 611),
  ('pluie-diamants', 'banner', 'Pluie de diamants', 2800, 612),
  ('rideau-velours', 'banner', 'Lever de rideau', 1900, 613),
  ('route-synthwave', 'banner', 'Route synthwave', 2400, 614),
  ('feu-sacre', 'banner', 'Feu sacré', 2600, 615),
  ('laurier', 'frame', 'Couronne de laurier', 1800, 616),
  ('orbite-as', 'frame', 'Orbite des As', 2000, 617),
  ('anneau-feu', 'frame', 'Anneau de feu', 1900, 618),
  ('givre', 'frame', 'Couronne de givre', 1600, 619),
  ('neon-pulse', 'frame', 'Néon pulsé', 1500, 620),
  ('serti-rubis', 'frame', 'Serti de rubis', 1700, 621),
  ('halo-celeste', 'frame', 'Halo céleste', 2200, 622),
  ('anneau-jetons', 'frame', 'Anneau de jetons', 1600, 623),
  ('jackpot', 'title', 'Jackpot', 1500, 624),
  ('main-du-diable', 'title', 'Main du diable', 1800, 625),
  ('coeur-de-glace', 'title', 'Cœur de glace', 1500, 626),
  ('oiseau-de-nuit', 'title', 'Oiseau de nuit', 1600, 627),
  ('le-magnat', 'title', 'Le Magnat', 2000, 628),
  ('hors-systeme', 'title', 'Hors système', 1700, 629),
  ('empereur', 'title', 'Empereur du casino', 2500, 630),
  ('intouchable', 'title', 'Intouchable', 1800, 631),
  ('maitre-du-temps', 'title', 'Maître du temps', 1400, 632),
  ('ame-de-dragon', 'title', 'Âme de dragon', 2000, 633),
  ('etoile-filante', 'title', 'Étoile filante', 1500, 634),
  ('millionnaire', 'title', 'Millionnaire', 2200, 635),
  ('ft-royal', 'felt', 'Feutre royal', 1800, 636),
  ('ft-cyber', 'felt', 'Néon cyberpunk', 1900, 637),
  ('ft-dragon', 'felt', 'Dragon rouge', 2400, 638),
  ('ft-monte-carlo', 'felt', 'Monte-Carlo', 2000, 639),
  ('ft-lave', 'felt', 'Lave en fusion', 2200, 640),
  ('ft-aurore', 'felt', 'Aurore boréale', 2200, 641)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- Vitrine de la semaine : 10 bannières, 7 cadres, 9 titres et 4 tapis
create or replace function public.shop_rotation(w date) returns table (item_id text)
language sql stable set search_path = public as $$
  select id from (
    select id, kind, row_number() over (partition by kind order by md5(id || w::text)) as rn
    from shop_items where price > 0
  ) x
  where (kind = 'banner' and rn <= 10) or (kind = 'frame' and rn <= 7) or (kind = 'title' and rn <= 9) or (kind = 'felt' and rn <= 4);
$$;
