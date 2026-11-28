// Web push notifications for students and parents.
//
// Devices subscribe through the push-notify function (server/src/app.js).
// Notifications are sent in two ways:
//   * a teacher broadcast, sent immediately;
//   * automatic alerts for a new assignment, an attendance change or new marks.
//     Database triggers write those to public.push_outbox, and processOutbox()
//     (run every few seconds by index.js) turns them into notifications. A
//     slow or failed push therefore never delays or undoes the teacher's save.
import webpush from 'web-push';

const SCHOOL_TIMEZONE = 'Asia/Kolkata';
const STALE_AFTER_MINUTES = 60;

const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function todayInSchool() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function timeInSchool(iso) {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleTimeString('en-IN', { timeZone: SCHOOL_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// `send(subscription, payloadText)` delivers one notification and rejects with
// { statusCode } on failure; the default uses the web-push library.
export function createPushService({ db, config, log = console, send }) {
  const configured = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
  const appBaseUrl = config.appUrl || 'https://codecrew-lab.github.io/nexora/';
  const deliverOne = send || ((subscription, payload) => webpush.sendNotification(subscription, payload, {
    TTL: 60 * 60 * 24,
    urgency: 'high',
    vapidDetails: { subject: config.vapidSubject || appBaseUrl, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey },
  }));

  // Student codes for a target ('ALL', 'CLASS:<name>' or one code), or null meaning everyone.
  async function codesForTarget(query, target) {
    if (!target || target.toUpperCase() === 'ALL') return null;
    if (target.startsWith('CLASS:')) {
      const { rows } = await query('select student_code from public.students where class_name = $1', [target.slice(6)]);
      return rows.map(row => row.student_code).filter(Boolean);
    }
    return [target.toUpperCase()];
  }

  async function findSubscriptions(query, roles, codes) {
    if (codes && codes.length === 0) return [];
    const params = [...roles];
    let sql = `select endpoint, p256dh, auth, role, student_code from public.push_subscriptions
               where role in (${roles.map((_, index) => `$${index + 1}`).join(', ')})`;
    if (codes) {
      sql += ` and student_code in (${codes.map((_, index) => `$${roles.length + index + 1}`).join(', ')})`;
      params.push(...codes);
    }
    return (await query(sql + ' limit 5000', params)).rows;
  }

  // Sends one payload per role to each device once, and forgets devices whose
  // subscription the browser has ended.
  async function deliver(rows, payloadFor) {
    const seen = new Set();
    const unique = rows.filter(row => {
      const key = row.endpoint + '|' + row.role;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const expired = [];
    let sent = 0;
    for (let start = 0; start < unique.length; start += 50) {
      const batch = unique.slice(start, start + 50);
      const results = await Promise.allSettled(batch.map(row => {
        const payload = payloadFor(row.role);
        return deliverOne(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          JSON.stringify({ ...payload, url: new URL(payload.url, appBaseUrl).href }),
        );
      }));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') { sent += 1; return; }
        const status = result.reason?.statusCode;
        if (status === 404 || status === 410) expired.push(batch[index].endpoint);
        else log.error('Push delivery failed:', status ?? '', result.reason?.message ?? '');
      });
    }
    if (expired.length) {
      await db.run(null, query => query(
        `delete from public.push_subscriptions where endpoint in (${expired.map((_, index) => `$${index + 1}`).join(', ')})`, expired,
      )).catch(error => log.error('Could not remove expired subscriptions:', error?.message || error));
    }
    return sent;
  }

  // One change recorded by a database trigger -> who to tell, and what.
  async function notificationFor(query, table, record) {
    if (table === 'assignments') {
      const codes = await codesForTarget(query, clean(record.target_code, 160) || 'ALL');
      const rows = await findSubscriptions(query, ['student', 'parent'], codes);
      const subject = clean(record.subject, 80) || 'New assignment';
      const due = formatDate(record.due_date);
      const text = clean(record.title, 160) + (due ? ` · Due ${due}` : '');
      return { rows, payloadFor: role => ({
        title: role === 'parent' ? `📚 New homework: ${subject}` : `📚 New assignment: ${subject}`,
        body: text,
        url: role === 'parent' ? 'parent.html' : 'classroom.html',
        tag: 'assignment-' + record.id,
      }) };
    }

    if (table === 'attendance_records') {
      // Only today's attendance, not a teacher correcting old records.
      if (record.attendance_date !== todayInSchool()) return null;
      const code = clean(record.student_code, 40).toUpperCase();
      const student = (await query('select student_name from public.students where student_code = $1', [code])).rows[0];
      if (!student) return null;
      const name = student.student_name || 'Your child';
      const isRfid = record.source === 'rfid';
      const message = record.status === 'Present'
        ? (isRfid
          ? `${name} arrived at school at ${timeInSchool(record.scanned_at || record.created_at)}${record.is_late === true ? ' (late)' : ''}.`
          : `${name} was marked present today.`)
        : record.status === 'Absent'
          ? `${name} was marked absent today. Please contact the school if this is unexpected.`
          : `${name} was marked on leave today.`;
      const rows = await findSubscriptions(query, ['parent'], [code]);
      return { rows, payloadFor: () => ({
        title: record.status === 'Absent' ? '⚠️ Attendance alert' : '📋 Attendance update',
        body: message,
        url: 'parent.html',
        tag: `attendance-${code}-${record.attendance_date}`,
      }) };
    }

    if (table === 'student_marks') {
      const student = (await query('select student_name, student_code from public.students where id = $1', [record.student_id])).rows[0];
      if (!student?.student_code) return null;
      const rows = await findSubscriptions(query, ['student', 'parent'], [student.student_code]);
      const score = `${Number(record.marks_obtained)}/${Number(record.marks_total)}`;
      const subject = clean(record.subject, 80);
      const exam = clean(record.exam_name, 120);
      return { rows, payloadFor: role => ({
        title: '📈 New marks published',
        body: role === 'parent'
          ? `${student.student_name || 'Your child'} scored ${score} in ${subject} (${exam}).`
          : `You scored ${score} in ${subject} (${exam}).`,
        url: role === 'parent' ? 'parent.html' : 'marks.html',
        tag: 'marks-' + record.id,
      }) };
    }

    return null;
  }

  let busy = false;

  // Takes waiting changes out of the outbox and sends their notifications.
  // Rows are removed as they are claimed, so several server instances never
  // send the same alert twice. Changes that waited too long (the server was
  // down) are dropped: an "arrived at school" alert hours late only confuses.
  async function processOutbox() {
    if (!configured || busy) return 0;
    busy = true;
    try {
      const events = await db.run(null, async query => (await query(
        `delete from public.push_outbox
         where id in (select id from public.push_outbox order by id limit 50 for update skip locked)
         returning id, table_name, record, created_at > now() - interval '${STALE_AFTER_MINUTES} minutes' as fresh`)).rows);
      let sent = 0;
      for (const event of events.sort((a, b) => Number(a.id) - Number(b.id))) {
        if (!event.fresh) continue;
        try {
          const record = typeof event.record === 'string' ? JSON.parse(event.record) : event.record;
          const plan = await db.run(null, query => notificationFor(query, event.table_name, record || {}));
          if (plan?.rows.length) sent += await deliver(plan.rows, plan.payloadFor);
        } catch (error) {
          log.error('Could not send a notification for', event.table_name, error?.message || error);
        }
      }
      return sent;
    } finally {
      busy = false;
    }
  }

  return { configured, codesForTarget, findSubscriptions, deliver, processOutbox };
}
