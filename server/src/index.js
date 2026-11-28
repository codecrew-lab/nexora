import http from 'node:http';
import pg from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDatabase } from './db.js';
import { createPushService } from './push.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax, connectionTimeoutMillis: 10000 });
// An idle connection dropping (database restart, network blip) must not crash the server.
pool.on('error', error => console.error('Database connection error:', error.message));

const db = createPgDatabase(pool);
const push = createPushService({ db, config });
const server = http.createServer(createApp({ db, config, push }));

// Collect the changes that database triggers queued (new homework, attendance,
// marks) and notify students and parents.
const PUSH_POLL_MS = 5000;
if (push.configured) {
  setInterval(() => {
    push.processOutbox().catch(error => console.error('Notification outbox error:', error?.message || error));
  }, PUSH_POLL_MS).unref();
}

server.listen(config.port, () => {
  console.log(`NEXORA server listening on port ${config.port}`);
  if (!config.teacherLoginCode || !config.teacherAccessCode) console.warn('Teacher sign-in is disabled: set TEACHER_LOGIN_CODE and TEACHER_ACCESS_CODE.');
  if (config.rfidDeviceSecret.length < 32) console.warn('RFID readers are disabled: set PULSE_RFID_DEVICE_SECRET (at least 32 characters).');
  if (!push.configured) console.warn('Push notifications are disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
