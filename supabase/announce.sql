-- Announcements: remember which app update created them, and whether a notification went out.
alter table public.announcements add column if not exists release_id text unique;
alter table public.announcements add column if not exists notified_at timestamptz;
alter table public.announcements add column if not exists notified_push int;
alter table public.announcements add column if not exists notified_line int;

create or replace function public.admin_save_announcement(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare aid bigint;
begin
  perform public.admin_guard();
  if (p->>'id') is null then
    insert into announcements (title, body, level, starts_at, ends_at, active, release_id)
    values (p->>'title', coalesce(p->>'body', ''), coalesce(p->>'level', 'info'), coalesce((p->>'starts_at')::timestamptz, now()), (p->>'ends_at')::timestamptz, coalesce((p->>'active')::boolean, true), nullif(p->>'release_id', ''))
    on conflict (release_id) do nothing
    returning id into aid;
  else
    update announcements set title = p->>'title', body = coalesce(p->>'body', ''), level = coalesce(p->>'level', 'info'),
      starts_at = coalesce((p->>'starts_at')::timestamptz, starts_at), ends_at = (p->>'ends_at')::timestamptz, active = coalesce((p->>'active')::boolean, true)
    where id = (p->>'id')::bigint returning id into aid;
  end if;
  return aid;
end $$;

-- how many phones and LINE accounts an announcement would reach
create or replace function public.admin_announce_reach() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'push', (select count(distinct user_id) from push_subs),
    'line', (select count(*) from profiles where line_user_id is not null));
end $$;
revoke all on function public.admin_announce_reach() from public, anon;
grant execute on function public.admin_announce_reach() to authenticated;
