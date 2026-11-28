// Portal API test: the real browser client (nexora-api.js, loaded in jsdom)
// talking over HTTP to the real NEXORA server on PGlite. Covers sign-in,
// sessions, table access under row-level security, RPC, the server functions
// and the origin allowlist.
//   cd tests && npm install && npm run test:api
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import bcrypt from '../server/node_modules/bcryptjs/index.js';
import { createChecker, createDatabase, startServer, repo } from './support.mjs';
import { signJwt } from '../server/src/auth.js';

const { check, finish } = createChecker();
const db = await createDatabase();
const q = async (sql, params) => (await db.query(sql, params)).rows;

// The teacher account comes from the baseline migration.
const TEACHER_ID = (await q(`update auth.users set raw_user_meta_data = '{"display_name":"Head Teacher"}' where email = 'teacher@auraway.app' returning id::text as id`))[0].id;
const ASHA_ID = '22222222-2222-4222-8222-222222222222';
// The cost-10 "$2a$" bcrypt form, as older systems store it.
const ashaHash = bcrypt.hashSync('asha-password-1', 10).replace(/^\$2b\$/, '$2a$');
await db.query(
  `insert into auth.users (id, email, encrypted_password, raw_app_meta_data, raw_user_meta_data) values
     ($1, 'c8-001@students.pulse.app', $2, '{"role":"student"}', '{"display_name":"Asha Rao"}')`,
  [ASHA_ID, ashaHash]);
await db.exec(`
  insert into public.students (student_code, student_name, class_name, auth_user_id, attendance_pct) values
    ('C8-001', 'Asha Rao', 'Class 8', '${ASHA_ID}', '92%'), ('C8-002', 'Vikram Shah', 'Class 8', null, null);
  insert into public.student_marks (student_id, exam_name, subject, marks_obtained, marks_total, assessed_on, created_by) values
    (1, 'Term 1', 'Maths', 41.5, 50, '2026-11-10', '${TEACHER_ID}'), (2, 'Term 1', 'Maths', 30, 50, '2026-11-10', '${TEACHER_ID}');
  insert into public.assignments (title, subject, due_date, target_code) values
    ('Algebra sheet', 'Maths', '2026-12-01', 'ALL'), ('Essay', 'English', '2026-12-02', 'CLASS:Class 8'), ('Other class', 'Art', '2026-12-03', 'CLASS:Class 9');
  insert into public.student_updates (assignment_id, student_code, status) values (1, 'C8-001', 'Completed'), (1, 'C8-002', 'Completed');
  insert into public.attendance_records (student_code, attendance_date, status) values ('C8-001', '2026-11-26', 'Present'), ('C8-002', '2026-11-26', 'Absent');

  -- Functions with awkward shapes, to exercise the RPC layer itself.
  create function public.pulse_whoami() returns jsonb language sql stable as $$
    select jsonb_build_object('uid', auth.uid(), 'email', auth.jwt() ->> 'email', 'role', auth.role()) $$;
  create function public.pulse_class_roster(p_class text, p_limit integer default 50)
    returns table (student_code text, student_name text) language sql stable security definer set search_path = public as $$
    select s.student_code, s.student_name from public.students s where s.class_name = p_class order by 1 limit p_limit $$;
  create function public.pulse_count_ids(p_student_ids bigint[], p_answers jsonb) returns integer language sql as $$
    select cardinality(p_student_ids) + jsonb_array_length(p_answers) $$;
  create function public.pulse_must_be_teacher() returns void language plpgsql as $$
    begin if not public.is_auraway_teacher() then raise exception 'Only teachers can do this.'; end if; end $$;
`);

const server = await startServer(db);

