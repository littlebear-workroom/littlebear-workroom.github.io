-- Phone notifications (Web Push) for the home-screen app.
-- Each phone that turns on notifications saves one subscription row.
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sub jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "own push subs" on public.push_subs;
create policy "own push subs" on public.push_subs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_subs to authenticated;
grant all on public.push_subs to service_role;

-- So a burst of edits sends one notification, not dozens.
create table if not exists public.push_log (
  workspace_id uuid not null,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
alter table public.push_log enable row level security;
grant all on public.push_log to service_role;

-- Login hand-off: when LINE sends the teacher back to Safari instead of the home-screen app,
-- the app picks up its login here with a one-time secret code.
create table if not exists public.login_pairs (
  nonce text primary key,
  token_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.login_pairs enable row level security;
grant all on public.login_pairs to service_role;
-- (the trigger that calls the web-push function is created separately because it contains the private secret)
-- A 6-digit code shown in Safari, so the teacher can type it into the app if the automatic hand-off misses.
alter table public.login_pairs add column if not exists code text;
create index if not exists login_pairs_code on public.login_pairs(code);
