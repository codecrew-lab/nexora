// NEXORA API: everything the portals and RFID readers need from the server.
//
//   POST /api/auth/login            student sign-in (e-mail + password)
//   POST /api/auth/teacher-login    teacher sign-in (login code + access code)
//   POST /api/auth/refresh          new access token for a live session
//   POST /api/auth/logout           end a session
//   POST /api/db/query              table read/write, as the caller's database role
//   POST /api/rpc/<function>        call a public.<function>, as the caller's role
//   POST /api/functions/parent-report            parent view by student code
//   POST /api/functions/student-account-manager  teacher sets a student password
//   POST /api/functions/student-enroll           teacher adds a student, login and RFID card
//   POST /api/functions/push-notify              notification subscribe / unsubscribe / teacher broadcast
//   POST /api/rfid/attendance       RFID readers (device secret, not browsers)
//   GET  /healthz
import crypto from 'node:crypto';
import { ApiError, toApiError } from './errors.js';
import {
  TEACHER_EMAIL, endSession, hashPassword, isTeacher, loadUser, refreshSession, safeEqual,
  signInAsEmail, signInWithPassword, verifyJwt,
} from './auth.js';
import { FUNCTION_LOOKUP_SQL, buildRpcQuery, buildTableQuery, describeFunctions, ident } from './query.js';

const MAX_BODY_BYTES = 1024 * 1024;
const FUNCTION_CACHE_MS = 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

// In-memory attempt counter. It is per process: put a proxy or WAF rate limit
// in front as well if the server is ever scaled to several instances.
function createLimiter(max) {
  const buckets = new Map();
  const live = key => {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt > Date.now()) return bucket;
    buckets.delete(key);
    return null;
  };
  return {
    blocked: key => (live(key)?.count ?? 0) >= max,
    hit(key) {
      const bucket = live(key);
      if (bucket) bucket.count += 1;
      else {
        if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt <= Date.now()) buckets.delete(k);
        buckets.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
      }
    },
    clear: key => buckets.delete(key),
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Invalid JSON body.');
  }
}

