# RFID attendance

How a card tap becomes an attendance record, and how to deploy and run it.

## Flow

```
Student taps card
   │
   ▼
ESP32 reader (hardware/nexora_rfid_reader)
   │  POST /api/rfid/attendance
   │  header x-pulse-device-secret, body { card_uid, device_id, scanned_at? }
   ▼
NEXORA server (server/src/app.js)
   │  checks the device secret, validates the UID
   │  select record_rfid_scan(card_uid, device_id, scanned_at)
   ▼
Postgres (db/migrations/20261127120000_rfid_attendance_v2.sql)
   │  one transaction:
   │   ├─ student_rfid_cards  → which student owns this card?
   │   ├─ attendance_records  → insert Present (never overwrites an existing record)
   │   ├─ rfid_scan_events    → log the tap (including unknown cards)
   │   └─ rfid_devices        → reader last seen
   ▼
Reply { result, student_name, status, late } → OLED + buzzer
```

Teachers, students and parents then read the same `attendance_records` rows:

| Portal | Where | What they see |
| --- | --- | --- |
| Teacher | `teacher.html` → **Add User & Map RFID Card** (`teacher-enroll.js`) | New student, login and card in one step |
| Teacher | `teacher.html` → **RFID Attendance** (`teacher-rfid.js`) | Live taps, reader status, unknown cards to assign, card registry, late cut-off |
| Teacher | `teacher.html` → **Class Attendance Manager** | Register per class/date. RFID taps are pre-filled; teacher marks the rest |
| Student | `attendance.html` | Own history with tap time and On time / Late |
| Parent | `parent.html` via the server's `parent-report` function | Child's history with tap time and On time / Late |

Display rules (RFID vs. manual, late) live in one place: `attendance-utils.js`.

## Data model

| Table | Purpose | Who can read / write from the browser |
| --- | --- | --- |
| `attendance_records` | One row per student per day. Adds `source` (`manual`/`rfid`), `scanned_at`, `device_id`, `is_late` | Teachers manage; students read their own |
| `student_rfid_cards` | Card UID → student. One active card per student; a UID is unique | Teachers |
| `rfid_scan_events` | Every tap and its result | Teachers read and delete; only the server inserts |
| `rfid_devices` | Reader heartbeat: last seen, firmware, Wi-Fi signal, queued taps | Teachers read and delete; only the server writes |
| `attendance_settings` | Late cut-off time (default 09:30 IST) | Teachers |

`record_rfid_scan()` and `rfid_device_heartbeat()` are not executable by the
`anon` and `authenticated` roles that browser requests run as. Only the server's
reader endpoint calls them, so browsers cannot fake taps.

### Rules

- The attendance **date** is the tap time in IST.
- The **first** tap of the day inserts Present. Later taps return `already_marked`
  with the existing status. A teacher's Absent or Leave is never overwritten.
- A tap is **late** when its IST minute is after `attendance_settings.late_after`.
  Changing the cut-off affects new taps only.
- **Offline taps** carry their original time. Future times are clamped to now;
  taps older than 7 days are rejected (`scan_too_old`).

## Deploy

1. **Database**: `cd server && npm run db:setup` creates everything, including
   the RFID tables and functions ([postgres.md](postgres.md)).
2. **Device secret**: set `PULSE_RFID_DEVICE_SECRET` in the server's environment
   to at least 32 random characters (`openssl rand -hex 24`) and restart the
   server. Use the same value in each reader's `config.h`.
3. **Readers**: set `ATTENDANCE_ENDPOINT` in `config.h` to
   `https://<your server>/api/rfid/attendance` and flash
   `hardware/nexora_rfid_reader` (see its README).
4. **Web**: merge to `main`. GitHub Pages publishes the portals. Until the
   migration has run, the RFID panel shows a setup hint.

## Daily use

- **New student with a card**: tap the new card on a reader, then in the teacher
  portal under *Add User & Map RFID Card* enter the name, class and a password,
  pick the card from *Recently tapped* and press **Add user**. The student, their
  login and the card are saved together.
- **Card for an existing student**: press **Map card** (or **Change card**) on
  the student's row, or tap the card and choose the student under *Unknown cards*.
- **Lost card**: **Deactivate** it under *Registered cards*, then assign the new one.
  Assigning a new card to a student with an active card replaces the old one.
- **Morning register**: open *Class Attendance Manager*, load today. RFID taps are
  already there; press **Mark rest Absent** (or set each student) and save.
  Only changed rows are saved, so tap times are kept.
- **Reader offline?** *Readers* shows the last heartbeat. Offline readers keep
  taps and sync them when they reconnect (`Q` count on the OLED).

## Housekeeping

`rfid_scan_events` grows by one row per tap. To keep 6 months:

```sql
delete from public.rfid_scan_events where received_at < now() - interval '180 days';
```

## Limitations

RFID UIDs can be cloned and a stolen reader holds the device secret. Treat a tap
as a convenience, not proof of identity: keep readers supervised and correct
records in the portal. If a reader is lost, rotate `PULSE_RFID_DEVICE_SECRET` and
re-flash the remaining readers.
