// Sign-in, session tokens and account storage.
//
// Access tokens are short-lived HS256 JWTs carrying the claims the database
// policies read (sub, email, role, app_metadata). A session is a row in
// auth.nexora_sessions holding the hash of a random refresh token; it lasts
// seven days from sign-in and is never extended.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ApiError } from './errors.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const SESSION_TTL_DAYS = 7;
export const TEACHER_EMAIL = 'teacher@auraway.app';

const BCRYPT_COST = 10;
// Compared against when the account does not exist, so a wrong e-mail takes as
// long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('nexora-no-such-account', BCRYPT_COST);

const b64url = input => Buffer.from(input).toString('base64url');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

export function verifyJwt(token, secret) {
  const invalid = () => new ApiError(401, 'invalid_token', 'Your session is not valid. Please sign in again.');
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw invalid();
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (header?.alg !== 'HS256') throw invalid();
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw invalid();
  if (!payload || typeof payload.sub !== 'string' || payload.role !== 'authenticated') throw invalid();
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    throw new ApiError(401, 'token_expired', 'Your session has expired. Please sign in again.');
  }
  return payload;
}

export const hashPassword = password => bcrypt.hash(password, BCRYPT_COST);

export const isTeacher = user => {
  const role = user?.app_metadata?.role;
  return user?.email?.toLowerCase() === TEACHER_EMAIL || role === 'teacher' || role === 'school_admin';
};

const USER_COLUMNS = 'u.id, u.email, u.encrypted_password, u.raw_app_meta_data, u.raw_user_meta_data';
const ACTIVE_USER = '(u.deleted_at is null and (u.banned_until is null or u.banned_until <= now()))';

const publicUser = row => ({
  id: row.id,
  email: row.email,
  role: 'authenticated',
  app_metadata: row.raw_app_meta_data || {},
  user_metadata: row.raw_user_meta_data || {},
});

function sessionResponse(row, refreshToken, sessionId, sessionExpiresAtMs, secret) {
  const user = publicUser(row);
  const now = Math.floor(Date.now() / 1000);
  // A token never outlives its session.
  const expiresAt = Math.min(now + ACCESS_TOKEN_TTL_SECONDS, Math.floor(sessionExpiresAtMs / 1000));
  const accessToken = signJwt({
    iss: 'nexora',
    aud: 'authenticated',
    role: 'authenticated',
    sub: user.id,
    email: user.email,
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    session_id: sessionId,
    iat: now,
    exp: expiresAt,
  }, secret);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_at: expiresAt,
    refresh_token: refreshToken,
    session_expires_at: sessionExpiresAtMs,
    user,
  };
}

async function startSession(query, row, secret) {
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const { rows } = await query(
    `insert into auth.nexora_sessions (user_id, refresh_token_hash, expires_at)
     values ($1, $2, now() + interval '${SESSION_TTL_DAYS} days')
     returning id, (extract(epoch from expires_at) * 1000)::bigint::text as expires_ms`,
    [row.id, sha256(refreshToken)],
  );
  await query('update auth.users set last_sign_in_at = now() where id = $1', [row.id]);
  // Opportunistic clean-up; the table only ever holds a few rows per user.
  await query('delete from auth.nexora_sessions where expires_at <= now()');
  return sessionResponse(row, refreshToken, rows[0].id, Number(rows[0].expires_ms), secret);
}

export async function signInWithPassword(db, secret, email, password) {
  const { rows } = await db.run(null, query => query(
    `select ${USER_COLUMNS} from auth.users u where lower(u.email) = lower($1) and ${ACTIVE_USER} limit 1`,
    [email],
  ));
  const row = rows[0];
  const matches = await bcrypt.compare(password, row?.encrypted_password || DUMMY_HASH);
  if (!row || !row.encrypted_password || !matches) return null;
  return db.run(null, query => startSession(query, row, secret));
}

// Signs in to an existing account without a password, for the teacher code
// sign-in. Never creates the account.
export async function signInAsEmail(db, secret, email) {
  return db.run(null, async query => {
    const { rows } = await query(
      `select ${USER_COLUMNS} from auth.users u where lower(u.email) = lower($1) and ${ACTIVE_USER} limit 1`,
      [email],
    );
    return rows[0] ? startSession(query, rows[0], secret) : null;
  });
}

export async function refreshSession(db, secret, refreshToken) {
  const { rows } = await db.run(null, query => query(
    `select ${USER_COLUMNS}, s.id as session_id,
            (extract(epoch from s.expires_at) * 1000)::bigint::text as expires_ms
     from auth.nexora_sessions s join auth.users u on u.id = s.user_id
     where s.refresh_token_hash = $1 and s.expires_at > now() and ${ACTIVE_USER}`,
    [sha256(refreshToken)],
  ));
  const row = rows[0];
  return row ? sessionResponse(row, refreshToken, row.session_id, Number(row.expires_ms), secret) : null;
}

export async function endSession(db, refreshToken) {
  await db.run(null, query => query(
    'delete from auth.nexora_sessions where refresh_token_hash = $1', [sha256(refreshToken)],
  ));
}

// The account as it is now, not as it was when the token was issued, for
// actions that need a current authorisation decision.
export async function loadUser(db, id) {
  const { rows } = await db.run(null, query => query(
    `select ${USER_COLUMNS} from auth.users u where u.id = $1 and ${ACTIVE_USER}`, [id],
  ));
  return rows[0] ? publicUser(rows[0]) : null;
}
