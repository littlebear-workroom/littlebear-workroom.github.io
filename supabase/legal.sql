-- Teachers' agreement to the privacy policy and terms (one row per version agreed).
create table if not exists public.legal_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  version text not null,
  agreed_at timestamptz not null default now(),
  primary key (user_id, version)
);
alter table public.legal_consents enable row level security;
revoke all on public.legal_consents from anon, authenticated;
grant all on public.legal_consents to service_role;
create or replace function public.agree_terms(p_version text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into legal_consents (user_id, version) values (auth.uid(), left(p_version, 40)) on conflict do nothing;
end $$;
create or replace function public.my_consents() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('version', version, 'agreed_at', agreed_at) order by agreed_at desc), '[]'::jsonb) from legal_consents where user_id = auth.uid();
$$;
revoke all on function public.agree_terms(text), public.my_consents() from public, anon;
grant execute on function public.agree_terms(text), public.my_consents() to authenticated;

-- 6-digit login code: count tries so it cannot be guessed
create table if not exists public.code_attempts (ip text not null, at timestamptz not null default now());
create index if not exists code_attempts_at on public.code_attempts (at);
alter table public.code_attempts enable row level security;
revoke all on public.code_attempts from anon, authenticated;
grant all on public.code_attempts to service_role;
