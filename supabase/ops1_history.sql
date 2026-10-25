-- New features and change history of class data (kept 30 days).
update public.plans set features = features || '{"attendance": true, "logs": true}'::jsonb where not (features ? 'attendance');
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
    when k = 'bear_attendance' then 'attendance'
    when k = 'bear_logs' then 'logs'
    when k = 'bear_tasks' then 'tasks'
    when k in ('bear_trainings', 'bear_training_cycle') then 'training'
    when k = 'bear_schedules' then 'schedule'
    when k = 'bear_chores' then 'chores'
    when k in ('bear_cal_events', 'bear_cal_plans') then 'calendar'
    else null end
$$;

create table if not exists public.data_history (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  version bigint not null,
  value jsonb,
  changed_by uuid,
  replaced_by uuid,
  at timestamptz not null default now()
);
create index if not exists data_history_ws on public.data_history (workspace_id, at desc);
alter table public.data_history enable row level security;
revoke all on public.data_history from anon, authenticated;
grant all on public.data_history to service_role;
grant usage, select on sequence public.data_history_id_seq to service_role;

create or replace function public.keep_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.value is distinct from new.value then
    insert into data_history (workspace_id, key, version, value, changed_by, replaced_by)
    values (old.workspace_id, old.key, old.version, old.value, old.updated_by, new.updated_by);
  end if;
  return new;
end $$;
drop trigger if exists shared_history on public.shared_data;
create trigger shared_history before update on public.shared_data for each row execute function public.keep_history();

create or replace function public.class_history(p_ws uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_ws) then raise exception 'not a member'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'key', h.key, 'version', h.version, 'at', h.at, 'by', coalesce(p.display_name, ''),
      'size', case when jsonb_typeof(h.value) = 'array' then jsonb_array_length(h.value) else null end) order by h.at desc)
    from (select * from data_history where workspace_id = p_ws order by at desc limit 150) h left join profiles p on p.id = h.replaced_by), '[]'::jsonb);
end $$;

create or replace function public.restore_history(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
declare h data_history; cur shared_data;
begin
  select * into h from data_history where id = p_id;
  if h.id is null or not public.is_member(h.workspace_id) then raise exception 'not found'; end if;
  if not public.can_write(h.workspace_id, h.key) then raise exception 'plan_readonly'; end if;
  select * into cur from shared_data where workspace_id = h.workspace_id and key = h.key for update;
  update shared_data set value = h.value, version = cur.version + 1, updated_at = now(), updated_by = auth.uid()
  where workspace_id = h.workspace_id and key = h.key;
end $$;
revoke all on function public.class_history(uuid), public.restore_history(bigint) from public, anon;
grant execute on function public.class_history(uuid), public.restore_history(bigint) to authenticated;
