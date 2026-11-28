-- NEXORA database platform layer.
--
-- Run this on a new PostgreSQL database before the migrations
-- (cd server && npm run db:setup does both).
--
-- The row-level-security policies and functions in db/migrations refer to the
-- roles `anon` / `authenticated` / `service_role` and to auth.uid(), auth.jwt()
-- and auth.users. This file provides them. The NEXORA server (server/) signs
-- users in against auth.users and runs each browser request as `anon` or
-- `authenticated` with the caller's token claims set, so Postgres itself
-- enforces who may read and write what.
--
-- Idempotent: safe to run again.

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
    -- The server's database user must be able to switch to the request roles.
    -- From PostgreSQL 16 that needs the SET option, which a non-superuser does
    -- not get automatically on roles it creates.
    if current_setting('server_version_num')::integer >= 160000 then
      if not pg_has_role(current_user, r, 'SET') then
        execute format('grant %I to %I with set true', r, current_user);
      end if;
    elsif not pg_has_role(current_user, r, 'MEMBER') then
      execute format('grant %I to %I', r, current_user);
    end if;
  end loop;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Accounts
-- ---------------------------------------------------------------------------
create schema if not exists auth;

-- Passwords are stored only as bcrypt hashes. raw_app_meta_data holds the role
-- ('student', 'teacher', 'school_admin') that ends up in the session token.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_email_lower_key
  on auth.users (lower(email)) where deleted_at is null;

-- One row per signed-in browser. A session lasts seven days from sign-in and is
-- never extended; the refresh token is stored only as a SHA-256 hash.
create table if not exists auth.nexora_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  refresh_token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists nexora_sessions_user_id_idx on auth.nexora_sessions (user_id);
create index if not exists nexora_sessions_expires_at_idx on auth.nexora_sessions (expires_at);

-- Only the server (the owner) may touch accounts and sessions.
revoke all on table auth.users from public, anon, authenticated;
revoke all on table auth.nexora_sessions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Request context used by RLS policies
-- ---------------------------------------------------------------------------
-- The server sets request.jwt.claims for the duration of each transaction.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt() ->> 'role', ''), 'anon');
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'email', '');
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
