-- 小熊工作室 database schema
-- Teachers sign in with LINE. Each class is a "workspace"; teachers join with an invite code.
-- Shared class data is visible only to members of that class; personal data only to its owner.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  line_user_id text unique,
  display_name text,
  picture_url text,
  real_name text not null default '',
  nicknames text[] not null default '{}',
  class_name text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- One row per data set (students, forms, roster ...) per class. "version" lets two
-- teachers edit at the same time without silently overwriting each other.
create table if not exists public.shared_data (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  value jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, key)
);

create table if not exists public.personal_data (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.shared_data enable row level security;
alter table public.personal_data enable row level security;

create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid());
$$;

-- profiles: see yourself and teachers who share a class with you; edit only yourself
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from workspace_members a join workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = auth.uid() and b.user_id = profiles.id));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());

-- workspaces: members can see; only the owner can rename
drop policy if exists ws_select on public.workspaces;
create policy ws_select on public.workspaces for select to authenticated using (public.is_member(id));
drop policy if exists ws_update on public.workspaces;
create policy ws_update on public.workspaces for update to authenticated using (
  exists (select 1 from workspace_members where workspace_id = id and user_id = auth.uid() and role = 'owner'));

-- members: see your classmates; leave a class yourself, or the owner removes someone
drop policy if exists wm_select on public.workspace_members;
create policy wm_select on public.workspace_members for select to authenticated using (public.is_member(workspace_id));
drop policy if exists wm_delete on public.workspace_members;
create policy wm_delete on public.workspace_members for delete to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from workspace_members o where o.workspace_id = workspace_members.workspace_id and o.user_id = auth.uid() and o.role = 'owner'));

-- shared class data: members only
drop policy if exists sd_all on public.shared_data;
create policy sd_all on public.shared_data for all to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

-- personal data: owner only
drop policy if exists pd_all on public.personal_data;
create policy pd_all on public.personal_data for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- create a class and become its owner
create or replace function public.create_workspace(p_name text)
returns public.workspaces language plpgsql security definer set search_path = public as $$
declare ws workspaces; code text; tries int := 0;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  loop
    code := upper(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when length(code) = 6 and not exists (select 1 from workspaces where invite_code = code);
    tries := tries + 1; if tries > 20 then raise exception 'could not make code'; end if;
  end loop;
  insert into workspaces (name, invite_code, created_by) values (trim(p_name), code, auth.uid()) returning * into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws.id, auth.uid(), 'owner');
  return ws;
end $$;

-- join a class with its invite code
create or replace function public.join_workspace(p_code text)
returns public.workspaces language plpgsql security definer set search_path = public as $$
declare ws workspaces;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into ws from workspaces where invite_code = upper(trim(p_code));
  if ws.id is null then raise exception 'invite code not found'; end if;
  insert into workspace_members (workspace_id, user_id) values (ws.id, auth.uid()) on conflict do nothing;
  return ws;
end $$;

-- owner can issue a new invite code (old one stops working)
create or replace function public.renew_invite_code(p_ws uuid)
returns text language plpgsql security definer set search_path = public as $$
declare code text;
begin
  if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner can do this'; end if;
  loop
    code := upper(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when length(code) = 6 and not exists (select 1 from workspaces where invite_code = code);
  end loop;
  update workspaces set invite_code = code where id = p_ws;
  return code;
end $$;

-- save shared data only if nobody else saved in between; otherwise hand back the newer copy
create or replace function public.put_shared(p_ws uuid, p_key text, p_value jsonb, p_base bigint)
returns table (ok boolean, version bigint, value jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare cur shared_data;
begin
  if not public.is_member(p_ws) then raise exception 'not a member of this class'; end if;
  select * into cur from shared_data s where s.workspace_id = p_ws and s.key = p_key for update;
  if cur.workspace_id is null then
    insert into shared_data (workspace_id, key, value, version, updated_by) values (p_ws, p_key, p_value, 1, auth.uid());
    return query select true, 1::bigint, p_value;
  elsif cur.version = coalesce(p_base, 0) then
    update shared_data s set value = p_value, version = cur.version + 1, updated_at = now(), updated_by = auth.uid()
      where s.workspace_id = p_ws and s.key = p_key;
    return query select true, cur.version + 1, p_value;
  else
    return query select false, cur.version, cur.value;
  end if;
end $$;

-- the table permissions the app needs (new tables are not exposed automatically)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.workspaces, public.workspace_members, public.shared_data, public.personal_data to authenticated;
revoke all on public.profiles, public.workspaces, public.workspace_members, public.shared_data, public.personal_data from anon;
grant execute on function public.is_member(uuid), public.create_workspace(text), public.join_workspace(text), public.renew_invite_code(uuid), public.put_shared(uuid, text, jsonb, bigint) to authenticated;
revoke execute on function public.is_member(uuid), public.create_workspace(text), public.join_workspace(text), public.renew_invite_code(uuid), public.put_shared(uuid, text, jsonb, bigint) from anon, public;

-- live updates when a classmate changes shared data
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shared_data') then
    alter publication supabase_realtime add table public.shared_data;
  end if;
end $$;

-- the server-side sign-in function works as service_role
grant usage on schema public to service_role;
grant all on public.profiles, public.workspaces, public.workspace_members, public.shared_data, public.personal_data to service_role;