// One jsdom window per portal page, each running the real client script.
const clientSource = fs.readFileSync(`${repo}/nexora-api.js`, 'utf8');
function openPortal(page, origin = 'http://localhost:3000') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${origin}/${page}`, runScripts: 'outside-only' });
  const { window } = dom;
  window.NEXORA_API_URL = server.url;
  window.fetch = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin } });
  // Top-level const bindings do not outlive one eval in jsdom, so hand them out here.
  window.eval(clientSource + '\n;window.__nexora = { client: nexoraClient, storageKey: NEXORA_AUTH_STORAGE_KEY };');
  return { window, ...window.__nexora };
}

let raw;
try {
  console.log('student sign-in');
  const student = openPortal('index.html');
  check('separate storage key per portal', student.storageKey === 'nexora-student-session', student.storageKey);
  let r = await student.client.auth.signInWithPassword({ email: 'c8-001@students.pulse.app', password: 'wrong-password' });
  check('wrong password rejected', r.error?.status === 400 && r.data.user === null && !r.error.message.toLowerCase().includes('fetch'), r);
  r = await student.client.auth.signInWithPassword({ email: 'nobody@students.pulse.app', password: 'asha-password-1' });
  check('unknown account rejected the same way', r.error?.status === 400 && r.error.message === 'Invalid login credentials', r);
  r = await student.client.auth.signInWithPassword({ email: 'C8-001@students.pulse.app', password: 'asha-password-1' });
  check('imported $2a$ hash signs in', !r.error && r.data.user?.id === ASHA_ID && r.data.session?.user?.app_metadata?.role === 'student', r);
  r = await student.client.auth.getSession();
  check('session is stored', r.data.session?.user?.email === 'c8-001@students.pulse.app');
  const sevenDays = r.data.session.session_expires_at - Date.now();
  check('session lasts seven days', sevenDays > 6.9 * 86400000 && sevenDays <= 7 * 86400000, sevenDays);

  console.log('student data access (row-level security)');
  r = await student.client.from('students')
    .select('id,student_name,class_name,student_code,study_hours,attendance_pct,teacher_request,areas_to_improve')
    .eq('auth_user_id', ASHA_ID).maybeSingle();
  check('student reads own profile', !r.error && r.data?.student_code === 'C8-001', r);
  check('bigint ids arrive as JSON numbers', r.data?.id === 1 && r.data?.attendance_pct === '92%', r.data);
  r = await student.client.from('students').select('*').order('created_at', { ascending: false });
  check('student sees only own student row', !r.error && r.data.length === 1, r);
  r = await student.client.from('student_marks').select('exam_name,subject,marks_obtained,marks_total,assessed_on').order('assessed_on', { ascending: false });
  check('student reads only own marks; numerics as numbers, dates as text', !r.error && r.data.length === 1 && r.data[0].marks_obtained === 41.5 && r.data[0].assessed_on === '2026-11-10', r);
  r = await student.client.from('student_marks').insert({ student_id: 1, exam_name: 'Fake', subject: 'Maths', marks_obtained: 50, marks_total: 50 });
  check('student cannot write marks', r.error?.code === '42501' && r.error.status === 403, r);
  r = await student.client.from('rfid_scan_events').select('id');
  check('student cannot see the scan log', !r.error && r.data.length === 0, r);
  r = await student.client.from('attendance_records').select('*').order('attendance_date', { ascending: false }).limit(365);
  check('student reads only own attendance', !r.error && r.data.length === 1 && r.data[0].student_code === 'C8-001', r);
  r = await student.client.from('assignments').select('*').order('due_date', { ascending: true });
  check('student sees assignments for all and for own class only', !r.error && r.data.map(a => a.title).join() === 'Algebra sheet,Essay', r);
  r = await student.client.from('student_updates').insert([{ student_code: 'C8-001', student_name: 'Asha Rao', assignment_id: 2, assignment_title: 'Essay', status: 'Completed' }]);
  check('student posts own homework status', !r.error, r);
  r = await student.client.from('student_updates').insert([{ student_code: 'C8-002', student_name: 'Vikram Shah', status: 'Student Note', student_note: 'forged' }]);
  check('student cannot post as another student', r.error?.code === '42501', r);
  r = await student.client.from('student_updates').select('assignment_id,status,updated_at').eq('student_code', 'C8-002');
  check('student cannot read another student\'s updates', !r.error && r.data.length === 0, r);
  r = await student.client.from('students').update({ class_name: 'Class 12', teacher_request: 'hacked' }).eq('id', 1);
  check('student cannot edit own record', (await q('select class_name from students where id = 1'))[0].class_name === 'Class 8', r);
  r = await student.client.from('quiz_questions').select('*');
  check('quiz answers are not readable from the browser', r.error?.code === '42501', r);
  r = await student.client.from('auth.users').select('*');
  check('other schemas are unreachable', r.error?.status === 400, r);
  r = await student.client.from('students').select('id; drop table students');
  check('malformed column list refused', r.error?.status === 400 && (await q('select count(*)::int n from students'))[0].n === 2, r);
  r = await student.client.from('no_such_table').select('*');
  check('missing table reports 42P01', r.error?.code === '42P01', r);

  console.log('anonymous access');
  const visitor = openPortal('index.html');
  r = await visitor.client.from('students').select('*');
  check('no session -> no table access', r.error?.code === '42501' && r.error.status === 401, r);
  r = await visitor.client.rpc('pulse_get_my_siblings');
  check('signed-out callers cannot call portal functions', r.error?.code === '42501', r);
  r = await visitor.client.rpc('pulse_whoami');
  check('anonymous rpc runs as anon', !r.error && r.data.role === 'anon' && r.data.uid === null, r);

  console.log('teacher sign-in');
  const teacher = openPortal('teacher.html');
  check('teacher portal keeps its own session', teacher.storageKey === 'nexora-teacher-session');
  r = await teacher.client.auth.signInWithTeacherCodes({ loginCode: 'LOGIN-CODE', accessCode: 'nope' });
  check('wrong access code rejected', r.error?.status === 401 && r.data.session === null, r);
  r = await teacher.client.auth.signInWithTeacherCodes({ loginCode: ' LOGIN-CODE ', accessCode: 'ACCESS-CODE' });
  check('teacher codes sign in to the existing account', !r.error && r.data.session?.user?.id === TEACHER_ID && r.data.session.user.user_metadata.display_name === 'Head Teacher', r);
  check('no account was created', (await q('select count(*)::int n from auth.users'))[0].n === 2);

  console.log('teacher data access');
  r = await teacher.client.from('students').select('*').order('created_at', { ascending: false });
  check('teacher sees every student', !r.error && r.data.length === 2, r);
  r = await teacher.client.from('students').insert([{ student_name: 'Meera Iyer', class_name: 'Class 9', student_code: 'CLASS9-1234' }]).select('id').single();
  const meeraId = r.data?.id;
  check('insert … select().single() returns the new row', !r.error && typeof meeraId === 'number', r);
  r = await teacher.client.from('students').update({ teacher_request: 'Revise fractions', class_name: 'Class 9A' }).in('id', [meeraId]);
  const meera = (await q('select class_name, teacher_request from students where id = $1', [meeraId]))[0];
  check('update with in() filter', !r.error && r.data === null && meera.class_name === 'Class 9A' && meera.teacher_request === 'Revise fractions', { r, meera });
  r = await teacher.client.from('students').update({ class_name: 'Everyone' });
  check('update without a filter refused', r.error?.code === '21000', r);
  r = await teacher.client.from('students').delete();
  check('delete without a filter refused', r.error?.code === '21000' && (await q('select count(*)::int n from students'))[0].n === 3, r);
  r = await teacher.client.from('students').insert({ student_name: 'Dup', class_name: 'Class 9', student_code: 'C8-001' });
  check('unique violation reports 23505', r.error?.code === '23505' && r.error.status === 409, r);

  const register = [{ student_code: 'C8-001', attendance_date: '2026-11-27', status: 'Present' }, { student_code: 'C8-002', attendance_date: '2026-11-27', status: 'Absent' }];
  r = await teacher.client.from('attendance_records').upsert(register, { onConflict: 'student_code,attendance_date' });
  check('upsert inserts the register', !r.error, r);
  r = await teacher.client.from('attendance_records').upsert([{ ...register[1], status: 'Leave' }], { onConflict: 'student_code,attendance_date' });
  let rec = await q(`select student_code, status, marked_by::text, source from attendance_records where attendance_date = '2026-11-27' order by 1`);
  check('upsert updates on conflict; marked_by defaults to the teacher', !r.error && rec.length === 2 && rec[1].status === 'Leave' && rec[0].marked_by === TEACHER_ID && rec[0].source === 'manual', rec);
  r = await teacher.client.from('attendance_records').select('student_code,status').in('student_code', ['C8-001', 'C8-002']).gte('attendance_date', '2026-11-27').lte('attendance_date', '2026-11-27').order('student_code').limit(2000);
  check('select with in/gte/lte/order/limit', !r.error && JSON.stringify(r.data) === '[{"student_code":"C8-001","status":"Present"},{"student_code":"C8-002","status":"Leave"}]', r);
  r = await teacher.client.from('attendance_settings').select('late_after').maybeSingle();
  check('maybeSingle on the settings row', !r.error && r.data?.late_after === '09:30:00', r);
  r = await teacher.client.from('student_rfid_cards').insert({ student_id: 1, card_uid: '39 c3 8e 02', created_by: TEACHER_ID });
  r = await teacher.client.from('student_rfid_cards').update({ active: false }).eq('student_id', 1).eq('active', true);
  const card = (await q('select card_uid, active from student_rfid_cards where student_id = 1'))[0];
  check('boolean filters and trigger-normalised insert', !r.error && card.card_uid === '39C38E02' && card.active === false, { r, card });
  r = await teacher.client.from('pulse_timetable').insert({ day_of_week: 'Monday', title: 'Maths', start_time: '09:00', end_time: '09:45', updated_by: TEACHER_ID });
  check('timetable insert passes its policy', !r.error, r);
  r = await teacher.client.from('students').delete().eq('id', meeraId);
  check('delete with a filter', !r.error && (await q('select count(*)::int n from students'))[0].n === 2, r);
  r = await teacher.client.from('students').select('id').eq('id', 999).single();
  check('single() with no rows is an error', r.error?.code === 'PGRST116' && r.data === null, r);

  console.log('rpc');
  r = await teacher.client.rpc('pulse_whoami');
  check('rpc sees the caller', !r.error && r.data.uid === TEACHER_ID && r.data.email === 'teacher@auraway.app' && r.data.role === 'authenticated', r);
  r = await student.client.rpc('pulse_class_roster', { p_class: 'Class 8' });
  check('table function returns rows; defaults apply', !r.error && r.data.length === 2 && r.data[0].student_code === 'C8-001', r);
  r = await student.client.rpc('pulse_count_ids', { p_student_ids: [1, 2, 3], p_answers: [{ id: 1, answer: 'a' }] });
  check('array and jsonb arguments', !r.error && r.data === 4, r);
  r = await student.client.rpc('pulse_must_be_teacher');
  check('raise exception reaches the page as the message', r.error?.message === 'Only teachers can do this.' && r.error.code === 'P0001', r);
  r = await teacher.client.rpc('pulse_must_be_teacher');
  check('void function returns null', !r.error && r.data === null, r);
  r = await teacher.client.rpc('record_rfid_scan', { p_card_uid: '39C38E02' });
  check('reader functions cannot be called from a browser', r.error?.code === '42501', r);
  r = await teacher.client.rpc('pulse_class_roster', { p_nope: 1 });
  check('unknown argument -> PGRST202', r.error?.code === 'PGRST202', r);
  r = await teacher.client.rpc('pg_sleep', { seconds: 1 });
  check('only public functions are callable', r.error?.code === 'PGRST202', r);

  console.log('add user + RFID card (student-enroll)');
  r = await student.client.functions.invoke('student-enroll', { body: { student_name: 'X', class_name: 'Class 8', password: 'long-enough-pw' } });
  check('students cannot add users', r.error?.status === 403, r);
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'Nila Menon', class_name: 'Class 7 B', password: 'short', card_uid: 'AA BB CC DD' } });
  check('short password refused', r.error?.status === 400 && /10 and 72/.test(r.data?.error), r);
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'Nila Menon', class_name: 'Class 7 B', password: 'nila-password-1', card_uid: 'xyz' } });
  check('malformed card UID refused', r.error?.status === 400 && /hex/.test(r.data?.error), r);
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: '  Nila   Menon ', class_name: 'Class 7 B', password: 'nila-password-1', card_uid: 'aa:bb:cc:dd' } });
  const nila = r.data?.student;
  check('teacher adds a user with a card in one step', !r.error && r.data?.success && nila?.student_name === 'Nila Menon' && /^CLASS7B-\d{4}$/.test(nila.student_code) && typeof nila.id === 'number' && r.data.card_uid === 'AABBCCDD', r);
  const nilaRow = (await q(`select s.auth_user_id is not null as has_login, u.email, c.card_uid, c.active, c.created_by::text as created_by
    from students s join auth.users u on u.id = s.auth_user_id join student_rfid_cards c on c.student_id = s.id where s.id = $1`, [nila.id]))[0];
  check('record, login and card were all saved', nilaRow?.has_login && nilaRow.email === nila.student_code.toLowerCase() + '@students.pulse.app' && nilaRow.card_uid === 'AABBCCDD' && nilaRow.active && nilaRow.created_by === TEACHER_ID, nilaRow);
  const nilaPortal = openPortal('index.html');
  r = await nilaPortal.client.auth.signInWithPassword({ email: nila.student_code.toLowerCase() + '@students.pulse.app', password: 'nila-password-1' });
  check('the new user can sign in straight away', !r.error && r.data.session?.user?.app_metadata?.role === 'student', r);
  let tap = await fetch(`${server.url}/api/rfid/attendance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pulse-device-secret': 'test-secret-0123456789abcdef0123456789' }, body: JSON.stringify({ card_uid: 'AABBCCDD', device_id: 'main-gate' }) });
  tap = await tap.json();
  check('and their card marks them present', tap.result === 'present_marked' && tap.student_name === 'Nila Menon', tap);
  const before = (await q('select count(*)::int n from students'))[0].n;
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'Card Thief', class_name: 'Class 7 B', password: 'thief-password-1', card_uid: 'AABBCCDD' } });
  check('a card that belongs to someone is refused, and nothing is half-saved', r.error?.status === 409 && /Nila Menon/.test(r.data?.error) && (await q('select count(*)::int n from students'))[0].n === before && (await q(`select count(*)::int n from auth.users where email like 'class7b-%'`))[0].n === 1, r);
  await db.exec(`update student_rfid_cards set active = false where card_uid = 'AABBCCDD'`);
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'Dev Pillai', class_name: 'Class 7 B', password: 'dev-password-01', card_uid: 'AABBCCDD' } });
  const reused = (await q(`select count(*)::int n, bool_and(active) active, min(student_id)::int student_id from student_rfid_cards where card_uid = 'AABBCCDD'`))[0];
  check('a deactivated card can be handed to a new user', !r.error && reused.n === 1 && reused.active && reused.student_id === r.data.student.id, { r, reused });
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'No Card', class_name: '10', password: 'nocard-password' } });
  check('the card is optional', !r.error && r.data.card_uid === null && /^10-\d{4}$/.test(r.data.student.student_code), r);
  r = await teacher.client.from('students').delete().eq('id', r.data.student.id);
  check('deleting a student also deletes their login', !r.error && (await q(`select count(*)::int n from auth.users where email like '10-%'`))[0].n === 0, r);

  console.log('daily quiz');
  r = await student.client.rpc('pulse_teacher_save_quiz_question', { p_id: null, p_subject: 'Science', p_question: 'Q?', p_options: ['a', 'b', 'c', 'd'], p_correct_option: 0, p_explanation: '' });
  check('students cannot add quiz questions', r.error?.code === '42501', r);
  for (let i = 1; i <= 9; i++) {
    r = await teacher.client.rpc('pulse_teacher_save_quiz_question', { p_id: null, p_subject: 'Science', p_question: `Science question ${i}?`, p_options: ['right', 'wrong 1', 'wrong 2', 'wrong 3'], p_correct_option: 0, p_explanation: 'Because.' });
  }
  check('teacher saves questions', !r.error && typeof r.data === 'number', r);
  r = await student.client.rpc('pulse_begin_daily_quiz', { p_subject: 'Science' });
  check('quiz with fewer than ten questions is not offered', /not ready yet/.test(r.error?.message || ''), r);
  r = await teacher.client.rpc('pulse_teacher_save_quiz_question', { p_id: null, p_subject: 'Science', p_question: 'Science question 10?', p_options: ['right', 'wrong 1', 'wrong 2'], p_correct_option: 0, p_explanation: '' });
  check('a question needs four options', /four options/.test(r.error?.message || ''), r);
  r = await teacher.client.rpc('pulse_teacher_save_quiz_question', { p_id: null, p_subject: 'Science', p_question: 'Science question 10?', p_options: ['right', 'wrong 1', 'wrong 2', 'wrong 3'], p_correct_option: 0, p_explanation: '' });
  const tenth = r.data;
  r = await teacher.client.rpc('pulse_teacher_list_quiz_questions', { p_subject: null });
  check('teacher lists the bank with answers', !r.error && r.data.length === 10 && r.data[0].correct_option === 0 && Array.isArray(r.data[0].options) && r.data[0].is_active === true, r);
  r = await teacher.client.rpc('pulse_teacher_save_quiz_question', { p_id: tenth, p_subject: 'Science', p_question: 'Edited question 10?', p_options: ['wrong', 'right', 'wrong 2', 'wrong 3'], p_correct_option: 1, p_explanation: '' });
  r = await teacher.client.rpc('pulse_teacher_set_quiz_question_active', { p_id: tenth, p_active: false });
  r = await teacher.client.rpc('pulse_teacher_list_quiz_questions', { p_subject: 'Science' });
  const edited = r.data.find(row => row.id === tenth);
  check('teacher edits and deactivates a question', edited?.question === 'Edited question 10?' && edited.correct_option === 1 && edited.is_active === false, edited);
  await teacher.client.rpc('pulse_teacher_set_quiz_question_active', { p_id: tenth, p_active: true });
  r = await student.client.rpc('pulse_begin_daily_quiz', { p_subject: 'Science' });
  const quiz = r.data?.questions || [];
  check('student gets ten questions without the answers', !r.error && quiz.length === 10 && quiz.every(item => item.options.length === 4 && !('correct_option' in item)), r);
  r = await student.client.rpc('pulse_begin_daily_quiz', { p_subject: 'Science' });
  check('resuming gives the same ten in the same order', r.data?.questions.map(item => item.id).join() === quiz.map(item => item.id).join(), r);
  const answers = Object.fromEntries(quiz.map((item, index) => [String(item.id), index < 7 ? (item.id === tenth ? 1 : 0) : 3]));
  r = await student.client.rpc('pulse_submit_daily_quiz', { p_subject: 'Science', p_answers: answers });
  check('answers are scored on the server', !r.error && r.data.score === 7, r);
  r = await student.client.rpc('pulse_submit_daily_quiz', { p_subject: 'Science', p_answers: Object.fromEntries(quiz.map(item => [String(item.id), item.id === tenth ? 1 : 0])) });
  check('a second submission cannot improve the score', !r.error && r.data.score === 7, r);
  r = await student.client.rpc('pulse_begin_daily_quiz', { p_subject: 'Science' });
  check('one attempt per day', r.data?.status === 'completed' && r.data.score === 7, r);
  r = await teacher.client.rpc('pulse_begin_daily_quiz', { p_subject: 'Science' });
  check('the quiz is for student accounts', /student account/.test(r.error?.message || ''), r);

  console.log('school calendar');
  r = await student.client.rpc('pulse_calendar_my_context');
  check('student has no calendar before the school is set up', !r.error && r.data.length === 0, r);
  r = await student.client.rpc('pulse_calendar_create_school', { p_name: 'Fake School' });
  check('students cannot set up the school', r.error?.code === '42501', r);
  r = await teacher.client.rpc('pulse_calendar_create_school', { p_name: 'Demo Public School' });
  const schoolId = r.data;
  check('teacher sets up the school', !r.error && typeof schoolId === 'string', r);
  r = await teacher.client.rpc('pulse_calendar_create_school', { p_name: 'Second School' });
  check('only one school can be set up', /already been set up/.test(r.error?.message || ''), r);
  r = await teacher.client.rpc('pulse_calendar_my_context');
  check('teacher context can manage', r.data?.[0]?.school_id === schoolId && r.data[0].school_name === 'Demo Public School' && r.data[0].can_manage === true, r);
  r = await student.client.rpc('pulse_calendar_my_context');
  check('existing students were linked to the school', r.data?.[0]?.school_id === schoolId && r.data[0].can_manage === false, r);
  r = await teacher.client.rpc('pulse_calendar_list_unassigned_students');
  check('nobody is left unassigned', !r.error && r.data.length === 0, r);
  await db.exec(`update students set school_id = null where id = 2`);
  r = await teacher.client.rpc('pulse_calendar_link_unassigned_students', { p_student_ids: [2, 999] });
  check('linking unassigned students returns the count', !r.error && r.data === 1, r);
  r = await teacher.client.from('academic_calendar_events').insert({ school_id: schoolId, title: 'Onam holiday', event_date: '2026-12-05', event_type: 'holiday', description: '' });
  check('teacher adds a calendar entry', !r.error, r);
  r = await student.client.from('academic_calendar_events').select('*').gte('event_date', '2026-12-01').lte('event_date', '2026-12-31').order('event_date').order('created_at');
  check('student reads the school calendar', !r.error && r.data.length === 1 && r.data[0].title === 'Onam holiday' && r.data[0].event_date === '2026-12-05', r);
  r = await student.client.from('academic_calendar_events').insert({ school_id: schoolId, title: 'Fake holiday', event_date: '2026-12-06', event_type: 'holiday' });
  check('student cannot add calendar entries', r.error?.code === '42501', r);
  r = await teacher.client.functions.invoke('student-enroll', { body: { student_name: 'Late Joiner', class_name: 'Class 8', password: 'late-joiner-pw1' } });
  check('users added later join the school automatically', (await q('select school_id::text id from students where id = $1', [r.data.student.id]))[0].id === schoolId, r);

  console.log('sibling links');
  r = await nilaPortal.client.rpc('pulse_request_sibling_link', { p_sibling_code: 'NOPE-0000' });
  check('unknown sibling code refused', /Check the sibling code/.test(r.error?.message || ''), r);
  r = await nilaPortal.client.rpc('pulse_request_sibling_link', { p_sibling_code: ' c8-001 ' });
  const requestId = r.data;
  check('a student asks to link a sibling', !r.error && typeof requestId === 'string', r);
  r = await nilaPortal.client.rpc('pulse_approve_sibling_link_request', { p_request_id: requestId });
  check('the requester cannot approve their own request', /no longer valid/.test(r.error?.message || ''), r);
  r = await nilaPortal.client.rpc('pulse_is_linked_sibling_code', { p_student_code: 'C8-001' });
  check('not linked until the sibling approves', r.data === false, r);
  r = await student.client.rpc('pulse_approve_sibling_link_request', { p_request_id: requestId });
  check('signing in as the sibling approves it', !r.error, r);
  r = await nilaPortal.client.rpc('pulse_get_my_siblings');
  check('the link shows on one side', !r.error && r.data.length === 1 && r.data[0].student_name === 'Asha Rao' && r.data[0].student_id === 1 && r.data[0].class_name === 'Class 8', r);
  r = await student.client.rpc('pulse_get_my_siblings');
  check('and on the other', r.data?.length === 1 && r.data[0].student_name === 'Nila Menon', r);
  r = await student.client.rpc('pulse_is_linked_sibling_code', { p_student_code: nila.student_code });
  check('linked code is recognised', r.data === true, r);
  r = await student.client.rpc('pulse_is_linked_sibling_code', { p_student_code: 'C8-002' });
  check('an unrelated code is not', r.data === false, r);
  r = await student.client.rpc('pulse_request_sibling_link', { p_sibling_code: nila.student_code });
  check('linking twice says already linked', (r.error?.message || '').includes('already linked'), r);
  r = await student.client.rpc('pulse_approve_sibling_link_request', { p_request_id: requestId });
  check('a request cannot be approved twice', /no longer valid/.test(r.error?.message || ''), r);

  console.log('exams');
  r = await teacher.client.from('nexora_exams').insert({
    title: 'Unit test 1', subject: 'Maths', instructions: 'Bring a pencil.', starts_at: '2026-12-10T04:00:00.000Z', duration_minutes: 60,
    status: 'published', visibility: 'assigned', created_by: TEACHER_ID, created_by_role: 'teacher', created_by_student_id: null
  }).select('id').single();
  const examId = r.data?.id;
  check('teacher publishes an exam', !r.error && typeof examId === 'string', r);
  r = await teacher.client.from('nexora_exam_targets').insert([{ exam_id: examId, student_id: 1, assigned_by: TEACHER_ID }]);
  check('and assigns it', !r.error, r);
  r = await student.client.from('nexora_exam_targets').select('exam_id').eq('student_id', 1);
  const examIds = (r.data || []).map(row => row.exam_id);
  r = await student.client.from('nexora_exams').select('id,title,subject,instructions,starts_at,duration_minutes').in('id', examIds).eq('status', 'published').order('starts_at', { ascending: true });
  check('the assigned student sees it', !r.error && r.data.length === 1 && r.data[0].title === 'Unit test 1', r);
  r = await nilaPortal.client.from('nexora_exams').select('id,title').in('id', [examId]);
  check('other students do not', !r.error && r.data.length === 0, r);
  r = await teacher.client.from('nexora_exams').select('id,title,subject,starts_at,duration_minutes,status').eq('created_by', TEACHER_ID).order('starts_at', { ascending: false });
  check('teacher lists published exams', !r.error && r.data.length === 1, r);

  console.log('push notifications');
  const device = name => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });
  const pushCall = (portal, body) => portal.client.functions.invoke('push-notify', { body });
  r = await student.client.from('push_subscriptions').select('*');
  check('subscriptions are not readable from the browser', r.error?.code === '42501', r);
  r = await pushCall(visitor, { action: 'subscribe', role: 'student', subscription: device('nobody') });
  check('a student subscription needs a sign-in', r.error?.status === 401, r);
  r = await pushCall(student, { action: 'subscribe', role: 'student', student_code: 'C8-002', subscription: device('asha-phone') });
  check('a student subscribes this device', !r.error && r.data?.ok, r);
  check('for their own code, whatever the page sends', (await q(`select student_code from push_subscriptions where endpoint like '%asha-phone'`))[0]?.student_code === 'C8-001');
  r = await pushCall(visitor, { action: 'subscribe', role: 'parent', student_code: 'NOPE-0000', subscription: device('stranger') });
  check('a parent needs a real student code', r.error?.status === 400 && /Invalid student code/.test(r.data?.error), r);
  r = await pushCall(visitor, { action: 'subscribe', role: 'parent', student_code: ' c8-001 ', subscription: device('asha-mum') });
  check('a parent subscribes with the student code', !r.error && r.data?.ok, r);
  await pushCall(visitor, { action: 'subscribe', role: 'parent', student_code: 'C8-001', subscription: device('gone-old-phone') });
  r = await pushCall(visitor, { action: 'subscribe', role: 'parent', student_code: 'C8-001', subscription: { endpoint: 'http://insecure.example/x', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } });
  check('a malformed subscription is refused', r.error?.status === 400, r);

  r = await pushCall(student, { action: 'broadcast', title: 'Hi', message: 'From a student' });
  check('students cannot broadcast', r.error?.status === 403 && server.pushed.length === 0, r);
  r = await pushCall(teacher, { action: 'broadcast', title: 'Holiday tomorrow', message: 'School is closed.', target: 'ALL', audience: 'all' });
  check('teacher broadcast reaches students and parents', !r.error && r.data.sent === 2 && r.data.devices === 3, r.data);
  const toParent = server.pushed.find(n => n.endpoint.endsWith('asha-mum'));
  check('each role is sent to its own page', toParent?.title === '🔔 Holiday tomorrow' && toParent.url === 'https://codecrew-lab.github.io/nexora/parent.html' && server.pushed.find(n => n.endpoint.endsWith('asha-phone'))?.url.endsWith('/index.html'), server.pushed);
  check('a device that has unsubscribed is forgotten', (await q(`select count(*)::int n from push_subscriptions where endpoint like '%gone%'`))[0].n === 0);
  server.pushed.length = 0;
  r = await pushCall(teacher, { action: 'broadcast', title: 'Class 9 only', message: 'x', target: 'CLASS:Class 9', audience: 'all' });
  check('a broadcast to another class reaches nobody here', !r.error && r.data.sent === 0 && server.pushed.length === 0, r.data);

  // Automatic alerts: the database queues the change, the server sends it.
  await db.exec('delete from push_outbox');
  r = await teacher.client.from('assignments').insert([{ title: 'Read chapter 4', subject: 'English', due_date: '2026-12-05', target_code: 'CLASS:Class 8' }]);
  check('saving an assignment queues an alert', !r.error && (await q('select count(*)::int n from push_outbox'))[0].n === 1, r);
  check('nothing is sent until the server collects the queue', server.pushed.length === 0);
  let delivered = await server.push.processOutbox();
  const homework = server.pushed.find(n => n.endpoint.endsWith('asha-phone'));
  check('new assignment alert goes to the class and their parents', delivered === 2 && homework?.title === '📚 New assignment: English' && /Read chapter 4 · Due 5 Dec/.test(homework.body) && homework.url.endsWith('/classroom.html') && server.pushed.find(n => n.endpoint.endsWith('asha-mum'))?.title === '📚 New homework: English', server.pushed);
  check('the queue is emptied', (await q('select count(*)::int n from push_outbox'))[0].n === 0 && await server.push.processOutbox() === 0);

  server.pushed.length = 0;
  const todayIst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  r = await teacher.client.from('attendance_records').upsert([{ student_code: 'C8-001', attendance_date: todayIst, status: 'Absent' }], { onConflict: 'student_code,attendance_date' });
  await server.push.processOutbox();
  check('marking a student absent alerts the parent only', !r.error && server.pushed.length === 1 && server.pushed[0].endpoint.endsWith('asha-mum') && server.pushed[0].title === '⚠️ Attendance alert' && /Asha Rao was marked absent today/.test(server.pushed[0].body), server.pushed);
  server.pushed.length = 0;
  await teacher.client.from('attendance_records').upsert([{ student_code: 'C8-001', attendance_date: todayIst, status: 'Absent' }], { onConflict: 'student_code,attendance_date' });
  await teacher.client.from('attendance_records').upsert([{ student_code: 'C8-001', attendance_date: '2026-11-20', status: 'Absent' }], { onConflict: 'student_code,attendance_date' });
  await server.push.processOutbox();
  check('saving the same status again, or an old date, alerts nobody', server.pushed.length === 0, server.pushed);
  await db.exec(`delete from attendance_records where student_code = 'C8-001' and attendance_date = '${todayIst}'; update student_rfid_cards set active = true where card_uid = '39C38E02'`);
  tap = await (await fetch(`${server.url}/api/rfid/attendance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pulse-device-secret': 'test-secret-0123456789abcdef0123456789' }, body: JSON.stringify({ card_uid: '39C38E02', device_id: 'main-gate' }) })).json();
  await server.push.processOutbox();
  check('an RFID tap tells the parent their child arrived', tap.result === 'present_marked' && server.pushed.length === 1 && /Asha Rao arrived at school at \d/.test(server.pushed[0].body), { tap, pushed: server.pushed });
  server.pushed.length = 0;
  r = await teacher.client.from('student_marks').insert({ student_id: 1, exam_name: 'Unit test 1', subject: 'Maths', marks_obtained: 18, marks_total: 20, created_by: TEACHER_ID });
  await server.push.processOutbox();
  check('new marks alert the student and the parent', !r.error && server.pushed.length === 2 && server.pushed.some(n => n.body === 'You scored 18/20 in Maths (Unit test 1).') && server.pushed.some(n => n.body === 'Asha Rao scored 18/20 in Maths (Unit test 1).'), server.pushed);
  await db.exec(`insert into push_outbox (table_name, record, created_at) values ('assignments', '{"title":"Old news","target_code":"ALL"}', now() - interval '3 hours')`);
  server.pushed.length = 0;
  await server.push.processOutbox();
  check('alerts that waited too long are dropped, not sent late', server.pushed.length === 0 && (await q('select count(*)::int n from push_outbox'))[0].n === 0, server.pushed);

  r = await pushCall(student, { action: 'unsubscribe', endpoint: device('asha-phone').endpoint, role: 'student', student_code: 'C8-001' });
  check('unsubscribe removes the device', !r.error && (await q(`select count(*)::int n from push_subscriptions where endpoint like '%asha-phone'`))[0].n === 0, r);
  const off = await startServer(db, { vapidPublicKey: '', vapidPrivateKey: '' });
  raw = await fetch(`${off.url}/api/functions/push-notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'subscribe', role: 'parent', student_code: 'C8-001', subscription: device('x') }) });
  check('without keys the feature reports it is not configured', raw.status === 503 && await off.push.processOutbox() === 0);
  await off.close();

  console.log('student-account-manager');
  r = await student.client.functions.invoke('student-account-manager', { body: { student_id: 2, password: 'vikram-password-1' } });
  check('students cannot set passwords', r.error?.status === 403 && /authorized teacher/.test(r.data?.error), r);
  r = await visitor.client.functions.invoke('student-account-manager', { body: { student_id: 2, password: 'vikram-password-1' } });
  check('signed-out callers are refused', r.error?.status === 401, r);
  r = await teacher.client.functions.invoke('student-account-manager', { body: { student_id: 2, password: 'short' } });
  check('short password refused', r.error?.status === 400 && /between 10 and 72/.test(r.data?.error), r);
  r = await teacher.client.functions.invoke('student-account-manager', { body: { student_id: 2, password: 'vikram-password-1' } });
  const vikram = (await q(`select u.email, u.raw_app_meta_data ->> 'role' as role, u.encrypted_password, s.auth_user_id = u.id as linked from students s join auth.users u on u.id = s.auth_user_id where s.id = 2`))[0];
  check('teacher creates and links a student account', !r.error && r.data?.success && vikram?.email === 'c8-002@students.pulse.app' && vikram.role === 'student' && vikram.linked && vikram.encrypted_password.startsWith('$2'), { r, vikram });
  const sibling = openPortal('index.html');
  r = await sibling.client.auth.signInWithPassword({ email: 'c8-002@students.pulse.app', password: 'vikram-password-1' });
  check('new student can sign in', !r.error && r.data.session, r);
  r = await teacher.client.functions.invoke('student-account-manager', { body: { student_id: 1, password: 'asha-password-2' } });
  check('reset keeps the same account', !r.error && (await q('select auth_user_id::text id from students where id = 1'))[0].id === ASHA_ID && (await q(`select count(*)::int n from auth.users where email = 'c8-001@students.pulse.app'`))[0].n === 1, r);
  r = await openPortal('index.html').client.auth.signInWithPassword({ email: 'c8-001@students.pulse.app', password: 'asha-password-1' });
  check('old password stops working', r.error?.status === 400, r);

  console.log('sessions');
  // The reset ended Asha's session server-side. Make her access token look
  // expired so the client must refresh, and check it signs her out.
  const stored = JSON.parse(student.window.localStorage.getItem(student.storageKey));
  student.window.localStorage.setItem(student.storageKey, JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 5 }));
  r = await student.client.auth.getSession();
  check('password reset ends the old session at the next refresh', r.data.session === null && student.window.localStorage.getItem(student.storageKey) === null, r);

  const teacherStored = JSON.parse(teacher.window.localStorage.getItem(teacher.storageKey));
  teacher.window.localStorage.setItem(teacher.storageKey, JSON.stringify({ ...teacherStored, expires_at: Math.floor(Date.now() / 1000) + 30 }));
  r = await teacher.client.from('students').select('id');
  const refreshed = JSON.parse(teacher.window.localStorage.getItem(teacher.storageKey));
  check('a token about to expire is refreshed transparently', !r.error && refreshed.expires_at > teacherStored.expires_at - 5 && refreshed.expires_at > Math.floor(Date.now() / 1000) + 3000 && refreshed.session_expires_at === teacherStored.session_expires_at, { r, refreshed: refreshed.expires_at });

  const expired = signJwt({ sub: TEACHER_ID, role: 'authenticated', email: 'teacher@auraway.app', exp: Math.floor(Date.now() / 1000) - 60 }, 'test-jwt-secret-0123456789abcdef0123456789abcdef');
  teacher.window.localStorage.setItem(teacher.storageKey, JSON.stringify({ ...refreshed, access_token: expired }));
  r = await teacher.client.from('students').select('id');
  check('an expired token is retried after a refresh', !r.error && r.data.length === (await q('select count(*)::int n from students'))[0].n, r);
  const forged = signJwt({ sub: TEACHER_ID, role: 'authenticated', email: 'teacher@auraway.app', exp: Math.floor(Date.now() / 1000) + 600 }, 'some-other-secret-that-is-long-enough-000');
  raw = await fetch(`${server.url}/api/db/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` }, body: JSON.stringify({ table: 'students', action: 'select' }) });
  check('a token signed with another key is refused', raw.status === 401 && (await raw.json()).error.code === 'invalid_token');

  await db.exec(`update auth.nexora_sessions set expires_at = now() - interval '1 minute' where user_id = '${TEACHER_ID}'`);
  raw = await fetch(`${server.url}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshed.refresh_token }) });
  check('a session cannot be refreshed past seven days', raw.status === 401);
  await teacher.client.auth.signInWithTeacherCodes({ loginCode: 'LOGIN-CODE', accessCode: 'ACCESS-CODE' });
  const sessionsBefore = (await q(`select count(*)::int n from auth.nexora_sessions where user_id = '${TEACHER_ID}'`))[0].n;
  r = await teacher.client.auth.signOut();
  const after = (await q(`select count(*)::int n from auth.nexora_sessions where user_id = '${TEACHER_ID}'`))[0].n;
  check('sign-out ends the session on the server', !r.error && sessionsBefore === 1 && after === 0 && teacher.window.localStorage.getItem(teacher.storageKey) === null, { sessionsBefore, after });
  check('getSession is empty after sign-out', (await teacher.client.auth.getSession()).data.session === null);

  console.log('parent-report');
  const parent = openPortal('parent.html');
  // jsdom needs a real URL; the Android apps send the literal origin "null".
  parent.window.fetch = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Origin: 'null' } });
  r = await parent.client.functions.invoke('parent-report', { body: { student_code: ' c8-001 ' } });
  check('report by student code (Android "null" origin)', !r.error && r.data?.success && r.data.student.student_name === 'Asha Rao' && !('id' in r.data.student), r);
  check('report lists attendance, assignments, updates, timetable',
    r.data?.attendance.map(a => a.attendance_date).slice(1).join() === '2026-11-27,2026-11-26,2026-11-20' && r.data.attendance[0].source === 'rfid' &&
    r.data.assignments.map(a => a.title).join() === 'Algebra sheet,Essay,Read chapter 4' && r.data.updates.length === 2 && r.data.timetable.length === 1, r.data);
  r = await parent.client.functions.invoke('parent-report', { body: { student_code: 'NOPE-0000' } });
  check('unknown code -> success:false', !r.error && r.data?.success === false, r);
  r = await parent.client.functions.invoke('parent-report', { body: { student_code: "x' or 1=1 --" } });
  check('malformed code refused', r.data?.success === false, r);
  for (let i = 0; i < 6; i++) await parent.client.functions.invoke('parent-report', { body: { student_code: 'NOPE-0000' } });
  r = await parent.client.functions.invoke('parent-report', { body: { student_code: 'C8-001' } });
  check('guessing codes is rate limited', r.error?.status === 429 && /Too many attempts/.test(r.data?.error), r);

  console.log('origins and limits');
  raw = await fetch(`${server.url}/api/db/query`, { method: 'OPTIONS', headers: { Origin: 'https://codecrew-lab.github.io', 'Access-Control-Request-Method': 'POST' } });
  check('preflight from the site is allowed', raw.status === 204 && raw.headers.get('access-control-allow-origin') === 'https://codecrew-lab.github.io');
  raw = await fetch(`${server.url}/api/auth/login`, { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  check('other websites are refused', raw.status === 403 && !raw.headers.get('access-control-allow-origin'));
  for (let i = 0; i < 5; i++) await teacher.client.auth.signInWithTeacherCodes({ loginCode: 'LOGIN-CODE', accessCode: 'guess' + i });
  r = await teacher.client.auth.signInWithTeacherCodes({ loginCode: 'LOGIN-CODE', accessCode: 'ACCESS-CODE' });
  check('teacher code guessing is rate limited', r.error?.status === 429, r);
  raw = await fetch(`${server.url}/healthz`);
  check('health check', raw.status === 200);
  // Behind a proxy: the caller's address is the last X-Forwarded-For entry, with any port removed.
  const proxied = await startServer(db, { trustProxy: true });
  const guess = (forwardedFor, code) => fetch(`${proxied.url}/api/auth/teacher-login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ login_code: 'LOGIN-CODE', access_code: code }),
  }).then(res => res.status);
  for (let i = 0; i < 5; i++) await guess(`10.9.9.${i}, 203.0.113.7:${40000 + i}`, 'guess');
  check('forged forwarding entries and changing ports do not dodge the rate limit', await guess('1.2.3.4, 203.0.113.7:51234', 'ACCESS-CODE') === 429);
  check('another real address is not affected', await guess('203.0.113.7, 198.51.100.20:443', 'ACCESS-CODE') === 200);
  await proxied.close();
  const offline = openPortal('index.html');
  offline.window.fetch = () => Promise.reject(new TypeError('network down'));
  r = await offline.client.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
  check('network failure is reported as a fetch error', r.error?.status === 0 && r.error.message.toLowerCase().includes('fetch'), r);

  check('no unexpected server errors were logged', server.errors.length === 0, server.errors);
} finally {
  await server.close();
}
finish('API');
