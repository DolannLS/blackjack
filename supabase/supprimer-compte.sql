-- Casino : supprimer définitivement un compte joueur.
-- Mets le pseudo entre les guillemets simples de la ligne « pseudo text := ... », puis
-- colle tout dans Supabase → SQL Editor → New query, et « Run ».
-- Le compte, son profil, ses parties, ses objets, ses récompenses et ses amitiés sont effacés.
-- C'est irréversible.

do $$
declare
  pseudo text := 'Mat-g13';
  uid uuid; nom text; nb_parties int;
begin
  select id, username into uid, nom from public.profiles where lower(username) = lower(pseudo);
  if uid is null then
    raise exception 'Aucun compte avec le pseudo « % ». Vérifie l''orthographe dans le classement.', pseudo;
  end if;
  select count(*) into nb_parties from public.games where user_id = uid;
  delete from auth.users where id = uid;   -- le profil et tout ce qui en dépend suivent
  delete from public.profiles where id = uid; -- au cas où le profil n'était pas relié au compte
  raise notice 'Compte « % » supprimé (% parties effacées).', nom, nb_parties;
end $$;

-- Vérification : doit afficher 0
select count(*) as comptes_restants_avec_ce_pseudo from public.profiles where lower(username) = lower('Mat-g13');
