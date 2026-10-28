-- Casino : QR code d'invitation personnel.
-- À coller dans Supabase → SQL Editor → New query, puis « Run » (après schema.sql).

-- Un code unique par joueur, que lui seul peut lire (il est dans son QR code).
alter table public.profiles
  add column if not exists invite_code text not null default upper(substr(md5(gen_random_uuid()::text), 1, 8));
create unique index if not exists profiles_invite_code_key on public.profiles (invite_code);

-- Les autres joueurs voient les pseudos, jamais les codes.
revoke select on public.profiles from authenticated, anon;
grant select (id, username, created_at) on public.profiles to authenticated;

create or replace function public.my_invite() returns text
language sql stable security definer set search_path = public as $$
  select invite_code from profiles where id = auth.uid();
$$;

-- Nouveau code (l'ancien QR ne marche plus).
create or replace function public.reset_invite() returns text
language sql security definer set search_path = public as $$
  update profiles set invite_code = upper(substr(md5(gen_random_uuid()::text), 1, 8))
  where id = auth.uid()
  returning invite_code;
$$;

-- Qui invite ? Visible avant d'avoir un compte, pour afficher « Camille t'invite ».
create or replace function public.invite_info(code text) returns text
language sql stable security definer set search_path = public as $$
  select username from profiles where invite_code = upper(trim(code));
$$;

-- Scanner un QR : les deux joueurs deviennent amis l'un de l'autre.
create or replace function public.accept_invite(code text) returns text
language plpgsql security definer set search_path = public as $$
declare host uuid; host_name text;
begin
  if auth.uid() is null then return 'auth'; end if;
  select id, username into host, host_name from profiles where invite_code = upper(trim(code));
  if host is null then return 'introuvable'; end if;
  if host = auth.uid() then return 'soi'; end if;
  insert into friends (user_id, friend_id) values (auth.uid(), host), (host, auth.uid()) on conflict do nothing;
  return host_name;
end $$;

revoke all on function public.my_invite() from public, anon;
revoke all on function public.reset_invite() from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.invite_info(text) from public;
grant execute on function public.my_invite() to authenticated;
grant execute on function public.reset_invite() to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.invite_info(text) to anon, authenticated;
