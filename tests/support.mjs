// Shared test set-up: the real NEXORA server (server/src/app.js) on top of
// PGlite (Postgres compiled to WebAssembly) with the real platform layer and
// migrations applied.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/src/app.js';
import { createPgliteDatabase } from '../server/src/db.js';
import { createPushService } from '../server/src/push.js';

export const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(`${repo}/${file}`, 'utf8');

export function createChecker() {
  let failures = 0;
  return {
    check(name, cond, extra) {
      if (cond) console.log('  ok   ', name);
      else { failures++; console.log('  FAIL ', name, extra !== undefined ? JSON.stringify(extra) : ''); }
    },
    finish(label) {
      console.log(failures ? `\n${failures} FAILED` : `\n${label} PASSED`);
      process.exit(failures ? 1 : 0);
    },
  };
}

// A database exactly as `npm run db:setup` builds it: the platform layer, then
// every migration in filename order. `until` stops before the first migration
// whose name contains it (for upgrade tests).
export const migrationFiles = () => fs.readdirSync(`${repo}/db/migrations`).filter(name => name.endsWith('.sql')).sort();

export async function createDatabase({ until } = {}) {
  const pglite = new PGlite();
  await pglite.exec(read('db/platform.sql'));
  for (const file of migrationFiles()) {
    if (until && file.includes(until)) break;
    await pglite.exec(read(`db/migrations/${file}`));
  }
  return pglite;
}

export const baseConfig = {
  jwtSecret: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
  teacherLoginCode: 'LOGIN-CODE',
  teacherAccessCode: 'ACCESS-CODE',
  rfidDeviceSecret: 'test-secret-0123456789abcdef0123456789',
  allowedOrigins: ['https://codecrew-lab.github.io', 'null', 'http://localhost:3000'],
  trustProxy: false,
  // Any non-empty values switch notifications on; tests never contact a real push service.
  vapidPublicKey: 'test-public-key',
  vapidPrivateKey: 'test-private-key',
  appUrl: 'https://codecrew-lab.github.io/nexora/',
};

export async function startServer(pglite, config = {}) {
  const errors = [];
  const log = { error: (...args) => errors.push(args.map(String).join(' ')), warn() {}, log() {} };
  const database = createPgliteDatabase(pglite);
  const settings = { ...baseConfig, ...config };
  // Stand-in for the browser push services: records what would be sent. An
  // endpoint containing "gone" answers like a device that has unsubscribed.
  const pushed = [];
  const push = createPushService({
    db: database, config: settings, log,
    send: async (subscription, payload) => {
      if (subscription.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      pushed.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
    },
  });
  const app = createApp({ db: database, config: settings, log, push });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, errors, push, pushed, close: () => new Promise(resolve => server.close(resolve)) };
}
