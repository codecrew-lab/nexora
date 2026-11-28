# NEXORA

A school portal with RFID attendance. Students tap a card at the classroom
reader and are marked present. Teachers, students and parents see the same
records in their portals.

- **Web portal (PWA)**: student, parent and teacher pages, published by GitHub
  Pages at <https://codecrew-lab.github.io/nexora/>
- **Android apps**: NEXORA (student), NEXORA-P (parent), NEXORA-T (teacher),
  which wrap the same web pages
- **RFID reader**: ESP32 + RC522 with OLED and buzzer
- **Backend**: Supabase (Postgres with row-level security, Auth, Edge Functions)

```
 ESP32 reader ──HTTPS──► Edge Functions ──► Postgres (RLS) ◄── supabase-js ── Web portal / Android apps
```

## Repository layout

```
/                       Web portal. GitHub Pages serves the repository root, so pages stay here.
  *.html                  One page per feature (teacher.html, parent.html, attendance.html, …)
  supabase.js             Supabase client and per-portal session handling
  student-auth.js         Student sign-in gate
  attendance-utils.js     Shared attendance display rules (RFID vs manual, late)
  teacher-rfid.js         Teacher portal RFID panel
  sw.js, pwa-installer.js Offline cache and install prompt
app/                    Android apps (Kotlin WebView). Web files are copied in at build time.
hardware/
  nexora_rfid_reader/     ESP32 firmware. Start with its README
  enclosure/              3D-printable box (OpenSCAD source + STL files)
supabase/
  migrations/             Database schema changes, applied in filename order
  functions/              Edge functions
    pulse-rfid-attendance   RFID reader endpoint
    bright-handler          Teacher code sign-in
    parent-report           Parent view by student code
    student-account-manager Teacher sets student passwords
    teacher-access          Legacy teacher sign-in (see docs/legacy-teacher-access.md)
  attendance-setup.sql    Original attendance table (v1)
  fixes/                  One-off performance fixes already applied
docs/                   Setup guides
tests/                  Database, edge-function and UI tests
.github/workflows/      CI: Android build and checks
```

## Guides

- [RFID attendance: how it works and how to deploy](docs/rfid-attendance.md)
- [RFID reader: wiring, flashing, troubleshooting](hardware/nexora_rfid_reader/README.md)
- [Teacher sign-in setup](docs/teacher-login.md)

## Developing

**Web portal**: serve the root with any static server, e.g.
`npx serve .` or VS Code Live Server (`http://127.0.0.1:5500` is an allowed origin).
When you add a page or script, add it to `ASSETS_TO_CACHE` in `sw.js` and bump
`CACHE_NAME` and the `sw.js?v=` number in `pwa-installer.js`.

**Android**: open the project in Android Studio, or
`gradle :app:assembleStudentDebug :app:assembleParentDebug :app:assembleTeacherDebug`.
The build copies the root web files into each APK (`syncWebPortal` tasks), so
never edit files under `app/src/main/assets`.

**Firmware**: see [hardware/nexora_rfid_reader/README.md](hardware/nexora_rfid_reader/README.md).
Secrets go in `config.h`, which is git-ignored.

**Tests** (Node 22, plus Deno for the end-to-end test):

```sh
cd tests
npm install
npm test        # database migration, teacher UI, and reader endpoint tests
```

CI runs these, type-checks the edge functions, compiles the firmware, and builds
all three Android apps.

## Secrets

Never commit secrets. This repository is public. The browser uses only the
Supabase publishable key in `supabase.js`. These belong in Supabase Edge
Function secrets:

| Secret | Used by |
| --- | --- |
| `PULSE_RFID_DEVICE_SECRET` | RFID readers → `pulse-rfid-attendance` |
| `TEACHER_LOGIN_CODE`, `TEACHER_ACCESS_CODE` | `bright-handler` |
| `NEXORA_ALLOWED_ORIGINS` (optional) | Overrides the browser origin allowlist of the browser-facing functions |
