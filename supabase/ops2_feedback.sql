-- Feedback inbox and site-wide announcements.
create table if not exists public.feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete cascade,
  category text not null default 'question',
  message text not null,
  status text not null default 'open' check (status in ('open', 'replied', 'closed')),
  reply text,
  replied_at timestamptz
);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
grant all on public.feedback to service_role;
grant usage, select on sequence public.feedback_id_seq to service_role;

create or replace function public.submit_feedback(p_category text, p_message text) returns bigint language plpgsql security definer set search_path = public as $$
declare fid bigint; n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_message, ''))) < 2 then raise exception 'empty'; end if;
  select count(*) into n from feedback where user_id = auth.uid() and created_at > now() - interval '1 day';
  if n >= 10 then raise exception 'too_many'; end if;
  insert into feedback (user_id, category, message) values (auth.uid(), coalesce(nullif(p_category, ''), 'question'), left(trim(p_message), 2000)) returning id into fid;
  return fid;
end $$;
create or replace function public.my_feedback() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'category', category, 'message', message, 'status', status, 'reply', reply, 'replied_at', replied_at) order by created_at desc), '[]'::jsonb)
  from (select * from feedback where user_id = auth.uid() order by created_at desc limit 30) f;
$$;
create or replace function public.admin_feedback() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'created_at', f.created_at, 'category', f.category, 'message', f.message, 'status', f.status,
      'reply', f.reply, 'replied_at', f.replied_at, 'user_id', f.user_id, 'name', coalesce(p.display_name, '')) order by (f.status = 'open') desc, f.created_at desc)
    from (select * from feedback order by created_at desc limit 300) f left join profiles p on p.id = f.user_id), '[]'::jsonb);
end $$;
create or replace function public.admin_reply_feedback(p_id bigint, p_reply text, p_close boolean) returns void language plpgsql security definer set search_path = public as $$
declare r text := nullif(trim(coalesce(p_reply, '')), '');
begin
  perform public.admin_guard();
  update feedback set reply = coalesce(r, reply),
    status = case when p_close then 'closed' when r is not null then 'replied' else status end,
    replied_at = case when r is not null then now() else replied_at end
  where id = p_id;
end $$;
revoke all on function public.submit_feedback(text, text), public.my_feedback(), public.admin_feedback(), public.admin_reply_feedback(bigint, text, boolean) from public, anon;
grant execute on function public.submit_feedback(text, text), public.my_feedback(), public.admin_feedback(), public.admin_reply_feedback(bigint, text, boolean) to authenticated;

create table if not exists public.announcements (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  title text not null,
  body text not null default '',
  level text not null default 'info' check (level in ('info', 'important')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  active boolean not null default true
);
alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated;
grant all on public.announcements to service_role;
grant usage, select on sequence public.announcements_id_seq to service_role;

create or replace function public.current_announcements() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body, 'level', level, 'starts_at', starts_at) order by starts_at desc), '[]'::jsonb)
  from announcements where active and starts_at <= now() and (ends_at is null or ends_at > now());
$$;
create or replace function public.admin_announcements() returns jsonb language plpgsql security definer set search_path = public as $$
begin perform public.admin_guard(); return coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from announcements a), '[]'::jsonb); end $$;
create or replace function public.admin_save_announcement(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare aid bigint;
begin
  perform public.admin_guard();
  if (p->>'id') is null then
    insert into announcements (title, body, level, starts_at, ends_at, active)
    values (p->>'title', coalesce(p->>'body', ''), coalesce(p->>'level', 'info'), coalesce((p->>'starts_at')::timestamptz, now()), (p->>'ends_at')::timestamptz, coalesce((p->>'active')::boolean, true))
    returning id into aid;
  else
    update announcements set title = p->>'title', body = coalesce(p->>'body', ''), level = coalesce(p->>'level', 'info'),
      starts_at = coalesce((p->>'starts_at')::timestamptz, starts_at), ends_at = (p->>'ends_at')::timestamptz, active = coalesce((p->>'active')::boolean, true)
    where id = (p->>'id')::bigint returning id into aid;
  end if;
  return aid;
end $$;
create or replace function public.admin_delete_announcement(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin perform public.admin_guard(); delete from announcements where id = p_id; end $$;
revoke all on function public.current_announcements(), public.admin_announcements(), public.admin_save_announcement(jsonb), public.admin_delete_announcement(bigint) from public, anon;
grant execute on function public.current_announcements(), public.admin_announcements(), public.admin_save_announcement(jsonb), public.admin_delete_announcement(bigint) to authenticated;
