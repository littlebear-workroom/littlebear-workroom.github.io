-- Admin back office. Only people in public.admins can call these.
-- None of these functions return class data (students, rosters…): only accounts, plans, usage and payments.
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;
create or replace function public.admin_guard() returns void language plpgsql stable security definer set search_path = public as $$
begin if not public.is_admin() then raise exception 'admin only'; end if; end $$;

create or replace function public.admin_overview() returns jsonb language plpgsql security definer set search_path = public as $$
declare out jsonb;
begin
  perform public.admin_guard();
  select jsonb_build_object(
    'users', coalesce((select jsonb_agg(u order by u->>'created_at' desc) from (
      select jsonb_build_object('id', au.id, 'name', coalesce(p.display_name, ''), 'picture', coalesce(p.picture_url, ''), 'created_at', au.created_at, 'last_sign_in', au.last_sign_in_at,
        'admin', exists (select 1 from admins a where a.user_id = au.id),
        'sub', (select to_jsonb(s) from subscriptions s where s.subject_type = 'user' and s.subject_id = au.id),
        'classes', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'role', m.role, 'status', m.status)) from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = au.id), '[]'::jsonb),
        'ai_30d', coalesce((select sum(points) from ai_ledger l where l.user_id = au.id and l.points > 0 and l.at > now() - interval '30 days'), 0)
      ) u from auth.users au left join profiles p on p.id = au.id where au.email not like 'test-%') x), '[]'::jsonb),
    'workspaces', coalesce((select jsonb_agg(w order by w->>'created_at' desc) from (
      select jsonb_build_object('id', w.id, 'name', w.name, 'created_at', w.created_at,
        'owner', (select coalesce(p.display_name, '') from workspace_members m left join profiles p on p.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' limit 1),
        'owner_id', (select m.user_id from workspace_members m where m.workspace_id = w.id and m.role = 'owner' limit 1),
        'members', (select count(*) from workspace_members m where m.workspace_id = w.id and m.status = 'active'),
        'pending', (select count(*) from workspace_members m where m.workspace_id = w.id and m.status = 'pending'),
        'sub', (select to_jsonb(s) from subscriptions s where s.subject_type = 'workspace' and s.subject_id = w.id),
        'ai_30d', coalesce((select sum(points) from ai_ledger l where l.subject_type = 'workspace' and l.subject_id = w.id and l.points > 0 and l.at > now() - interval '30 days'), 0)
      ) w from workspaces w) y), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort) from plans p), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from app_settings), '{}'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x) - 'raw' order by x.created_at desc) from (select * from payments order by created_at desc limit 200) x), '[]'::jsonb),
    'ai_by_kind_30d', coalesce((select jsonb_object_agg(kind, n) from (select kind, sum(points) n from ai_ledger where points > 0 and at > now() - interval '30 days' group by kind) k), '{}'::jsonb)
  ) into out;
  return out;
end $$;

