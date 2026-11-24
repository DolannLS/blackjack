-- Casino : messages et vocaux entre amis.
-- On peut écrire à un joueur qui est dans ses amis (ou qui nous a ajouté).
-- Les vocaux sont rangés dans un espace privé : seuls l'expéditeur et le destinataire peuvent les écouter.
-- À coller dans Supabase → SQL Editor → New query, puis « Run ». Peut être relancé.

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  sender uuid not null references public.profiles on delete cascade,
  recipient uuid not null references public.profiles on delete cascade,
  body text check (char_length(body) <= 1000),
  audio_path text check (char_length(audio_path) <= 200),
  audio_seconds int check (audio_seconds between 0 and 120),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (body is not null or audio_path is not null),
  check (sender <> recipient)
);
create index if not exists messages_pair on public.messages (least(sender, recipient), greatest(sender, recipient), created_at desc);
create index if not exists messages_unread on public.messages (recipient) where read_at is null;
alter table public.messages enable row level security;
drop policy if exists "mes messages" on public.messages;
create policy "mes messages" on public.messages for select to authenticated using (sender = auth.uid() or recipient = auth.uid());

-- Espace privé des vocaux : voice/<id de l'expéditeur>/<fichier>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice', 'voice', false, 2097152, array['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/x-m4a'])
on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/x-m4a'];
drop policy if exists "vocaux envoi" on storage.objects;
create policy "vocaux envoi" on storage.objects for insert to authenticated
  with check (bucket_id = 'voice' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "vocaux écoute" on storage.objects;
create policy "vocaux écoute" on storage.objects for select to authenticated
  using (bucket_id = 'voice' and ((storage.foldername(name))[1] = auth.uid()::text
         or exists (select 1 from public.messages m where m.audio_path = name and m.recipient = auth.uid())));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from friends where (user_id = a and friend_id = b) or (user_id = b and friend_id = a));
$$;

-- Envoyer un message (texte et/ou vocal) à un ami
create or replace function public.send_message(to_name text, body text default null, audio_path text default null, audio_seconds int default null)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid; m messages;
begin
  if me is null then raise exception 'auth'; end if;
  select id into them from profiles where lower(username) = lower(trim(to_name));
  if them is null then raise exception 'introuvable'; end if;
  if not are_friends(me, them) then raise exception 'pas_ami'; end if;
  body := nullif(trim(coalesce(body, '')), '');
  if body is null and audio_path is null then raise exception 'vide'; end if;
  if audio_path is not null and split_part(audio_path, '/', 1) <> me::text then raise exception 'vocal'; end if;
  if (select count(*) from messages where sender = me and created_at > now() - interval '1 minute') >= 20 then raise exception 'trop_vite'; end if;
  insert into messages (sender, recipient, body, audio_path, audio_seconds)
    values (me, them, left(body, 1000), audio_path, least(120, greatest(0, coalesce(audio_seconds, 0)))) returning * into m;
  return json_build_object('id', m.id, 'mine', true, 'body', m.body, 'audio_path', m.audio_path, 'audio_seconds', m.audio_seconds, 'created_at', m.created_at, 'read', false);
end $$;

-- Mes conversations : chaque ami, son dernier message et les non-lus
create or replace function public.my_conversations() returns json
language sql stable security definer set search_path = public as $$
  with mates as (
    select distinct case when f.user_id = auth.uid() then f.friend_id else f.user_id end as id
    from friends f where f.user_id = auth.uid() or f.friend_id = auth.uid()
  ),
  last as (
    select distinct on (mt.id) mt.id, m.body, m.audio_path, m.created_at, m.sender = auth.uid() as mine
    from mates mt left join messages m on (m.sender = mt.id and m.recipient = auth.uid()) or (m.sender = auth.uid() and m.recipient = mt.id)
    order by mt.id, m.created_at desc nulls last
  )
  select coalesce(json_agg(json_build_object(
           'username', p.username, 'banner', p.banner, 'frame', p.frame, 'avatar_url', p.avatar_url,
           'last', l.body, 'last_audio', l.audio_path is not null, 'last_at', l.created_at, 'last_mine', l.mine,
           'unread', (select count(*) from messages u where u.sender = p.id and u.recipient = auth.uid() and u.read_at is null))
         order by l.created_at desc nulls last, p.username), '[]'::json)
  from last l join profiles p on p.id = l.id;
$$;

-- Les messages avec un ami (les plus récents), marqués comme lus
create or replace function public.conversation(with_name text, before_id bigint default null) returns json
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid; out json;
begin
  if me is null then raise exception 'auth'; end if;
  select id into them from profiles where lower(username) = lower(trim(with_name));
  if them is null then raise exception 'introuvable'; end if;
  update messages set read_at = now() where sender = them and recipient = me and read_at is null;
  select coalesce(json_agg(x order by x.id), '[]'::json) into out from (
    select m.id, m.sender = me as mine, m.body, m.audio_path, m.audio_seconds, m.created_at, m.read_at is not null as read
    from messages m
    where ((m.sender = me and m.recipient = them) or (m.sender = them and m.recipient = me)) and (before_id is null or m.id < before_id)
    order by m.id desc limit 60
  ) x;
  return json_build_object('with', (select username from profiles where id = them), 'friends', are_friends(me, them), 'messages', out);
end $$;

create or replace function public.unread_messages() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from messages where recipient = auth.uid() and read_at is null;
$$;

revoke all on function public.are_friends(uuid, uuid) from public, anon, authenticated;
revoke all on function public.send_message(text, text, text, int) from public, anon;
revoke all on function public.my_conversations() from public, anon;
revoke all on function public.conversation(text, bigint) from public, anon;
revoke all on function public.unread_messages() from public, anon;
grant execute on function public.send_message(text, text, text, int) to authenticated;
grant execute on function public.my_conversations() to authenticated;
grant execute on function public.conversation(text, bigint) to authenticated;
grant execute on function public.unread_messages() to authenticated;
