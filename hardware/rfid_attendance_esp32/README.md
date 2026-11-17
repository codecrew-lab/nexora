# PULSE RFID Attendance — ESP32 + RC522

## Files
- `supabase/migrations/20261117180000_create_student_rfid_cards.sql`: card registry and teacher-only RLS.
- `supabase/functions/pulse-rfid-attendance/index.ts`: device-authenticated attendance endpoint.
- `hardware/rfid_attendance_esp32/rfid_attendance_esp32.ino`: Arduino IDE sketch.

## Register a card (school-authorised teacher/admin only)
Run in the Supabase SQL Editor after confirming the student's identity in the official school roster:

```sql
insert into public.student_rfid_cards (student_id, card_uid, created_by)
select s.id, upper('39C38E02'), auth.uid()
from public.students s
where s.student_code = 'STUDENT-CODE-HERE';
```

The query inserts nothing if the student code does not match. Use the card UID printed by the serial monitor. Do not register a card based only on a UID supplied by an unknown person. The teacher can disable a lost card with `update public.student_rfid_cards set active = false where card_uid = 'UID';`.

## Device configuration
1. Add `PULSE_RFID_DEVICE_SECRET` in Supabase Edge Function Secrets (minimum 32 random characters).
2. Copy the secret into the local Arduino sketch only. Never commit the real value.
3. Set Wi-Fi credentials locally.
4. Add the currently trusted root CA certificate for the Supabase HTTPS endpoint in `SUPABASE_ROOT_CA`. Keep certificate verification enabled.
5. Install the ESP32 board package and MFRC522 library, select **ESP32 Dev Module**, and upload.

## Attendance behaviour
- The date is calculated by the server in `Asia/Kolkata`.
- The first valid scan creates Present.
- A second scan on the same date returns already_marked and does not overwrite Present, Absent, or Leave.
- An unregistered or disabled card is rejected.
- The service-role key remains server-side.

## Important limitations
RFID UIDs can be copied and the device secret can be extracted from firmware. Use this only as a supervised attendance aid with school approval, keep manual correction available, and do not treat a UID scan as strong proof of identity.
