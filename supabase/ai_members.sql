-- Who used how many AI points this period, for classes with two or more teachers (shared point pool).
create or replace function public.ai_member_usage(p_ws uuid, p_st text, p_sid uuid, p_since timestamptz) returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select user_id from workspace_members where workspace_id = p_ws and status = 'active'),
  u as (select user_id, sum(points)::int pts from ai_ledger where subject_type = p_st and subject_id = p_sid and at >= p_since and kind not in ('topup', 'admin') group by user_id)
  select case when (select count(*) from m) < 2 then null else
    (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(pr.display_name, ''), '老師'), 'points', greatest(0, coalesce(u.pts, 0)), 'me', m.user_id = auth.uid()) order by coalesce(u.pts, 0) desc, pr.display_name), '[]'::jsonb)
     from m left join u on u.user_id = m.user_id left join profiles pr on pr.id = m.user_id) end;
$$;
revoke all on function public.ai_member_usage(uuid, text, uuid, timestamptz) from public, anon, authenticated;

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
    'ai_by_member', case when p_ws is not null and public.is_member(p_ws) and members >= 2 then public.ai_member_usage(p_ws, st, sid, s.period_start) end,
    'delete_after', s.ends_at + make_interval(days => ro),
    'is_owner', (p_ws is null or exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid() and role = 'owner'))
  );
end $$;

-- admin: the same breakdown for every class with two or more teachers
create or replace function public.admin_ai_members() returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; st text; sid uuid; since timestamptz; out jsonb := '{}'::jsonb; v jsonb;
begin
  perform public.admin_guard();
  for r in select workspace_id from workspace_members where status = 'active' group by workspace_id having count(*) >= 2 loop
    if exists (select 1 from subscriptions where subject_type = 'workspace' and subject_id = r.workspace_id) then st := 'workspace'; sid := r.workspace_id;
    else st := 'user'; select user_id into sid from workspace_members where workspace_id = r.workspace_id and role = 'owner' limit 1; end if;
    select period_start into since from subscriptions where subject_type = st and subject_id = sid;
    if since is null then continue; end if;
    v := public.ai_member_usage(r.workspace_id, st, sid, since);
    if v is not null then out := out || jsonb_build_object(r.workspace_id::text, jsonb_build_object('since', since, 'members', v)); end if;
  end loop;
  return out;
end $$;
revoke all on function public.admin_ai_members() from public, anon;
grant execute on function public.admin_ai_members() to authenticated;
