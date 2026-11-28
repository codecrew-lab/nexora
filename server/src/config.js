const DEFAULT_ORIGINS = 'https://codecrew-lab.github.io,null,http://localhost:3000,http://127.0.0.1:5500';

// Reads the server configuration from the environment. Throws with a clear
// message when something the server cannot run without is missing.
export function loadConfig(env = process.env) {
  const problems = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set.');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) problems.push('JWT_SECRET must be at least 32 characters (openssl rand -hex 32).');
  if (problems.length) throw new Error('NEXORA server configuration:\n  ' + problems.join('\n  '));

  return {
    databaseUrl: env.DATABASE_URL,
    poolMax: Number(env.DATABASE_POOL_MAX) || 10,
    port: Number(env.PORT) || 8787,
    jwtSecret: env.JWT_SECRET,
    teacherLoginCode: env.TEACHER_LOGIN_CODE || '',
    teacherAccessCode: env.TEACHER_ACCESS_CODE || '',
    rfidDeviceSecret: env.PULSE_RFID_DEVICE_SECRET || '',
    allowedOrigins: (env.NEXORA_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map(value => value.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // Web push notifications; without the two keys the feature is switched off.
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || '',
    appUrl: env.NEXORA_APP_URL || 'https://codecrew-lab.github.io/nexora/',
  };
}
