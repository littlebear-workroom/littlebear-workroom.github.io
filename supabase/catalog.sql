-- Feature list sync: the admin panel sends the app's feature list (features.js); new features are
-- switched on for every plan, new AI tasks get their default points, and data keys map to features.
create or replace function public.key_feature(k text) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value->>k from app_settings where key = 'feature_keys'),
    case
      when k = 'bear_student_records' then 'students'
      when k = 'bear_forms' then 'forms'
      when k in ('bear_fund_records', 'bear_fund_types') then 'funds'
      when k = 'bear_afterschool' then 'afterschool'
      when k in ('bear_bus_routes', 'bear_bus_riders') then 'bus'
      when k in ('bear_teacher_map', 'bear_roster_rows', 'bear_sub_records') then 'roster'
      when k = 'bear_routine' then 'routine'
      when k in ('bear_motor_days', 'bear_motor_plans') then 'motor'
      when k in ('bear_lessons', 'bear_lesson_themes') then 'lessons'
      when k = 'bear_attendance' then 'attendance'
      when k = 'bear_logs' then 'logs'
      when k = 'bear_tasks' then 'tasks'
      when k in ('bear_trainings', 'bear_training_cycle') then 'training'
      when k = 'bear_schedules' then 'schedule'
      when k = 'bear_chores' then 'chores'
      when k in ('bear_cal_events', 'bear_cal_plans') then 'calendar'
      else null end)
$$;
create or replace function public.admin_sync_catalog(p_features jsonb, p_keys jsonb, p_kinds jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare f text; added_f int := 0; added_k int := 0; costs jsonb;
begin
  perform public.admin_guard();
  -- new features: on for every plan (the admin can untick them)
  for f in select jsonb_array_elements_text(p_features) loop
    update plans set features = features || jsonb_build_object(f, true), updated_at = now() where not (features ? f);
    if found then added_f := added_f + 1; end if;
  end loop;
  -- new AI tasks: default points
  select coalesce(value, '{}'::jsonb) into costs from app_settings where key = 'ai_costs';
  select count(*) into added_k from jsonb_object_keys(p_kinds) k where not (coalesce(costs, '{}'::jsonb) ? k);
  insert into app_settings (key, value) values ('ai_costs', p_kinds || coalesce(costs, '{}'::jsonb))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into app_settings (key, value) values ('feature_keys', p_keys) on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('features_added', added_f, 'ai_kinds_added', added_k);
end $$;
revoke all on function public.admin_sync_catalog(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.admin_sync_catalog(jsonb, jsonb, jsonb) to authenticated;
