-- 小熊工作室 subscriptions: plans, trials, seats, AI points, payments, admin.
-- Access is decided on the server; the page only shows it.

-- ---------- tables ----------
create table if not exists public.plans (
  id text primary key,
  name text not null,
  description text not null default '',
  price_month int not null default 0,
  price_year int not null default 0,
  seats int not null default 1,             -- teachers included
  extra_seat_price int not null default 0,  -- per extra teacher per month
  ai_points int not null default 0,         -- AI points per month
  features jsonb not null default '{}'::jsonb,
  public boolean not null default true,     -- shown on the plans page
  sort int not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.subscriptions (
  subject_type text not null check (subject_type in ('user', 'workspace')),
  subject_id uuid not null,
  plan_id text not null references public.plans(id),
  status text not null default 'active' check (status in ('trial', 'active')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  seats int,                    -- override of plan seats (null = plan default)
  ai_used int not null default 0,
  ai_bonus int not null default 0,  -- bought top-ups, never expire until used
  period_start timestamptz not null default now(),
  note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (subject_type, subject_id)
);
create table if not exists public.ai_ledger (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  subject_type text, subject_id uuid,
  kind text not null,
  points int not null,          -- positive = used, negative = added
  note text not null default ''
);
create index if not exists ai_ledger_subject on public.ai_ledger (subject_type, subject_id, at);
create table if not exists public.payments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  subject_type text not null, subject_id uuid not null,
  plan_id text, months int not null default 0, extra_seats int not null default 0, topup_points int not null default 0,
  amount int not null default 0,
  method text not null default 'manual',   -- manual / ecpay
  status text not null default 'paid' check (status in ('pending', 'paid', 'failed', 'refunded')),
  trade_no text unique,
  note text not null default '',
  raw jsonb,
  paid_by uuid
);
create table if not exists public.app_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);

alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.ai_ledger enable row level security;
alter table public.payments enable row level security;
alter table public.app_settings enable row level security;
alter table public.admins enable row level security;
revoke all on public.plans, public.subscriptions, public.ai_ledger, public.payments, public.app_settings, public.admins from anon, authenticated;
grant all on public.plans, public.subscriptions, public.ai_ledger, public.payments, public.app_settings, public.admins to service_role;
grant usage, select on all sequences in schema public to service_role;
-- signed-in teachers may read the public plan list (for the plans page)
grant select on public.plans to authenticated;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (public);

-- ---------- defaults ----------
insert into public.app_settings (key, value) values
  ('trial', '{"days": 7, "plan": "trial"}'),
  ('ai_costs', '{"routine": 1, "roster": 1, "bus": 1, "motor": 1, "calendar": 2, "lesson": 1, "lessonChat": 2}'),
  ('readonly_days', '90'),
  ('topups', '[{"points": 20, "price": 29, "name": "小額補充包"}, {"points": 50, "price": 59, "name": "標準補充包"}, {"points": 100, "price": 99, "name": "大容量補充包"}]'),
  ('pay_note', '"請聯絡管理者付款，付款後會幫你開通。"')
on conflict (key) do nothing;
insert into public.plans (id, name, description, price_month, price_year, seats, extra_seat_price, ai_points, features, public, sort) values
  ('trial', '免費體驗', '新用戶免費體驗全部功能', 0, 0, 3, 0, 30,
   '{"tasks":true,"schedule":true,"lessons":true,"training":true,"calendar":true,"chores":true,"funds":true,"supplies":true,"forms":true,"students":true,"roster":true,"routine":true,"motor":true,"afterschool":true,"bus":true,"indicators":true,"team":true,"ai":true}', false, 0),
  ('personal', '小熊個人版', '適合希望整理個人教學、工作及研習紀錄的老師', 99, 990, 1, 0, 40,
   '{"tasks":true,"schedule":true,"lessons":true,"training":true,"calendar":true,"chores":true,"funds":true,"supplies":true,"forms":true,"students":true,"roster":true,"routine":true,"motor":true,"afterschool":true,"bus":true,"indicators":true,"team":false,"ai":true}', true, 1),
  ('class', '小熊班級協作版', '適合主教老師、協同教師與助理共同使用', 299, 2990, 3, 49, 40,
   '{"tasks":true,"schedule":true,"lessons":true,"training":true,"calendar":true,"chores":true,"funds":true,"supplies":true,"forms":true,"students":true,"roster":true,"routine":true,"motor":true,"afterschool":true,"bus":true,"indicators":true,"team":true,"ai":true}', true, 2),
  ('ai', '小熊 AI 進階協作版', '適合需要大量 AI 文字生成、教案規劃及資料整理的班級', 499, 4990, 3, 49, 200,
   '{"tasks":true,"schedule":true,"lessons":true,"training":true,"calendar":true,"chores":true,"funds":true,"supplies":true,"forms":true,"students":true,"roster":true,"routine":true,"motor":true,"afterschool":true,"bus":true,"indicators":true,"team":true,"ai":true}', true, 3)
