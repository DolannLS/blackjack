-- Casino : 70 nouveaux objets en boutique et une vitrine plus grande chaque semaine.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après defis.sql). Peut être relancé.

-- ============ 30 bannières, 16 cadres, 24 titres de plus ============
insert into public.shop_items (id, kind, name, price, sort) values
  ('eclipse', 'banner', 'Éclipse', 1300, 300),
  ('tropiques', 'banner', 'Tropiques', 500, 301),
  ('minuit', 'banner', 'Minuit', 400, 302),
  ('orage', 'banner', 'Orage', 750, 303),
  ('marbre-noir', 'banner', 'Marbre noir', 900, 304),
  ('marbre-blanc', 'banner', 'Marbre blanc', 900, 305),
  ('or-massif', 'banner', 'Or massif', 2000, 306),
  ('bambou', 'banner', 'Bambou', 500, 307),
  ('corail', 'banner', 'Récif de corail', 650, 308),
  ('nebuleuse', 'banner', 'Nébuleuse', 1200, 309),
  ('code-vert', 'banner', 'Code vert', 800, 310),
  ('pixel', 'banner', 'Pixel', 600, 311),
  ('zebre', 'banner', 'Zèbre', 550, 312),
  ('leopard', 'banner', 'Léopard', 650, 313),
  ('camouflage', 'banner', 'Camouflage', 450, 314),
  ('arc-en-ciel', 'banner', 'Arc-en-ciel', 700, 315),
  ('bonbon', 'banner', 'Bonbon', 400, 316),
  ('cerise', 'banner', 'Cerise', 450, 317),
  ('agrumes', 'banner', 'Agrumes', 450, 318),
  ('pluie-jetons', 'banner', 'Pluie de jetons', 1100, 319),
  ('main-gagnante', 'banner', 'Main gagnante', 900, 320),
  ('porte-bonheur', 'banner', 'Trèfle porte-bonheur', 700, 321),
  ('gatsby', 'banner', 'Gatsby', 1300, 322),
  ('vitrail', 'banner', 'Vitrail', 1000, 323),
  ('origami', 'banner', 'Origami', 550, 324),
  ('circuit', 'banner', 'Circuit', 800, 325),
  ('lave', 'banner', 'Lave', 950, 326),
  ('abysses', 'banner', 'Abysses', 850, 327),
  ('crepuscule', 'banner', 'Crépuscule', 500, 328),
  ('champagne', 'banner', 'Champagne', 1500, 329),
  ('platine-pur', 'frame', 'Platine pur', 900, 300),
  ('obsidienne', 'frame', 'Obsidienne', 650, 301),
  ('corail-vif', 'frame', 'Corail', 450, 302),
  ('menthe-givree', 'frame', 'Menthe givrée', 450, 303),
  ('lilas', 'frame', 'Lilas', 400, 304),
  ('feu-glace', 'frame', 'Feu et glace', 1300, 305),
  ('ruban-arc-en-ciel', 'frame', 'Ruban arc-en-ciel', 1000, 306),
  ('aurore-polaire', 'frame', 'Aurore polaire', 1200, 307),
  ('chrome', 'frame', 'Chrome', 700, 308),
  ('coulee-lave', 'frame', 'Coulée de lave', 1100, 309),
  ('tournesol', 'frame', 'Tournesol', 500, 310),
  ('nuit-bleue', 'frame', 'Nuit bleue', 450, 311),
  ('diamant-noir', 'frame', 'Diamant noir', 1600, 312),
  ('jeton', 'frame', 'Jeton de casino', 800, 313),
  ('fleur-cerisier', 'frame', 'Fleur de cerisier', 600, 314),
  ('toxique', 'frame', 'Toxique', 750, 315),
  ('all-in', 'title', 'All-in', 500, 300),
  ('le-croupier', 'title', 'Le Croupier', 400, 301),
  ('vingt-et-un', 'title', 'Vingt-et-un', 350, 302),
  ('poker-face', 'title', 'Poker face', 600, 303),
  ('le-parrain', 'title', 'Le Parrain', 1200, 304),
  ('nerfs-d-acier', 'title', 'Nerfs d''acier', 500, 305),
  ('petit-joueur', 'title', 'Petit joueur', 100, 306),
  ('roi-de-la-river', 'title', 'Roi de la river', 650, 307),
  ('zero-pointe', 'title', 'Zéro pointé', 200, 308),
  ('quinte-royale', 'title', 'Quinte flush royale', 1500, 309),
  ('fortune', 'title', 'Fortune', 700, 310),
  ('le-stratege', 'title', 'Le Stratège', 450, 311),
  ('chat-noir', 'title', 'Chat noir', 300, 312),
  ('trefle-a-quatre', 'title', 'Trèfle à quatre feuilles', 550, 313),
  ('baron', 'title', 'Baron du casino', 900, 314),
  ('duchesse', 'title', 'Duchesse', 900, 315),
  ('mise-max', 'title', 'Mise max', 400, 316),
  ('pas-de-chance', 'title', 'Pas de chance', 150, 317),
  ('le-calculateur', 'title', 'Le Calculateur', 500, 318),
  ('grand-seigneur', 'title', 'Grand seigneur', 750, 319),
  ('tout-ou-rien', 'title', 'Tout ou rien', 450, 320),
  ('loup-du-tapis', 'title', 'Loup du tapis', 800, 321),
  ('maitre-zen', 'title', 'Maître zen', 350, 322),
  ('nuit-blanche', 'title', 'Nuit blanche', 300, 323)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price, sort = excluded.sort;

-- ============ Vitrine de la semaine : 8 bannières, 5 cadres et 7 titres ============
create or replace function public.shop_rotation(w date) returns table (item_id text)
language sql stable set search_path = public as $$
  select id from (
    select id, kind, row_number() over (partition by kind order by md5(id || w::text)) as rn
    from shop_items where price > 0
  ) x
  where (kind = 'banner' and rn <= 8) or (kind = 'frame' and rn <= 5) or (kind = 'title' and rn <= 7);
$$;
