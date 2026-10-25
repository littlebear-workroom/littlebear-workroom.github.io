-- Expiry: renewal reminders, deletion warnings, and removing data after the read-only period.
create table if not exists public.purge_log (id bigserial primary key, at timestamptz not null default now(), subject_type text, subject_id uuid, what text);
alter table public.purge_log enable row level security;
revoke all on public.purge_log from anon, authenticated;
grant all on public.purge_log to service_role;
grant usage, select on sequence public.purge_log_id_seq to service_role;

-- does this teacher still have access anywhere (own plan, or a class they belong to)?
create or replace function public.user_has_access(p_user uuid) returns boolean language plpgsql stable security definer set search_path = public as $$
declare w uuid;
begin
  if exists (select 1 from subscriptions where subject_type = 'user' and subject_id = p_user and ends_at > now()) then return true; end if;
  for w in select workspace_id from workspace_members where user_id = p_user and status = 'active' loop
    if exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = w and ends_at > now()) then return true; end if;
    if not exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = w)
       and exists (select 1 from workspace_members m join subscriptions s on s.subject_type = 'user' and s.subject_id = m.user_id
                   where m.workspace_id = w and m.role = 'owner' and s.ends_at > now()) then return true; end if;
  end loop;
  return false;
end $$;

-- when a class's data would be removed (null = the class still has access)
create or replace function public.ws_expiry(p_ws uuid) returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare e timestamptz; ro int;
begin
  select coalesce(value::text::int, 90) into ro from app_settings where key = 'readonly_days';
  select ends_at into e from subscriptions where subject_type = 'workspace' and subject_id = p_ws;
  if e is null then
    select s.ends_at into e from workspace_members m join subscriptions s on s.subject_type = 'user' and s.subject_id = m.user_id
    where m.workspace_id = p_ws and m.role = 'owner' limit 1;
  end if;
  if e is null or e > now() then return null; end if;
  return e + make_interval(days => ro);
end $$;

-- reminders due today: renewal 7/3/1 days before the end, deletion warning 7 days before removal
create or replace function public.billing_reminders() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ro int; today date := (now() at time zone 'Asia/Taipei')::date;
begin
  select coalesce(value::text::int, 90) into ro from app_settings where key = 'readonly_days';
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object(
      'user_id', case when s.subject_type = 'user' then s.subject_id
                      else (select user_id from workspace_members where workspace_id = s.subject_id and role = 'owner' limit 1) end,
      'kind', case when s.ends_at > now() then 'renew' else 'purge' end,
      'days', case when s.ends_at > now() then (s.ends_at at time zone 'Asia/Taipei')::date - today
                   else ((s.ends_at + make_interval(days => ro)) at time zone 'Asia/Taipei')::date - today end,
      'plan', p.name, 'trial', s.status = 'trial', 'ends_at', s.ends_at,
      'class', (select name from workspaces where id = s.subject_id and s.subject_type = 'workspace')) r
    from subscriptions s join plans p on p.id = s.plan_id
    where (s.ends_at > now() and (s.ends_at at time zone 'Asia/Taipei')::date - today in (7, 3, 1))
       or (s.ends_at <= now() and ((s.ends_at + make_interval(days => ro)) at time zone 'Asia/Taipei')::date - today = 7)
  ) x where r->>'user_id' is not null), '[]'::jsonb);
end $$;

-- remove data whose read-only period has ended (run once a day)
create or replace function public.purge_expired() returns jsonb language plpgsql security definer set search_path = public as $$
declare w record; u record; n_ws int := 0; n_u int := 0; ro int; ex timestamptz;
begin
  select coalesce(value::text::int, 90) into ro from app_settings where key = 'readonly_days';
  for w in select id from workspaces loop
    ex := public.ws_expiry(w.id);
    if ex is not null and ex < now() and exists (select 1 from shared_data where workspace_id = w.id) then
      delete from shared_data where workspace_id = w.id;
      delete from data_history where workspace_id = w.id;
      insert into purge_log (subject_type, subject_id, what) values ('workspace', w.id, '班級資料已依到期規定刪除');
      n_ws := n_ws + 1;
    end if;
  end loop;
  for u in select s.subject_id as id from subscriptions s where s.subject_type = 'user' and s.ends_at + make_interval(days => ro) < now() loop
    if not public.user_has_access(u.id) and exists (select 1 from personal_data where user_id = u.id and key not in ('bear_notify_prefs', 'bear_profile')) then
      delete from personal_data where user_id = u.id and key not in ('bear_notify_prefs', 'bear_profile');
      insert into purge_log (subject_type, subject_id, what) values ('user', u.id, '個人資料已依到期規定刪除');
      n_u := n_u + 1;
    end if;
  end loop;
  delete from data_history where at < now() - interval '30 days';
  return jsonb_build_object('classes', n_ws, 'users', n_u);
end $$;
revoke all on function public.user_has_access(uuid), public.ws_expiry(uuid), public.billing_reminders(), public.purge_expired() from public, anon, authenticated;
grant execute on function public.user_has_access(uuid), public.ws_expiry(uuid), public.billing_reminders(), public.purge_expired() to service_role;

-- access through a class only (ignoring the teacher's own plan)
create or replace function public.user_class_access(p_user uuid) returns boolean language plpgsql stable security definer set search_path = public as $$
declare w uuid;
begin
  for w in select workspace_id from workspace_members where user_id = p_user and status = 'active' loop
    if exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = w and ends_at > now()) then return true; end if;
    if not exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = w)
       and exists (select 1 from workspace_members m join subscriptions s on s.subject_type = 'user' and s.subject_id = m.user_id
                   where m.workspace_id = w and m.role = 'owner' and m.user_id <> p_user and s.ends_at > now()) then return true; end if;
  end loop;
  return false;
end $$;
revoke all on function public.user_class_access(uuid) from public, anon, authenticated;
grant execute on function public.user_class_access(uuid) to service_role;
create or replace function public.billing_reminders() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ro int; today date := (now() at time zone 'Asia/Taipei')::date;
begin
  select coalesce(value::text::int, 90) into ro from app_settings where key = 'readonly_days';
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object(
      'user_id', case when s.subject_type = 'user' then s.subject_id
                      else (select user_id from workspace_members where workspace_id = s.subject_id and role = 'owner' limit 1) end,
      'kind', case when s.ends_at > now() then 'renew' else 'purge' end,
      'days', case when s.ends_at > now() then (s.ends_at at time zone 'Asia/Taipei')::date - today
                   else ((s.ends_at + make_interval(days => ro)) at time zone 'Asia/Taipei')::date - today end,
      'plan', p.name, 'trial', s.status = 'trial', 'ends_at', s.ends_at,
      'class', (select name from workspaces where id = s.subject_id and s.subject_type = 'workspace')) r
    from subscriptions s join plans p on p.id = s.plan_id
    where ((s.ends_at > now() and (s.ends_at at time zone 'Asia/Taipei')::date - today in (7, 3, 1))
        or (s.ends_at <= now() and ((s.ends_at + make_interval(days => ro)) at time zone 'Asia/Taipei')::date - today = 7))
      and not (s.subject_type = 'user' and public.user_class_access(s.subject_id))
  ) x where r->>'user_id' is not null), '[]'::jsonb);
end $$;