export function createApp({ db, config, log = console, push = null }) {
  const allowedOrigins = new Set(config.allowedOrigins);
  const teacherLimiter = createLimiter(5);
  const studentLimiter = createLimiter(10);
  const parentLimiter = createLimiter(8);
  const pushLimiter = createLimiter(20);
  const functionCache = new Map();

  // Behind a reverse proxy the caller's address is the LAST X-Forwarded-For
  // entry: the proxy appends it, and anything before it was supplied by the
  // caller and can be forged to dodge the rate limits. Some proxies (Azure App
  // Service) add the port, which must not make every request look new.
  const clientIp = req => {
    let forwarded = '';
    if (config.trustProxy) {
      const entries = String(req.headers['x-forwarded-for'] || '').split(',').map(entry => entry.trim()).filter(Boolean);
      forwarded = (entries[entries.length - 1] || '')
        .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')        // [2001:db8::1]:443
        .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');   // 203.0.113.5:443
    }
    return forwarded || req.socket?.remoteAddress || 'unknown';
  };

  const send = (res, status, body, headers = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...res.nexoraCors,
      ...headers,
    });
    res.end(text);
  };

  const sendError = (res, error) => send(res, error.status, {
    error: { message: error.message, code: error.code, details: error.details, hint: error.hint },
  });

  // Who is calling. No token means the `anon` database role.
  function requestContext(req) {
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token) return { role: 'anon', claims: { role: 'anon' } };
    return { role: 'authenticated', claims: verifyJwt(token, config.jwtSecret) };
  }

  async function lookupFunction(name) {
    const cached = functionCache.get(name);
    if (cached && cached.expires > Date.now()) return cached.overloads;
    const { rows } = await db.run(null, query => query(FUNCTION_LOOKUP_SQL, [name]));
    const overloads = describeFunctions(rows);
    functionCache.set(name, { overloads, expires: Date.now() + FUNCTION_CACHE_MS });
    return overloads;
  }

  // ------------------------------------------------------------------ auth
  async function login(req, res, body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password || email.length > 320 || password.length > 200) {
      throw new ApiError(400, 'invalid_credentials', 'Invalid login credentials');
    }
    // Keyed on the account as well as the address: a whole school usually
    // shares one public IP, and one student's typos must not lock out the rest.
    const key = `${clientIp(req)}|${email}`;
    if (studentLimiter.blocked(key)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Please wait 15 minutes and try again.');
    }
    const session = await signInWithPassword(db, config.jwtSecret, email, password);
    if (!session) {
      studentLimiter.hit(key);
      throw new ApiError(400, 'invalid_credentials', 'Invalid login credentials');
    }
    studentLimiter.clear(key);
    send(res, 200, session);
  }

  async function teacherLogin(req, res, body) {
    const ip = clientIp(req);
    if (teacherLimiter.blocked(ip)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Please wait 15 minutes and try again.');
    }
    if (!config.teacherLoginCode || !config.teacherAccessCode) {
      log.error('Teacher sign-in is missing TEACHER_LOGIN_CODE / TEACHER_ACCESS_CODE.');
      throw new ApiError(503, 'not_configured', 'Teacher sign-in is not configured yet.');
    }
    const loginCode = typeof body.login_code === 'string' ? body.login_code.trim() : '';
    const accessCode = typeof body.access_code === 'string' ? body.access_code : '';
    // Compare both before deciding, so timing does not reveal which was wrong.
    const loginOk = safeEqual(loginCode, config.teacherLoginCode);
    const accessOk = safeEqual(accessCode, config.teacherAccessCode);
    if (!loginOk || !accessOk) {
      teacherLimiter.hit(ip);
      throw new ApiError(401, 'invalid_credentials', 'The login details are incorrect.');
    }
    teacherLimiter.clear(ip);
    // Only the existing teacher account is signed in. Nothing is created here.
    const session = await signInAsEmail(db, config.jwtSecret, TEACHER_EMAIL);
    if (!session) {
      throw new ApiError(404, 'teacher_account_missing', 'The existing teacher account was not found. Contact the school administrator.');
    }
    send(res, 200, session);
  }

  async function refresh(req, res, body) {
    const token = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    const session = token ? await refreshSession(db, config.jwtSecret, token) : null;
    if (!session) throw new ApiError(401, 'session_expired', 'Your session has ended. Please sign in again.');
    send(res, 200, session);
  }

  async function logout(req, res, body) {
    if (typeof body.refresh_token === 'string' && body.refresh_token) await endSession(db, body.refresh_token);
    send(res, 200, { success: true });
  }

  // ------------------------------------------------------------------ data
  async function tableQuery(req, res, body) {
    const context = requestContext(req);
    const built = buildTableQuery(body);
    if (built.empty) return send(res, 200, built.hasBody ? '{"data":[]}' : '{"data":null}');
    const result = await db.run(context, query => query(built.sql, built.params));
    send(res, 200, built.hasBody ? `{"data":${result.rows[0].body}}` : '{"data":null}');
  }

  async function rpc(req, res, body, name) {
    const context = requestContext(req);
    ident(name, 'function');
    const overloads = await lookupFunction(name);
    if (!overloads.length) {
      throw new ApiError(404, 'PGRST202', `Could not find the function public.${name} in the schema cache`);
    }
    const built = buildRpcQuery(name, body, overloads);
    const result = await db.run(context, query => query(built.sql, built.params));
    send(res, 200, `{"data":${result.rows[0]?.body ?? 'null'}}`);
  }

  // ------------------------------------------------------- server functions
  const jsonRows = async (query, sql, params) =>
    (await query(`select coalesce(json_agg(row_to_json(q)), '[]'::json)::text as body from (${sql}) q`, params)).rows[0].body;

  // Parents have no account: the teacher-issued student code is the credential.
  async function parentReport(req, res, body) {
    const ip = clientIp(req);
    if (parentLimiter.blocked(ip)) {
      return send(res, 429, { error: 'Too many attempts. Please wait 15 minutes and try again.' });
    }
    parentLimiter.hit(ip);

    const code = typeof body.student_code === 'string' ? body.student_code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9-]{4,40}$/.test(code)) {
      return send(res, 200, { success: false, error: 'Invalid student code. Please check it with the teacher.' });
    }

    try {
      const report = await db.run(null, async query => {
        const students = JSON.parse(await jsonRows(query,
          `select student_name, class_name, student_code, study_hours, teacher_request, areas_to_improve
           from public.students where student_code = $1 limit 2`, [code]));
        if (students.length !== 1) return null;
        const student = students[0];
        const attendance = await jsonRows(query,
          `select attendance_date, status, created_at, marked_by, source, scanned_at, is_late
           from public.attendance_records where student_code = $1
           order by attendance_date desc limit 365`, [code]);
        const assignments = await jsonRows(query,
          `select id, title, subject, due_date, target_code
           from public.assignments where target_code in ('ALL', $1, $2)
           order by due_date asc limit 200`, [code, `CLASS:${student.class_name}`]);
        const updates = await jsonRows(query,
          `select assignment_id, status, updated_at
           from public.student_updates where student_code = $1 and status in ('Completed', 'Not Completed')
           order by updated_at desc limit 500`, [code]);
        const timetable = await jsonRows(query,
          `select id, day_of_week, period_type, title, start_time, end_time, room, note
           from public.pulse_timetable order by day_of_week asc, start_time asc`, []);
        return `{"success":true,"student":${JSON.stringify(student)},"attendance":${attendance},` +
          `"assignments":${assignments},"updates":${updates},"timetable":${timetable}}`;
      });
      if (!report) {
        return send(res, 200, { success: false, error: 'Invalid student code. Please check the exact code with the teacher.' });
      }
      send(res, 200, report);
    } catch (error) {
      log.error('Parent report lookup failed:', error?.message || error);
      send(res, 500, { success: false, error: 'Unable to load the report right now. Please try again later.' });
    }
  }

  // Only a signed-in teacher may manage students. Returns the caller, or null
  // after sending the refusal. A bad or expired token throws 401, which the
  // portal answers by refreshing its session. The role is read from the
  // account as it is now, not from the token.
  async function requireTeacher(req, res, refusal) {
    if (!req.headers.authorization) {
      send(res, 401, { error: 'Sign in as a teacher first.' });
      return null;
    }
    const caller = await loadUser(db, requestContext(req).claims.sub);
    if (!caller || !isTeacher(caller)) {
      send(res, 403, { error: refusal });
      return null;
    }
    return caller;
  }

  // Creates the student's login, or updates it, and links it to the student
  // record. The login name is <student code>@students.pulse.app.
  async function saveStudentAccount(query, record, passwordHash) {
    const email = `${String(record.student_code).trim().toLowerCase()}@students.pulse.app`;
    const role = JSON.stringify({ role: 'student' });
    const profile = JSON.stringify({ display_name: record.student_name });
    const update = (where, value, setEmail) => query(
      `update auth.users
       set encrypted_password = $2, ${setEmail ? 'email = $5,' : ''}
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           raw_app_meta_data = raw_app_meta_data || $3::text::jsonb,
           raw_user_meta_data = raw_user_meta_data || $4::text::jsonb,
           updated_at = now()
       where ${where} and deleted_at is null
       returning id`,
      setEmail ? [value, passwordHash, role, profile, email] : [value, passwordHash, role, profile]);

    let accountId = null;
    if (record.auth_user_id) accountId = (await update('id = $1', record.auth_user_id, true)).rows[0]?.id ?? null;
    if (!accountId) accountId = (await update('lower(email) = lower($1)', email, false)).rows[0]?.id ?? null;
    if (!accountId) {
      accountId = (await query(
        `insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
         values ($1, $2, $3, now(), $4::text::jsonb, $5::text::jsonb) returning id`,
        [crypto.randomUUID(), email, passwordHash, role, profile])).rows[0].id;
    }
    await query('update public.students set auth_user_id = $1 where id = $2', [accountId, record.id]);
    // A new password signs the student out everywhere the old one was used.
    await query('delete from auth.nexora_sessions where user_id = $1', [accountId]);
    return accountId;
  }

  const validPassword = password => typeof password === 'string' && password.length >= 10 && password.length <= 72;

  // A teacher sets (or resets) a student's permanent password, creating the
  // student's login on first use.
  async function studentAccountManager(req, res, body) {
    if (!await requireTeacher(req, res, 'Only an authorized teacher can manage student passwords.')) return;

    const studentId = Number(body.student_id);
    if (!Number.isSafeInteger(studentId) || studentId <= 0) {
      return send(res, 400, { error: 'A valid student record is required.' });
    }
    if (!validPassword(body.password)) {
      return send(res, 400, { error: 'Password must be between 10 and 72 characters.' });
    }

    try {
      const passwordHash = await hashPassword(body.password);
      const student = await db.run(null, async query => {
        const { rows } = await query(
          'select id, student_name, student_code, auth_user_id from public.students where id = $1', [studentId]);
        if (!rows[0]) return null;
        await saveStudentAccount(query, rows[0], passwordHash);
        return rows[0];
      });
      if (!student) return send(res, 404, { error: 'Student record not found.' });
      send(res, 200, {
        success: true,
        student_name: student.student_name,
        student_code: student.student_code,
        message: 'Permanent password saved. Share it privately with the student.',
      });
    } catch (error) {
      log.error('Student account password update failed:', error?.message || error);
      send(res, 500, { error: 'Unable to update student password.' });
    }
  }

  // A teacher adds a student in one step: the student record with a new login
  // code, the login itself, and (optionally) the student's RFID card. Either
  // everything is saved or nothing is.
  //   { student_name, class_name, password, card_uid? }
  async function studentEnroll(req, res, body) {
    const teacher = await requireTeacher(req, res, 'Only an authorized teacher can add students.');
    if (!teacher) return;

    const name = typeof body.student_name === 'string' ? body.student_name.trim().replace(/\s+/g, ' ') : '';
    const className = typeof body.class_name === 'string' ? body.class_name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 120) return send(res, 400, { error: 'Enter the student\'s full name (up to 120 characters).' });
    if (!className || className.length > 60) return send(res, 400, { error: 'Enter the class (up to 60 characters).' });
    if (!validPassword(body.password)) return send(res, 400, { error: 'Password must be between 10 and 72 characters.' });

    const rawUid = typeof body.card_uid === 'string' ? body.card_uid.trim() : '';
    const cardUid = rawUid.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (rawUid && !/^[0-9A-F]{8,20}$/.test(cardUid)) {
      return send(res, 400, { error: 'A card UID is 8 to 20 hex characters, for example 39C38E02.' });
    }

    try {
      const passwordHash = await hashPassword(body.password);
      const outcome = await db.run(null, async query => {
        let card = null;
        if (cardUid) {
          card = (await query(
            `select c.id, c.active, s.student_name from public.student_rfid_cards c
             left join public.students s on s.id = c.student_id where c.card_uid = $1 for update of c`, [cardUid])).rows[0] ?? null;
          if (card?.active) {
            return { conflict: `Card ${cardUid} already belongs to ${card.student_name || 'another student'}. Deactivate it under RFID Attendance first, or use another card.` };
          }
        }

        // Login code: the class without spaces or punctuation, plus four digits.
        const prefix = className.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'STU';
        let student = null;
        for (let attempt = 0; attempt < 12 && !student; attempt++) {
          student = (await query(
            `insert into public.students (student_name, class_name, student_code) values ($1, $2, $3)
             on conflict (student_code) do nothing
             returning id::text as id, student_name, class_name, student_code, auth_user_id`,
            [name, className, `${prefix}-${crypto.randomInt(1000, 10000)}`])).rows[0] ?? null;
        }
        if (!student) throw new Error('Could not generate a unique student code.');

        await saveStudentAccount(query, student, passwordHash);

        if (card) {
          // UIDs are unique, so a card that was used before is re-pointed.
          await query('update public.student_rfid_cards set student_id = $1, active = true where id = $2', [student.id, card.id]);
        } else if (cardUid) {
          await query('insert into public.student_rfid_cards (student_id, card_uid, created_by) values ($1, $2, $3)',
            [student.id, cardUid, teacher.id]);
        }
        return { student };
      });

      if (outcome.conflict) return send(res, 409, { error: outcome.conflict });
      send(res, 200, {
        success: true,
        student: {
          id: Number(outcome.student.id),
          student_name: outcome.student.student_name,
          class_name: outcome.student.class_name,
          student_code: outcome.student.student_code,
        },
        card_uid: cardUid || null,
      });
    } catch (error) {
      // Two teachers registering the same card at the same moment.
      if (error?.code === '23505') return send(res, 409, { error: `Card ${cardUid} was just assigned to another student. Use another card.` });
      log.error('Student enrolment failed:', error?.message || error);
      send(res, 500, { error: 'Unable to add the student. Please try again.' });
    }
  }

  // Web push notifications (server/src/push.js sends them).
  //   subscribe    a student (signed in) or a parent (student code) saves this device
  //   unsubscribe  removes this device's subscriptions, by endpoint
  //   broadcast    a teacher sends a message to everyone, a class or one student
  async function pushNotify(req, res, body) {
    if (!push?.configured) return send(res, 503, { error: 'Notifications are not configured yet.' });
    const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const action = text(body.action, 20);
    const codeOf = value => text(value, 40).toUpperCase();

    try {
      if (action === 'subscribe') {
        const subscription = body.subscription && typeof body.subscription === 'object' ? body.subscription : {};
        const endpoint = text(subscription.endpoint, 1000);
        const p256dh = text(subscription.keys?.p256dh, 200);
        const auth = text(subscription.keys?.auth, 100);
        if (!endpoint.startsWith('https://') || p256dh.length < 20 || auth.length < 8) {
          return send(res, 400, { error: 'Invalid push subscription.' });
        }

        let studentCode;
        if (body.role === 'student') {
          // Throws 401 for a missing, bad or expired token.
          const context = requestContext(req);
          if (context.role !== 'authenticated') return send(res, 401, { error: 'Please sign in again.' });
          const { rows } = await db.run(null, query => query(
            'select student_code from public.students where auth_user_id = $1', [context.claims.sub]));
          if (!rows[0]?.student_code) return send(res, 403, { error: 'This login is not linked to a student.' });
          studentCode = rows[0].student_code;
        } else if (body.role === 'parent') {
          // Parents have no account, so this path is open: limit guessing of codes.
          const ip = clientIp(req);
          if (pushLimiter.blocked(ip)) return send(res, 429, { error: 'Too many attempts. Please wait and try again.' });
          pushLimiter.hit(ip);
          studentCode = codeOf(body.student_code);
          const known = /^[A-Z0-9-]{4,40}$/.test(studentCode) && (await db.run(null, query => query(
            'select 1 from public.students where student_code = $1', [studentCode]))).rows.length === 1;
          if (!known) return send(res, 400, { error: 'Invalid student code.' });
        } else {
          return send(res, 400, { error: 'Unknown role.' });
        }

        await db.run(null, query => query(
          `insert into public.push_subscriptions (endpoint, p256dh, auth, role, student_code, user_agent)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (endpoint, role, student_code)
           do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, updated_at = now()`,
          [endpoint, p256dh, auth, body.role, studentCode, text(req.headers['user-agent'], 300) || null]));
        return send(res, 200, { ok: true });
      }

      if (action === 'unsubscribe') {
        // The endpoint is a long unguessable URL known only to the device and us.
        const endpoint = text(body.endpoint, 1000);
        if (!endpoint) return send(res, 400, { error: 'Missing endpoint.' });
        const params = [endpoint];
        let sql = 'delete from public.push_subscriptions where endpoint = $1';
        if (body.role === 'student' || body.role === 'parent') { params.push(body.role); sql += ` and role = $${params.length}`; }
        const code = codeOf(body.student_code);
        if (code) { params.push(code); sql += ` and student_code = $${params.length}`; }
        await db.run(null, query => query(sql, params));
        return send(res, 200, { ok: true });
      }

      if (action === 'broadcast') {
        if (!await requireTeacher(req, res, 'Teacher sign-in required.')) return;
        const title = text(body.title, 80);
        const message = text(body.message, 300);
        if (!title || !message) return send(res, 400, { error: 'Enter a title and a message.' });
        const audience = text(body.audience, 20);
        const roles = audience === 'students' ? ['student'] : audience === 'parents' ? ['parent'] : ['student', 'parent'];
        const rows = await db.run(null, async query =>
          push.findSubscriptions(query, roles, await push.codesForTarget(query, text(body.target, 160) || 'ALL')));
        const tag = 'broadcast-' + Date.now();
        const sent = await push.deliver(rows, role => ({
          title: '🔔 ' + title,
          body: message,
          url: role === 'parent' ? 'parent.html' : 'index.html',
          tag,
        }));
        return send(res, 200, { ok: true, sent, devices: rows.length });
      }

      return send(res, 400, { error: 'Unknown action.' });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      log.error('push-notify failed:', error?.message || error);
      send(res, 500, { error: 'Notification request failed. Please try again.' });
    }
  }

  // ------------------------------------------------------------ RFID reader
  // Called by the ESP32 readers in hardware/nexora_rfid_reader.
  //   scan:      { "card_uid": "39C38E02", "device_id": "main-gate", "scanned_at": 1764213000 }
  //              scanned_at (unix seconds or ISO string) is only sent for offline replays.
  //   heartbeat: { "type": "heartbeat", "device_id": "main-gate", "firmware": "2.0.0", "rssi": -61, "queued": 0 }
  // Every outcome the reader should display (including unknown cards) is HTTP
  // 200 with a "result" field; 4xx/5xx mean the request itself failed. The
  // reader keeps 5xx and network failures queued and retries them.
  function parseScannedAt(value) {
    if (value === undefined || value === null || value === '' || value === 0) return null;
    const date = typeof value === 'number'
      ? new Date(value * 1000)
      : typeof value === 'string'
        ? new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value)
        : null;
    // Ignore unset device clocks (before 2024) and garbage; server time is used instead.
    if (!date || Number.isNaN(date.getTime()) || date.getTime() < Date.UTC(2024, 0, 1)) return null;
    return date.toISOString();
  }

  const asInt = value => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null);

  async function rfidAttendance(req, res) {
    const fail = (error, status) => send(res, status, { result: 'error', error });
    if (req.method !== 'POST') return fail('Method not allowed.', 405);
    if (!config.rfidDeviceSecret || config.rfidDeviceSecret.length < 32) {
      log.error('RFID attendance is missing PULSE_RFID_DEVICE_SECRET (at least 32 characters).');
      return fail('RFID attendance is not configured.', 503);
    }
    if (!safeEqual(req.headers['x-pulse-device-secret'] ?? '', config.rfidDeviceSecret)) {
      return fail('Unauthorized device.', 401);
    }

    let body;
    try {
      body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    } catch {
      return fail('Invalid JSON body.', 400);
    }

    const deviceId = typeof body.device_id === 'string' ? body.device_id : (req.headers['x-pulse-device-id'] ?? null);

    if (body.type === 'heartbeat') {
      try {
        const { rows } = await db.run(null, query => query(
          'select public.rfid_device_heartbeat($1, $2, $3, $4)::text as body',
          [deviceId, typeof body.firmware === 'string' ? body.firmware : null, asInt(body.rssi), asInt(body.queued) ?? 0]));
        return send(res, 200, rows[0].body);
      } catch (error) {
        log.error('RFID heartbeat failed:', error?.message || error);
        return fail('Heartbeat could not be recorded.', 500);
      }
    }

    if (typeof body.card_uid !== 'string') return fail('card_uid is required.', 400);
    const cardUid = body.card_uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    if (!/^[0-9A-F]{8,20}$/.test(cardUid)) return fail('Invalid card UID format.', 400);

    try {
      const { rows } = await db.run(null, query => query(
        'select public.record_rfid_scan($1, $2, $3::timestamptz)::text as body',
        [cardUid, deviceId, parseScannedAt(body.scanned_at)]));
      return send(res, 200, rows[0].body);
    } catch (error) {
      if (error?.code === '22023') return fail(error.message, 400);
      // 42883: the function does not exist yet (migration not applied).
      log.error('RFID attendance processing failed:', error?.code, error?.message);
      return fail('Attendance could not be recorded.', error?.code === '42883' ? 503 : 500);
    }
  }

  // ---------------------------------------------------------------- routing
  const routes = new Map([
    ['/api/auth/login', login],
    ['/api/auth/teacher-login', teacherLogin],
    ['/api/auth/refresh', refresh],
    ['/api/auth/logout', logout],
    ['/api/db/query', tableQuery],
    ['/api/functions/parent-report', parentReport],
    ['/api/functions/student-account-manager', studentAccountManager],
    ['/api/functions/student-enroll', studentEnroll],
    ['/api/functions/push-notify', pushNotify],
  ]);

  return async function handle(req, res) {
    let signedIn = false;
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
      res.nexoraCors = {};

      if (path === '/healthz') {
        await db.run(null, query => query('select 1'));
        return send(res, 200, { status: 'ok' });
      }

      // Readers are not browsers: no CORS, authenticated by the device secret.
      if (path === '/api/rfid/attendance') return await rfidAttendance(req, res);

      // Browser-facing routes. No cookies are used, so the origin allowlist is
      // defence in depth: it keeps other websites from driving the API with a
      // visitor's typed-in codes. Requests without an Origin header (curl,
      // server-to-server) are not browsers and are let through.
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        return send(res, 403, { error: { message: 'Origin not allowed.', code: 'origin_not_allowed' } });
      }
      if (origin !== undefined) {
        res.nexoraCors = {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Max-Age': '600',
          'Vary': 'Origin',
        };
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, res.nexoraCors);
        return res.end();
      }

      const rpcMatch = path.match(/^\/api\/rpc\/([^/]+)$/);
      const route = routes.get(path) || (rpcMatch ? rpc : null);
      if (!route) throw new ApiError(404, 'not_found', 'Not found.');
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
      signedIn = Boolean(req.headers.authorization);
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_json', 'The request body must be a JSON object.');
      }
      await route(req, res, body, rpcMatch?.[1]);
    } catch (error) {
      if (res.headersSent) return res.end();
      const apiError = toApiError(error, { signedIn });
      if (apiError) {
        if (apiError.status === 503) log.error('Database unavailable:', error?.message || error);
        return sendError(res, apiError);
      }
      log.error('Unhandled request error:', error);
      sendError(res, new ApiError(500, 'internal_error', 'The server could not complete the request. Please try again.'));
    }
  };
}
