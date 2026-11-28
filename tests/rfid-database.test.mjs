// RFID attendance database tests: runs the real migrations on PGlite (Postgres
// compiled to WebAssembly) on top of the platform layer (db/platform.sql).
//   cd tests && npm install && npm run test:db
import fs from 'node:fs';
import { createDatabase, repo } from './support.mjs';

// Everything up to, but not including, the RFID v2 migration: the state a v1 school was in.
const db = await createDatabase({ until: 'rfid_attendance_v2' });
const q = async (sql, params) => (await db.query(sql, params)).rows;
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ', name);
  else { failures++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// v1 era data
await db.exec(`
  insert into public.students (student_code, student_name, class_name) values
    ('C8-001', 'Asha Rao', 'Class 8'), ('C8-002', 'Vikram Shah', 'Class 8'), ('C9-001', 'Meera Iyer', 'Class 9');
  insert into public.student_rfid_cards (student_id, card_uid) values (1, '39C38E02'), (2, 'AABBCCDD');
  insert into public.attendance_records (student_code, attendance_date, status, marked_by, created_at) values
    ('C8-001', '2026-11-20', 'Present', null, '2026-11-20 03:50:00+00'),   -- RFID 09:20 IST, on time
    ('C8-002', '2026-11-20', 'Present', null, '2026-11-20 04:10:00+00'),   -- RFID 09:40 IST, late
    ('C9-001', '2026-11-20', 'Absent', gen_random_uuid(), '2026-11-20 05:00:00+00');
`);

const migration = fs.readFileSync(`${repo}/db/migrations/20261127120000_rfid_attendance_v2.sql`, 'utf8');
await db.exec(migration);
console.log('migration applied');
await db.exec(migration);
console.log('migration re-applied (idempotent)');

console.log('backfill');
const back = await q(`select student_code, source, is_late, scanned_at is not null as has_scan from attendance_records where attendance_date = '2026-11-20' order by student_code`);
check('on-time RFID row labelled', back[0].source === 'rfid' && back[0].is_late === false && back[0].has_scan, back[0]);
check('late RFID row labelled late', back[1].source === 'rfid' && back[1].is_late === true, back[1]);
check('manual row untouched', back[2].source === 'manual' && back[2].has_scan === false, back[2]);

console.log('late cut-off');
const late = await q(`select public.attendance_is_late('2026-11-27 04:00:59+00') a, public.attendance_is_late('2026-11-27 04:01:00+00') b`);
check('09:30:59 IST on time', late[0].a === false);
check('09:31:00 IST late', late[0].b === true);

console.log('record_rfid_scan');
const scan = async (uid, device, at) => (await q(`select public.record_rfid_scan($1, $2, $3) r`, [uid, device, at ?? null]))[0].r;
let r = await scan('39:c3:8e:02', 'Main Gate #1');
check('first tap marks present', r.result === 'present_marked' && r.student_name === 'Asha Rao' && r.status === 'Present', r);
r = await scan('39C38E02', 'main-gate-1');
check('second tap already marked', r.result === 'already_marked' && r.status === 'Present', r);
r = await scan('DEADBEEF', 'main-gate-1');
check('unknown card reported with uid', r.result === 'unregistered_card' && r.card_uid === 'DEADBEEF', r);

const today = (await q(`select (now() at time zone 'Asia/Kolkata')::date::text d`))[0].d;
await q(`insert into attendance_records (student_code, attendance_date, status, marked_by) values ('C8-002', $1, 'Leave', gen_random_uuid())`, [today]);
r = await scan('AABBCCDD', null);
check('teacher Leave not overwritten', r.result === 'already_marked' && r.status === 'Leave', r);

// Offline replay from yesterday
const yesterday = new Date(Date.now() - 86400000).toISOString();
r = await scan('39C38E02', 'main-gate-1', yesterday);
const yDate = (await q(`select (($1::timestamptz) at time zone 'Asia/Kolkata')::date::text d`, [yesterday]))[0].d;
check('offline replay uses original date', r.result === 'present_marked' && r.attendance_date === yDate, r);
r = await scan('39C38E02', 'main-gate-1', new Date(Date.now() - 9 * 86400000).toISOString());
check('very old replay rejected', r.result === 'scan_too_old', r);
r = await scan('39C38E02', 'main-gate-1', new Date(Date.now() + 3600000).toISOString());
check('future tap clamped to now (already marked today)', r.result === 'already_marked' && r.attendance_date === today, r);

let threw = false;
try { await scan('XYZ', 'x'); } catch (e) { threw = e.code === '22023'; }
check('invalid uid raises 22023', threw);

const rec = (await q(`select source, device_id, marked_by, scanned_at is not null s from attendance_records where student_code = 'C8-001' and attendance_date = $1`, [today]))[0];
check('rfid row has provenance', rec.source === 'rfid' && rec.device_id === 'main-gate-1' && rec.marked_by === null && rec.s, rec);

const dev = await q(`select device_id from rfid_devices order by 1`);
check('device ids normalised', JSON.stringify(dev.map(d => d.device_id)) === '["default","main-gate-1"]', dev);

const hb = (await q(`select public.rfid_device_heartbeat('main-gate-1', '2.0.0', -61, 3) r`))[0].r;
const devRow = (await q(`select firmware_version, wifi_rssi, queued_scans from rfid_devices where device_id = 'main-gate-1'`))[0];
check('heartbeat stored', hb.result === 'ok' && devRow.firmware_version === '2.0.0' && devRow.wifi_rssi === -61 && devRow.queued_scans === 3, devRow);

const events = await q(`select result, count(*)::int n from rfid_scan_events group by 1 order by 1`);
check('scan events logged', JSON.stringify(events) === JSON.stringify([
  { result: 'already_marked', n: 3 }, { result: 'present_marked', n: 2 }, { result: 'unregistered_card', n: 1 }]), events);

console.log('cards');
await q(`insert into student_rfid_cards (student_id, card_uid) values (3, 'ab cd ef 01')`);
const card = (await q(`select card_uid from student_rfid_cards where student_id = 3`))[0];
check('uid normalised on insert', card.card_uid === 'ABCDEF01', card);
await q(`delete from students where id = 3`);
const gone = await q(`select 1 from student_rfid_cards where student_id = 3`);
check('deleting a student with a card now works (cascade)', gone.length === 0);
const fks = await q(`select confdeltype from pg_constraint where conrelid = 'public.student_rfid_cards'::regclass and confrelid = 'public.students'::regclass and contype = 'f'`);
check('exactly one FK, cascade', fks.length === 1 && fks[0].confdeltype === 'c', fks);

console.log('permissions');
const grants = await q(`
  select r.rolname, has_function_privilege(r.rolname, 'public.record_rfid_scan(text,text,timestamptz)', 'execute') scan,
         has_function_privilege(r.rolname, 'public.rfid_device_heartbeat(text,text,integer,integer)', 'execute') hb
  from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by 1`);
check('anon cannot call reader API', grants[0].scan === false && grants[0].hb === false, grants[0]);
check('authenticated cannot call reader API', grants[1].scan === false && grants[1].hb === false, grants[1]);
check('service_role can call reader API', grants[2].scan === true && grants[2].hb === true, grants[2]);

// RLS: a student session sees nothing in the reader tables; the teacher sees them.
const asRole = async (jwt, sql) => {
  await db.exec(`set request.jwt.claims = '${JSON.stringify(jwt)}'; set role authenticated;`);
  try { return await q(sql); } finally { await db.exec(`reset role; reset request.jwt.claims;`); }
};
const studentScans = await asRole({ role: 'authenticated', email: 'c8-001@students.pulse.app' }, `select count(*)::int n from rfid_scan_events`);
const teacherScans = await asRole({ role: 'authenticated', email: 'teacher@auraway.app' }, `select count(*)::int n from rfid_scan_events`);
check('student cannot read scan log', studentScans[0].n === 0, studentScans);
check('teacher can read scan log', teacherScans[0].n === 6, teacherScans);
const teacherSettings = await asRole({ role: 'authenticated', email: 'teacher@auraway.app' }, `update attendance_settings set late_after = '09:15' returning late_after::text`);
check('teacher can change late cut-off', teacherSettings[0]?.late_after === '09:15:00', teacherSettings);
const studentSettings = await asRole({ role: 'authenticated', email: 'x@students.pulse.app' }, `update attendance_settings set late_after = '12:00' returning 1`);
check('student cannot change late cut-off', studentSettings.length === 0, studentSettings);
let insertBlocked = false;
try { await asRole({ role: 'authenticated', email: 'teacher@auraway.app' }, `insert into rfid_scan_events (card_uid, device_id, result, attendance_date, scanned_at) values ('AAAAAAAA','x','present_marked',current_date, now())`); }
catch (e) { insertBlocked = /permission denied/.test(e.message); }
check('nobody can forge scan events from the browser', insertBlocked);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