on conflict (id) do nothing;

-- ---------- which subscription applies ----------
-- In a class: the class's own subscription, otherwise its owner's personal one.
-- Not in a class: the teacher's personal subscription (a trial is created on first use).
create or replace function public.sub_subject(p_ws uuid) returns table (stype text, sid uuid) language plpgsql stable security definer set search_path = public as $$
declare owner uuid;
begin
  if p_ws is not null and public.is_member(p_ws) then
    if exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = p_ws) then return query select 'workspace'::text, p_ws; return; end if;
    select user_id into owner from workspace_members where workspace_id = p_ws and role = 'owner' limit 1;
    if owner is not null then return query select 'user'::text, owner; return; end if;
  end if;
  return query select 'user'::text, auth.uid();
end $$;

create or replace function public.ensure_trial(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare t jsonb; days int; pid text;
begin
  if p_user is null or exists (select 1 from subscriptions where subject_type = 'user' and subject_id = p_user) then return; end if;
  select value into t from app_settings where key = 'trial';
  days := coalesce((t->>'days')::int, 7); pid := coalesce(t->>'plan', 'trial');
  insert into subscriptions (subject_type, subject_id, plan_id, status, ends_at, note)
  values ('user', p_user, pid, 'trial', now() + make_interval(days => days), '首次登入免費體驗') on conflict do nothing;
end $$;

-- monthly AI points reset (lazy)
create or replace function public.sub_roll(st text, sid uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update subscriptions set ai_used = 0, period_start = period_start + make_interval(months => greatest(1, (extract(year from age(now(), period_start)) * 12 + extract(month from age(now(), period_start)))::int))
  where subject_type = st and subject_id = sid and period_start + interval '1 month' <= now();
end $$;

create or replace function public.my_access(p_ws uuid default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare st text; sid uuid; s subscriptions; p plans; ro int; seats int; members int; state text;
begin
  if auth.uid() is null then return jsonb_build_object('state', 'guest'); end if;
  perform public.ensure_trial(auth.uid());
  select * into st, sid from public.sub_subject(p_ws);
  perform public.sub_roll(st, sid);
  select * into s from subscriptions where subject_type = st and subject_id = sid;
  if s.plan_id is null then return jsonb_build_object('state', 'none', 'subject', st); end if;
  select * into p from plans where id = s.plan_id;
  select coalesce(value::text::int, 90) into ro from app_settings where key = 'readonly_days';
  state := case when s.ends_at > now() then s.status else 'readonly' end;
  seats := coalesce(s.seats, p.seats);
  if p_ws is not null then select count(*) into members from workspace_members where workspace_id = p_ws and status = 'active'; end if;
  return jsonb_build_object(
    'state', state, 'subject', st, 'plan_id', p.id, 'plan', p.name, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'features', p.features, 'seats', seats, 'members', members,
    'ai_total', p.ai_points, 'ai_used', s.ai_used, 'ai_bonus', s.ai_bonus,
    'ai_left', greatest(0, p.ai_points - s.ai_used) + s.ai_bonus, 'period_start', s.period_start,
    'delete_after', s.ends_at + make_interval(days => ro),
    'is_owner', (p_ws is null or exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid() and role = 'owner'))
  );
end $$;

-- Feature that a data key belongs to (used to check writes on the server).
create or replace function public.key_feature(k text) returns text language sql immutable as $$
  select case
    when k = 'bear_student_records' then 'students'
    when k = 'bear_forms' then 'forms'
    when k in ('bear_fund_records', 'bear_fund_types') then 'funds'
    when k = 'bear_afterschool' then 'afterschool'
    when k in ('bear_bus_routes', 'bear_bus_riders') then 'bus'
    when k in ('bear_teacher_map', 'bear_roster_rows', 'bear_sub_records') then 'roster'
    when k = 'bear_routine' then 'routine'
    when k in ('bear_motor_days', 'bear_motor_plans') then 'motor'
    when k in ('bear_lessons', 'bear_lesson_themes') then 'lessons'
    when k = 'bear_tasks' then 'tasks'
    when k in ('bear_trainings', 'bear_training_cycle') then 'training'
    when k = 'bear_schedules' then 'schedule'
    when k = 'bear_chores' then 'chores'
    when k in ('bear_cal_events', 'bear_cal_plans') then 'calendar'
    else null end
$$;
create or replace function public.can_write(p_ws uuid, k text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare st text; sid uuid; s subscriptions; f jsonb; feat text;
begin
  if auth.uid() is null then return false; end if;
  select * into st, sid from public.sub_subject(p_ws);
  select * into s from subscriptions where subject_type = st and subject_id = sid;
  if s.plan_id is null or s.ends_at <= now() then return false; end if;
  feat := public.key_feature(k);
  if feat is null then return true; end if;
  select features into f from plans where id = s.plan_id;
  return coalesce((f->>feat)::boolean, false) or (feat = 'students' and coalesce((f->>'supplies')::boolean, false));
end $$;
-- Personal space: the teacher's current class plan counts too.
create or replace function public.can_write_personal(k text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare w uuid;
begin
  if public.can_write(null, k) then return true; end if;
  for w in select workspace_id from workspace_members where user_id = auth.uid() and status = 'active' loop
    if public.can_write(w, k) then return true; end if;
  end loop;
  return false;
end $$;

-- writes are checked on the server
drop policy if exists pd_all on public.personal_data;
drop policy if exists pd_select on public.personal_data;
drop policy if exists pd_insert on public.personal_data;
drop policy if exists pd_update on public.personal_data;
drop policy if exists pd_delete on public.personal_data;
create policy pd_select on public.personal_data for select to authenticated using (user_id = auth.uid());
create policy pd_insert on public.personal_data for insert to authenticated with check (user_id = auth.uid() and public.can_write_personal(key));
create policy pd_update on public.personal_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_write_personal(key));
create policy pd_delete on public.personal_data for delete to authenticated using (user_id = auth.uid());
drop policy if exists sd_all on public.shared_data;
drop policy if exists sd_select on public.shared_data;
create policy sd_select on public.shared_data for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.shared_data from authenticated;  -- only through put_shared

create or replace function public.put_shared(p_ws uuid, p_key text, p_value jsonb, p_base bigint)
returns table (ok boolean, version bigint, value jsonb) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare cur shared_data;
begin
  if not public.is_member(p_ws) then raise exception 'not a member of this class'; end if;
  if not public.can_write(p_ws, p_key) then raise exception 'plan_readonly'; end if;
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

-- creating a class needs the "team" feature; approving needs a free seat
create or replace function public.create_workspace(p_name text) returns workspaces language plpgsql security definer set search_path = public as $$
declare w workspaces; code text; tries int := 0; f jsonb; s subscriptions;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  perform public.ensure_trial(auth.uid());
  select * into s from subscriptions where subject_type = 'user' and subject_id = auth.uid();
  select features into f from plans where id = s.plan_id;
  if s.ends_at <= now() then raise exception 'plan_readonly'; end if;
  if not coalesce((f->>'team')::boolean, false) then raise exception 'plan_no_team'; end if;
  loop
    code := upper(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=0O1IL', ''), 1, 6));
    exit when length(code) = 6 and not exists (select 1 from workspaces where invite_code = code);
    tries := tries + 1; if tries > 20 then raise exception 'could not make code'; end if;
  end loop;
  insert into workspaces (name, invite_code, created_by) values (trim(p_name), code, auth.uid()) returning * into w;
  insert into workspace_members (workspace_id, user_id, role, status) values (w.id, auth.uid(), 'owner', 'active');
  return w;
end $$;
create or replace function public.approve_member(p_ws uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare a jsonb;
begin
  if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid() and role = 'owner' and status = 'active') then
    raise exception 'only the owner can do this'; end if;
  a := public.my_access(p_ws);
  if a->>'state' = 'readonly' then raise exception 'plan_readonly'; end if;
  if not coalesce((a->'features'->>'team')::boolean, false) then raise exception 'plan_no_team'; end if;
  if (a->>'members')::int >= (a->>'seats')::int then raise exception 'seats_full'; end if;
  update workspace_members set status = 'active' where workspace_id = p_ws and user_id = p_user;
end $$;

-- AI points: called by the ai-read function (service role) with the teacher's id
create or replace function public.ai_consume(p_user uuid, p_ws uuid, p_kind text) returns jsonb language plpgsql security definer set search_path = public as $$
declare st text; sid uuid; s subscriptions; p plans; cost int; left_month int;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform public.ensure_trial(p_user);
  select * into st, sid from public.sub_subject(p_ws);
  perform public.sub_roll(st, sid);
  select * into s from subscriptions where subject_type = st and subject_id = sid for update;
  if s.plan_id is null then return jsonb_build_object('ok', false, 'error', 'no_plan'); end if;
  if s.ends_at <= now() then return jsonb_build_object('ok', false, 'error', 'readonly'); end if;
  select * into p from plans where id = s.plan_id;
  if not coalesce((p.features->>'ai')::boolean, false) then return jsonb_build_object('ok', false, 'error', 'no_ai'); end if;
  select coalesce((value->>p_kind)::int, 1) into cost from app_settings where key = 'ai_costs';
  cost := coalesce(cost, 1);
  left_month := greatest(0, p.ai_points - s.ai_used);
  if left_month + s.ai_bonus < cost then return jsonb_build_object('ok', false, 'error', 'no_points', 'left', left_month + s.ai_bonus, 'cost', cost); end if;
  if left_month >= cost then update subscriptions set ai_used = ai_used + cost, updated_at = now() where subject_type = st and subject_id = sid;
  else update subscriptions set ai_used = p.ai_points, ai_bonus = ai_bonus - (cost - left_month), updated_at = now() where subject_type = st and subject_id = sid; end if;
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points) values (p_user, st, sid, p_kind, cost);
  return jsonb_build_object('ok', true, 'cost', cost, 'left', left_month + s.ai_bonus - cost, 'subject_type', st, 'subject_id', sid);
end $$;
create or replace function public.ai_refund(p_subject_type text, p_subject_id uuid, p_points int, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update subscriptions set ai_used = greatest(0, ai_used - p_points) where subject_type = p_subject_type and subject_id = p_subject_id;
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points, note) values (p_user, p_subject_type, p_subject_id, 'refund', -p_points, 'AI 沒有完成，退回點數');
end $$;

-- ---------- grants ----------
revoke all on function public.sub_subject(uuid), public.ensure_trial(uuid), public.sub_roll(text, uuid), public.can_write(uuid, text), public.can_write_personal(text), public.ai_consume(uuid, uuid, text), public.ai_refund(text, uuid, int, uuid) from public, anon, authenticated;
grant execute on function public.can_write(uuid, text), public.can_write_personal(text) to authenticated;
grant execute on function public.ai_consume(uuid, uuid, text), public.ai_refund(text, uuid, int, uuid), public.ensure_trial(uuid) to service_role;
revoke all on function public.my_access(uuid) from public, anon;
grant execute on function public.my_access(uuid) to authenticated;
revoke all on function public.create_workspace(text), public.approve_member(uuid, uuid), public.put_shared(uuid, text, jsonb, bigint) from public, anon;
grant execute on function public.create_workspace(text), public.approve_member(uuid, uuid), public.put_shared(uuid, text, jsonb, bigint) to authenticated;
