-- Security hardening (2026-10-25)
-- 1. Defence in depth: nobody signed-out can touch any table; nobody can truncate/alter.
revoke all on all tables in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;
-- 2. Classmates see each other's name and picture, never the LINE user id.
revoke select on public.profiles from authenticated;
grant select (id, display_name, picture_url, real_name, nicknames, class_name, updated_at) on public.profiles to authenticated;
-- 3. New members wait for the class owner's approval before they can see any class data.
alter table public.workspace_members add column if not exists status text not null default 'active';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_status_check') then
    alter table public.workspace_members add constraint workspace_members_status_check check (status in ('active','pending'));
  end if;
end $$;
create or replace function public.is_member(ws uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and status = 'active');
$$;
drop policy if exists wm_select on public.workspace_members;
create policy wm_select on public.workspace_members for select to authenticated using (public.is_member(workspace_id) or user_id = auth.uid());
drop policy if exists ws_select on public.workspaces;
create policy ws_select on public.workspaces for select to authenticated using (public.is_member(id) or exists (select 1 from workspace_members m where m.workspace_id = id and m.user_id = auth.uid()));
-- 4. Limit invite-code guessing: 10 wrong codes per teacher per hour.
create table if not exists public.join_attempts (user_id uuid not null, at timestamptz not null default now());
create index if not exists join_attempts_user_at on public.join_attempts (user_id, at);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;
grant all on public.join_attempts to service_role;
drop function if exists public.join_workspace(text);
create function public.join_workspace(p_code text) returns jsonb language plpgsql security definer set search_path = public as $$
declare w workspaces; fails int; st text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select count(*) into fails from join_attempts where user_id = auth.uid() and at > now() - interval '1 hour';
  if fails >= 10 then return jsonb_build_object('error', 'too_many'); end if;
  select * into w from workspaces where invite_code = upper(trim(p_code));
  if w.id is null then
    insert into join_attempts (user_id) values (auth.uid());
    return jsonb_build_object('error', 'not_found');
  end if;
  insert into workspace_members (workspace_id, user_id, status) values (w.id, auth.uid(), 'pending') on conflict do nothing;
  select status into st from workspace_members where workspace_id = w.id and user_id = auth.uid();
  return jsonb_build_object('id', w.id, 'name', w.name, 'status', st);
end $$;
revoke all on function public.join_workspace(text) from public, anon;
grant execute on function public.join_workspace(text) to authenticated;
create or replace function public.approve_member(p_ws uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid() and role = 'owner' and status = 'active') then
    raise exception 'only the owner can do this'; end if;
  update workspace_members set status = 'active' where workspace_id = p_ws and user_id = p_user;
end $$;
revoke all on function public.approve_member(uuid, uuid) from public, anon;
grant execute on function public.approve_member(uuid, uuid) to authenticated;
revoke execute on function public.create_workspace(text), public.put_shared(uuid, text, jsonb, bigint), public.renew_invite_code(uuid), public.is_member(uuid) from public, anon;

-- Hardening after the attack test (2026-10-25): teachers write only through the app's own paths.
revoke insert, update, delete on public.profiles from authenticated;           -- set by the server at LINE sign-in only
revoke insert, update on public.workspace_members from authenticated;          -- join/approve go through functions
revoke insert, delete, update on public.workspaces from authenticated;         -- created through create_workspace
grant update (name) on public.workspaces to authenticated;                     -- owner may rename (policy ws_update)