create or replace function public.admin_set_sub(p_type text, p_id uuid, p_plan text, p_status text, p_ends timestamptz, p_seats int, p_note text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  if p_plan is null then delete from subscriptions where subject_type = p_type and subject_id = p_id; return; end if;
  insert into subscriptions (subject_type, subject_id, plan_id, status, ends_at, seats, note)
  values (p_type, p_id, p_plan, coalesce(p_status, 'active'), p_ends, p_seats, coalesce(p_note, ''))
  on conflict (subject_type, subject_id) do update set plan_id = excluded.plan_id, status = excluded.status, ends_at = excluded.ends_at, seats = excluded.seats, note = excluded.note, updated_at = now();
end $$;

create or replace function public.admin_add_points(p_type text, p_id uuid, p_points int, p_note text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  update subscriptions set ai_bonus = greatest(0, ai_bonus + p_points), updated_at = now() where subject_type = p_type and subject_id = p_id;
  if not found then raise exception 'no subscription yet'; end if;
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points, note) values (auth.uid(), p_type, p_id, 'admin', -p_points, coalesce(p_note, '管理者調整'));
end $$;

-- Apply a payment: extends the plan from today or from the current end date (whichever is later), sets seats, adds top-up points.
create or replace function public.apply_payment(p_payment bigint) returns void language plpgsql security definer set search_path = public as $$
declare pay payments; s subscriptions; base timestamptz; pl plans;
begin
  select * into pay from payments where id = p_payment for update;
  if pay.id is null or pay.status <> 'paid' then return; end if;
  select * into s from subscriptions where subject_type = pay.subject_type and subject_id = pay.subject_id for update;
  if pay.plan_id is not null and pay.months > 0 then
    select * into pl from plans where id = pay.plan_id;
    base := case when s.plan_id is not null and s.status = 'active' and s.plan_id = pay.plan_id and s.ends_at > now() then s.ends_at else now() end;
    insert into subscriptions (subject_type, subject_id, plan_id, status, starts_at, ends_at, seats, period_start, ai_used, note)
    values (pay.subject_type, pay.subject_id, pay.plan_id, 'active', now(), base + make_interval(months => pay.months), case when pay.extra_seats > 0 then pl.seats + pay.extra_seats else null end, now(), 0, '付款開通 #' || pay.id)
    on conflict (subject_type, subject_id) do update set plan_id = excluded.plan_id, status = 'active',
      starts_at = case when subscriptions.plan_id = excluded.plan_id and subscriptions.status = 'active' and subscriptions.ends_at > now() then subscriptions.starts_at else now() end,
      ends_at = excluded.ends_at,
      seats = coalesce(excluded.seats, subscriptions.seats),
      period_start = case when subscriptions.plan_id = excluded.plan_id and subscriptions.status = 'active' and subscriptions.ends_at > now() then subscriptions.period_start else now() end,
      ai_used = case when subscriptions.plan_id = excluded.plan_id and subscriptions.status = 'active' and subscriptions.ends_at > now() then subscriptions.ai_used else 0 end,
      note = excluded.note, updated_at = now();
  elsif pay.extra_seats > 0 then
    update subscriptions set seats = coalesce(seats, (select seats from plans where id = subscriptions.plan_id)) + pay.extra_seats, updated_at = now() where subject_type = pay.subject_type and subject_id = pay.subject_id;
  end if;
  if pay.topup_points > 0 then
    update subscriptions set ai_bonus = ai_bonus + pay.topup_points, updated_at = now() where subject_type = pay.subject_type and subject_id = pay.subject_id;
    insert into ai_ledger (user_id, subject_type, subject_id, kind, points, note) values (pay.paid_by, pay.subject_type, pay.subject_id, 'topup', -pay.topup_points, '加購 #' || pay.id);
  end if;
end $$;

create or replace function public.admin_record_payment(p_type text, p_id uuid, p_plan text, p_months int, p_extra_seats int, p_topup int, p_amount int, p_method text, p_note text) returns bigint language plpgsql security definer set search_path = public as $$
declare pid bigint;
begin
  perform public.admin_guard();
  insert into payments (subject_type, subject_id, plan_id, months, extra_seats, topup_points, amount, method, status, note, paid_by)
  values (p_type, p_id, nullif(p_plan, ''), coalesce(p_months, 0), coalesce(p_extra_seats, 0), coalesce(p_topup, 0), coalesce(p_amount, 0), coalesce(nullif(p_method, ''), 'manual'), 'paid', coalesce(p_note, ''), auth.uid())
  returning id into pid;
  perform public.apply_payment(pid);
  return pid;
end $$;

create or replace function public.admin_save_plan(p jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  insert into plans (id, name, description, price_month, price_year, seats, extra_seat_price, ai_points, features, public, sort)
  values (p->>'id', p->>'name', coalesce(p->>'description', ''), coalesce((p->>'price_month')::int, 0), coalesce((p->>'price_year')::int, 0), coalesce((p->>'seats')::int, 1),
          coalesce((p->>'extra_seat_price')::int, 0), coalesce((p->>'ai_points')::int, 0), coalesce(p->'features', '{}'::jsonb), coalesce((p->>'public')::boolean, true), coalesce((p->>'sort')::int, 0))
  on conflict (id) do update set name = excluded.name, description = excluded.description, price_month = excluded.price_month, price_year = excluded.price_year, seats = excluded.seats,
    extra_seat_price = excluded.extra_seat_price, ai_points = excluded.ai_points, features = excluded.features, public = excluded.public, sort = excluded.sort, updated_at = now();
end $$;
create or replace function public.admin_delete_plan(p_id text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  if exists (select 1 from subscriptions where plan_id = p_id) then raise exception 'plan_in_use'; end if;
  delete from plans where id = p_id;
end $$;
create or replace function public.admin_save_setting(p_key text, p_value jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  insert into app_settings (key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
create or replace function public.admin_set_admin(p_user uuid, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  if p_on then insert into admins values (p_user) on conflict do nothing;
  elsif p_user <> auth.uid() then delete from admins where user_id = p_user; end if;
end $$;

-- teachers: what the plans page needs (public plans, top-ups, how to pay)
create or replace function public.plan_catalog() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description, 'price_month', price_month, 'price_year', price_year, 'seats', seats, 'extra_seat_price', extra_seat_price, 'ai_points', ai_points, 'features', features) order by sort) from plans where public), '[]'::jsonb),
    'topups', (select value from app_settings where key = 'topups'),
    'ai_costs', (select value from app_settings where key = 'ai_costs'),
    'pay_note', (select value from app_settings where key = 'pay_note'),
    'trial', (select value from app_settings where key = 'trial'));
$$;

revoke all on function public.is_admin(), public.admin_guard(), public.admin_overview(), public.admin_set_sub(text, uuid, text, text, timestamptz, int, text), public.admin_add_points(text, uuid, int, text),
  public.apply_payment(bigint), public.admin_record_payment(text, uuid, text, int, int, int, int, text, text), public.admin_save_plan(jsonb), public.admin_delete_plan(text),
  public.admin_save_setting(text, jsonb), public.admin_set_admin(uuid, boolean), public.plan_catalog() from public, anon;
grant execute on function public.is_admin(), public.admin_overview(), public.admin_set_sub(text, uuid, text, text, timestamptz, int, text), public.admin_add_points(text, uuid, int, text),
  public.admin_record_payment(text, uuid, text, int, int, int, int, text, text), public.admin_save_plan(jsonb), public.admin_delete_plan(text),
  public.admin_save_setting(text, jsonb), public.admin_set_admin(uuid, boolean), public.plan_catalog() to authenticated;
grant execute on function public.apply_payment(bigint) to service_role;
