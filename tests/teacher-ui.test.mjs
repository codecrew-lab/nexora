// Teacher portal UI tests: runs teacher-rfid.js and the attendance register from
// teacher.html in jsdom against an in-memory stand-in for the API client that enforces the
// same unique constraints as Postgres.
//   cd tests && npm install && npm run test:ui
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ', name);
  else { failures++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const tick = () => new Promise(r => setTimeout(r, 20));

const teacherHtml = fs.readFileSync(`${repo}/teacher.html`, 'utf8');
// Keep the markup, drop every script; we load exactly what we test.
const markup = teacherHtml.replace(/<script[\s\S]*?<\/script>/g, '');

function makeClient(tables, log, { failTables = new Set() } = {}) {
  let nextId = 1000;
  class Query {
    constructor(table) { Object.assign(this, { table, filters: [], op: 'select', payload: null, single: false, returning: false }); }
    select() { if (this.op !== 'select') this.returning = true; return this; }
    eq(c, v) { this.filters.push(r => r[c] === v); return this; }
    in(c, vs) { this.filters.push(r => vs.includes(r[c])); return this; }
    gte(c, v) { this.filters.push(r => r[c] >= v); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.single = true; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    upsert(p, o) { this.op = 'upsert'; this.payload = p; this.opts = o; return this; }
    delete() { this.op = 'delete'; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.exec()).then(resolve, reject); }
    exec() {
      if (failTables.has(this.table)) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${this.table}' in the schema cache` } };
      const rows = (tables[this.table] ||= []);
      const match = r => this.filters.every(f => f(r));
      log.push({ table: this.table, op: this.op, payload: this.payload });
      const violates = () => {
        if (this.table !== 'student_rfid_cards') return null;
        const uids = new Set(); const active = new Set();
        for (const r of rows) {
          if (uids.has(r.card_uid)) return { code: '23505', message: 'duplicate key value violates unique constraint "student_rfid_cards_card_uid_key"' };
          uids.add(r.card_uid);
          if (r.active) { if (active.has(r.student_id)) return { code: '23505', message: 'duplicate key value violates unique constraint "student_rfid_cards_one_active_per_student"' }; active.add(r.student_id); }
        }
        return null;
      };
      if (this.op === 'select') {
        const data = rows.filter(match);
        return { data: this.single ? (data[0] ?? null) : data, error: null };
      }
      const snapshot = JSON.stringify(rows);
      let affected = [];
      if (this.op === 'insert') {
        const items = [].concat(this.payload).map(p => ({ id: nextId++, active: true, created_at: new Date().toISOString(), ...p }));
        rows.push(...items); affected = items;
      } else if (this.op === 'update') {
        affected = rows.filter(match); affected.forEach(r => Object.assign(r, this.payload));
      } else if (this.op === 'delete') {
        affected = rows.filter(match); tables[this.table] = rows.filter(r => !match(r));
      } else if (this.op === 'upsert') {
        const keys = this.opts.onConflict.split(',');
        for (const p of this.payload) {
          const existing = rows.find(r => keys.every(k => r[k] === p[k]));
          if (existing) Object.assign(existing, p); else rows.push({ id: nextId++, source: 'manual', created_at: new Date().toISOString(), ...p });
          affected.push(p);
        }
      }
      const error = violates();
      if (error) { tables[this.table] = JSON.parse(snapshot); return { data: null, error }; }
      return { data: this.returning ? affected : null, error: null };
    }
  }
  return { from: table => new Query(table) };
}

function setup({ failTables } = {}) {
  const dom = new JSDOM(markup, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const now = new Date();
  const minutesAgo = m => new Date(now.getTime() - m * 60000).toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const tables = {
    students: [
      { id: 1, student_name: 'Asha Rao', class_name: 'Class 8', student_code: 'C8-001' },
      { id: 2, student_name: 'Vikram Shah', class_name: 'Class 8', student_code: 'C8-002' },
      { id: 3, student_name: 'Meera Iyer', class_name: 'Class 8', student_code: 'C8-003' },
    ],
    student_rfid_cards: [
      { id: 1, student_id: 1, card_uid: '39C38E02', active: true, created_at: minutesAgo(9000) },
      { id: 2, student_id: 2, card_uid: 'AABBCCDD', active: true, created_at: minutesAgo(9000) },
      { id: 3, student_id: 2, card_uid: '11223344', active: false, created_at: minutesAgo(20000) },
    ],
    rfid_devices: [
      { device_id: 'main-gate', last_seen_at: minutesAgo(2), firmware_version: '2.0.0', wifi_rssi: -60, queued_scans: 0 },
      { device_id: 'library', last_seen_at: minutesAgo(60), firmware_version: '2.0.0', wifi_rssi: -80, queued_scans: 4 },
    ],
    rfid_scan_events: [
      { id: 1, card_uid: '39C38E02', device_id: 'main-gate', student_id: 1, result: 'present_marked', scanned_at: minutesAgo(30), received_at: minutesAgo(30), attendance_date: today, is_late: false },
      { id: 2, card_uid: '39C38E02', device_id: 'main-gate', student_id: 1, result: 'already_marked', scanned_at: minutesAgo(29), received_at: minutesAgo(29), attendance_date: today, is_late: false },
      { id: 3, card_uid: 'AABBCCDD', device_id: 'main-gate', student_id: 2, result: 'present_marked', scanned_at: minutesAgo(10), received_at: minutesAgo(10), attendance_date: today, is_late: true },
      { id: 4, card_uid: 'DEADBEEF', device_id: 'main-gate', student_id: null, result: 'unregistered_card', scanned_at: minutesAgo(5), received_at: minutesAgo(5), attendance_date: today, is_late: false },
      { id: 5, card_uid: 'DEADBEEF', device_id: 'main-gate', student_id: null, result: 'unregistered_card', scanned_at: minutesAgo(4), received_at: minutesAgo(4), attendance_date: today, is_late: false },
      { id: 6, card_uid: '11223344', device_id: 'library', student_id: null, result: 'unregistered_card', scanned_at: minutesAgo(3), received_at: minutesAgo(3), attendance_date: today, is_late: false },
    ],
    attendance_settings: [{ id: true, late_after: '09:30:00' }],
    attendance_records: [
      { id: 50, student_code: 'C8-001', attendance_date: today, status: 'Present', source: 'rfid', marked_by: null, created_at: minutesAgo(30), scanned_at: minutesAgo(30), is_late: false },
      { id: 51, student_code: 'C8-002', attendance_date: today, status: 'Present', source: 'rfid', marked_by: null, created_at: minutesAgo(10), scanned_at: minutesAgo(10), is_late: true },
    ],
  };
  const log = [];
  window.confirm = () => true;
  window.alert = () => {};
  window.NEXORA_TEACHER_USER_ID = 'teacher-uuid';
  window.eval(`var nexoraClient;`);
  window.nexoraClient = makeClient(tables, log, { failTables });
  window.eval(fs.readFileSync(`${repo}/attendance-utils.js`, 'utf8'));
  window.eval(fs.readFileSync(`${repo}/teacher-rfid.js`, 'utf8'));
  return { window, doc: window.document, tables, log, today };
}

const text = el => el.textContent.replace(/\s+/g, ' ').trim();

console.log('RFID panel');
{
  const { window, doc, tables, log } = setup();
  window.NexoraRfidAdmin.studentsChanged(tables.students);
  await tick();
  const readers = text(doc.getElementById('rfidReaders'));
  check('online reader shown online', /main-gate.*Online/.test(readers), readers);
  check('stale reader shown offline with queue', /library.*4 taps waiting to sync.*Offline/.test(readers), readers);
  const summary = text(doc.getElementById('rfidTodaySummary'));
  check('today summary counts students and late', summary.includes('2 / 3') && summary.includes('1 late') && summary.includes('3 unknown-card taps'), summary);
  const unknown = text(doc.getElementById('rfidUnknownCards'));
  check('unknown cards grouped by uid', unknown.includes('DEADBEEF') && unknown.includes('2 taps'), unknown);
  check('inactive (previously used) uid listed as unknown', unknown.includes('11223344'), unknown);
  check('active cards not listed as unknown', !unknown.includes('39C38E02'), unknown);
  const feed = text(doc.getElementById('rfidScanFeed'));
  check('feed shows names, late and repeat taps', feed.includes('Asha Rao (Class 8)') && feed.includes('Late') && feed.includes('Repeat tap') && feed.includes('Unknown card DEADBEEF'), feed);
  check('late cut-off loaded', doc.getElementById('rfidLateAfter').value === '09:30');
  check('active card count', doc.getElementById('rfidCardCount').textContent === '2');

  // Assign DEADBEEF to Meera (no card yet) from the unknown list.
  const row = [...doc.querySelectorAll('#rfidUnknownCards .rfid-row')].find(r => r.textContent.includes('DEADBEEF'));
  row.querySelector('select').value = '3';
  row.querySelector('button').click();
  await tick(); await tick();
  const meera = tables.student_rfid_cards.find(c => c.card_uid === 'DEADBEEF');
  check('unknown card assigned via insert', meera && meera.student_id === 3 && meera.active && meera.created_by === 'teacher-uuid', meera);
  check('success message', /assigned to Meera Iyer/.test(doc.getElementById('rfidMessage').textContent), doc.getElementById('rfidMessage').textContent);
  check('assigned card leaves unknown list', !text(doc.getElementById('rfidUnknownCards')).includes('DEADBEEF'));

  // Re-use old inactive UID 11223344 for Asha (who already has 39C38E02): must deactivate old, then re-point.
  log.length = 0;
  const row2 = [...doc.querySelectorAll('#rfidUnknownCards .rfid-row')].find(r => r.textContent.includes('11223344'));
  row2.querySelector('select').value = '1';
  row2.querySelector('button').click();
  await tick(); await tick();
  const asha = tables.student_rfid_cards.filter(c => c.student_id === 1);
  check('replacing a card keeps one active per student', asha.filter(c => c.active).length === 1 && asha.find(c => c.active).card_uid === '11223344', asha);
  check('reused uid updated, not inserted (uid is unique)', !log.some(l => l.op === 'insert'), log.map(l => l.op));
  check('no error shown', doc.getElementById('rfidMessage').style.color !== 'rgb(239, 68, 68)', doc.getElementById('rfidMessage').textContent);

  // Register form with messy UID input.
  doc.getElementById('rfidRegisterStudent').value = '2';
  doc.getElementById('rfidRegisterUid').value = 'ca:fe:ba:be';
  doc.getElementById('rfidRegisterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  const vikram = tables.student_rfid_cards.filter(c => c.student_id === 2 && c.active);
  check('register form normalises uid and replaces card', vikram.length === 1 && vikram[0].card_uid === 'CAFEBABE', vikram);
  check('register button label restored', doc.getElementById('rfidRegisterButton').textContent === 'Register card');

  // Bad UID
  doc.getElementById('rfidRegisterUid').value = 'xyz';
  doc.getElementById('rfidRegisterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  check('invalid uid rejected with message', /8 to 20 hex/.test(doc.getElementById('rfidMessage').textContent));

  // Deactivate a card from the registry list.
  const cardRow = [...doc.querySelectorAll('#rfidCardList .rfid-row')].find(r => r.textContent.includes('CAFEBABE'));
  cardRow.querySelector('button').click();
  await tick(); await tick();
  check('deactivate card', tables.student_rfid_cards.find(c => c.card_uid === 'CAFEBABE').active === false);

  // Search filter
  doc.getElementById('rfidCardSearch').value = 'meera';
  doc.getElementById('rfidCardSearch').dispatchEvent(new window.Event('input'));
  const listed = doc.querySelectorAll('#rfidCardList .rfid-row').length;
  check('card search filters', listed === 1, listed);

  // Late cut-off
  doc.getElementById('rfidLateAfter').value = '09:15';
  doc.getElementById('rfidLateForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick();
  check('late cut-off saved', tables.attendance_settings[0].late_after === '09:15', tables.attendance_settings[0]);
  window.close();
}

console.log('RFID panel before migration');
{
  const { window, doc, tables } = setup({ failTables: new Set(['rfid_devices']) });
  window.NexoraRfidAdmin.studentsChanged(tables.students);
  await tick();
  check('missing tables -> migration hint', /Apply db\/migrations\/20261127120000_rfid_attendance_v2.sql/.test(doc.getElementById('rfidMessage').textContent), doc.getElementById('rfidMessage').textContent);
  window.close();
}

console.log('Attendance register');
{
  const { window, doc, tables, log, today } = setup();
  // Pull the register functions out of teacher.html's inline script.
  const inline = teacherHtml.slice(teacherHtml.indexOf('    async function loadAttendanceRoster(statusMessage) {'),
    teacherHtml.indexOf("    document.getElementById('attendanceDateInput').value = NexoraAttendance.todayIso();"));
  window.eval(`var allStudents = ${JSON.stringify(tables.students)}; var loadStudentsCalls = 0; function loadStudentsRoster(){ loadStudentsCalls++; }\n${inline}\nwindow.loadAttendanceRoster = loadAttendanceRoster; window.saveClassAttendance = saveClassAttendance;`);
  window.eval(`document.getElementById('attendanceDateInput').value = NexoraAttendance.todayIso();`);
  check('date defaults to today in IST', doc.getElementById('attendanceDateInput').value === today, doc.getElementById('attendanceDateInput').value);
  const classSelect = doc.getElementById('attendanceClassSelect');
  classSelect.innerHTML = '<option value="Class 8">Class 8</option>';
  classSelect.value = 'Class 8';
  doc.getElementById('saveClassAttendance').addEventListener('click', () => window.saveClassAttendance());
  await window.loadAttendanceRoster();
  const roster = text(doc.getElementById('teacherAttendanceRoster'));
  check('summary counts rfid / teacher / unmarked', roster.includes('2 tapped in (1 late)') && roster.includes('0 marked by teacher') && roster.includes('1 not marked'), roster);
  check('rfid tap time shown', /RFID entry: .* · Late/.test(roster) && /RFID entry: .* · On time/.test(roster), roster);
  const selects = [...doc.querySelectorAll('.attendance-status-select')];
  const meera = selects.find(s => s.dataset.studentCode === 'C8-003');
  check('unmarked student defaults to "Not marked" (not Present)', meera.value === '', meera.value);
  const save = doc.getElementById('saveClassAttendance');
  check('nothing to save initially', save.disabled && save.textContent === 'No changes to save', save.textContent);
  [...doc.querySelectorAll('#teacherAttendanceRoster .attendance-summary button')].find(b => b.textContent === 'Mark rest Absent').click();
  check('mark rest absent only touches unmarked', meera.value === 'Absent' && selects.filter(s => s.value === 'Present').length === 2);
  check('save button shows 1 change', !save.disabled && save.textContent === 'Save 1 change', save.textContent);
  log.length = 0;
  save.click();
  await tick(); await tick();
  const upserts = log.filter(l => l.op === 'upsert');
  check('only the changed row is upserted', upserts.length === 1 && upserts[0].payload.length === 1 && upserts[0].payload[0].student_code === 'C8-003' && upserts[0].payload[0].status === 'Absent', upserts);
  check('rfid rows keep their source', tables.attendance_records.filter(r => r.source === 'rfid').length === 2);
  check('saved message survives the reload', doc.getElementById('attendanceSaveMessage').textContent === 'Saved 1 change.', doc.getElementById('attendanceSaveMessage').textContent);
  check('register reloads with no pending changes', doc.getElementById('saveClassAttendance').textContent === 'No changes to save');
  window.close();
}

console.log('Add user form');
{
  const { window, doc, tables } = setup();
  const calls = [];
  // Stand-in for the server's student-enroll function.
  window.nexoraClient.functions = {
    invoke: async (name, { body }) => {
      calls.push({ name, body });
      if (body.card_uid === '39C38E02') return { data: { error: 'Card 39C38E02 already belongs to Asha Rao.' }, error: { status: 409, message: 'The request failed (409).' } };
      const student = { id: 4, student_name: body.student_name, class_name: body.class_name, student_code: 'CLASS8-4321' };
      tables.students.push(student);
      if (body.card_uid) tables.student_rfid_cards.push({ id: 9, student_id: 4, card_uid: body.card_uid, active: true, created_at: new Date().toISOString() });
      return { data: { success: true, student, card_uid: body.card_uid || null }, error: null };
    },
  };
  // Roster rows carry the same hooks teacher.html renders.
  window.loadStudentsRoster = async () => {
    doc.getElementById('studentsRosterList').innerHTML = tables.students
      .map(st => `<div><span data-card-for="${st.id}">No card</span><button data-map-card="${st.id}">Map card</button></div>`).join('');
    window.NexoraRfidAdmin.studentsChanged(tables.students);
    window.NexoraEnroll.studentsChanged(tables.students);
    window.NexoraEnroll.renderRosterCards();
  };
  window.eval(fs.readFileSync(`${repo}/teacher-enroll.js`, 'utf8'));
  await window.loadStudentsRoster();
  await tick();

  const badge = id => text(doc.querySelector(`[data-card-for="${id}"]`));
  check('roster shows who has a card', badge(1) === 'Card 39C38E02' && badge(3) === 'No card', [badge(1), badge(3)]);
  check('roster button reads Change card / Map card', text(doc.querySelector('[data-map-card="1"]')) === 'Change card' && text(doc.querySelector('[data-map-card="3"]')) === 'Map card');
  check('class suggestions come from the roster', [...doc.querySelectorAll('#enrollClassList option')].map(o => o.value).join() === 'Class 8');
  const picks = [...doc.querySelectorAll('#enrollTappedCards button')].map(text);
  check('recently tapped unassigned cards are offered', picks.some(t => t.startsWith('DEADBEEF')) && picks.some(t => t.startsWith('11223344')) && !picks.some(t => t.startsWith('39C38E02')), picks);

  const form = doc.getElementById('enrollStudentForm');
  const submit = async () => { form.dispatchEvent(new window.Event('submit', { cancelable: true })); await tick(); await tick(); };
  const message = () => text(doc.getElementById('enrollMessage'));
  doc.getElementById('enrollGeneratePassword').click();
  const password = doc.getElementById('enrollPassword').value;
  check('Generate makes a 12-character password without look-alike characters', /^[A-HJKMNP-Za-hjkmnp-z2-9]{12}$/.test(password), password);

  doc.getElementById('enrollName').value = 'Nila Menon';
  doc.getElementById('enrollClass').value = 'Class 8';
  doc.getElementById('enrollCardUid').value = 'not-a-card';
  await submit();
  check('a malformed card UID is caught before anything is sent', calls.length === 0 && /8 to 20 hex/.test(message()), message());

  doc.getElementById('enrollPassword').value = 'short';
  doc.getElementById('enrollCardUid').value = '';
  await submit();
  check('a short password is caught', calls.length === 0 && /10 to 72/.test(message()), message());

  doc.getElementById('enrollPassword').value = password;
  doc.getElementById('enrollCardUid').value = '39C38E02';
  await submit();
  check('a card that is taken shows the server\'s reason and keeps the form', calls.length === 1 && /already belongs to Asha Rao/.test(message()) && doc.getElementById('enrollName').value === 'Nila Menon', message());

  [...doc.querySelectorAll('#enrollTappedCards button')].find(b => text(b).startsWith('DEADBEEF')).click();
  check('picking a tapped card fills the UID', doc.getElementById('enrollCardUid').value === 'DEADBEEF');
  doc.getElementById('enrollCardUid').value = 'de:ad:be:ef';
  await submit();
  const sent = calls[1]?.body;
  check('one request carries name, class, password and the normalised UID', calls[1]?.name === 'student-enroll' && sent.student_name === 'Nila Menon' && sent.class_name === 'Class 8' && sent.password === password && sent.card_uid === 'DEADBEEF', sent);
  const result = text(doc.getElementById('enrollResult'));
  check('result shows code, password and card once', !doc.getElementById('enrollResult').hidden && result.includes('CLASS8-4321') && result.includes(password) && result.includes('DEADBEEF (mapped'), result);
  check('form is cleared for the next user', doc.getElementById('enrollName').value === '' && doc.getElementById('enrollPassword').value === '' && message() === '');
  check('new user appears in the roster with the card', badge(4) === 'Card DEADBEEF', badge(4));
  check('the mapped card leaves the unassigned list', ![...doc.querySelectorAll('#enrollTappedCards button')].some(b => text(b).startsWith('DEADBEEF')));

  doc.getElementById('enrollName').value = 'No Card';
  doc.getElementById('enrollClass').value = 'Class 9';
  doc.getElementById('enrollGeneratePassword').click();
  tables.students = tables.students.filter(st => st.id !== 4);
  await submit();
  check('the card is optional', calls[2]?.body.card_uid === '' && /not mapped yet/.test(text(doc.getElementById('enrollResult'))), calls[2]?.body);

  // "Map card" on a roster row opens the card form for that student.
  window.NexoraRfidAdmin.startAssign(3);
  const details = doc.getElementById('rfidRegisterForm').closest('details');
  check('Map card opens the card form with the student chosen', details.open && doc.getElementById('rfidRegisterStudent').value === '3' && /Meera Iyer/.test(text(doc.getElementById('rfidMessage'))), text(doc.getElementById('rfidMessage')));
  check('and suggests the most recently tapped unassigned card', doc.getElementById('rfidRegisterUid').value === '11223344', doc.getElementById('rfidRegisterUid').value);
  doc.getElementById('rfidRegisterForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(); await tick();
  check('registering it updates the roster badge', badge(3) === 'Card 11223344' && text(doc.querySelector('[data-map-card="3"]')) === 'Change card', badge(3));
}

console.log(failures ? `\n${failures} FAILED` : '\nUI PASSED');
process.exit(failures ? 1 : 0);
