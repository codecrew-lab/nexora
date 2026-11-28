# NEXORA

A school portal with RFID attendance. Students tap a card at the classroom
reader and are marked present. Teachers, students and parents see the same
records in their portals.

- **Web portal (PWA)**: student, parent and teacher pages, published by GitHub
  Pages at <https://codecrew-lab.github.io/nexora/>
- **Android apps**: NEXORA (student), NEXORA-P (parent), NEXORA-T (teacher),
  which wrap the same web pages
- **RFID reader**: ESP32 + RC522 with OLED and buzzer
- **Backend**: our own Node server and PostgreSQL database (row-level security
  in the database, sign-in and the reader endpoint in the server)

```
 ESP32 reader ──────────HTTPS──┐
                               ├──► NEXORA server (server/) ──► PostgreSQL (RLS)
 Web portal / Android apps ────┘
      nexora-api.js
```

## Repository layout

```
/                       Web portal. GitHub Pages serves the repository root, so pages stay here.
  *.html                  One page per feature (teacher.html, parent.html, attendance.html, …)
  nexora-api.js           API client and per-portal session handling
  student-auth.js         Student sign-in gate
  attendance-utils.js     Shared attendance display rules (RFID vs manual, late)
  teacher-rfid.js         Teacher portal RFID panel
  teacher-enroll.js       Teacher portal: add a user and map their RFID card
  sw.js, pwa-installer.js Offline cache and install prompt
app/                    Android apps (Kotlin WebView). Web files are copied in at build time.
hardware/
  nexora_rfid_reader/     ESP32 firmware. Start with its README
  enclosure/              3D-printable box (OpenSCAD source + STL files)
server/                 NEXORA server: sign-in, data access, parent report, student
                        passwords and the RFID reader endpoint
  src/app.js              Routes
  src/query.js            Table and RPC requests → parameterised SQL
  src/auth.js             Passwords, tokens, sessions
  scripts/db.js           npm run db:setup | db:migrate | db:check
db/
  platform.sql            Roles, auth schema and auth.uid()/auth.jwt(). Applied first
  migrations/             The whole schema, applied in filename order
docs/                   Setup guides
tests/                  Database, server API and UI tests
.github/workflows/      CI: Android build and checks
```

## Guides

- [Backend: setting up the database and running the server](docs/postgres.md)
- [RFID attendance: how it works and how to deploy](docs/rfid-attendance.md)
- [RFID reader: wiring, flashing, troubleshooting](hardware/nexora_rfid_reader/README.md)
- [Teacher sign-in setup](docs/teacher-login.md)

## Developing

**Server**: copy `.env.example` to `.env`, fill it in, then
`cd server && npm install && npm run db:setup && npm start`
(see [docs/postgres.md](docs/postgres.md)).

**Web portal**: serve the root with any static server, e.g.
`npx serve .` or VS Code Live Server (`http://127.0.0.1:5500` is an allowed origin).
Pages opened from localhost use the server at `http://localhost:8787`.
When you add a page or script, add it to `ASSETS_TO_CACHE` in `sw.js` and bump
`CACHE_NAME` and the `sw.js?v=` number in `pwa-installer.js`.

**Android**: open the project in Android Studio, or
`gradle :app:assembleStudentDebug :app:assembleParentDebug :app:assembleTeacherDebug`.
The build copies the root web files into each APK (`syncWebPortal` tasks), so
never edit files under `app/src/main/assets`.

**Firmware**: see [hardware/nexora_rfid_reader/README.md](hardware/nexora_rfid_reader/README.md).
Secrets go in `config.h`, which is git-ignored.

**Tests** (Node 22; they run the real server on an in-process Postgres, so no
database is needed):

```sh
(cd server && npm install)
cd tests
npm install
npm test        # database migration, server API, teacher UI, and reader endpoint tests
```

CI runs these, compiles the firmware, and builds all three Android apps.

## Secrets

Never commit secrets. This repository is public and GitHub Pages serves its
root. The browser holds no secrets: `nexora-api.js` contains only the server's
address. These belong in the server's environment (`.env` locally, which is
git-ignored):

| Secret | Used for |
| --- | --- |
| `DATABASE_URL` | The PostgreSQL connection, including its password |
| `JWT_SECRET` | Signing session tokens |
| `PULSE_RFID_DEVICE_SECRET` | RFID readers → `/api/rfid/attendance` |
| `TEACHER_LOGIN_CODE`, `TEACHER_ACCESS_CODE` | Teacher sign-in |
| `NEXORA_ALLOWED_ORIGINS` (optional) | Overrides the browser origin allowlist |
