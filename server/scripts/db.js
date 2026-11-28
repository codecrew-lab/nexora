// Database maintenance for the NEXORA server.
//
//   npm run db:setup      everything a new database needs: db:platform, then db:migrate
//   npm run db:platform   create the roles, auth schema and helper functions (db/platform.sql)
//   npm run db:migrate    apply db/migrations/*.sql that have not been applied yet
//   npm run db:check      verify the database has everything the portals and readers use
//
// db:migrate -- --baseline records every migration as applied without running
// it, for a database that was restored from a backup taken elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const command = process.argv[2];
const baseline = process.argv.includes('--baseline');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in server/.env or the environment.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const rows = async (sql, params) => (await client.query(sql, params)).rows;

async function platform() {
  await client.query(fs.readFileSync(path.join(repo, 'db/platform.sql'), 'utf8'));
  console.log('Platform layer applied (roles, auth schema, auth.uid()/auth.jwt()).');
}

async function migrate() {
  await client.query(`
    create table if not exists public.nexora_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
    revoke all on table public.nexora_schema_migrations from public, anon, authenticated;`);
  const applied = new Set((await rows('select name from public.nexora_schema_migrations')).map(row => row.name));
  const directory = path.join(repo, 'db/migrations');
  const pending = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort().filter(name => !applied.has(name));
  if (!pending.length) return console.log('Nothing to do: every migration is already recorded.');
  for (const name of pending) {
    if (!baseline) {
      try {
        await client.query(fs.readFileSync(path.join(directory, name), 'utf8'));
      } catch (error) {
        await client.query('rollback').catch(() => {});
        console.error(`\n${name} failed: ${error.message}`);
        console.error('Nothing after it was run.');
        process.exitCode = 1;
        return;
      }
    }
    await client.query('insert into public.nexora_schema_migrations (name) values ($1)', [name]);
    console.log(`${baseline ? 'recorded' : 'applied '}  ${name}`);
  }
}

const TABLES = [
  'students', 'assignments', 'student_updates', 'attendance_records', 'attendance_settings',
  'student_marks', 'student_rfid_cards', 'rfid_devices', 'rfid_scan_events', 'pulse_timetable',
  'nexora_exams', 'nexora_exam_targets', 'academic_calendar_events', 'schools',
  'quiz_questions', 'quiz_attempts', 'student_sibling_links', 'student_sibling_link_requests',
];
const FUNCTIONS = [
  'is_auraway_teacher', 'record_rfid_scan', 'rfid_device_heartbeat',
  'pulse_get_my_siblings', 'pulse_request_sibling_link', 'pulse_approve_sibling_link_request', 'pulse_is_linked_sibling_code',
  'pulse_begin_daily_quiz', 'pulse_submit_daily_quiz',
  'pulse_teacher_list_quiz_questions', 'pulse_teacher_save_quiz_question', 'pulse_teacher_set_quiz_question_active',
  'pulse_calendar_my_context', 'pulse_calendar_list_unassigned_students', 'pulse_calendar_link_unassigned_students', 'pulse_calendar_create_school',
];

async function check() {
  let problems = 0;
  const report = (ok, text) => { if (!ok) problems += 1; console.log(`  ${ok ? 'ok     ' : 'MISSING'} ${text}`); };

  console.log('Platform');
  const roles = new Set((await rows(`select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')`)).map(row => row.rolname));
  for (const role of ['anon', 'authenticated', 'service_role']) report(roles.has(role), `role ${role}`);
  // Try it for real: this is exactly what the server does on every request.
  let canSwitch = roles.has('anon') && roles.has('authenticated');
  for (const role of canSwitch ? ['anon', 'authenticated'] : []) {
    try {
      await client.query('begin');
      await client.query(`select set_config('role', $1, true)`, [role]);
    } catch {
      canSwitch = false;
    } finally {
      await client.query('rollback');
    }
  }
  report(canSwitch, 'the server user can switch to anon / authenticated');
  const [{ users, sessions, uid }] = await rows(`select to_regclass('auth.users') is not null as users, to_regclass('auth.nexora_sessions') is not null as sessions, to_regprocedure('auth.uid()') is not null as uid`);
  report(users, 'auth.users');
  report(sessions, 'auth.nexora_sessions');
  report(uid, 'auth.uid()');

  console.log('Tables');
  const tables = await rows(
    `select c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) = current_user as owned
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1)`, [TABLES]);
  const byName = new Map(tables.map(row => [row.relname, row]));
  for (const table of TABLES) {
    const row = byName.get(table);
    report(Boolean(row), `public.${table}` + (row && !row.relrowsecurity ? '   WARNING: row-level security is OFF' : '') +
      (row && !row.owned ? '   WARNING: not owned by the server user' : ''));
  }

  console.log('Functions');
  const functions = new Set((await rows(`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [FUNCTIONS])).map(row => row.proname));
  for (const fn of FUNCTIONS) report(functions.has(fn), `public.${fn}()`);

  if (users) {
    console.log('Accounts');
    const [{ total, teacher, with_password }] = await rows(
      `select count(*)::int as total, count(*) filter (where lower(email) = 'teacher@auraway.app')::int as teacher,
              count(*) filter (where encrypted_password like '$2%')::int as with_password from auth.users where deleted_at is null`);
    console.log(`  ${total} accounts, ${with_password} with a password`);
    report(teacher === 1, 'teacher account teacher@auraway.app');
    if (byName.has('students')) {
      const [{ unlinked }] = await rows(
        `select count(*)::int as unlinked from public.students s
         where s.auth_user_id is not null and not exists (select 1 from auth.users u where u.id = s.auth_user_id)`);
      report(unlinked === 0, `every student login points at an account${unlinked ? ` (${unlinked} do not)` : ''}`);
    }
  }

  console.log(problems ? `\n${problems} problem(s). See docs/postgres.md.` : '\nDatabase is ready.');
  process.exitCode = problems ? 1 : 0;
}

try {
  if (command === 'setup') { await platform(); await migrate(); }
  else if (command === 'platform') await platform();
  else if (command === 'migrate') await migrate();
  else if (command === 'check') await check();
  else {
    console.error('Usage: node scripts/db.js setup | platform | migrate [--baseline] | check');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
