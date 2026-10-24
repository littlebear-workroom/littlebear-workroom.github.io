-- LINE notification support: a log so each reminder goes out once per day,
-- and a job that runs the line-notify function every 5 minutes.
create table if not exists public.notify_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, day)
);
alter table public.notify_log enable row level security;
grant all on public.notify_log to service_role;
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- (the schedule itself is created separately because it contains the private cron secret)
