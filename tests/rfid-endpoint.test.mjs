// RFID endpoint end-to-end test: firmware-shaped HTTP requests -> the real
// NEXORA server -> the real migrations on PGlite.
//   cd tests && npm install && npm run test:e2e
import { createChecker, createDatabase, startServer, baseConfig } from './support.mjs';

const db = await createDatabase();
const q = async (sql, params) => (await db.query(sql, params)).rows;
await db.exec(`
  insert into public.students (student_code, student_name, class_name) values ('C8-001', 'Asha Rao', 'Class 8'), ('C8-002', 'Vikram Shah', 'Class 8');
  insert into public.student_rfid_cards (student_id, card_uid) values (1, '39C38E02'), (2, 'AABBCCDD');
`);

const SECRET = baseConfig.rfidDeviceSecret;
const { check, finish } = createChecker();
const server = await startServer(db);
const endpoint = `${server.url}/api/rfid/attendance`;

const post = async (body, secret = SECRET, extraHeaders = {}, url = endpoint) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pulse-device-secret': secret, ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

try {
  const todayIst = (await q(`select (now() at time zone 'Asia/Kolkata')::date::text d`))[0].d;
  let r = await post({ card_uid: '39C38E02', device_id: 'Main Gate' });
  check('tap -> 200 present_marked with name', r.status === 200 && r.body.result === 'present_marked' && r.body.student_name === 'Asha Rao', r);
  r = await post({ card_uid: '39C38E02', device_id: 'main-gate' });
  check('repeat tap -> already_marked', r.status === 200 && r.body.result === 'already_marked', r);
  r = await post({ card_uid: 'DEADBEEF' });
  check('unknown card -> 200 unregistered_card', r.status === 200 && r.body.result === 'unregistered_card' && r.body.card_uid === 'DEADBEEF', r);
  r = await post({ card_uid: '39C38E02' }, 'wrong-secret');
  check('wrong secret -> 401', r.status === 401 && r.body.result === 'error', r);
  r = await post({ card_uid: 'zz' });
  check('bad uid -> 400', r.status === 400, r);
  r = await post('not json');
  check('bad json -> 400', r.status === 400, r);
  const yesterday = Math.floor(Date.now() / 1000) - 86400;
  r = await post({ card_uid: 'AABBCCDD', device_id: 'main-gate', scanned_at: yesterday });
  check('offline replay (epoch seconds) -> yesterday', r.status === 200 && r.body.result === 'present_marked' && r.body.attendance_date < todayIst, r);
  r = await post({ card_uid: 'AABBCCDD', scanned_at: 12345 });
  check('unset device clock ignored -> server time (today)', r.status === 200 && r.body.result === 'present_marked' && r.body.attendance_date === todayIst, r);
  r = await post({ type: 'heartbeat', device_id: 'main-gate', firmware: '2.0.0', rssi: -58, queued: 2 });
  check('heartbeat -> ok', r.status === 200 && r.body.result === 'ok' && r.body.device_id === 'main-gate', r);
  r = await post({ card_uid: 'AABBCCDD' }, SECRET, { 'x-pulse-device-id': 'Library Door' });
  const libDoor = await q(`select 1 from rfid_devices where device_id = 'library-door'`);
  check('device id taken from header when body has none', r.status === 200 && libDoor.length === 1, r);
  const get = await fetch(endpoint);
  check('GET -> 405', get.status === 405);

  // A server without a usable device secret must refuse every tap.
  const unconfigured = await startServer(db, { rfidDeviceSecret: 'short' });
  r = await post({ card_uid: '39C38E02' }, 'short', {}, `${unconfigured.url}/api/rfid/attendance`);
  check('missing/short device secret -> 503', r.status === 503 && r.body.result === 'error', r);
  await unconfigured.close();
} finally {
  await server.close();
}
finish('E2E');
