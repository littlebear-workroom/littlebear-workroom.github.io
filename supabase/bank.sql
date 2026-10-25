-- Bank-transfer payments: the teacher picks a plan, transfers, and sends a notice (bank code + last 5 digits).
-- The admin confirms in the back office, which turns the plan on.
alter table public.payments add column if not exists from_bank text;
alter table public.payments add column if not exists from_last5 text;
alter table public.payments add column if not exists transfer_date date;
alter table public.payments add column if not exists cycle text;
alter table public.payments add column if not exists reviewed_at timestamptz;
insert into public.app_settings (key, value) values ('bank', '{"bank_name": "", "bank_code": "", "account": "", "holder": ""}') on conflict (key) do nothing;

-- price of an order, worked out on the server
create or replace function public.order_price(p_plan text, p_cycle text, p_extra int, p_topup int) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare pl plans; months int := 0; amt int := 0; tops jsonb; t jsonb; pts int := 0;
begin
  if coalesce(p_plan, '') <> '' then
    select * into pl from plans where id = p_plan and public;
    if pl.id is null then raise exception 'unknown_plan'; end if;
    months := case when p_cycle = 'year' then 12 else 1 end;
    amt := case when p_cycle = 'year' and pl.price_year > 0 then pl.price_year else pl.price_month * months end;
    if coalesce(p_extra, 0) > 0 then amt := amt + p_extra * pl.extra_seat_price * months; end if;
  end if;
  if p_topup is not null and p_topup >= 0 then
    select value into tops from app_settings where key = 'topups';
    t := tops -> p_topup;
    if t is null then raise exception 'unknown_topup'; end if;
    amt := amt + coalesce((t->>'price')::int, 0); pts := coalesce((t->>'points')::int, 0);
  end if;
  return jsonb_build_object('months', months, 'amount', amt, 'points', pts);
end $$;

create or replace function public.submit_payment_notice(p_plan text, p_cycle text, p_extra int, p_topup int, p_ws uuid, p_bank text, p_last5 text, p_date date, p_note text) returns jsonb language plpgsql security definer set search_path = public as $$
declare o jsonb; st text := 'user'; sid uuid := auth.uid(); pl plans; pid bigint; pend int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(p_bank, '') !~ '^[0-9]{3}$' then raise exception 'bad_bank'; end if;
  if coalesce(p_last5, '') !~ '^[0-9]{5}$' then raise exception 'bad_last5'; end if;
  if coalesce(p_plan, '') = '' and coalesce(p_extra, 0) <= 0 and p_topup is null then raise exception 'empty_order'; end if;
  select count(*) into pend from payments where paid_by = auth.uid() and status = 'pending';
  if pend >= 3 then raise exception 'too_many_pending'; end if;
  o := public.order_price(p_plan, p_cycle, p_extra, p_topup);
  -- a class plan bought inside a class belongs to that class; everything else to the teacher
  if coalesce(p_plan, '') <> '' then select * into pl from plans where id = p_plan; end if;
  if p_ws is not null and public.is_member(p_ws) and (pl.id is null or coalesce((pl.features->>'team')::boolean, false)) then st := 'workspace'; sid := p_ws; end if;
  insert into payments (subject_type, subject_id, plan_id, months, extra_seats, topup_points, amount, method, status, note, paid_by, from_bank, from_last5, transfer_date, cycle)
  values (st, sid, nullif(p_plan, ''), (o->>'months')::int, coalesce(p_extra, 0), (o->>'points')::int, (o->>'amount')::int, 'bank', 'pending', left(coalesce(p_note, ''), 200), auth.uid(), p_bank, p_last5, coalesce(p_date, current_date), p_cycle)
  returning id into pid;
  return jsonb_build_object('id', pid, 'amount', (o->>'amount')::int);
end $$;

create or replace function public.my_payments() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'created_at', p.created_at, 'plan', pl.name, 'cycle', p.cycle, 'months', p.months, 'extra_seats', p.extra_seats, 'topup_points', p.topup_points,
    'amount', p.amount, 'status', p.status, 'note', p.note, 'from_bank', p.from_bank, 'from_last5', p.from_last5, 'transfer_date', p.transfer_date, 'for_class', p.subject_type = 'workspace') order by p.created_at desc), '[]'::jsonb)
  from (select * from payments where paid_by = auth.uid() order by created_at desc limit 20) p left join plans pl on pl.id = p.plan_id;
$$;

create or replace function public.admin_review_payment(p_id bigint, p_ok boolean, p_note text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_guard();
  if p_ok then
    update payments set status = 'paid', reviewed_at = now(), note = case when coalesce(p_note, '') = '' then note else note || case when note = '' then '' else '；' end || p_note end where id = p_id and status = 'pending';
    if found then perform public.apply_payment(p_id); end if;
  else
    update payments set status = 'failed', reviewed_at = now(), note = coalesce(nullif(p_note, ''), '款項核對不符') where id = p_id and status = 'pending';
  end if;
end $$;

-- teachers see the bank details through the plan catalog
create or replace function public.plan_catalog() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'description', description, 'price_month', price_month, 'price_year', price_year, 'seats', seats, 'extra_seat_price', extra_seat_price, 'ai_points', ai_points, 'features', features) order by sort) from plans where public), '[]'::jsonb),
    'topups', (select value from app_settings where key = 'topups'),
    'ai_costs', (select value from app_settings where key = 'ai_costs'),
    'pay_note', (select value from app_settings where key = 'pay_note'),
    'bank', (select value from app_settings where key = 'bank'),
    'trial', (select value from app_settings where key = 'trial'));
$$;

revoke all on function public.order_price(text, text, int, int), public.submit_payment_notice(text, text, int, int, uuid, text, text, date, text), public.my_payments(), public.admin_review_payment(bigint, boolean, text) from public, anon;
grant execute on function public.order_price(text, text, int, int), public.submit_payment_notice(text, text, int, int, uuid, text, text, date, text), public.my_payments(), public.admin_review_payment(bigint, boolean, text) to authenticated;
-- (the trigger that tells the admin about a new notice is created separately because it contains the private secret)
