-- One phone can hold two home-screen apps (teacher app and admin app). Each subscription remembers which app(s) it belongs to.
alter table public.push_subs add column if not exists apps text[] not null default '{teacher}';
create or replace function public.push_sub_save(p_sub jsonb, p_app text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_app not in ('teacher', 'admin') or coalesce(p_sub->>'endpoint', '') = '' then raise exception 'bad request'; end if;
  if p_app = 'admin' and not exists (select 1 from admins where user_id = auth.uid()) then raise exception 'forbidden'; end if;
  insert into push_subs (endpoint, user_id, sub, apps) values (p_sub->>'endpoint', auth.uid(), p_sub, array[p_app])
  on conflict (endpoint) do update set user_id = auth.uid(), sub = excluded.sub,
    apps = case when push_subs.user_id = auth.uid() then (select array_agg(distinct a) from unnest(push_subs.apps || array[p_app]) a) else array[p_app] end;
end $$;
-- returns how many apps still use this subscription (0 = the phone can unsubscribe)
create or replace function public.push_sub_remove(p_endpoint text, p_app text) returns int language plpgsql security definer set search_path = public as $$
declare left_n int;
begin
  update push_subs set apps = array_remove(apps, p_app) where endpoint = p_endpoint and user_id = auth.uid() returning coalesce(array_length(apps, 1), 0) into left_n;
  if left_n is null then return 0; end if;
  if left_n = 0 then delete from push_subs where endpoint = p_endpoint and user_id = auth.uid(); end if;
  return left_n;
end $$;
revoke all on function public.push_sub_save(jsonb, text), public.push_sub_remove(text, text) from public, anon;
grant execute on function public.push_sub_save(jsonb, text), public.push_sub_remove(text, text) to authenticated;
