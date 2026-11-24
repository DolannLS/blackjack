-- Casino : au blackjack, remplacer le sabot entamé par un sabot neuf de 312 cartes mélangées, pour 25 couronnes.
-- À coller dans Supabase → SQL Editor → New query, puis « Run ». Peut être relancé.

create or replace function public.pay_new_shoe() returns int
language plpgsql security definer set search_path = public as $$
declare left_crowns int;
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  update profiles set crowns = crowns - 25 where id = auth.uid() and crowns >= 25 returning crowns into left_crowns;
  if left_crowns is null then raise exception 'solde'; end if;
  return left_crowns;
end $$;

revoke all on function public.pay_new_shoe() from public, anon;
grant execute on function public.pay_new_shoe() to authenticated;
