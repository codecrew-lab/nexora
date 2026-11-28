-- NEXORA RFID attendance v2
--
-- What this adds:
--   * attendance_records: where a record came from (manual / rfid), the real tap
--     time, which reader was used, and whether the tap was late.
--   * attendance_settings: the late cut-off time, editable by teachers.
--   * rfid_scan_events: a log of every tap, including unknown cards, so teachers
--     can register new cards from the portal instead of the SQL editor.
--   * rfid_devices: reader heartbeat / last-seen status.
--   * record_rfid_scan(): one atomic call that the edge function makes per tap.
--
-- Safety: additive and idempotent (safe to run more than once). It never deletes
-- attendance, student, or card rows. The only data change is labelling existing
-- RFID-created rows (marked_by IS NULL and status = 'Present') as source = 'rfid',
-- which is exactly the rule the portals already used to show "RFID entry".

begin;

-- ---------------------------------------------------------------------------
-- 1. Attendance provenance
-- ---------------------------------------------------------------------------
alter table public.attendance_records
  add column if not exists source text not null default 'manual',
  add column if not exists scanned_at timestamptz,
  add column if not exists device_id text,
  add column if not exists is_late boolean not null default false;

do $$
begin
  alter table public.attendance_records
    add constraint attendance_records_source_check check (source in ('manual', 'rfid'));
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Attendance settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_settings (
  id boolean primary key default true constraint attendance_settings_singleton check (id),
  -- A tap is late when its minute (IST) is after this time. 09:30 means
  -- 09:30:59 is on time and 09:31:00 is late, matching the previous behaviour.
  late_after time not null default '09:30',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.attendance_settings (id) values (true) on conflict (id) do nothing;

alter table public.attendance_settings enable row level security;
revoke all on table public.attendance_settings from anon, public;
grant select, update on table public.attendance_settings to authenticated;

drop policy if exists "Teachers read attendance settings" on public.attendance_settings;
create policy "Teachers read attendance settings"
  on public.attendance_settings for select to authenticated
  using ((select public.is_auraway_teacher()));

drop policy if exists "Teachers update attendance settings" on public.attendance_settings;
create policy "Teachers update attendance settings"
  on public.attendance_settings for update to authenticated
  using ((select public.is_auraway_teacher()))
  with check ((select public.is_auraway_teacher()));

create or replace function public.attendance_is_late(p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select date_trunc('minute', p_at at time zone 'Asia/Kolkata')::time
         > coalesce((select late_after from public.attendance_settings limit 1), time '09:30');
$$;

revoke all on function public.attendance_is_late(timestamptz) from public, anon, authenticated;
grant execute on function public.attendance_is_late(timestamptz) to service_role;

-- Label rows created by the v1 RFID endpoint (it inserted with marked_by = null).
update public.attendance_records
set source = 'rfid',
    scanned_at = created_at,
    is_late = public.attendance_is_late(created_at)
where source = 'manual'
  and scanned_at is null
  and marked_by is null
  and status = 'Present';

-- ---------------------------------------------------------------------------
-- 3. Card registry fixes
-- ---------------------------------------------------------------------------
-- v1 used ON DELETE RESTRICT, so a teacher could not delete a student who had a
-- card. A card mapping is meaningless without its student, so cascade instead.
do $$
declare
  fk record;
begin
  for fk in
    select conname
    from pg_constraint
    where conrelid = 'public.student_rfid_cards'::regclass
      and confrelid = 'public.students'::regclass
      and contype = 'f'
  loop
    execute format('alter table public.student_rfid_cards drop constraint %I', fk.conname);
  end loop;
end $$;

alter table public.student_rfid_cards
  add constraint student_rfid_cards_student_id_fkey
  foreign key (student_id) references public.students(id) on delete cascade;

-- Teachers may type UIDs with spaces, colons, or lower case. Normalise them so
-- the format check and the reader lookups always agree.
create or replace function public.student_rfid_cards_normalise_uid()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.card_uid := upper(regexp_replace(coalesce(new.card_uid, ''), '[^0-9A-Fa-f]', '', 'g'));
  return new;
end;
$$;

drop trigger if exists student_rfid_cards_normalise_uid on public.student_rfid_cards;
create trigger student_rfid_cards_normalise_uid
  before insert or update of card_uid on public.student_rfid_cards
  for each row execute function public.student_rfid_cards_normalise_uid();

-- ---------------------------------------------------------------------------
-- 4. Readers
-- ---------------------------------------------------------------------------
create table if not exists public.rfid_devices (
  device_id text primary key constraint rfid_devices_id_format check (device_id ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  firmware_version text,
  wifi_rssi integer,
  queued_scans integer not null default 0,
  last_seen_at timestamptz not null default now(),
  last_scan_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.rfid_devices enable row level security;
revoke all on table public.rfid_devices from anon, public;
grant select, delete on table public.rfid_devices to authenticated;

drop policy if exists "Teachers view RFID readers" on public.rfid_devices;
create policy "Teachers view RFID readers"
  on public.rfid_devices for select to authenticated
  using ((select public.is_auraway_teacher()));

drop policy if exists "Teachers remove RFID readers" on public.rfid_devices;
create policy "Teachers remove RFID readers"
  on public.rfid_devices for delete to authenticated
  using ((select public.is_auraway_teacher()));

create or replace function public.rfid_normalise_device_id(p_device_id text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(
      left(
        regexp_replace(
          regexp_replace(lower(btrim(coalesce(p_device_id, ''))), '[^a-z0-9_-]+', '-', 'g'),
          '^[^a-z0-9]+', ''
        ),
        48
      ),
      ''
    ),
    'default'
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Scan log
-- ---------------------------------------------------------------------------
create table if not exists public.rfid_scan_events (
  id bigint generated by default as identity primary key,
  card_uid text not null,
  device_id text not null,
  student_id bigint references public.students(id) on delete set null,
  result text not null constraint rfid_scan_events_result_check
    check (result in ('present_marked', 'already_marked', 'unregistered_card', 'student_unavailable')),
  attendance_date date not null,
  scanned_at timestamptz not null,
  received_at timestamptz not null default now(),
  is_late boolean not null default false
);

create index if not exists rfid_scan_events_received_idx
  on public.rfid_scan_events (received_at desc);
create index if not exists rfid_scan_events_date_idx
  on public.rfid_scan_events (attendance_date, scanned_at desc);
create index if not exists rfid_scan_events_student_idx
  on public.rfid_scan_events (student_id);
create index if not exists rfid_scan_events_unknown_idx
  on public.rfid_scan_events (card_uid, received_at desc)
  where result = 'unregistered_card';

alter table public.rfid_scan_events enable row level security;
revoke all on table public.rfid_scan_events from anon, public;
grant select, delete on table public.rfid_scan_events to authenticated;

drop policy if exists "Teachers view RFID scans" on public.rfid_scan_events;
create policy "Teachers view RFID scans"
  on public.rfid_scan_events for select to authenticated
  using ((select public.is_auraway_teacher()));

drop policy if exists "Teachers delete RFID scans" on public.rfid_scan_events;
create policy "Teachers delete RFID scans"
  on public.rfid_scan_events for delete to authenticated
  using ((select public.is_auraway_teacher()));

-- ---------------------------------------------------------------------------
-- 6. Reader API (called only by the pulse-rfid-attendance edge function)
-- ---------------------------------------------------------------------------
create or replace function public.record_rfid_scan(
  p_card_uid text,
  p_device_id text default null,
  p_scanned_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid text := upper(regexp_replace(coalesce(p_card_uid, ''), '[^0-9A-Fa-f]', '', 'g'));
  v_device text := public.rfid_normalise_device_id(p_device_id);
  v_now timestamptz := now();
  v_scanned timestamptz := coalesce(p_scanned_at, now());
  v_date date;
  v_late boolean;
  v_student_id bigint;
  v_code text;
  v_name text;
  v_class text;
  v_status text := 'Present';
  v_result text;
begin
  if v_uid !~ '^[0-9A-F]{8,20}$' then
    raise exception 'Invalid card UID format.' using errcode = '22023';
  end if;

  -- Offline replays carry the original tap time. Tolerate small clock drift,
  -- never accept future taps, and drop anything older than a week.
  if v_scanned > v_now then
    v_scanned := v_now;
  end if;
  if v_scanned < v_now - interval '7 days' then
    return jsonb_build_object('result', 'scan_too_old', 'scanned_at', v_scanned);
  end if;

  v_date := (v_scanned at time zone 'Asia/Kolkata')::date;
  v_late := public.attendance_is_late(v_scanned);

  insert into public.rfid_devices (device_id, last_seen_at, last_scan_at)
  values (v_device, v_now, v_now)
  on conflict (device_id) do update
    set last_seen_at = excluded.last_seen_at,
        last_scan_at = excluded.last_scan_at;

  select c.student_id into v_student_id
  from public.student_rfid_cards c
  where c.card_uid = v_uid and c.active
  limit 1;

  if v_student_id is null then
    insert into public.rfid_scan_events (card_uid, device_id, result, attendance_date, scanned_at)
    values (v_uid, v_device, 'unregistered_card', v_date, v_scanned);
    return jsonb_build_object(
      'result', 'unregistered_card',
      'card_uid', v_uid,
      'attendance_date', v_date,
      'scanned_at', v_scanned
    );
  end if;

  select s.student_code, s.student_name, s.class_name
    into v_code, v_name, v_class
  from public.students s
  where s.id = v_student_id;

  if v_code is null or btrim(v_code) = '' then
    insert into public.rfid_scan_events (card_uid, device_id, student_id, result, attendance_date, scanned_at)
    values (v_uid, v_device, v_student_id, 'student_unavailable', v_date, v_scanned);
    return jsonb_build_object('result', 'student_unavailable', 'attendance_date', v_date);
  end if;

  insert into public.attendance_records
    (student_code, attendance_date, status, marked_by, source, scanned_at, device_id, is_late)
  values
    (v_code, v_date, 'Present', null, 'rfid', v_scanned, v_device, v_late)
  on conflict (student_code, attendance_date) do nothing;

  if found then
    v_result := 'present_marked';
  else
    v_result := 'already_marked';
    select ar.status into v_status
    from public.attendance_records ar
    where ar.student_code = v_code and ar.attendance_date = v_date;
  end if;

  insert into public.rfid_scan_events
    (card_uid, device_id, student_id, result, attendance_date, scanned_at, is_late)
  values
    (v_uid, v_device, v_student_id, v_result, v_date, v_scanned, v_late);

  return jsonb_build_object(
    'result', v_result,
    'student_name', coalesce(nullif(btrim(v_name), ''), 'Student'),
    'class_name', v_class,
    'status', coalesce(v_status, 'Present'),
    'attendance_date', v_date,
    'scanned_at', v_scanned,
    'late', v_late
  );
end;
$$;

create or replace function public.rfid_device_heartbeat(
  p_device_id text default null,
  p_firmware_version text default null,
  p_wifi_rssi integer default null,
  p_queued_scans integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_device text := public.rfid_normalise_device_id(p_device_id);
begin
  insert into public.rfid_devices (device_id, firmware_version, wifi_rssi, queued_scans, last_seen_at)
  values (
    v_device,
    left(p_firmware_version, 32),
    p_wifi_rssi,
    greatest(coalesce(p_queued_scans, 0), 0),
    now()
  )
  on conflict (device_id) do update
    set firmware_version = coalesce(excluded.firmware_version, public.rfid_devices.firmware_version),
        wifi_rssi = excluded.wifi_rssi,
        queued_scans = excluded.queued_scans,
        last_seen_at = excluded.last_seen_at;
  return jsonb_build_object('result', 'ok', 'device_id', v_device, 'server_time', now());
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default. These must only be reachable with the service-role key.
revoke all on function public.record_rfid_scan(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.rfid_device_heartbeat(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.rfid_normalise_device_id(text) from public, anon, authenticated;
grant execute on function public.record_rfid_scan(text, text, timestamptz) to service_role;
grant execute on function public.rfid_device_heartbeat(text, text, integer, integer) to service_role;
grant execute on function public.rfid_normalise_device_id(text) to service_role;

commit;
