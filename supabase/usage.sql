-- Real AI cost per call, and which class it was used in (for the admin usage view).
alter table public.ai_ledger add column if not exists workspace_id uuid;
alter table public.ai_ledger add column if not exists tokens_in int;
alter table public.ai_ledger add column if not exists tokens_out int;
alter table public.ai_ledger add column if not exists cost_usd numeric(10, 5);
create index if not exists ai_ledger_ws on public.ai_ledger (workspace_id, at);
create index if not exists ai_ledger_user on public.ai_ledger (user_id, at);
insert into public.app_settings (key, value) values ('usd_twd', '32'), ('ai_price_usd', '{"in": 4, "out": 20}') on conflict (key) do nothing;

create or replace function public.ai_consume(p_user uuid, p_ws uuid, p_kind text) returns jsonb language plpgsql security definer set search_path = public as $$
declare st text; sid uuid; s subscriptions; p plans; cost int; left_month int; lid bigint;
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
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points, workspace_id) values (p_user, st, sid, p_kind, cost, case when p_ws is not null and public.is_member(p_ws) then p_ws end) returning id into lid;
  return jsonb_build_object('ok', true, 'cost', cost, 'left', left_month + s.ai_bonus - cost, 'subject_type', st, 'subject_id', sid, 'ledger_id', lid);
end $$;
create or replace function public.ai_record_cost(p_id bigint, p_in int, p_out int) returns void language plpgsql security definer set search_path = public as $$
declare pr jsonb;
begin
  select value into pr from app_settings where key = 'ai_price_usd';
  update ai_ledger set tokens_in = p_in, tokens_out = p_out,
    cost_usd = (coalesce(p_in, 0) * coalesce((pr->>'in')::numeric, 4) + coalesce(p_out, 0) * coalesce((pr->>'out')::numeric, 20)) / 1000000
  where id = p_id;
end $$;
revoke all on function public.ai_consume(uuid, uuid, text), public.ai_record_cost(bigint, int, int) from public, anon, authenticated;
grant execute on function public.ai_consume(uuid, uuid, text), public.ai_record_cost(bigint, int, int) to service_role;

-- usage summary for the admin: per teacher and per class, last 30 days and this month
create or replace function public.admin_usage() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'usd_twd', (select coalesce(value::text::numeric, 32) from app_settings where key = 'usd_twd'),
    'by_user', coalesce((select jsonb_object_agg(user_id, x) from (
      select user_id, jsonb_build_object('calls30', count(*) filter (where points > 0 and at > now() - interval '30 days'), 'points30', coalesce(sum(points) filter (where points > 0 and at > now() - interval '30 days'), 0),
        'cost30', coalesce(sum(cost_usd) filter (where at > now() - interval '30 days'), 0), 'calls_all', count(*) filter (where points > 0), 'cost_all', coalesce(sum(cost_usd), 0),
        'month_points', coalesce(sum(points) filter (where points > 0 and at >= date_trunc('month', now())), 0), 'month_cost', coalesce(sum(cost_usd) filter (where at >= date_trunc('month', now())), 0)) x
      from ai_ledger where user_id is not null and kind not in ('admin', 'topup') group by user_id) a), '{}'::jsonb),
    'by_ws', coalesce((select jsonb_object_agg(workspace_id, x) from (
      select workspace_id, jsonb_build_object('calls30', count(*) filter (where points > 0 and at > now() - interval '30 days'), 'points30', coalesce(sum(points) filter (where points > 0 and at > now() - interval '30 days'), 0),
        'cost30', coalesce(sum(cost_usd) filter (where at > now() - interval '30 days'), 0), 'calls_all', count(*) filter (where points > 0), 'cost_all', coalesce(sum(cost_usd), 0),
        'month_points', coalesce(sum(points) filter (where points > 0 and at >= date_trunc('month', now())), 0), 'month_cost', coalesce(sum(cost_usd) filter (where at >= date_trunc('month', now())), 0)) x
      from ai_ledger where workspace_id is not null and kind not in ('admin', 'topup') group by workspace_id) b), '{}'::jsonb),
    'paid_user', coalesce((select jsonb_object_agg(subject_id, t) from (select subject_id, sum(amount) t from payments where status = 'paid' and subject_type = 'user' group by subject_id) c), '{}'::jsonb),
    'paid_ws', coalesce((select jsonb_object_agg(subject_id, t) from (select subject_id, sum(amount) t from payments where status = 'paid' and subject_type = 'workspace' group by subject_id) d), '{}'::jsonb),
    'total', (select jsonb_build_object('cost30', coalesce(sum(cost_usd) filter (where at > now() - interval '30 days'), 0), 'cost_month', coalesce(sum(cost_usd) filter (where at >= date_trunc('month', now())), 0), 'calls30', count(*) filter (where points > 0 and at > now() - interval '30 days')) from ai_ledger),
    'by_kind', coalesce((select jsonb_object_agg(kind, x) from (select kind, jsonb_build_object('calls', count(*), 'points', sum(points), 'cost', coalesce(sum(cost_usd), 0), 'avg', coalesce(avg(cost_usd), 0)) x from ai_ledger where points > 0 and at > now() - interval '30 days' and kind not in ('admin', 'topup') group by kind) k), '{}'::jsonb)
  );
end $$;
-- recent calls of one teacher or class (no content, only what/when/how much)
create or replace function public.admin_usage_detail(p_type text, p_id uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'kind', l.kind, 'points', l.points, 'cost', l.cost_usd, 'note', l.note, 'who', coalesce(p.display_name, ''), 'ws', coalesce(w.name, '')) order by l.at desc)
    from (select * from ai_ledger where (p_type = 'user' and user_id = p_id) or (p_type = 'workspace' and workspace_id = p_id) order by at desc limit 100) l
    left join profiles p on p.id = l.user_id left join workspaces w on w.id = l.workspace_id), '[]'::jsonb);
end $$;
revoke all on function public.admin_usage(), public.admin_usage_detail(text, uuid) from public, anon;
grant execute on function public.admin_usage(), public.admin_usage_detail(text, uuid) to authenticated;
