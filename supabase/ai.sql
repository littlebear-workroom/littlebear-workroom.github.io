-- How many AI reads each teacher used per day (caps cost; written only by the server)
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
grant all on public.ai_usage to service_role;
