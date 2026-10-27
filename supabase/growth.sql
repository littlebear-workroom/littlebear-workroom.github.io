-- Referrals (invite a teacher, both get AI points after their first payment) and automatic error reports.
create table if not exists public.referrals (
  referee uuid primary key references auth.users(id) on delete cascade,
  referrer uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  points int
);
alter table public.referrals enable row level security;
revoke all on public.referrals from anon, authenticated;
grant all on public.referrals to service_role;
insert into public.app_settings (key, value) values ('referral_points', '50') on conflict (key) do nothing;

-- a short, stable code per teacher (first 8 chars of a hash of the user id)
create or replace function public.ref_code(p uuid) returns text language sql immutable as $$ select upper(substr(md5(p::text || 'bear-ref'), 1, 8)) $$;
revoke all on function public.ref_code(uuid) from public, anon, authenticated;

create or replace function public.my_referral() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); pts int;
begin
  if me is null then return null; end if;
  select coalesce(value::text::int, 50) into pts from app_settings where key = 'referral_points';
  return jsonb_build_object(
    'code', public.ref_code(me), 'points', coalesce(pts, 50),
    'invited', (select count(*) from referrals where referrer = me),
    'rewarded', (select count(*) from referrals where referrer = me and rewarded_at is not null),
    'earned', (select coalesce(sum(points), 0) from referrals where referrer = me and rewarded_at is not null),
    'referred_by', exists (select 1 from referrals where referee = me),
    'can_claim', not exists (select 1 from referrals where referee = me) and (select created_at from auth.users where id = me) > now() - interval '30 days'
      and not exists (select 1 from payments where paid_by = me and status = 'paid' and amount > 0));
end $$;

-- a new teacher (signed up in the last 30 days, never paid) enters someone's code
create or replace function public.claim_referral(p_code text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); who uuid;
begin
  if me is null then return jsonb_build_object('ok', false, 'error', '請先登入'); end if;
  if exists (select 1 from referrals where referee = me) then return jsonb_build_object('ok', false, 'error', '已經輸入過邀請碼了'); end if;
  if (select created_at from auth.users where id = me) <= now() - interval '30 days' or exists (select 1 from payments where paid_by = me and status = 'paid' and amount > 0) then
    return jsonb_build_object('ok', false, 'error', '邀請碼只限新加入、還沒付費的老師使用'); end if;
  select id into who from auth.users where public.ref_code(id) = upper(trim(p_code)) limit 1;
  if who is null then return jsonb_build_object('ok', false, 'error', '找不到這個邀請碼'); end if;
  if who = me then return jsonb_build_object('ok', false, 'error', '不能輸入自己的邀請碼'); end if;
  insert into referrals (referee, referrer) values (me, who);
  return jsonb_build_object('ok', true, 'name', (select display_name from profiles where id = who));
end $$;

-- when a referred teacher's first real payment is confirmed, both teachers get bonus points
create or replace function public.referral_reward() returns trigger language plpgsql security definer set search_path = public as $$
declare r referrals; pts int;
begin
  if new.status <> 'paid' or new.amount <= 0 or (tg_op = 'UPDATE' and old.status = 'paid') then return new; end if;
  select * into r from referrals where referee = new.paid_by and rewarded_at is null for update;
  if r.referee is null then return new; end if;
  select coalesce(value::text::int, 50) into pts from app_settings where key = 'referral_points';
  pts := coalesce(pts, 50);
  -- the new teacher's points go to whatever they paid for (their own plan or their class); the inviter's to their own plan
  update subscriptions set ai_bonus = ai_bonus + pts, updated_at = now() where subject_type = new.subject_type and subject_id = new.subject_id;
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points, note) values (r.referee, new.subject_type, new.subject_id, 'referral', -pts, '邀請好友獎勵');
  perform public.ensure_trial(r.referrer);
  update subscriptions set ai_bonus = ai_bonus + pts, updated_at = now() where subject_type = 'user' and subject_id = r.referrer;
  insert into ai_ledger (user_id, subject_type, subject_id, kind, points, note) values (r.referrer, 'user', r.referrer, 'referral', -pts, '邀請好友獎勵');
  update referrals set rewarded_at = now(), points = pts where referee = r.referee;
  return new;
end $$;
drop trigger if exists payments_referral on public.payments;
create trigger payments_referral after insert or update of status on public.payments for each row execute function public.referral_reward();

-- usage breakdown should not count bonus points that were given
create or replace function public.ai_member_usage(p_ws uuid, p_st text, p_sid uuid, p_since timestamptz) returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select user_id from workspace_members where workspace_id = p_ws and status = 'active'),
  u as (select user_id, sum(points)::int pts from ai_ledger where subject_type = p_st and subject_id = p_sid and at >= p_since and kind not in ('topup', 'admin', 'referral') group by user_id)
  select case when (select count(*) from m) < 2 then null else
    (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(pr.display_name, ''), '老師'), 'points', greatest(0, coalesce(u.pts, 0)), 'me', m.user_id = auth.uid()) order by coalesce(u.pts, 0) desc, pr.display_name), '[]'::jsonb)
     from m left join u on u.user_id = m.user_id left join profiles pr on pr.id = m.user_id) end;
$$;

-- errors from teachers' screens (code errors only, never data)
create table if not exists public.client_errors (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  message text not null,
  stack text not null default '',
  view text not null default '',
  version text not null default '',
  ua text not null default ''
);
create index if not exists client_errors_at on public.client_errors (at);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;
grant all on public.client_errors to service_role;
grant usage, select on sequence public.client_errors_id_seq to service_role;
create or replace function public.log_client_error(p jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from client_errors where user_id = auth.uid() and at > now() - interval '1 day') >= 30 then return; end if;
  insert into client_errors (user_id, message, stack, view, version, ua)
  values (auth.uid(), left(coalesce(p->>'message', ''), 500), left(coalesce(p->>'stack', ''), 2000), left(coalesce(p->>'view', ''), 40), left(coalesce(p->>'version', ''), 40), left(coalesce(p->>'ua', ''), 200));
  delete from client_errors where at < now() - interval '60 days';
end $$;
create or replace function public.admin_client_errors() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(x order by x->>'last' desc) from (
    select jsonb_build_object('message', message, 'count', count(*), 'users', count(distinct user_id), 'last', max(at), 'view', max(view), 'version', max(version), 'stack', max(stack), 'ua', max(ua)) x
    from client_errors where at > now() - interval '14 days' group by message) t), '[]'::jsonb);
end $$;
create or replace function public.admin_referrals() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('referrer', (select display_name from profiles where id = r.referrer), 'referee', (select display_name from profiles where id = r.referee), 'at', r.created_at, 'rewarded_at', r.rewarded_at, 'points', r.points) order by r.created_at desc) from referrals r), '[]'::jsonb);
end $$;
revoke all on function public.my_referral(), public.claim_referral(text), public.log_client_error(jsonb), public.admin_client_errors(), public.admin_referrals() from public, anon;
grant execute on function public.my_referral(), public.claim_referral(text), public.log_client_error(jsonb), public.admin_client_errors(), public.admin_referrals() to authenticated;
revoke all on function public.referral_reward() from public, anon, authenticated;
