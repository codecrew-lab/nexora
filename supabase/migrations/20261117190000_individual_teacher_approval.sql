-- Individual teacher identities and school-admin approval.
-- This migration does not modify student, attendance, marks, or RFID records.

create table if not exists public.teacher_access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) between 2 and 100),
  email text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);

create index if not exists teacher_access_requests_status_created_idx
  on public.teacher_access_requests(status, created_at desc);

alter table public.teacher_access_requests enable row level security;

-- Requests are only read or changed by the trusted Edge Function using service_role.
revoke all on table public.teacher_access_requests from public, anon, authenticated;
grant all on table public.teacher_access_requests to service_role;

-- Remove the legacy shared-email shortcut. Only server-controlled app_metadata roles
-- may pass existing teacher RLS policies.
create or replace function public.is_auraway_teacher()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') in ('teacher', 'school_admin'),
    false
  );
$$;

revoke all on function public.is_auraway_teacher() from public, anon;
grant execute on function public.is_auraway_teacher() to authenticated;
