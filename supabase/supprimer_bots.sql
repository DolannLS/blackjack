-- Retire les joueurs automatiques, leurs parties et leurs récompenses, et arrête leur activité.
-- À coller dans Supabase → SQL Editor → New query, puis « Run ».
update public.bot_state set enabled = false;
delete from auth.users where id in (select id from public.profiles where is_bot);
